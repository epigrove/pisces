/**
 * dsh-koi-affect — 情感、精力与多维心情。
 *
 * 好感/喜恶归 lexicon；多维心情由她自己通过 feel_dimension 记录，按曲线现算。
 * M3（2026-11-24）起不再写长期单值心情：旧的 moodEvents 和曲线配置只保留为
 * 历史数据/调参兼容，不再产生或注入 0-100 心情分。
 *
 * 状态落在 ~/.koi/affect.json；多维心情在 mood-dims.json。
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { MoodDims } from './mood-dims.js';
import { weight, stabilityToAlpha, curveForZero, accumulate } from 'dsh-koi-decay';
import { resolveKoiDataDir } from 'dsh-pisces-config/ai-config';
import { dirname, join } from 'node:path';

export const name = 'koi-affect';
export const inject = ['tools'];

const DAY_MS = 86400000;
/** 召回加固系数（比记忆 0.45 更陡） */
const AFF_REINFORCE = 0.6;
/** 低于这个强度视为印象已模糊，不注入（但历史仍在文件里） */
const AFF_MIN_VISIBLE = 0.25; // 与 lexicon 统一的注入阈值
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


/** 好感值 → 文字（也用于注入时的「模糊」判断） */
function visibleAffinity(a) {
  return Math.abs(a) >= AFF_MIN_VISIBLE;
}

export function apply(ctx, config) {
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
  /**
   * 只有**真的批过一次调参**才用这个 half。
   *
   * `moodCurveDefaults.half` 是老单值曲线的默认值（18 小时），
   * 每个装过的部署都有——如果无条件读它，等于把多维情绪的默认半衰期
   * 从文档写的 36 小时偷偷改成 18 小时，而且没人批过（codex review P2）。
   * 所以认 `tunedAt` 这个戳：tuning.mjs 批准时才写。
   */
  const tunedAt = Number(state?.moodCurveDefaults?.tunedAt);
  const tunedHalf = Number(state?.moodCurveDefaults?.half);
  const defaultAlpha = Number.isFinite(tunedAt) && tunedAt > 0 && Number.isFinite(tunedHalf) && tunedHalf > 0
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

  /** 旧单值曲线的默认值只为历史数据与调参申请保留；M3 起不再写 moodEvents。 */
  state.moodCurveDefaults ??= { w0: 1.0, half: 18, shape: 1.3 };
  /** 每日重置：情绪回到基线附近，好感轻微向 0 回归（不遗忘） */
  function rollDay() {
    const now = new Date();
    const key = dayKey(now);
    if (state.day === key) return;
    state.day = key;
    // 过了一天=睡了一觉，恢复到现在时段的正常水平（不再固定 62）
    state.energy = clamp(slotOf(new Date().getHours()).energy, 40, 100);
    // M3：心情不存值，也不再由已退休的单值事件曲线现算。
    // 2026-11-08：日结采样删了。
    //   v3 的 items 每条都带时间戳，任何时刻的值都能重算，
    //   不需要每天往 lexicon 里写一条「日结转存（当时 0.001）」这种账。
    //   （那些账在迁移时已经全进 archive 了）
    saveJson(file, state);
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
      contexts: [...(base.contexts ?? []), { name: 'koi:mood', text: parts.join('\n') }],
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
      '申请改情绪衰减的默认速度。field 只能是 half（多少小时衰减一半）——' +
      '2026-11-24 起心情只按多维情绪算，w0/shape 已经不对应任何活的东西，别申请那两个。' +
      '提交后不立刻生效，等运维方看过。想改得给理由。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        field: { type: 'string', enum: ['half'] },
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
      // 只认 half：另外两个字段 2026-11-24 起不对应任何活的东西（见 M3），
      // 放进来只会变成"批了没效果"的假按钮
      if (field !== 'half') return 'field 只能是 half（多少小时衰减一半）；w0 / shape 已经不调了。';
      if (!Number.isFinite(value) || value <= 0) return 'value 要是正数。';
      if (why === '') return '得说清楚为什么。';
      /**
       * `from` 要报**实际生效的那个值**：没批过调参时生效的是内置 36 小时，
       * 不是 affect.json 里遗留的 18（codex review P2）。
       */
      const effectiveHalf = Number.isFinite(tunedAt) && tunedAt > 0 && Number.isFinite(tunedHalf)
        ? tunedHalf
        : Number((36).toFixed(0));
      const req = { at: Date.now(), kind: 'mood', field, value, why, from: effectiveHalf, signal: 'curve', by: 'koi' };
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

  console.log('[koi-affect] 注入段：koi:mood（contexts）——心情/精力/刚才是谁，仅本插件负责');

  const lexPeople = readLexiconPeople();
  const nPeople = Object.keys(lexPeople).length;
  console.log(
    `[koi-affect] v4 ready → ${file} (energy=${Math.round(state.energy)}, `
      + `多维情绪 ${moodDims.current().length} 项, 好感/喜恶归 lexicon：${nPeople} 人)`,
  );
}
