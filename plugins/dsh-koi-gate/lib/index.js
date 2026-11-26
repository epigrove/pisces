/**
 * dsh-koi-gate —— 出入口的判定层（2026-11-24 三包合并）
 *
 * 合并前是三个包：`dsh-koi-rules`（纯规则）+ `dsh-koi-says`（出口 host 层）
 * + `dsh-koi-selftalk`（入口门控）。合并原因是三类故障反复出现在同一接缝：
 *
 *   写了没接上、存了没送到、有接口没通知调用方。
 *
 * 三个包各自都对，但它们描述的是**同一件事**——"什么能进、什么能出"。
 * 拆成三个包以后，「出口」这条链被切成三段，每一段都要单独接一次，
 * 每接一次就多一次"以为接了其实没接"的机会（`says.apply` 就是死在没进 bundles）。
 *
 * 现在的分工是**目录**而不是包：
 *   lib/rules/*.mjs   —— 纯规则，零 IO，可单测（原 dsh-koi-rules）
 *   lib/says.js       —— 出口 host 层：白名单、状态行去重、退场守卫（原 dsh-koi-says）
 *   lib/selftalk-*.js —— 入口门控：这条消息该不该叫醒她（原 dsh-koi-selftalk）
 *   lib/index.js      —— 插件半边：注入出口自查段 + 打印加载状态
 *
 * 通道侧调用不变（只是包名换了）：
 *   import { createGate, allow } from 'dsh-koi-gate';
 */
import { SILENCE_TOKEN } from './silence.mjs';
import { allow as allowImpl } from './says.js';
import { installSelftalk } from './selftalk-gate.mjs';

// ── 纯规则（原 dsh-koi-rules 的公共面） ─────────────────
export { isPureAside } from './aside.mjs';
export { SILENCE_TOKEN, isSilenceToken } from './silence.mjs';
export { shouldDropLeak, looksInternal, filterOutbound, setWhitelistLoader, WL_TTL } from './leak.mjs';
export { guardExit, EXIT_RE } from './exit.mjs';
export { markImage, markNamed, turnFlagsFor, clearTurnFlags } from './turn-state.mjs';

// ── 出口 host 层（原 dsh-koi-says） ────────────────────
export { allow, allowOnce } from './says.js';

// ── 入口门控（原 dsh-koi-selftalk） ────────────────────
export { installSelftalk };

export const name = 'koi-gate';
export const inject = [];

/**
 * 真正发送结果的模块级订阅口。
 *
 * **这是插件里唯一知道平台是否真的发送成功的地方**：`assistant/message`
 * 只证明模型生成了文本，`installSendLog` 包住的平台 send 才拿到成功/失败回执。
 * 审计插件应消费这里（`onSendResult`），不要拿模型消息冒充外发事实。
 *
 * 宿主事件总线没有稳定的跨插件 send-result 事件，所以保持为同进程最小回调接口。
 * 返回注销函数；回调抛错不会影响发送。
 */
const sendResultListeners = new Set();

export function onSendResult(callback) {
  if (typeof callback !== 'function') return () => {};
  sendResultListeners.add(callback);
  return () => sendResultListeners.delete(callback);
}

function publishSendResult(result) {
  for (const callback of sendResultListeners) {
    try {
      callback(result);
    } catch {
      /* 观察者失败不能影响平台发送 */
    }
  }
}

/**
 * 造出通道中间件。签名与原来的 `createGate` 完全一致，
 * 通道侧那一行调用长期不用改：
 *   bot.use(createGate(bot, ctx, config));
 */
/**
 * 出站投递结果日志（B3，2026-11-24）
 *
 * 为什么需要：qqbot 只在**失败**时 `logger.error`，成功不留痕。
 * 曾有一条群消息未落地（平台静默拦截），排查时只能靠前后消息对照猜，
 * 当时没有可靠的「发出去了没有」回执。
 *
 * 为什么包 sendMarkdown 而不是打 pnpm patch：判定归插件，通道只留一行调用（`createGate` 已经拿到 bot）。
 * 包一层不影响原逻辑：成功记一行，失败记错误码再原样抛出（qqbot 那边的 catch 照旧生效）。
 */
export function installSendLog(bot, log, contextOf = () => ({})) {
  if (bot === null || typeof bot !== 'object') return false;
  if (bot.__koiSendLogged === true) return false; // 幂等：只包一次

  /**
   * 记一行**永不抛错**：日志失败不能把一次成功的发送变成"失败"。
   * （codex review 2026-11-24 P3：原来 target/长度计算在 try 里，
   *   遇到循环引用或日志 sink 故障会把成功报成失败。）
   */
  const safeLog = (line) => {
    try {
      log(line);
    } catch {
      /* 日志 sink 自己坏了也不能影响发送 */
    }
  };
  const targetOf = (t) => {
    try {
      if (t === null || typeof t !== 'object') return String(t).slice(0, 64);
      return String(t.targetId ?? t.id ?? t.openid ?? t.groupOpenid ?? '[object]').slice(0, 64);
    } catch {
      return '?';
    }
  };
  const lenOf = (v) => {
    try {
      if (typeof v === 'string') return v.length;
      if (Array.isArray(v)) return v.length;
      return -1;
    } catch {
      return -1;
    }
  };
  const tokenOf = (v) => {
    try {
      const s = String(v ?? '').replace(/\s+/g, '_').slice(0, 128);
      return s === '' ? '-' : s;
    } catch {
      return '?';
    }
  };
  const correlationOf = (opts) => {
    let current = {};
    try {
      current = contextOf(opts) ?? {};
    } catch {
      // 取不到调用上下文就退化成空关联：日志少字段，但绝不能挡住发送
      current = {};
    }
    const declared = {
      ...(current && typeof current === 'object' ? current : {}),
      ...(opts?.audit && typeof opts.audit === 'object' ? opts.audit : {}),
      ...(opts?.correlation && typeof opts.correlation === 'object' ? opts.correlation : {}),
      ...(opts?.meta && typeof opts.meta === 'object' ? opts.meta : {}),
    };
    const session = declared.session ?? declared.sessionId
      ?? opts?.sessionId ?? opts?.session?.id ?? opts?.target?.sessionId;
    const turn = declared.turn ?? declared.turnId
      ?? opts?.turn ?? opts?.turnId ?? opts?.target?.turn;
    const step = declared.step ?? declared.stepId
      ?? opts?.step ?? opts?.stepId ?? opts?.target?.step;
    return { session: tokenOf(session), turn: tokenOf(turn), step: tokenOf(step) };
  };
  const record = ({ opts, ok, via, len, started, err = '' }) => {
    const corr = correlationOf(opts);
    const target = targetOf(opts?.target ?? opts);
    const result = {
      session: corr.session,
      turn: corr.turn,
      step: corr.step,
      target,
      ok,
      len,
    };
    const detail = [
      `session=${corr.session}`,
      `turn=${corr.turn}`,
      `step=${corr.step}`,
      `target=${target}`,
      `ok=${ok}`,
      `len=${len}`,
      `via=${via}`,
      `ms=${Date.now() - started}`,
    ].join(' ');
    safeLog(`[send] ${ok ? 'ok' : 'failed'} ${detail}${err ? ` err=${err}` : ''}`);
    publishSendResult(result);
  };

  const wrapped = [];

  /**
   * 只包**最底层**的 `send(opts)`（codex review 2026-11-24 P2）。
   * 实测 SDK：`sendMarkdown(target, content)` 内部就是 `this.send({target, markdown:{content}})`——
   * 两个都包的话每条消息会记两行，且内层那行 target 是 `[object]`、长度 0。
   * 另外 SDK 的签名是 `send(opts)`，不是一个一个参数。
   */
  const origSend = bot.send;
  if (typeof origSend === 'function') {
    bot.send = async function sendLogged(opts, ...rest) {
      const started = Date.now();
      const len = lenOf(opts?.markdown?.content ?? opts?.content ?? opts?.text);
      let result;
      try {
        result = await origSend.call(this, opts, ...rest);
      } catch (err) {
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        record({ opts, ok: false, via: 'send', len, started, err: msg.slice(0, 160) });
        throw err;
      }
      record({ opts, ok: true, via: 'send', len, started });
      return result;
    };
    wrapped.push('send');
  }

  /**
   * 附件发送走 `sendMedia(opts)`（`sendImage/sendFile/sendVoice` 都委托到它），
   * **不经过 `send`**——2026-11-24 review P2：不包它，`qqbot_send_file` 就没有投递记录。
   */
  const origSendMedia = bot.sendMedia;
  if (typeof origSendMedia === 'function') {
    bot.sendMedia = async function sendMediaLogged(opts, ...rest) {
      const started = Date.now();
      const len = lenOf(opts?.content ?? opts?.file ?? opts?.media);
      let result;
      try {
        result = await origSendMedia.call(this, opts, ...rest);
      } catch (err) {
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        record({ opts, ok: false, via: 'sendMedia', len, started, err: msg.slice(0, 160) });
        throw err;
      }
      record({ opts, ok: true, via: 'sendMedia', len, started });
      return result;
    };
    wrapped.push('sendMedia');
  }

  // 流式：openStream(opts) → session.update / complete，成败发生在 session 方法上
  const origOpenStream = bot.openStream;
  if (typeof origOpenStream === 'function') {
    bot.openStream = function openStreamLogged(opts, ...rest) {
      const started = Date.now();
      const len = lenOf(opts?.markdown?.content ?? opts?.content ?? opts?.text);
      let session;
      try {
        session = origOpenStream.call(this, opts, ...rest);
      } catch (err) {
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        record({ opts, ok: false, via: 'openStream', len, started, err: msg.slice(0, 160) });
        throw err;
      }
      if (session !== null && typeof session === 'object') {
        for (const m of ['update', 'complete']) {
          const fn = session[m];
          if (typeof fn !== 'function') continue;
          session[m] = async function streamStepLogged(...args) {
            const t0 = Date.now();
            try {
              const r = await fn.apply(this, args);
              record({
                opts,
                ok: true,
                via: `stream.${m}`,
                len: lenOf(args[0]),
                started: t0,
              });
              return r;
            } catch (err) {
              const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
              record({
                opts,
                ok: false,
                via: `stream.${m}`,
                len: lenOf(args[0]),
                started: t0,
                err: msg.slice(0, 160),
              });
              throw err;
            }
          };
        }
      }
      return session;
    };
    wrapped.push('openStream');
  }

  if (wrapped.length === 0) return false;
  bot.__koiSendLogged = true;
  bot.__koiSendLogPaths = wrapped;
  return true;
}

export function createGate(bot, ctx, config) {
  // 先把投递日志装上：这样第一条出站就有记录（B3）
  const bootLog = (m) => console.log(m);
  /**
   * rc.5 的事件顺序是 `system-prompt/assemble` → `user/message`。
   * “当前说话人”由 lexicon 持有并在 `session/event` 的 `user/message` 更新，
   * 所以首个 step 会看到上一位说话人。gate 不复制这份状态；正确的修复位置在
   * lexicon：改听 `agent/inbox/claimed`（或同等“本轮入站已归属”事件）。
   * 这里仅维护发送关联上下文，不把说话人判定藏进 gate。
   */
  let lastEventContext = {};
  try {
    ctx?.on?.('session/event', (session, event) => {
      const sessionId = String(session?.id ?? session?.sessionId ?? '');
      const data = event?.data ?? {};
      if (sessionId === '' || (data.turn === undefined && data.step === undefined)) return;
      lastEventContext = {
        session: sessionId,
        turn: data.turn ?? data.turnId,
        step: data.step ?? data.stepId,
      };
    });
  } catch {
    /* 事件订阅不可用：发送日志仍用 opts 或未知值 */
  }
  try {
    const installed = installSendLog(bot, bootLog, () => lastEventContext);
    // 装上和"真的发出去了"是两件事：这里只证明**挂钩装上了**（B3 判据之一）
    bootLog(installed
      ? `[koi-gate] 出站投递日志已装上（覆盖 ${(bot.__koiSendLogPaths ?? []).join('/')}；每条落一行 [send]）`
      : '[koi-gate] 出站投递日志未安装（已经装过，或 bot 没有可包的发方法）');
  } catch (err) {
    // 记一笔就走：投递日志装不上不该影响发送本身（但不能静默）
    bootLog(`[koi-gate] 出站日志没装上（不影响发送）：${err instanceof Error ? err.message : String(err)}`);
  }
  let mw = null;
  // installSelftalk 会用 bot.use(...) 注册自己，这里截住那个中间件。
  const shim = { use: (fn) => { mw = fn; } };
  installSelftalk(shim, ctx, config);
  if (typeof mw !== 'function') {
    throw new Error('koi-gate: installSelftalk 没有注册中间件');
  }
  return mw;
}

export function apply(ctx) {
  /**
   * 直接 console.log：ctx.logger 的输出**不进 koi.log**，运维看不到。
   * 2026-11-24 审计插件就栽在这上面（contract-audit 抓到），这里一开始也在犯。
   */
  const log = (m) => console.log(m);

  // DSH 的 assembly 是结构（{ sections: [...] }），不是字符串——拼字符串会破坏流水线。
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const base = await next();
    const text = [
      '## 出口规则（发送前自查）',
      '- 只说给人听的话。括号里的底稿、内心活动、对账过程，一个字都不发。',
      `- 不想说话就输出 ${SILENCE_TOKEN}，或干脆不输出。别写「（没回）」这种占位。`,
      '- 退场语别连着用同一句；连着两条退场后，第三条必须说实在的。',
      '- 内部进度可以说，但要讲得让人听得懂；行话（版本号/字段名/某栏）等于没说。',
    ].join('\n');
    if (base && typeof base === 'object' && Array.isArray(base.sections)) {
      return { ...base, sections: [...base.sections, { name: 'koi:outbound', order: 97, text }] };
    }
    return base;
  });

  log('[koi-gate] 已启用：入口门控 createGate() + 出口判定 allow() + 自查段已注入提示词');
  return () => {};
}

/** 兜底：万一有人从旧包名迁过来，至少能在运行时报出一句清楚的话 */
export const __merged_from = ['dsh-koi-rules', 'dsh-koi-says', 'dsh-koi-selftalk'];
void allowImpl;
