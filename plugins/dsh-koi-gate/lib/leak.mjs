/**
 * 漏话：行为型（内部自述、空转小结、调度话术）。
 *
 * 不是词汇过滤——词汇过滤必然误伤，而且误伤是无声的。
 * 只拦「把自己的对账过程念出来」这一类。
 * 白名单由宿主注入（setWhitelistLoader），本文件不碰文件系统。
 */
import { isPureAside } from './aside.mjs';

/**
 * **误杀事故**：正常询问得到的回复曾被这里吞掉。
 *
 * 例如回复中提到「等我醒」时命中 `等[^。！]{0,8}醒`，整条消息被丢弃，
 * 群里只看到点名没有反应。
 *
 * 而且同一条里还叠了另一个误判：`/[（）()]/` 只要**出现**一个括号就丢。
 * 「astrum（星星）」这种正常引用也会被吞。
 *
 * 判据：**宁可明确报出误伤，也不要静默吞掉正常发言**。
 * 所以词表只留**不可能出现在正常对话里**的调度话术，
 * 括号检测改用 isPureAside（整句就是旁白才丢，不是"含有括号"）。
 */
const LEAK_RE = /(话已发出去|再醒一次|已经排到|下次醒来是)/;

/**
 * 白名单到期制：白名单容易长期膨胀成词表，所以必须有明确失效时间。
 * 一条白名单活不过两周；到期不复核就删，删了误伤就让它误伤——
 * 宁可暴露误伤，也不要静默吞话。复核=把 until 往后改。
 * 条目格式 {w, until}；旧的纯字符串自动迁移成 {w, until: now+14d}。
 */
const WL_TTL = 14 * 86400_000;

/**
 * 白名单由宿主注入（本包不碰文件系统，保持纯逻辑）。
 * 宿主调 setWhitelistLoader(fn)，fn 返回 [{w, until}] 或字符串数组。
 * 传输层只管"从哪读、怎么存"，规则层只管"命中没命中"。
 */
let whitelistLoader = () => [];
export function setWhitelistLoader(fn) {
  whitelistLoader = typeof fn === 'function' ? fn : () => [];
}

function whitelist() {
  let raw = [];
  try { raw = whitelistLoader() ?? []; } catch { raw = []; }
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  return raw
    .map((e) => (typeof e === 'string' ? { w: e, until: now + WL_TTL } : e))
    .filter((e) => e && typeof e.w === 'string' && Number(e.until) > now)
    .map((e) => e.w);
}

export { WL_TTL };

/** 返回 true = 这条是漏话（括号/内部自述/空转），应丢弃。丢的留原文（误伤可查）。 */
export function shouldDropLeak(text) {
  const t = String(text ?? '');
  if (t.trim() === '') return false;
  if (whitelist().some((w) => w && t.includes(w))) return false;
  // 整句就是旁白（括号包起来、没有正文）才丢；
  // **含**括号不等于旁白——「astrum（星星）」是正常写法。
  const aside = isPureAside(t);
  const leak = aside || LEAK_RE.test(t);
  if (leak) console.log(`[leak-guard] 丢（${aside ? '纯旁白' : '内部自述/空转'}）原文：${t}`);
  return leak;
}

/** 包一层：拿到原文，返回 { drop:true } 或 { drop:false, text } */
export function filterOutbound(text) {
  if (isPureAside(text)) return { drop: true, text: '' };
  return { drop: false, text };
}

/**
 * 群聊里不该出现的内部用语。
 *
 * 直接做正则清理会误伤正常表达，因此这里**只告警不清理**。
 * 命中就记一条日志，事后定位漏规则的位置，而不是当场改模型生成的句子。
 */
const INTERNAL_RE =
  /(\d+\s*行|\d+\s*个文件|\w+\.(?:m?js|yml|yaml|json|md)\b|提交\s*[0-9a-f]{7}|插件名)/i;

export function looksInternal(text) {
  return INTERNAL_RE.test(String(text ?? ''));
}
