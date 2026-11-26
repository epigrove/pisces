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
export function installSendLog(bot, log) {
  if (bot === null || typeof bot !== 'object') return false;
  if (bot.__koiSendLogged === true) return false; // 幂等：只包一次
  const orig = bot.sendMarkdown;
  if (typeof orig !== 'function') return false;
  const targetOf = (t) => {
    if (t === null || typeof t !== 'object') return String(t);
    return String(t.targetId ?? t.id ?? t.openid ?? t.groupOpenid ?? JSON.stringify(t)).slice(0, 64);
  };
  bot.sendMarkdown = async function sendMarkdownLogged(target, text, ...rest) {
    const started = Date.now();
    try {
      const result = await orig.call(this, target, text, ...rest);
      log(`[send] ok target=${targetOf(target)} len=${String(text ?? '').length} ms=${Date.now() - started}`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      log(`[send] failed target=${targetOf(target)} len=${String(text ?? '').length} ms=${Date.now() - started} err=${msg.slice(0, 160)}`);
      throw err;
    }
  };
  bot.__koiSendLogged = true;
  return true;
}

export function createGate(bot, ctx, config) {
  // 先把投递日志装上：这样第一条出站就有记录（B3）
  const bootLog = (m) => console.log(m);
  try {
    installSendLog(bot, bootLog);
  } catch (err) {
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
