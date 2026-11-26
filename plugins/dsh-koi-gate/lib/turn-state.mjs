/**
 * turn-state.mjs —— 入口与出口之间唯一共享的状态。
 *
 * 为什么单独一个文件：
 *   入口（dsh-koi-selftalk）知道「这条消息带图 / 点名了她」，
 *   出口（dsh-koi-says）要知道同一件事，才能判断「这时候说退场语是敷衍」。
 *   这是**真实的业务耦合**，不是设计缺陷——但这个耦合只该是一张标记表，
 *   不该是「两个插件互相 import 对方的一切」。
 *
 * 所以：标记存这里，两个插件都只依赖这一个文件。
 * 同进程内共享（都在 agent 的进程里），所以直接内存 Map 就够。
 *
 * 谁写谁读：
 *   selftalk  → markImage / markNamed   （入站时写）
 *   outbound  → turnFlagsFor / clearTurnFlags（出站时读、读完成结论后清）
 */

const turnFlags = new Map(); // gid -> { image, named }

export function markImage(gid, on = true) {
  const f = turnFlags.get(gid) ?? {};
  f.image = !!on;
  turnFlags.set(gid, f);
}

export function markNamed(gid, on = true) {
  const f = turnFlags.get(gid) ?? {};
  f.named = !!on;
  turnFlags.set(gid, f);
}

/** 读当前标记（不修改）。 */
export function turnFlagsFor(gid) {
  return turnFlags.get(gid) ?? {};
}

/** 清掉标记（出口放行了实质内容后调）。 */
export function clearTurnFlags(gid) {
  turnFlags.delete(gid);
}
