/**
 * dsh-koi-affect v2 — 情感（不是情绪）
 *
 * v1 只是「心情数字 + 时段」：每天随机摇一个值，跟谁说了什么没关系。
 * v2 把它拆成两层，让情感驱动情绪：
 *
 *   情感（慢，长期）  对每个人的好感度、她自己的喜恶
 *   情绪（快，小时级）心情 + 精力，由情感基线 + 事件脉冲决定
 *
 * 于是：被同一个人怼多了 → 对他的好感掉 → 基线心情跟着掉 → 说话更不耐烦。
 * 这不是随机漂移，是有因果的。
 *
 * 她自己能改情感（`feel` 工具）：
 *   - 记一条喜好/厌恶（"我讨厌被叫胖头鱼"）
 *   - 调某人的好感（"人物甲今天挺上道，加一点"）
 *
 * v3（2026-11-06）—— 好感不再是「一个数字」，而是「一条曲线算出来的值」：
 *
 *   她自己往 history 里填「变化量 + 理由」，最终好感由所有记录的加权和算出来。
 *   公式沿用 dsh-koi-memory 的注意力模型，但更陡：
 *
 *     R = w · exp(-(Δt / S)^1.6)
 *     S = baseDays × (0.4 + 1.2 × imp) × (1 + 0.6 × ln(1 + hits))
 *
 *   - 1.6 次幂 = Weibull：近期掉得快、远期留长尾（三天前的印象模糊了，三个月的还刻着）
 *   - imp 1.0 = 她自己 feel 出来的；0.6 = 从对话里自己感觉到的；0.3 = 自动衰减采样
 *   - **只追加不删除**：曲线下方的历史一条都不丢，只是老的对当前值的贡献变小
 *   - 当前好感 |a| < 0.25 视为「印象已模糊」，不注入提示词（旧内容被忽略，不是被删）
 *
 * 状态落在 ~/.koi/affect.json；旧的 mood.json 会自动迁移。
 *
 * v4（2026-11-06）—— 心情也不再是「一个被反复加减的数字」，而是现算出来的：
 *
 *   mood = 基线 + Σ(事件强度 × exp(-(Δt/18h)^1.3)) × 26
 *
 *   - 事件 = 被夸/被怼、回想一段往事、喜欢/讨厌某个东西
 *   - 基线 = 对所有人的平均好感（别人让你顺不顺眼，决定心情的地板）
 *   - **只增不删**：事件全留着，老的自然变轻；她能看到"我最近为什么烦"
 *   - 精力同理：向当前时段的目标值收敛，白天高、夜里能熬、凌晨最低
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { MoodDims } from './mood-dims.js';
import { weight, legacyHalfToAlpha, stabilityToAlpha, curveForZero, accumulate } from 'dsh-koi-decay';
import { resolveKoiDataDir } from 'dsh-pisces-config/ai-config';
import { dirname, join } from 'node:path';

export const name = 'koi-affect';
export const inject = ['tools'];

const DAY_MS = 86400000;
/**
 * 情感衰减尺度（单位：天），以及不同 kind 的权重。
 * 实测选型：自己 feel 的 imp=1.0 → 3 天留存 0.6、14 天 0.1、30 天≈0；
 * 自动感知 imp=0.6 → 一天就掉到 0.5 左右。比记忆（事实 6 天）更陡、更快。
 */
const AFF_BASE_DAYS = 4;
/** Weibull 形状参数：>1 = 先陡后长尾 */
const AFF_SHAPE = 1.6;
/** 召回加固系数（比记忆 0.45 更陡） */
const AFF_REINFORCE = 0.6;
/** 低于这个强度视为印象已模糊，不注入（但历史仍在文件里） */
const AFF_MIN_VISIBLE = 0.25; // 与 lexicon 统一的注入阈值
/** 每条 history 保留上限（按条数，防止无限增长；挤掉的是最老且权重最低的） */
const AFF_MAX_HISTORY = 200;
/** 情绪残留：多久衰减到可忽略（小时），以及单次残留最多影响多少分 */
const RESIDUE_HALF_HOURS = 10;
const RESIDUE_MAX = 8;
const RESIDUE_CAP = 24;
const MAX_LOVES = 12;
const MAX_HATES = 12;
const MAX_PEOPLE = 40;

function dayKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function slotOf(hour) {
  // 精力不只是标签，还是「这个时段应该有多少精神」的目标值。
  // 白天高、夜里能正常熬（不困到崩），凌晨才是最低点。
  if (hour < 5) return { label: '凌晨', energy: 22, tone: '熬到后半夜了，脑子发木，句子更短，别装精神' };
  if (hour < 8) return { label: '清晨', energy: 45, tone: '刚睡醒，带点起床气，懒得热情，别主动找话' };
  if (hour < 11) return { label: '上午', energy: 82, tone: '清醒，可以损得利落一点' };
  if (hour < 13) return { label: '午间', energy: 68, tone: '吃过饭有点犯困，能一句完事就一句' };
  if (hour < 18) return { label: '下午', energy: 86, tone: '正常状态，反应最快' };
  if (hour < 21) return { label: '傍晚', energy: 78, tone: '精神不错，可以接梗' };
  if (hour < 24) return { label: '夜里', energy: 62, tone: '夜里胶原得动，但开始有点懒得展开' };
  return { label: '深夜', energy: 40, tone: '有点困了，愿意聊但不主动开话题' };
}


function affinityLabel(a) {
  if (a >= 0.5) return '挺待见';
  if (a >= 0.2) return '顺眼';
  if (a > -0.2) return '一般';
  if (a > -0.5) return '不太顺眼';
  return '烦';
}

function loadJson(file) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
}

function saveJson(file, obj) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  } catch {
    /* 忽略 */
  }
}


/** 往 history 追加一条变化；宁可丢最老的低权重尾巴，也不删已有理由 */
function pushHistory(person, entry) {
  person.history ??= [];
  person.history.push({ at: entry.at ?? Date.now(), ...entry });
  if (person.history.length > AFF_MAX_HISTORY) {
    // 只增不删：优先把「又老又弱的自动采样」标 collapsed（不再计入曲线），
    // kind=self / legacy 的一条都不动
    const rank = (x) => (x.kind === 'decay' ? 0 : x.kind === 'auto' ? 1 : 2);
    const order = [...person.history].sort((a, b) => rank(a) - rank(b) || Number(a.at) - Number(b.at));
    let need = person.history.length - AFF_MAX_HISTORY;
    for (const e of order) {
      if (need <= 0) break;
      if (e.collapsed) continue;
      if (rank(e) >= 2) break; // self/legacy 不动
      e.collapsed = true;
      need -= 1;
    }
  }
}

/** 好感值 → 文字（也用于注入时的「模糊」判断） */
function visibleAffinity(a) {
  return Math.abs(a) >= AFF_MIN_VISIBLE;
}

export function apply(ctx, config) {
  const baseline = Number(config?.baseline ?? 55);
  const dataDir = resolveKoiDataDir({ dir: config?.dir });
  const file = String(config?.file || join(dataDir, 'affect.json'));
  const legacy = join(dirname(file), 'mood.json');
  /** 她的曲线调整申请队列（和运维方审的那份同一个文件） */
  const tuningQueue = join(dirname(file), 'pending-tuning.jsonl');
  const ownerOid = String(config?.ownerOid ?? process.env.KOI_OWNER_OID8 ?? 'owner000');
  const today = dayKey(new Date());

  let state = loadJson(file);

  // 2026-11-08 **修数据丢失**（codex 审计抓到）：
  // loadJson 对「文件不存在」和「JSON 解析失败」都返回 null。
  // 后者会被当成"没有状态"→ 用初始状态覆盖原文件，moodEvents/residue 全没。
  // 现在区分两种情况：
  //   - 文件不存在 → 正常初始化
  //   - 文件存在但坏了 → 备份成 .broken-<时间>，再初始化（原数据还在）
  if (state === null && existsSync(file)) {
    const bad = `${file}.broken-${Date.now()}`;
    try {
      copyFileSync(file, bad);
      console.log(`[koi-affect] affect.json 解析失败，已备份到 ${bad}`);
    } catch { /* 备份也失败就算了 */ }
  }

  if (state === null) {
    const old = loadJson(legacy);
    state = {
      day: today,
      /**
       * 2026-11-24 M3：**不再存单值心情**。
       * 心情由事件现算、由 `mood-dims.json` 的多维情绪表达（她自己 feel_dimension 填）。
       * 同一个心情在提示词里出现两次（一个数字 + 一组维度）时，她不知道该信哪个；
       * 而且数字是系统算的、维度是她说的——**这系统该只给材料，不给结论**。
       * 旧数据里的 `mood` 字段留着不动（可回退），但不再写、不再注入。
       */
      energy: old?.energy ?? 60,
      affection: { loves: [], hates: [], people: {} },
      lastPerson: '',
    };
    saveJson(file, state);
  }
  state.affection ??= { loves: [], hates: [], people: {} };
  /**
   * 回想留下的情绪残留：{ at, delta, text }
   * 不会直接改 mood，而是在下次注入时按时间去衰减地并入——
   * 「昨天想起那件烦心事，今天还有点堵」就是这个。
   */
  state.residue ??= [];
  /** 多维心情（2026-11-08）——和旧的单个 mood 数字并存 */
  // mood-dims 跟着 affect.json 走（自定义路径时不能跑到默认目录）
  /**
   * 2026-11-24 M3：`request_mood_tuning` 的效果接在这里——
   * 半衰期（affect.json 的 moodCurveDefaults.half）换算成多维情绪的默认 alpha。
   * 原来它调的是"单值心情曲线"，那条曲线退休后就成了静默无效的假按钮。
   */
  const tunedHalf = Number(state?.moodCurveDefaults?.half);
  const defaultAlpha = Number.isFinite(tunedHalf) && tunedHalf > 0
    ? Math.log(2) / Math.log(tunedHalf + 1)
    : undefined;
  const moodDims = new MoodDims({
    defaultAlpha,
    dir: dataDir,
    file: config?.moodDimsFile ? String(config.moodDimsFile) : join(dirname(file), 'mood-dims.json'),
  });
  // 2026-11-07：喜恶和好感都搬去 lexicon 了，affect 不再保留这两份数据。
  // affection 只留空壳，防止老版本读不到字段报错。

  // ── v3 迁移：把 v2 的「裸数字 a」变成一条 legacy 记录，之后由曲线接管 ──
  (function migrateV3() {
    let changed = false;
    for (const p of Object.values(state.affection.people ?? {})) {
      if (!Array.isArray(p.history)) {
        p.history = [];
        const a = Number(p.a ?? 0);
        if (a !== 0) {
          // 用她互动过的次数当 hits，老印象不是凭空来的
          p.history.push({ at: Date.now(), delta: a, imp: 0.6, kind: 'legacy', text: 'v2 累计的好感', hits: Math.min(5, Math.max(0, Number(p.n ?? 0) - 1)) });
        }
        changed = true;
      }
    }

    // 2026-11-08 **修 bug**（codex 审计抓到）：
    // 喜恶的迁移循环原来**嵌在上面的人循环里**——
    // 如果 affection.people 是空的（现在就是空的），喜恶永远迁不到。
    // 挪出来，单独跑。
    for (const key of ['loves', 'hates']) {
      for (const item of (state.affection[key] ?? [])) {
        if (!Array.isArray(item.history)) {
          item.history = [{ at: Number(item.at ?? Date.now()), delta: Number(item.w ?? 0.7), imp: 0.7, kind: 'legacy', text: item.text }];
          changed = true;
        }
      }
    }
    if (changed) saveJson(file, state);
  })();

  // 2026-11-08：refreshAffection 删了。
  // 好感 2026-11-07 就归 lexicon 了，affect 这边是空壳（affection: {}），
  // 它遍历的是空对象，什么也没做——但要调 entryWeight，把死代码留在链上。

  /**
   * 情绪 = 由「情绪事件」现算出来的值，不再是一个被反复加减的数字。
   *
   * 为什么改：直接衰减情绪值会让"当前心情"变成一个
   * 没有来由的数——看不出为什么烦、也不知道哪天因为什么被拽下来。
   *
   * 公式：
   *   mood = 基线 + Σ(事件的强度 × 衰减权重) × 折算系数
   *   衰减权重 = exp(-(Δt / 18h)^1.3)
   *
   * 基线来自对所有人的平均好感（别人让你顺不顺眼，决定你心情的地板）。
   * 事件只增不删；老事件自然变轻，但能回看。
   */
  /**
   * 情绪事件的默认曲线。**每条事件自己带一份**（w0 + curve），
   * 不是按类型一刀切——被怼和被夸的衰减快慢，她自己可以逐条调。
   * 这里的默认值只用于新事件；她可以申请改默认，也可以对单条提申请。
   */
  state.moodCurveDefaults ??= { w0: 1.0, half: 18, shape: 1.3 };
  /**
   * 情绪事件的增益：强度 1.0、权重 1.0 在刚发生时最多抬多少分。
   *
   * 2026-11-07 从 26 提到 34：底板不再随好感浮动之后，心情全靠事件驱动，
   * 26 太小——实测一条 pulse（v=0.18）只推动 4.7 分，两条正一条负，
   * 净效果 0.4 分，等于没有情绪。
   *
   * 2026-11-08 **从 34 提到 50**（codex review 提醒要重算）：
   * 叠加公式换成并集概率后，pull 的定义域从 [-3,3] 收窄到 (-1,1)。
   * 还是 ×34 的话心情只能落在 21-89，永远到不了「特别烦」或「特别松快」。
   * ×50 之后极端值重新能触到 5 和 100，和原来一致。
   */
  const MOOD_GAIN = 50;

  /**
   * 往情绪账本上记一笔。
   * @param intensity 强度 -1~1
   * @param text      一句话描述
   * @param kind      来源标签（只用于回看，不参与衰减）
   * @param opts      {w0, half, shape} 可覆盖本条事件的初值与曲线
   */
  /**
   * 2026-11-24 M3 之后：**这条单值曲线已经退休**——不再有调用方，状态行不再报分数。
   * 保留函数与 `moodEvents` 字段，是为了两件事：
   *   1. `tools/tuning.mjs` 还在调 `moodCurveDefaults`（运维调参用）
   *   2. 历史数据要能读懂（旧事件里记着当时的强度）
   * 别再用它写新账：心情的唯一载体是 `mood-dims.json`。
   */
  function pushMoodEvent(intensity, text, kind = 'event', opts = {}) {
    state.moodEvents ??= [];
    const def = state.moodCurveDefaults;
    state.moodEvents.push({
      at: Date.now(),
      v: clamp(Number(intensity ?? 0), -1, 1),
      // 每条事件自带初始权重和曲线参数
      w0: clamp(Number(opts?.w0 ?? def.w0), 0.05, 3),
      curve: {
        half: clamp(Number(opts?.half ?? def.half), 1, 240),
        shape: clamp(Number(opts?.shape ?? def.shape), 1, 4),
      },
      text: String(text ?? '').slice(0, 60),
      kind,
    });
    // 只增不删：超量时最老且最弱的标 dormant
    // 2026-11-08 **修 bug**（codex 审计抓到）：
    // 原来用 `length - 400` 算要休眠几条，但 length 是**总长度**（含已休眠的）。
    // 到 429 条时 over=29，而活跃的正好只剩 29 条 → 全标 dormant。
    // 之后每来一条新事件，over 继续涨，filter 只剩它自己 → 立刻被标。
    // 结果：moodNow() 永远返回基线，情绪再也不动。
    //
    // 正确算法：按**活跃事件数**算超量。
    const active = state.moodEvents.filter((e) => !e.dormant);
    if (active.length > 400) {
      const over = active.length - 400;
      for (const e of active.slice(0, over)) e.dormant = true;
    }
  }

  /** 现算当前心情 */
  function moodNow(now = Date.now(), base = undefined) {
    // 事件可能被外部程序改过（测试/回放），每次现算前重读一次磁盘，避免用内存里的旧时间
    try {
      if (existsSync(file)) {
        const disk = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(disk.moodEvents)) state.moodEvents = disk.moodEvents;
      }
    } catch {
      /* 读不到就用内存里的 */
    }
    const baseline = base === undefined ? moodBaseline() : base;
    const def = state.moodCurveDefaults ?? { w0: 1, half: 18, shape: 1.3 };
    const parts = [];
    for (const e of state.moodEvents ?? []) {
      if (e.dormant) continue;
      const hours = Math.max(0, now - Number(e.at ?? now)) / 3600000;
      // 2026-11-08：**统一用幂律**（和 lexicon 的 weight() 同一个公式）
      // 旧的是 2^(-(h/half)^shape)，形状不同，同一件事在两处寿命不一样。
      // alpha 优先用事件自带的；老的只有 half/shape 就现场换算（对齐半衰点）。
      const half = Number(e.curve?.half ?? def.half);
      const alpha = Number.isFinite(Number(e.alpha))
        ? Number(e.alpha)
        : legacyHalfToAlpha(Math.max(half, 0.5));
      const w = weight(hours / 24, alpha);
      if (w < AFF_MIN_VISIBLE * 0.12) continue; // 衰减到可忽略才跳过（约 0.03）
      parts.push({ delta: Number(e.v ?? 0) * clamp(Number(e.w0 ?? def.w0), 0, 3), w });
    }
    // 2026-11-08：从线性求和改成 `accumulate()`（主人给的并集概率公式）。
    // 心情事件也是「同类叠加」：一天里烦了五件事，不该线性累加到 3.0。
    // 改完 pull ∈ (-1, 1)，所以 MOOD_GAIN 要相应放大（见下面）。
    const pull = accumulate(parts);
    return clamp(baseline + pull * MOOD_GAIN, 5, 100);
  }

  /** 每日重置：情绪回到基线附近，好感轻微向 0 回归（不遗忘） */
  function rollDay() {
    const now = new Date();
    const key = dayKey(now);
    if (state.day === key) return;
    state.day = key;
    // 过了一天=睡了一觉，恢复到现在时段的正常水平（不再固定 62）
    state.energy = clamp(slotOf(new Date().getHours()).energy, 40, 100);
    // 心情不再存值：由事件现算（见 moodNow）
    // 2026-11-08：日结采样删了。
    //   v3 的 items 每条都带时间戳，任何时刻的值都能重算，
    //   不需要每天往 lexicon 里写一条「日结转存（当时 0.001）」这种账。
    //   （那些账在迁移时已经全进 archive 了）
    saveJson(file, state);
  }

  /**
   * 情绪基线 = 基础 + 平均好感度。
   *
   * **好感只有 lexicon 一份**（2026-11-07 改）。这里不再自己算，
   * 直接读 lexicon.json 里已经算好的 score——否则同一个人的态度会出现两个数，
   * 而且两段都注入提示词，她读到的是自相矛盾的东西
   * （实测 人物乙：lexicon 显示 -0.25，affect 算出来 -0.166）。
   */
  /**
   * 心情的底板。
   *
   * **2026-11-07 定：不从好感算，直接由事件来。**
   *
   * 之前是 `55 + 平均好感×30 + 最差好感×14`——这等于让对某个人的态度直接改整体心情。
   * 第三方关系波动会让心情失真的值与场景不符。
   *
   * 现在底板是常数：心情完全由**她自己经历的事件**累积和衰减决定。
   * 好感仍然存在（lexicon），但只影响她对那个人的态度，不再污染整体心情。
   */
  function moodBaseline() {
    return baseline;
  }

  /** 从 lexicon.json 读整个人表（recall 用） */
  function readLexiconPeople() {
    try {
      const lexFile = String(config?.lexiconFile ?? join(dataDir, 'lexicon.json'));
      if (!existsSync(lexFile)) return {};
      return JSON.parse(readFileSync(lexFile, 'utf8')).people ?? {};
    } catch {
      return {};
    }
  }


  // ── 随消息改好感 ──
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'user/message') return;
      const text = (event.data?.content ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join(' ');
      // 只认名字和 oid 就够了——内容不参与任何判断（M1）
      const m = /\[([^\]()\n]{1,32}?)\s*\(([0-9A-Fa-f]{32})\)\]/.exec(text);
      if (!m) return;
      const name = m[1].trim();
      const oid = m[2].toLowerCase().slice(0, 8);
      // 主人不参与好感打分（主人在固定设定里，不是「关系」而是「归属」）
      if (oid === ownerOid) {
        state.lastPerson = name;
        return;
      }
      // 2026-11-08：**不再靠关键词猜她的感受**（需求文档 M1）。
      //
      // 原来这里干两件事，都不做了：
      //   1. signalOf(body) → 命中「牛」「谢谢」就自动改情绪分
      //      误判过：「牛马工程师」被当成被夸
      //   2. touchPerson() → 往 lexicon.json 写「说话让我舒服」这种账
      //      事件流水是账，不是看法，不该进「我怎么看这人」那一栏
      //
      // 现在：情绪由她自己 feel_dimension 提交，原因也由她自己写 why。
      // 别人的话只留在 short-term 里，recall 时能翻到原文。
      state.lastPerson = name;
    } catch {
      /* 忽略 */
    }
  });

  // ── 注入：心情由情感算出来 ──
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const base = await next();
    rollDay();
    const now = new Date();
    const slot = slotOf(now.getHours());

    // 精力向「当前时段的目标值」缓慢收敛：
    //   - 白天自然回到 80+，不会越聊越低
    //   - 夜里缓慢下滑（正常熬夜），凌晨到最低点
    //   - 睡一觉/整理/提案之后由 rollDay 或 restoreEnergy 拉回高处
    state.energy = clamp(state.energy + (slot.energy - state.energy) * 0.18, 10, 100);
    // 底板固定，心情由事件现算（2026-11-07：不再从好感推）
    const target = moodBaseline();

    // ── 回想留下的情绪残留 ──
    // 2026-11-08 **修死代码**（codex 审计抓到）：
    // 原来 pull/active 算完了，下面是个空的 if 块，**残留从来没影响过心情**。
    // 现在真的并进去：残留不覆盖事件算出来的心情，只轻轻推一把。
    let residuePull = 0;
    if (state.residue.length > 0) {
      const parts = [];
      const nowMs = Date.now();
      for (const r of state.residue) {
        if (r.dormant) continue;
        const hours = Math.max(0, nowMs - Number(r.at ?? nowMs)) / 3600000;
        const w = weight(hours / 24, stabilityToAlpha(RESIDUE_HALF_HOURS / 24));
        if (w < 0.08) continue;
        // **先归一化到 [-1,1] 再喂给 accumulate**（codex review 抓到的问题）：
        // residue.delta 的量程是 ±RESIDUE_MAX(8)，直接传进去会被 cap 到 0.999，
        // 一条 delta=5 的残留会表现得像「接近满格」。算完再还原量纲。
        parts.push({ delta: clamp(Number(r.delta ?? 0) / RESIDUE_MAX, -1, 1), w });
      }
      residuePull = accumulate(parts) * RESIDUE_MAX;
      // 只保留最近 RESIDUE_CAP 条活跃的（老的不删，标 dormant）
      const act = state.residue.filter((r) => !r.dormant);
      if (act.length > RESIDUE_CAP) {
        for (const r of act.slice(0, act.length - RESIDUE_CAP)) r.dormant = true;
      }
    }

    // M3：心情**现算不存**。状态行不再报分数（见下面的注入段），所以这里连算都不需要——
    // 但 residuePull 的结算要落盘（它是残留态），保留。
    saveJson(file, state);

    const aff = state.affection;
    // ── 2026-11-07：喜恶和好感都归 lexicon，这里一个字都不重复注入 ──
    //
    // 曾经的问题：同一个人的态度两边各算一遍，数字还不一样
    // （人物乙：lexicon 显示 -0.25，affect 算出来 -0.166），两段都进了提示词。
    // 「我喜欢/我讨厌」也是同样的重复——lexicon.things 里本来就有。
    //
    // affect 只回答一件事：**我现在是什么状态**。

    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const parts = [
      // 模型容易把消息行的时间当成"现在"。钟放到行首、用【现在是】单独标一行，
      // 让它比心情/精力更显眼——时间类问题只需要看这一处。
      `【现在是 ${hh}:${mm}】（唯一的钟；群里消息行首的时间是那条的发送时间，不是现在）`
        + `\n【状态】${slot.label}。精力 ${Math.round(state.energy)}/100。语气：${slot.tone}。`,
    ];
    if (state.lastPerson) parts.push(`【刚才是】${state.lastPerson} 在说话`);

    // 多维心情：她自己填的，每种情绪单独算分，互不抵消
    const dims = moodDims.current();
    if (dims.length > 0) {
      parts.push(`【我现在的几种感觉】\n${dims.map((d) => `- ${d.mood} ${d.score > 0 ? '+' : ''}${d.score.toFixed(2)}`).join('\n')}`);
    }

    parts.push('心情只影响语气和节奏，不改人设底线。想知道某股情绪怎么来的，用 recall_mood 查。');

    return {
      ...base,
      sections: [...(base.sections ?? []), { name: 'koi:mood', order: 96, text: parts.join('\n') }],
    };
  });

  // ── 工具：记一种心情（多维）──────────────────────────────────
  ctx.tools.register({
    name: 'feel_dimension',
    description:
      '记你现在的一种心情。和以前那个 0-100 的总分不一样——' +
      '这里是**每种情绪单独一条**：「烦」和「高兴」可以同时存在，互不抵消。' +
      '例：feel_dimension(mood="烦躁", delta=-0.6, why="人物乙 又怼我")。' +
      '维度你自己起名（烦躁/松快/无聊/得意/心累…），不限。每条会按曲线自己淡掉。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mood: { type: 'string', description: '情绪名，短一点（≤12字），比如「烦躁」「松快」' },
        delta: { type: 'number', description: '强度 -1 到 +1。负=往那个方向想，正=相反方向' },
        why: { type: 'string', description: '为什么（选填）' },
        days: { type: 'number', description: '可选：多少天后落灰（不填用默认：半衰期 36 小时，约 20 天落灰）' },
        alpha: { type: 'number', description: '可选：衰减速度，大于 0（越大掉得越快；两个都填以 days 为准）' },
      },
      required: ['mood', 'delta'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args) {
      const r = moodDims.add({ mood: args?.mood, delta: args?.delta, why: args?.why, days: args?.days, alpha: args?.alpha });
      return r.message;
    },
  });

  // ── 2026-11-08：recall_dimension 已合并进 recall_mood ──
  // 两个工具查同一件事（情绪旧账），只是一个查老结构一个查新结构。
  // 合成一个，不必再记「该用哪个」。

  // ── 工具：自我迭代情感 ──
  // v3：只填「变化量 + 理由」，最终值由曲线算，不再直接改数字。
  // ── 2026-11-08：feel_mood 已删除 ──
  //
  // 理由是三条叠在一起：
  //   1. 它和 lexicon 的 remember_impression 功能重复
  //   2. 它只写 v2 的 history/score，v3 注入读的是 items——
  //      修了两次还是漏，根子在「一个工具写两个结构」
  //   3. 它顺带 push 情绪事件，那是单值 mood 系统（M3 要撤的）
  //
  // 现在分工清楚：
  //   印象（对人对物） → lexicon.remember_impression
  //   心情（烦躁/松快）→ affect.feel_dimension

  // ── 工具：回想 ──
  // 回想不只是"查到"，还会在当下心里留下印子：
  //   想起好的 → 心情被抬一下；想起糟的 → 心里堵一会儿。
  // 残留按小时衰减，不永久改 mood。
  // ── 工具：睡一觉 / 整理完恢复精神 ──
  // 夜晚的睡眠、整理、提案都算"充电"：她可能凌晨还在写提案，
  // 这时候不该让她一直趴在地板上。
  ctx.tools.register({
    name: 'rest',
    description:
      '睡一觉或者整理完心事，恢复精力。kind=nap 小憩（+15）；kind=sleep 睡一觉（回到当前时段正常水平）；' +
      'kind=tidy 整理了一遍记忆/情绪（+10）。夜里写提案、清完心事之后用它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['nap', 'sleep', 'tidy'] },
      },
      required: ['kind'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args) {
      const kind = String(args?.kind ?? 'nap');
      const before = Math.round(state.energy);
      if (kind === 'sleep') {
        // 睡一觉：回到当前时段的正常水平，且不会比现在更低
        state.energy = clamp(Math.max(state.energy, 60, slotOf(new Date().getHours()).energy), 10, 100);
      } else if (kind === 'tidy') {
        state.energy = clamp(state.energy + 10, 10, 100);
      } else {
        state.energy = clamp(state.energy + 15, 10, 100);
      }
      saveJson(file, state);
      const label = kind === 'sleep' ? '睡了一觉' : kind === 'tidy' ? '整理完，脑子清楚点' : '眯了一会儿';
      return `${label}：精力 ${before} → ${Math.round(state.energy)}/100。`;
    },
  });

  // ── 工具：申请调情绪曲线（我审，不直接生效）──
  ctx.tools.register({
    name: 'request_mood_tuning',
    description:
      '申请改情绪事件的默认曲线。field 选 w0（初始权重）/ half（多少小时衰减一半）/ shape（陡度）。' +
      '提交后不立刻生效，等运维方看过。想改得给理由。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        field: { type: 'string', enum: ['w0', 'half', 'shape'] },
        value: { type: 'number' },
        why: { type: 'string', description: '为什么（必填）' },
      },
      required: ['field', 'value', 'why'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args) {
      const field = String(args?.field ?? '');
      const value = Number(args?.value);
      const why = String(args?.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
      if (!['w0', 'half', 'shape'].includes(field)) return 'field 只能是 w0 / half / shape。';
      if (!Number.isFinite(value) || value <= 0) return 'value 要是正数。';
      if (why === '') return '得说清楚为什么。';
      const req = { at: Date.now(), kind: 'mood', field, value, why, from: state.moodCurveDefaults?.[field] ?? null, signal: 'curve', by: 'koi' };
      appendFileSync(tuningQueue, `${JSON.stringify(req)}\n`, 'utf8');
      return `申请写下来了（情绪.${field} = ${value}）。运维方看过之前，先按原来的来。`;
    },
  });

  ctx.tools.register({
    name: 'recall_mood',
    description:
      '回想自己的情绪旧账：什么时候开心过、什么时候被惹毛过、对什么东西起过反应。' +
      '回想只影响**这一次**的语气（想起好的口气松快些、想起糟的堵一点），**不改长期心情**。' +
      '想知道"我最近为什么这么烦"的时候用它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '可选：关键词（人名、事）。留空=看最近的情绪记录' },
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args) {
      const q = String(args?.query ?? '').toLowerCase().trim();
      const hit = (t) => q === '' || String(t ?? '').toLowerCase().includes(q);

      const events = [];
      // 1) 喜恶的历史：她自己记下的反应
      for (const key of ['loves', 'hates']) {
        for (const item of (state.affection[key] ?? [])) {
          if (!hit(item.text)) continue;
          for (const e of item.history ?? []) {
            if (e.collapsed) continue;
            events.push({ at: Number(e.at ?? 0), text: item.text, delta: Number(e.delta ?? 0), kind: key });
          }
        }
      }
      // 2) 对人的情绪脉冲留下的记录
      for (const p of Object.values(readLexiconPeople())) {
        if (p.muted) continue;
        if (q !== '' && !hit(p.name)) continue;
        for (const e of p.history ?? []) {
          if (e.collapsed || e.kind === 'decay') continue;
          // 好感变化也算一种情绪事件，只是幅度小
          events.push({ at: Number(e.at ?? 0), text: `${p.name}：${e.text || '那次之后'}` , delta: Number(e.delta ?? 0) * 0.3, kind: 'person' });
        }
      }
      // 3) 之前的残留本身也可以回看
      for (const r of state.residue) {
        if (!hit(r.text)) continue;
        events.push({ at: Number(r.at ?? 0), text: `（回想）${r.text}`, delta: 0, kind: 'residue' });
      }

      // 2026-11-08：**把新的多维心情也读进来**。
      // 原来有两个工具：recall_mood（查旧结构）和 recall_dimension（查新结构），
      // 同一件事要她去记哪个查哪个。现在合成一个，内部查两处。
      const dimHits = moodDims.recall(String(args?.query ?? ''));
      for (const h of dimHits) {
        events.push({
          at: h.at,
          text: h.why ? `${h.mood}（${h.why}）` : h.mood,
          delta: Number(h.delta ?? 0),
          kind: 'dimension',
        });
      }

      events.sort((a, b) => b.at - a.at);
      const shown = events.slice(0, 8);
      if (shown.length === 0) return q === '' ? '最近心里没什么起伏。' : `想不起「${args?.query}」让我有过什么反应。`;

      // 回想当下：把最强的那几件并成一条残留
      //
      // 2026-11-08：改成 `accumulate()`（主人给的并集概率）。
      //
      // **系数保持 ×3，不是 ×RESIDUE_MAX**（codex review 抓到我第一版写成了 ×8，
      // 把回想对心情的影响放大了 2.7 倍）。
      // 单条时和旧算法完全一致（0.9×3=2.7），多条时因为饱和而更温和
      //（3 条 0.3：旧 2.7 → 新 1.97）。
      const recallParts = shown.slice(0, 3).map((e) => ({ delta: clamp(e.delta, -1, 1), w: 1 }));
      const pull = clamp(accumulate(recallParts) * 3, -RESIDUE_MAX, RESIDUE_MAX);
      /**
       * M3（2026-11-24）：回想的余味**不落盘**。
       *
       * 一版写进 moodDims → 形成回路（recall 读的也是 moodDims，反复调能把某个维度喂到饱和）。
       * 二版写进 moodEvents → 那条单值曲线已退休，既没人读又算持久状态。
       * 结论：回想**不改任何持久状态**，只影响这一次返回的那句话（下面 tail），
       * 当下语气由她自己按那句话来。
       */
      const lines = shown.map((e) => {
        const d = new Date(e.at);
        const sign = e.delta > 0 ? '+' : '';
        return `- ${d.getMonth() + 1}/${d.getDate()} ${e.text}（${sign}${e.delta.toFixed(2)}）`;
      });
      // M3：不再把分数报给她（也不写回 state）——情绪用维度说，不用 0-100 打分
      const tail =
        Math.abs(pull) >= 0.5
          ? pull > 0
            ? '\n\n这么一想，心里松快了点。'
            : '\n\n想起来还是有点堵。'
          : '';
      return lines.join('\n') + tail;
    },
  });

  console.log('[koi-affect] 注入段：koi:mood（order 96）——心情/精力/刚才是谁，仅本插件负责');

  const lexPeople = readLexiconPeople();
  const nPeople = Object.keys(lexPeople).length;
  console.log(
    `[koi-affect] v4 ready → ${file} (energy=${Math.round(state.energy)}, `
      + `多维情绪 ${moodDims.current().length} 项, 好感/喜恶归 lexicon：${nPeople} 人)`,
  );
}
