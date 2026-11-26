/**
 * 退场守卫：带图/点名时不许用退场语敷衍；退场语不许重复与连击。
 *
 * 状态按目标（群/会话）存。标记由入口（selftalk）写，守卫在出口读。
 */
import { SILENCE_TOKEN } from './silence.mjs';
import { turnFlagsFor, clearTurnFlags } from './turn-state.mjs';

const EXIT_WINDOW_MS = 10 * 60_000; // 10 分钟内同一句退场只放一次
// 旧的退场语已从退场语表删除：它既像正常告别语又被用作静默词，两处并存只会被无声吞掉。
export const EXIT_RE = /^(我?退下了|退下了|告辞|先走了|不聊了|睡了|去睡了|我先走|歇了|散了吧|不说了|就这样吧)[。~！!.…]*$/;

const recentExits = new Map(); // gid -> [{ text, at }]
const exitStreak = new Map();  // gid -> 连续发出去的退场条数（2026-11-16）


function isExitPhrase(text) {
  const t = String(text ?? '').trim();
  if (t === SILENCE_TOKEN) return true;
  // 2026-11-15 codex P1：必须锚定「收尾」意图，不能见"睡"就吞
  // （"没睡，在呢"/"睡不着" 是正常回复，不是退场）。
  return t.length <= 20 && (EXIT_RE.test(t) || /(^睡了|^去睡|^睡去|^灯关|睡到天亮)/.test(t));
}

/**
 * 发送前检查。返回 true = 丢掉这条（强制沉默）。
 * 非退场语一律放行，并清掉标记/计数。
 */
export function guardExit(text, gid) {
  const t = String(text ?? '').trim();
  if (t === '') return false;
  const key = String(gid ?? '');
  if (!isExitPhrase(t)) {
    clearTurnFlags(key);
    recentExits.delete(key);
    exitStreak.delete(key); // 说了实在话，连击清零
    return false;
  }
  // 2026-11-16 参考 agent②：连着两条退场后，第三条退场直接抑制（要么说实在的要么空着）
  if ((exitStreak.get(key) ?? 0) >= 2) {
    console.log(`[exit-guard] 丢（退场连击>=2）原文：${t}`);
    return true;
  }
  const f = turnFlagsFor(key);
  if (f?.image || f?.named) {
    // 2026-11-14 参考 agent：出口只看句子形状、看不见语境，可能误吞该说的话。
    // 所以丢掉的必须留原文+原因，不能只留计数——外部要能核对被吞了什么。
    console.log(`[exit-guard] 丢（${f?.image ? '带图' : '点名'}）原文：${t}`);
    return true;
  }
  const now = Date.now();
  // 2026-11-15 参考 agent：同一天退场语不撞车（"睡了/睡到天亮/灯关了" 算同一类）。
  const cat = /睡|灯关/.test(t) ? 'sleep' : 'leave';
  const day = new Date(now).toDateString();
  const recent = (recentExits.get(key) ?? []).filter((x) => now - x.at < 24 * 3600_000);
  const sameText = recent.some((x) => x.text === t && now - x.at < EXIT_WINDOW_MS);
  const sameCatToday = recent.some((x) => x.cat === cat && new Date(x.at).toDateString() === day);
  if (sameText || sameCatToday) {
    console.log(`[exit-guard] 丢（${sameText ? '重复退场' : '同日同类退场'}）原文：${t}`);
    return true;
  }
  recent.push({ text: t, cat, at: now });
  recentExits.set(key, recent.slice(-8));
  exitStreak.set(key, (exitStreak.get(key) ?? 0) + 1); // 这条退场发出去了，连击+1
  return false;
}
