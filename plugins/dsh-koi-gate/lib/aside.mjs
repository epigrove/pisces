/**
 * 括号旁白：整条是不是「写给自己看的底稿」。
 *
 * 只判结构，不猜语义：以括号开头、或整段被一对括号包住，就算旁白。
 * 命中即丢，不重写、不补一句。
 */
export function isPureAside(text) {
  const t = String(text ?? '').trim();
  if (t === '') return false;
  if (/^[(（]/.test(t)) return true;
  const open = t[0];
  const close = t[t.length - 1];
  return (open === '（' && close === '）') || (open === '(' && close === ')');
}
