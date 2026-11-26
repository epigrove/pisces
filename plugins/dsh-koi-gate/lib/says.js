/**
 * 出口判定的 **host 层**（原 dsh-koi-says，2026-11-24 并入 dsh-koi-gate）。
 *
 * 分工：
 *   lib/rules/*.mjs → 纯规则（什么算底稿/静默词/退场），零 IO，可单测
 *   本文件          → 规则 + koi 的约定（白名单文件、状态文件、KOI_HOME）
 *
 * 为什么不把这两件事混在一起：
 *   规则本身是可测的纯函数；路径和文件格式换个 agent 就变。
 *   混在一起以后，想复用规则就得连 koi 的目录结构一起搬。
 *
 * 通道侧用法（一行）：
 *   import { allow } from 'dsh-koi-says';
 *   if (allow(text, { target }).drop) return;   // 不发，也不补一句替它
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isSilenceToken, SILENCE_TOKEN } from './silence.mjs';
import { guardExit } from './exit.mjs';
import { setWhitelistLoader } from './leak.mjs';
import { turnFlagsFor, clearTurnFlags } from './turn-state.mjs';
import { allowOnce } from './dedupe.mjs';

// 2026-11-17：不再把 rules 的符号**全量转发**出去。
// 那层转发除了让「这个符号到底住在哪个包」变糊，没有任何用处——
// 唯一的消费者（退场语测试）已经改成直接从 rules 拿。
// 这里只导出本包自己产出的东西。
export { allowOnce };

const home = () => process.env.KOI_HOME ?? homedir();
const whitelistFile = () => join(home(), '.koi', 'outbound-whitelist.json');

// ── 白名单：读/存/到期清理都在这里，规则层只管"命中没命中" ──
const WL_TTL = 14 * 86400_000;
let wlCache = null;
let wlAt = 0;

function loadWhitelist() {
  const p = whitelistFile();
  let raw = [];
  try { raw = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : []; }
  catch (e) { console.log('[outbound] 白名单读失败：' + String(e)); raw = []; }
  if (!Array.isArray(raw)) raw = [];

  const now = Date.now();
  let changed = false;
  const norm = raw.map((e) => {
    if (typeof e === 'string') { changed = true; return { w: e, until: now + WL_TTL }; }
    return e;
  });
  const active = norm.filter((e) => e && typeof e.w === 'string' && Number(e.until) > now);
  if (active.length !== norm.length) changed = true;

  if (changed) {
    try {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(active, null, 2) + '\n', 'utf8');
    } catch (e) { console.log('[outbound] 白名单回写失败：' + String(e)); }
  }
  return active;
}

function whitelist() {
  const now = Date.now();
  if (wlCache !== null && now - wlAt < 60_000) return wlCache;
  wlAt = now;
  wlCache = loadWhitelist();
  return wlCache;
}

// 把"从哪读白名单"注入规则层
setWhitelistLoader(whitelist);

/**
 * 通道发送前的唯一入口。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.target] 目标（群/会话 id），用于退场与状态去重
 * @param {boolean} [opts.statusDedup=true]
 * @returns {{drop:boolean, reason:string}}
 *   reason ∈ '' | 'silence' | 'aside' | 'leak' | 'exit' | 'status'
 */
export function allow(text, opts = {}) {
  const t = String(text ?? '');
  if (t.trim() === '') return { drop: true, reason: 'silence' };

  if (isSilenceToken(t).silent) return { drop: true, reason: 'silence' };

  /**
   * 两类规则已移除：既然无法可靠判断「该丢」，就不应继续按内容形状拦截。
   * 不想说话时让 agent 输出固定短语即可，不需要复杂的内容判别。
   *
   * 这是对的，而且和「词表解不了语义」是同一件事的两个面：
   *   - 「想不想说」是**意图**，由 agent 输出 SILENCE_TOKEN 明确表达，不靠猜测
   *   - 「这句像不像旁白/漏话」是**内容形状**，正则判不准，误伤还无声
   *
   * 所以这里删掉两条按内容形状猜的规则：
   *   - aside（整句是括号旁白）→ 她不想说就用静默词，不用假装旁白
   *   - leak（漏话/调度话术）→ 词表必然误伤，今天已经吞掉她 5 条真实回复，
   *     其中一条是回答「还活着吗」的
   *
   * 留下的三条都不是在猜内容：
   *   - silence：她自己说的"这轮不说"
   *   - exit / status：**重复控制**（同一句退场、状态行 24h 只说一次），
   *     判的是"说过没有"，不是"这句话什么意思"
   */

  const target = String(opts.target ?? '');
  if (guardExit(t, target)) return { drop: true, reason: 'exit' };

  /**
   * `status`（状态行 24h 只说一次）同样在猜内容形状。
   * 它先被改成"同句去重"，之后**整条删掉了**——
   *
   * 因为同一判据适用：**拦不准的东西留着只会悄悄吃话**。
   * "同句去重"虽然不看内容语义，但仍然会吞掉正常的重复
   * （隔一会儿又说一句「在」、换个群又答一句「好」），而那种吞是无声的。
   *
   * 重复要不要再说一次，属于"怎么说"，归她自己判断；
   * 出口只保留两个判据：**她自己声明的沉默** + **退场语的重复/连击**。
   */

  return { drop: false, reason: '' };
}
