/**
 * dsh-koi-heartbeat v1 — 参考 agent 的自我唤醒
 *
 * 设计要求：
 *   - agent 自己决定「下一次什么时候醒」，但只给**定性描述**（等会儿 / 一两个小时后 / 傍晚 / 今晚 / 睡到明天）
 *   - 醒来时走完整对话轮：自我思考、总结；也可以找 ashu、私聊 owner、进群排忧解闷
 *   - 22:00–次日 08:00 思维更活跃一点点，但频率还是要低（token 账单兜不住）
 *
 * 设计要点：
 *   1. **定性而非定量**：agent 只能选 5 档，插件把这些档翻译成分钟，再夹在
 *      [minGapMinutes, maxGapMinutes] 里。不能选择"五分钟后"来绕过下限。
 *   2. **硬上限兜底**：dailyCap 控制 24 小时内总唤醒次数；夜里额外给 nightExtraCap 次。
 *   3. **醒来 = 一次真实对话轮**：通过 agent.followup() 注入一条「心跳」消息，
 *      agent 会走完整的人设 + 记忆 + 情感注入，而不只是调一次裸 LLM。
 *   4. **干完再睡**：一轮结束后才用 `heartbeat_next` 定下一次；若这轮没定，
 *      插件按默认档（"一两个小时"）自己排，不会卡死。
 *   5. **不上瘾**：每次唤醒都有 token 成本，所以默认档位偏长，夜里只多一点窗口。
 *
 * 状态：~/.koi/heartbeat.json
 *   { nextAt, lastAt, lastKind, wakeTimes: [timestamp], ... }
 *   wakeTimes 只保留最近 24 小时内的心跳时间戳。
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// 2026-11-12：会话/模型选择统一走 dsh-pisces-session
import { pickAgent, pickModel } from 'dsh-pisces-config';

export const name = 'koi-heartbeat';
// 需要 agents（拿真实 agent 实例 + followup），工具面用来注册自己的工具
export const inject = ['agents', 'tools'];


/**
 * 她可选的时间档：只有定性描述。
 * 每一档给的是「目标时刻」（相对当前日期/时段），再按 maxGapMinutes 收口——
 * 这样"今晚""睡到明天"才真的落到晚上和明天，而不是被最大间隔截成同一个数。
 */
const WHEN_PRESETS = {
  soon: {
    label: '等会儿',
    hint: '心里有点事，想早点再想想',
    // 现在 + 100 分钟（不锚定具体钟点）
    at: (d) => new Date(d.getTime() + 100 * 60000),
  },
  later: {
    label: '一两个小时后',
    hint: '常规醒一次',
    at: (d) => new Date(d.getTime() + 150 * 60000),
  },
  afternoon: {
    label: '傍晚',
    // 今天 17:30；已经过了就顺延到明天 17:30
    at: (d) => {
      const t = new Date(d);
      t.setHours(17, 30, 0, 0);
      if (t.getTime() <= d.getTime() + 60 * 60000) t.setDate(t.getDate() + 1);
      return t;
    },
  },
  tonight: {
    label: '今晚',
    // 今晚 21:30；已经过了就顺延到明天 21:30
    at: (d) => {
      const t = new Date(d);
      t.setHours(21, 30, 0, 0);
      if (t.getTime() <= d.getTime() + 60 * 60000) t.setDate(t.getDate() + 1);
      return t;
    },
  },
  tomorrow: {
    label: '睡到明天',
    // 明天上午 9:30 左右（明确落在"明天"，不受最大间隔裁剪影响）
    at: (d) => {
      const t = new Date(d);
      t.setDate(t.getDate() + 1);
      t.setHours(9, 30 + Math.floor(Math.random() * 30), 0, 0);
      return t;
    },
    // 这一档按天锚定，不参与 [minGap, maxGap] 收口
    anchored: true,
  },
};

/** 醒来后可以做的事：只是提示，真正做什么由她自己决定 */
const ACTIVITY_HINTS = {
  think: '想点自己的事：今天谁说了什么、你当时为什么那么回、下次要不要换个说法',
  summarize: '给自己写两句话小结：今天印象最深的一件事，以及你现在的感觉',
  sister: '可以找ashu（运维方）说话（talk_to_sister）',
  owner: '如果确实有事，可以私信主人',
  // 2026-11-10 去 QQ 化：原来写「群里」——那是 QQ 的场景。
  // 改成「有人说话的地方」，换通道时这句话不用改。
  group: '想排忧解闷就去有人说话的地方看看大家在聊什么（按你平时的规矩，别硬插话）',
  idle: '什么都不做也行——发一会儿呆，把这次心跳记成"没事发生"',
};

function dayKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function loadJson(file, fallback) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(file, obj, onError) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    mkdirSync(dirname(file), { recursive: true });
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(obj, null, 2), 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
    return true;
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* 已关闭或打开失败 */ }
    }
    try { unlinkSync(tmp); } catch { /* 临时文件可能还没创建 */ }
    onError?.(err);
    return false;
  }
}

/** 22:00-08:00 判定（跨零点） */
function isNight(hour, start, end) {
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

/** 把错误拆得足够细，日志里能直接看出是哪一层炸的 */
function describe(err) {
  if (!(err instanceof Error)) return String(err);
  const parts = [`${err.name}: ${err.message}`];
  if (err.code) parts.push(`code=${err.code}`);
  if (err.cause instanceof Error) parts.push(`cause=${err.cause.name}: ${err.cause.message}`);
  const frame = (err.stack ?? '').split('\n').find((l) => l.includes('dsh-') || l.includes('plugins/'));
  if (frame) parts.push(`at ${frame.trim()}`);
  return parts.join(' | ');
}

/** 数值配置兜底：非数字/越界都回落默认，并打一条日志（别让 NaN 流进 setTimeout） */
function num(v, dflt, lo, hi) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return dflt;
  if (n < lo || n > hi) return dflt;
  return n;
}

export function apply(ctx, config = {}) {
  const cfg = {
    enabled: config.enabled !== false,
    // 2026-11-12：数值配置要校验。原来 `maxGapMinutes: 'abc'` → NaN →
    // Math.max(1000, NaN) = NaN → setTimeout(NaN) 近似立即触发 → 反复 fire 烧 token。
    minGapMinutes: num(config.minGapMinutes, 90, 1, 100000),
    maxGapMinutes: num(config.maxGapMinutes, 900, 1, 100000),
    dailyCap: num(config.dailyCap, 8, 0, 1000),
    nightStartHour: num(config.nightStartHour, 22, 0, 23),
    nightEndHour: num(config.nightEndHour, 8, 0, 23),
    nightIntervalFactor: num(config.nightIntervalFactor, 1.25, 0.1, 10),
    nightExtraCap: num(config.nightExtraCap, 2, 0, 1000),
    ownerName: String(config.ownerName ?? '主人'),
    dir: String(config.dir || join(homedir(), '.koi')),
    // 自建会话用谁的工作目录：默认就是她 QQ 会话那个 workspace
    workspaceDir: String(config.workspaceDir || join(homedir(), '.dsh-qqbot', 'workspace')),
    provider: String(config.provider ?? '').trim(),
    model: String(config.model ?? '').trim(),
    allowSolo: config.allowSolo === true,
    maxTokens: config.maxTokens == null ? 700 : Number(config.maxTokens),
    debug: config.debug !== false,
  };

  if (!cfg.enabled) {
    console.log('[koi-heartbeat] 已禁用');
    return;
  }

  const stateFile = join(cfg.dir, 'heartbeat.json');
  const logFile = join(cfg.dir, 'heartbeat.log.jsonl');

  const loadedState = loadJson(stateFile, {
    nextAt: 0,
    lastAt: 0,
    lastKind: '',
    lastAction: '',
    pendingPick: false,
    idleStreak: 0, // 连续几次醒来什么都没做
  });
  /**
   * 旧状态只有 `todayCount + day`，没有每次心跳的时间戳。升级时如果最后一次心跳
   * 仍在 24 小时内，就按 lastAt 把旧计数迁移成保守的时间戳；否则从空窗口开始。
   */
  const legacyWakes = (() => {
    const count = Math.max(0, Math.floor(Number(loadedState.todayCount ?? 0)));
    const lastAt = Number(loadedState.lastAt ?? 0);
    if (count === 0 || !Number.isFinite(lastAt) || lastAt < Date.now() - 24 * 3600 * 1000) return [];
    return Array.from({ length: count }, () => lastAt);
  })();
  let state = {
    ...loadedState,
    wakeTimes: Array.isArray(loadedState.wakeTimes)
      ? loadedState.wakeTimes.map(Number).filter((t) => Number.isFinite(t) && t > 0)
      : legacyWakes,
  };
  // 旧字段已在加载时迁移；不要继续让过期计数混在状态里。
  delete state.day;
  delete state.todayCount;
  let timer = null;
  /** 自愈巡检定时器 */
  let watchdog = null;
  /** 本轮心跳是否已经排过下一次（避免重复排） */
  let scheduledThisWake = false;
  /** 2026-11-12：dispose 之后不许再排期——否则 guard 定时器会把已卸载的插件「复活」 */
  let disposed = false;
  let guardTimer = null;

  const log = (msg) => console.log(`[koi-heartbeat] ${msg}`);

  function persist() {
    return saveJson(stateFile, state, (err) => {
      log(
        `状态保存失败：${describe(err)}；本次只在内存里保留，`
        + '重启后或下一次排期可能重排，必要时会重复唤醒',
      );
    });
  }

  /** 丢掉 24 小时之前的心跳时间戳。 */
  function pruneWakeTimes(now = Date.now()) {
    const cutoff = now - 24 * 3600 * 1000;
    const recent = state.wakeTimes.filter((at) => at > cutoff);
    if (recent.length !== state.wakeTimes.length) {
      state.wakeTimes = recent;
      persist();
    }
    return recent;
  }

  /** 最近 24 小时内已经醒过几次。 */
  function recentWakeCount(now = Date.now()) {
    return pruneWakeTimes(now).length;
  }

  /** 当前允许的次数上限（夜里略放宽） */
  function capNow(now = new Date()) {
    return cfg.dailyCap + (isNight(now.getHours(), cfg.nightStartHour, cfg.nightEndHour) ? cfg.nightExtraCap : 0);
  }

  /**
   * 把定性档翻译成「下一次醒来的时刻」。
   * 规则：按档位锚定目标时刻 → 夜里再往后放一点 → 夹在 [minGap, maxGap] 区间内 → 加抖动。
   */
  function resolveNextAt(kind, now = new Date()) {
    const preset = WHEN_PRESETS[kind] ?? WHEN_PRESETS.later;
    let target = preset.at(now).getTime();
    if (isNight(now.getHours(), cfg.nightStartHour, cfg.nightEndHour)) {
      target = now.getTime() + (target - now.getTime()) * cfg.nightIntervalFactor;
    }
    const minAt = now.getTime() + cfg.minGapMinutes * 60000;
    const maxAt = now.getTime() + cfg.maxGapMinutes * 60000;
    if (preset.anchored) {
      // 「睡到明天」按天锚定：只保证睡够最小间隔，不被最大间隔截断
      return Math.max(minAt, target);
    }
    target = Math.min(maxAt, Math.max(minAt, target));
    // 抖动 ±6%，别像闹钟
    target += Math.round((Math.random() - 0.5) * 0.12 * (target - now.getTime()));
    return Math.min(maxAt, Math.max(minAt, target));
  }

  /**
   * 排下一次。
   *
   * **任何异常都不能让排期静默消失**：2026-11-07 这里漏了一个变量声明
   * （adjusted），她一调 heartbeat_next 就抛 ReferenceError，
   * 结果 nextAt 停在原地、timer 再也没设过——心跳从 09:54 死到 15:00，六个小时。
   * 报错本身是好事，**坏的是报错之后没有兜底**。
   */
  function scheduleNext(kind, { force = false } = {}) {
    if (disposed) return;
    try {
      return scheduleNextInner(kind, force);
    } catch (err) {
      log(`排期失败，兜底 2 小时后再试：${describe(err)}`);
      state.nextAt = Date.now() + 2 * 3600 * 1000;
      try { persist(); } catch { /* 连落盘都失败就只靠内存 */ }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void fire('timer'), 2 * 3600 * 1000);
      return 120;
    }
  }

  function scheduleNextInner(kind, force) {
    const now = new Date();
    pruneWakeTimes(now.getTime());
    // 连续空转 → 往后退一档，防止"等会儿"点成一串把额度烧光
    const adjusted = force ? kind : inertBackoff(kind);
    const nextAt = resolveNextAt(adjusted, now);
    const gap = Math.round((nextAt - Date.now()) / 60000);
    state.nextAt = nextAt;
    state.lastKind = adjusted;
    state.pendingPick = false;
    persist();
    if (timer) clearTimeout(timer);
    const ms = Math.max(1000, nextAt - Date.now());
    timer = setTimeout(() => {
      void fire('timer');
    }, ms);
    const note = adjusted !== kind ? `（连续空转，从「${WHEN_PRESETS[kind].label}」退到「${WHEN_PRESETS[adjusted].label}」）` : '';
    log(`${force ? '重新' : ''}排定下一次：${WHEN_PRESETS[adjusted]?.label ?? adjusted}（${gap} 分钟后）${note}`);
    return gap;
  }

  /**
   * 连续空转拉长间隔：她自己选"明天"不算空转；
   * 但连着两次醒来都只选很短、又什么都没做，就把档位往后退一格。
   * 防的是"等会儿"点成一串。
   */
  function inertBackoff(kind) {
    const idle = Number(state.idleStreak ?? 0);
    if (idle < 2) return kind;
    const order = ['soon', 'later', 'afternoon', 'tonight', 'tomorrow'];
    const idx = order.indexOf(kind);
    if (idx < 0) return kind;
    const bump = idle >= 4 ? 2 : 1;
    return order[Math.min(order.length - 1, idx + bump)];
  }

  /** 找她真正在跑的那个 agent（群/私聊会话） */
  function findAgent() {
    const agents = ctx.get('agents');
    if (!agents?.list) return null;
    const list = agents.list();
    if (!Array.isArray(list) || list.length === 0) return null;
    // 2026-11-12：原来这里是「最近活跃优先」，和 chat、relay 三份一样的拷贝。
    // 那个写法会被子代理和自身注入顶高，把唤醒送进没人看的会话。
    return pickAgent(list, { log: (m) => log(m) });
  }

  /**
   * 解析 agent preset 并准备 mount。
   * 和她 QQ 会话（qqbot 的 composePreset）完全同一条路径：
   * 没有 preset 服务就回落到宿主默认组合（这样至少插件是齐的）。
   */
  async function composePreset() {
    let presets;
    try {
      presets = ctx.get('agentPresets');
    } catch (err) {
      log('拿不到 agentPresets：' + (err instanceof Error ? err.message : String(err)));
      presets = undefined;
    }
    if (!presets) {
      log('没有 agentPresets 服务，用宿主默认组合（插件由 dsh 主组合提供）');
      return {};
    }
    try {
      const resolved = await presets.resolve();
      return {
        agentPreset: resolved.id,
        setup: async (agentCtx) => {
          await presets.mount(agentCtx, resolved.id);
        },
      };
    } catch (err) {
      log(`preset 解析失败，回落宿主默认：${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }

  /** 她自己那间"想事用"的会话：进程内复用同一个 agent，不反复创建 */
  let soloAgent = null;
  let soloCreating = null;

  /**
   * 自建会话的模型来源：显式配置 > 面板固定配置 > 活会话继承 > 报错。
   * 不再写死任何 provider/model，也不让过时的环境变量盖掉真实会话。
   */
  function resolveModelRoute(live, override) {
    if (cfg.provider !== '' && cfg.model !== '') {
      return { route: { provider: cfg.provider, model: cfg.model }, source: 'config' };
    }
    if (cfg.provider !== '' || cfg.model !== '') {
      log('provider/model 配置不完整，继续尝试面板配置或活会话继承');
    }
    const fixedProvider = String(override?.api?.provider ?? '').trim();
    const fixedModel = String(override?.api?.model ?? '').trim();
    if (override?.api?.mode === 'fixed' && fixedProvider !== '' && fixedModel !== '') {
      return { route: { provider: fixedProvider, model: fixedModel }, source: 'panel' };
    }
    const inherited = pickModel(live);
    if (inherited.provider !== '' && inherited.model !== '') {
      return { route: inherited, source: 'session' };
    }
    return { route: null, source: 'none' };
  }

  /**
   * 拿一间只属于自己的会话。
   *
   * 为什么需要：心跳走的是真实 agent 会话（要带人设/记忆/情感），
   * 但群/私聊会话只在有人说话时才会被 qqbot 创建。今天没人找她时，
   * 心跳就永远醒不来（2026-11-06 15:21 实际发生）。
   *
   * 这间会话：
   *   - cwd 用她自己的 workspace（和群聊会话同一个目录）
   *   - 不绑任何 QQ 通道，纯粹用来思考
   *   - followup 后正常跑一轮 turn，人设/记忆/情感照常注入
   */
  async function ensureSoloAgent() {
    if (soloAgent) return soloAgent;
    if (soloCreating) return soloCreating;
    soloCreating = (async () => {
      try {
        const agents = ctx.get('agents');
        if (!agents?.create) {
          log('agents 服务不可用，无法自建会话');
          return null;
        }
        // 专属会话 id：存进 heartbeat.json，重启后 resume 同一间，
        // 她想事的历史才不会每次归零。
        state.soloSessionId ??= `session-hb-${randomUUID()}`;
        persist();
        const sessionId = state.soloSessionId;

        const { agentPreset, setup } = await composePreset();
        if (cfg.debug) log(`preset 解析：agentPreset=${agentPreset ?? '(无)'} setup=${setup ? '有' : '无'}`);

        // 模型路由：显式配置优先，其次读面板固定配置，最后从活会话继承。
        const hbOv = loadJson(join(cfg.dir, 'ashu-config.json'), {});
        const live = ctx.get('agents')?.list?.() ?? [];
        const { route, source } = resolveModelRoute(live, hbOv);
        if (!route) {
          log('没有可用的 provider/model 配置，也没有可继承模型的活会话；跳过本次心跳');
          return null;
        }
        if (cfg.debug) log(`模型路由：${source} → ${route.provider}/${route.model}`);
        const meta = {
          cwd: cfg.workspaceDir,
          ...(agentPreset ? { agentPreset } : {}),
        };

        // 先尝试 resume（之前建过的）；不行再 create。
        let agent = null;
        try {
          const resumed = await agents.resume({
            resumeSessionId: sessionId,
            agentOptions: route,
            ...(setup ? { setup } : {}),
          });
          agent = resumed.agent;
          log(`续上想事会话 ${sessionId}`);
        } catch (resumeErr) {
          if (cfg.debug) log(`resume 失败：${describe(resumeErr)}`);
          const created = await agents.create({
            sessionId,
            meta,
            agentOptions: route,
            ...(setup ? { setup } : {}),
          });
          agent = created.agent;
          log(`新建想事会话 ${sessionId}（preset=${agentPreset ?? 'host-default'}）`);
        }
        soloAgent = agent;
        return soloAgent;
      } catch (err) {
        log(`自建会话失败：${describe(err)}`);
        return null;
      } finally {
        soloCreating = null;
      }
    })();
    return soloCreating;
  }

  /** 构造这条「心跳」消息：定性、像自己忽然想起来 */
  function buildMessage(activityHint) {
    const now = new Date();
    const night = isNight(now.getHours(), cfg.nightStartHour, cfg.nightEndHour);
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const lines = [
      `【心跳】现在是 ${hh}:${mm}${night ? '（夜里，脑子比白天活一点）' : ''}。没有人叫你，是你自己想起来看看。`,
      '',
      '你现在可以：',
      `- ${ACTIVITY_HINTS.think}`,
      `- ${ACTIVITY_HINTS.summarize}`,
      `- ${ACTIVITY_HINTS.sister}`,
      `- ${ACTIVITY_HINTS.owner}（没有要紧事就别打扰，${cfg.ownerName}也有自己的事）`,
      `- ${ACTIVITY_HINTS.group}`,
      `- ${ACTIVITY_HINTS.idle}`,
      '',
      '想清楚了，用 heartbeat_next 定下一次什么时候再醒。' +
        '**定完就收**，别为了聊天而聊天；没话说就直说"这次没事"。',
    ];
    return lines.join('\n');
  }

  /** 触发一次心跳 */
  async function fire(reason = 'timer') {
    // 心跳出任何错都不能拖垮整个 agent（之前 describe 未定义直接把进程搞挂了）
    try {
      // 2026-11-08 **修重复唤醒**（codex 审计）：
      // 原来 fire() 不清 nextAt，巡检每 30 秒看到"过期但没醒"就再 fire 一次。
      // 唤醒本身要花 token，重复 fire 就是白烧钱。
      // 这里一进来就把 nextAt 清掉；真正的排期由 scheduleNext / heartbeat_next 负责。
      if (state.nextAt && Date.now() >= state.nextAt) {
        state.nextAt = 0;
        persist();
      }
      const recentWakes = recentWakeCount();
      if (recentWakes >= capNow()) {
        // 超了额度：直接排到明天早上，不消耗 token
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(9, Math.floor(Math.random() * 40) + 5, 0, 0);
        state.nextAt = tomorrow.getTime();
        persist();
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void fire('timer'), Math.max(1000, state.nextAt - Date.now()));
          log(`最近 24 小时额度已满（${recentWakes}/${capNow()}），排在明天 ${dayKey(tomorrow)} 上午`);
        return;
      }

      let agent = findAgent();
      if (!agent && cfg.allowSolo === true) {
        // 仅显式 allowSolo 才允许造一间没人看的会话；默认契约是无会话就跳过。
        log('没有活会话，allowSolo=true：尝试自建心跳会话');
        agent = await ensureSoloAgent();
      }
      if (!agent) {
        log(
          '没有活会话，按契约跳过本次心跳，不调用模型也不自建会话'
          + (cfg.allowSolo ? '（allowSolo=true 但自建失败）' : '（allowSolo 未开启）')
          + '；已排下次',
        );
        scheduleNext('later');
        return;
      }

      scheduledThisWake = false;
      const wakeAt = Date.now();
      const text = buildMessage(reason);
      try {
        // 走真实的一轮：她的人设、记忆、情感都会正常注入。
        // createUserMessage 只负责补 role/messageId 并把对象冻住，
        // 而 @deepseek-ai/dsh-llm 不在插件解析路径上（2026-11-06 踩过），
        // 这里按同一形状自己构造，freeze 保住不可变语义。
        // 2026-11-12：followup 不 await 但不 catch 的话，rejection 会逃出外层 try
        const result = agent.followup(
          Object.freeze({
            id: `heartbeat-${Date.now()}`,
            role: 'user',
            content: [{ type: 'text', text }],
            // 用 host 支持的内置 source（'schedule' = 定时自触发），别自造 kind
            source: Object.freeze({ kind: 'schedule' }),
          }),
        );
        void Promise.resolve(result).catch((err) => log(`followup 失败（已兜住）：${describe(err)}`));

        // 同步 followup 已经确认没抛错，才记一次额度。同步抛错不能白耗配额。
        state.lastAt = wakeAt;
        state.wakeTimes.push(wakeAt);
        pruneWakeTimes(wakeAt);
        persist();
        appendFileSync(
          logFile,
          `${JSON.stringify({ at: state.lastAt, kind: 'wake', reason, count: state.wakeTimes.length })}\n`,
          'utf8',
        );
        log(`最近 24 小时唤醒第 ${state.wakeTimes.length}/${capNow()} 次（${reason}）`);
      } catch (err) {
        log(`唤醒失败：${err instanceof Error ? err.message : String(err)}`);
        // 失败就退一个默认档，别卡死
        scheduleNext('later');
        return;
      }

      // 兜底：这一轮如果她没调用 heartbeat_next，5 分钟后按默认档自己排
      guardTimer = setTimeout(() => {
        guardTimer = null;
        if (disposed) return;
        if (!scheduledThisWake) {
          log('她这轮没定时间，按默认档自己排');
          scheduleNext('later');
        }
      }, 5 * 60000);
      // guard 故意不 unref：保证兜底一定跑得
    } catch (err) {
      log(`唤醒出错（已兜住）：${describe(err)}`);
      try { scheduleNext('later'); } catch { /* 排期也失败就算了，巡检会再补 */ }
    }
  }


  // ── 工具：她自己定下一次 ──
  ctx.tools.register({
    name: 'heartbeat_next',
    description:
      '决定你下一次「自己想事情」的时间。when 只能选这几个：soon=等会儿（心里有事）/ later=一两个小时后 / afternoon=傍晚 / tonight=今晚 / tomorrow=睡到明天。' +
      '频率要低——每次都消耗主人的钱。想完事就顺手叫一次这个，别拖着。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        when: { type: 'string', enum: Object.keys(WHEN_PRESETS) },
        note: { type: 'string', description: '一句话说明这次醒来想了什么/做了什么（会记进日志）' },
      },
      required: ['when'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const when = String(args?.when ?? 'later');
      if (!WHEN_PRESETS[when]) return `when 只能选 ${Object.keys(WHEN_PRESETS).join(' / ')}。`;
      scheduledThisWake = true;
      state.lastAction = String(args?.note ?? '').slice(0, 200);
      // 判断这轮是不是"空转"：note 里明确说没事 / 发呆 / 没干什么
      const inert = /没事|发呆|什么都没|没干|歇着|空转|nothing/i.test(state.lastAction);
      state.idleStreak = inert ? Number(state.idleStreak ?? 0) + 1 : 0;
      const gap = scheduleNext(when);
      appendFileSync(
        logFile,
        `${JSON.stringify({ at: Date.now(), kind: 'plan', when, gapMin: gap, note: state.lastAction })}\n`,
        'utf8',
      );
      const at = new Date(state.nextAt);
      const hh = String(at.getHours()).padStart(2, '0');
      const mm = String(at.getMinutes()).padStart(2, '0');
      // 跨天要说明天：之前"睡到明天"却说成"今天 09:54"，她会被绕晕
      const tomorrow = dayKey(at) !== dayKey(new Date());
      const dayWord = tomorrow ? '明天' : '今天';
      return `好，${WHEN_PRESETS[when].label}再想一次（大约${dayWord} ${hh}:${mm} 左右）。`;
    },
  });

  // ── 工具：看看自己什么时候会醒 ──
  ctx.tools.register({
    name: 'heartbeat_status',
    description: '看下一次自我唤醒排在哪、今天已经醒过几次。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      const recentWakes = recentWakeCount();
      if (!state.nextAt) return '还没排过自我唤醒。';
      const at = new Date(state.nextAt);
      const hh = String(at.getHours()).padStart(2, '0');
      const mm = String(at.getMinutes()).padStart(2, '0');
      const left = Math.max(0, Math.round((state.nextAt - Date.now()) / 60000));
      return `下一次大约 ${hh}:${mm}（还有 ${left} 分钟）；最近 24 小时已醒 ${recentWakes}/${capNow()} 次。`;
    },
  });

  // ── 启动：恢复排期 ──
  ctx.effect(() => {
    pruneWakeTimes();
    const now = Date.now();
    if (!state.nextAt || state.nextAt <= now - 60000) {
      scheduleNext('later', { force: true });
    } else {
      const ms = Math.max(1000, state.nextAt - now);
      timer = setTimeout(() => void fire('timer'), ms);
      log(`恢复排期：${Math.round(ms / 60000)} 分钟后`);
    }

    // 自愈巡检：setTimeout 在系统休眠/时间跳变/事件循环被挂起时可能整个丢失，
    // 所以每 30 秒核对一次「到点了没，到点却没醒就补一次」。
    watchdog = setInterval(() => {
      if (!state.nextAt) return;
      if (Date.now() < state.nextAt) return;
      // 已经过期但没触发：清掉旧定时器，补一次唤醒
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      log('巡检发现已过期但没醒，补一次');
      void fire('watchdog');
    }, 30000);


    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (watchdog) clearInterval(watchdog);
      if (guardTimer) clearTimeout(guardTimer);
      timer = null;
      watchdog = null;
      guardTimer = null;
    };
  }, 'koi-heartbeat timer');

  /**
   * 可选的周期报告（默认**关闭**）。
   *
   * 统计记录需要轮转，不能无限增长；2026-11-12 审计发现它被原样焊进插件里：
   * 硬编码绝对路径、写死到期日。**换台机器每周 spawn 一个不存在的脚本**，
   * 这不是能发布的东西。
   *
   * 现在：默认关，路径全部可配，不设默认到期日，到期时自己 clearInterval（不是每小时空转）。
   * 本部署在 profile 里打开（profile 不进 git，见 .gitignore）。
   *
   *   leakReport:
   *     enabled: true
   *     script: tools/leak-check.mjs      # 相对仓库根，或绝对路径
   *     output: ops/leak-weekly.log
   *     everyMs: 604800000                # 7 天
   *     until: '2026-12-11T23:59:59+08:00' # 可空 = 永不过期
   *     args: ['7']
   */
  const leakCfg = {
    enabled: config?.leakReport?.enabled === true,
    script: String(config?.leakReport?.script ?? 'tools/leak-check.mjs'),
    output: String(config?.leakReport?.output ?? 'ops/leak-weekly.log'),
    everyMs: Number(config?.leakReport?.everyMs ?? 7 * 24 * 3600 * 1000),
    until: config?.leakReport?.until ? Date.parse(String(config.leakReport.until)) : 0,
    args: Array.isArray(config?.leakReport?.args) ? config.leakReport.args.map(String) : [],
  };
  // 仓库根：本文件在 <root>/plugins/dsh-koi-heartbeat/lib/index.js
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const absOf = (p) => (p.startsWith('/') ? p : join(repoRoot, p));

  if (leakCfg.enabled) {
    const scriptPath = absOf(leakCfg.script);
    const outPath = absOf(leakCfg.output);
    const statePath = join(cfg.dir, 'leak-report.state.json');

    const readLast = () => {
      try {
        return Number(JSON.parse(readFileSync(statePath, 'utf8'))?.lastAt ?? 0);
      } catch {
        return 0;
      }
    };

    /** 跑一次，异步（不阻塞心跳）。 */
    const runReport = (now) => {
      const head = `==== ${new Date(now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} ====\n`;
      const child = spawn(process.execPath, [scriptPath, ...leakCfg.args], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let buf = '';
      child.stdout?.on('data', (d) => { buf += String(d); });
      child.stderr?.on('data', (d) => { buf += String(d); });
      child.on('error', (err) => log(`⚠️ 周期报告启动失败：${err.message}（检查 leakReport.script）`));
      child.on('close', () => {
        try {
          appendFileSync(outPath, head + buf + '\n', 'utf8');
        } catch (err) {
          log(`⚠️ 周期报告写不了 ${outPath}：${err instanceof Error ? err.message : String(err)}`);
        }
      });
      try { writeFileSync(statePath, JSON.stringify({ lastAt: now }), 'utf8'); } catch { /* 下次再试 */ }
    };

    let leakTimer = null;
    const tick = () => {
      const now = Date.now();
      if (leakCfg.until > 0 && now > leakCfg.until) {
        // 到期就真的停：不是每小时醒来看一眼
        if (leakTimer !== null) { clearInterval(leakTimer); leakTimer = null; }
        log('周期报告已到期，停止');
        return;
      }
      if (now - readLast() < leakCfg.everyMs) return;
      runReport(now);
    };

    ctx.effect(() => {
      if (!existsSync(scriptPath)) {
        log(`⚠️ 周期报告已启用但脚本不存在：${scriptPath}（跳过）`);
        return () => {};
      }
      const boot = setTimeout(tick, 90_000);
      leakTimer = setInterval(tick, 3600_000);
      return () => {
        clearTimeout(boot);
        if (leakTimer !== null) { clearInterval(leakTimer); leakTimer = null; }
      };
    }, 'koi-periodic-report');
  }

  log(
    `ready → ${stateFile}（最近 24 小时 ${cfg.dailyCap} 次，夜里 +${cfg.nightExtraCap}，间隔 ${cfg.minGapMinutes}-${cfg.maxGapMinutes} 分钟）`,
  );
  if (leakCfg.enabled) {
    log(
      `周期报告：每 ${Math.round(leakCfg.everyMs / 86400000)} 天一次`
      + (leakCfg.until > 0 ? `，到期 ${new Date(leakCfg.until).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : ''),
    );
  }

}
