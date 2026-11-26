/**
 * 状态类文本去重
 *
 * 同一类「无新消息 / 无进展」状态文本在 24 小时内只发第一条。
 *
 * 判据只判**这条是不是状态类**，不判语义：
 *   全是这几类短语之一、且很短 → 状态类
 * 状态类 → 24 小时内同一类只放第一条。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const STATE_RE = [
  /^(已经|已)排到|排到.*了/,
  /^(这次)?没事/,
  /^(我)?(睡|歇)(了|着)/,
  /^晚安/,
  /^睡了/,
  /^(没有|没)新消息/,
  /^(我这边)?安静/,
  /^等运维方/,
  /^没新事/,
];

/** 这条是不是「状态类」发言（短且整条像状态） */
export function isStatusLine(text) {
  const t = String(text ?? '').trim();
  if (t === '' || t.length > 40) return false;
  return STATE_RE.some((re) => re.test(t));
}

/**
 * 24 小时内同类只放一条。
 * @returns {{allow:boolean, reason?:string}}
 */
export function allowOnce(file, category, now = Date.now(), windowMs = 24 * 3600_000) {
  let store = {};
  try {
    store = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  } catch {
    store = {};
  }
  const last = Number(store[category] ?? 0);
  if (now - last < windowMs) {
    return { allow: false, reason: `${Math.round((now - last) / 60000)} 分钟前已经说过一次` };
  }
  store[category] = now;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(store, null, 1), 'utf8');
  } catch {
    /* 写不进去，宁可放行也别卡死 */
  }
  return { allow: true };
}
