/**
 * 身份抽象（2026-11-24，去 QQ 化第一块）
 *
 * 两条设计约束：
 *   1. koi 不是 qq agent，是**通用聊天 agent**，只是目前在 qq 用
 *   2. 插件设计要为「脱离 QQ」留可能，**特别是唯一标识符**
 *
 * 判据：**删掉所有 QQ 相关代码，插件还能工作**，它就干净。
 *
 * 所以身份只认一个形状：
 *
 *   source.person = { platform, id, name?, scope? }
 *
 *   platform  平台名（qq / web / cli …），只用来拼 key，不参与判断
 *   id        平台内的**稳定 id**（qq 是 openid，web 是用户 id）
 *   name      这次显示的名字，**只用于给人看**，不能当唯一标识
 *   scope     c2c / group（可选）
 *
 * 通道（qqbot）负责把平台字段翻译成这个形状；插件只读这个形状，
 * 不再从正文里 `[昵称 (openid)]` 那种地方抠 id——那是通道的活。
 *
 * **兼容**：老消息没有 source.person（历史会话、别的通道），
 * 调用方可以用 `legacyKeyFromText()` 兜底，它只认「括号里的 32 位 hex」这一种形态，
 * 且明确标成 legacy —— 新代码别再依赖它。
 */

/** 从 source 取结构化身份；没有就返回 null */
export function personOf(source) {
  const p = source?.person;
  if (!p || typeof p !== 'object') return null;
  const id = String(p.id ?? '').trim();
  if (id === '') return null;
  return {
    platform: String(p.platform ?? 'unknown').trim() || 'unknown',
    id,
    name: p.name === undefined ? undefined : String(p.name),
    scope: p.scope === undefined ? undefined : String(p.scope),
  };
}

/**
 * 人的唯一 key：`<platform>:<id>`。
 *
 * 为什么带 platform：不同平台可能出现相同的 id 字符串，
 * 只按 id 记人会在换通道时把两个人并成一个。带上前缀就能共存。
 */
export function personKeyOf(source) {
  const p = personOf(source);
  if (p === null) return '';
  /**
   * 2026-11-24 codex review P2：**id 大小写要归一**。
 * 实际 QQ 入站的 openid 有大小写混合（`AbCdEf01…`），而配置里的 owner 可能写小写；
   * 不归一的话 `isOwnerPerson()` 会对着自己人返回 false，
   * 而且"结构化身份"和"legacy 抠出来的"两条路会给出不同的 key。
   * 统一小写：平台 id 本来就是不透明串，大小写不承载含义。
   */
  return `${String(p.platform).toLowerCase()}:${String(p.id).toLowerCase()}`;
}

/** 显示名（只用于给人看；没有就退回 id 前 8 位） */
export function personNameOf(source, fallbackId = '') {
  const p = personOf(source);
  if (p?.name !== undefined && p.name !== '') return p.name;
  const id = p?.id ?? String(fallbackId);
  return id.slice(0, 8);
}

/**
 * 判断这条消息是不是「主人」。
 *
 * 主人由**配置**给（`owners: ['qq:<openid>', 'web:<id>']`），不认任何写死的前缀——
 * 写死等于把某个人的平台 id 焊进代码，换通道/换人就废。
 *
 * @param {object} source   消息 source
 * @param {string[]} owners 形如 ['qq:xxxx'] 的 owner key 列表
 */
export function isOwnerPerson(source, owners = []) {
  const key = personKeyOf(source);
  if (key === '') return false;
  // 配置那边也可能写成大写，两边都归一再比
  return Array.isArray(owners) && owners.map((o) => String(o).toLowerCase()).includes(key);
}

/**
 * **legacy 兜底**：老消息里没有结构化身份时，从正文抠「[昵称 (32位hex)]」里的 id。
 *
 * 只给还没迁移的调用方用；新代码不要调它。
 * 返回 `qq:<id>` 和名字，取不到返回 null。
 *
 * 2026-11-24 codex review P2：老消息的正文是
 *   `[Chat history begins] … [Current message] [发送者 (id)] 正文`
 * **第一条**匹配是历史里的某个人，不是发这条的人。
 * 所以先切到 `[Current message]` 之后，再取**最后一条**标记——
 * 这和 `dsh-koi-memory` 里 parseIncoming 的做法是同一个判据（它 2026-11-10 就踩过）。
 */
export function legacyKeyFromText(text) {
  const raw = String(text ?? '');
  const mark = raw.lastIndexOf('[Current message]');
  const body = mark === -1 ? raw : raw.slice(mark + '[Current message]'.length);
  const re = /\[([^\]\n]{1,40})\s+\(([a-f0-9]{32})\)\]/gi;
  let m;
  let last = null;
  while ((m = re.exec(body)) !== null) last = m;
  if (last === null) return null;
  return { key: `qq:${String(last[2]).toLowerCase()}`, name: last[1].trim(), legacy: true };
}
