/**
 * chat-store — `chat.jsonl` 的唯一读写层（2026-11-08）
 *
 * 为什么要有这个模块
 * ------------------
 * 有三个地方要碰这份文件：
 *
 *   chat      agent 的进程   读（from=ashu）+ 写（talk_to_sister）
 *   iterate   agent 的进程   读（去重）+ 写（04:00 提案）
 *   relay     运维方的进程   读（from=koi）→ followup 推给运维方
 *
 * 在此之前，**三份各自实现的 JSONL 解析**，而且写法还不一样：
 *
 *   chat     readAll() 函数里
 *   iterate  内联，filter 写法还不同
 *   relay    第三种
 *
 * 文件格式改一次要改三处。抽出来。
 *
 * 设计约束
 * --------
 * 只追加、不重写、不删行、不共享游标文件。任何一方需要"改"某条消息，
 * 就再追加一条引用它的新消息，不要回头改历史。
 *
 * 所以这个模块只提供：读、解析、追加。
 * **不提供改和删**——那是纪律，不是能力缺失。
 *
 * 游标和 seen 集合各自管，不进这个模块。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

/** 一条消息的稳定去重键：按原始行 curl 的 sha1 前 16 位 */
export function idOf(line) {
  return createHash('sha1').update(line).digest('hex').slice(0, 16);
}

/**
 * 读全部消息，并保留“读不到”和“空文件”的区别。坏行跳过，不抛。
 *
 * 文件不存在是可读的空通道；权限错误、I/O 错误、临时不可读则必须返回
 * `readable:false`。调用方不能把后者当成文件被截断。
 *
 * @param {string} chatFile
 * @returns {{
 *   messages:Array<{from?:string, at?:number, kind?:string, text?:string, _id:string, _line:number}>,
 *   readable:boolean,
 *   error:string,
 *   badLines:number
 * }}
 */
export function readAllSafe(chatFile) {
  try {
    let raw;
    try {
      raw = readFileSync(chatFile, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return { messages: [], readable: true, error: '', badLines: 0 };
      throw err;
    }
    const out = [];
    let badLines = 0;
    // 2026-11-08 codex review P3：**行号要按真实行算**。
    // 原来空行 `continue` 跳过了 lineNo++，所以有连续空行时后面的行号全错位。
    // 改用 split 的下标（0-based，和 readAll 的调用方约定一致）。
    raw.split('\n').forEach((line, i) => {
      if (line.trim() === '') return;
      try {
        const o = JSON.parse(line);
        if (o === null || typeof o !== 'object') return;
        o._id = idOf(line);
        o._line = i;
        out.push(o);
      } catch {
        // 单行坏了跳过——一行坏了不该让整份文件读不出来
        badLines += 1;
      }
    });
    return { messages: out, readable: true, error: '', badLines };
  } catch (err) {
    return {
      messages: [],
      readable: false,
      error: err instanceof Error ? err.message : String(err),
      badLines: 0,
    };
  }
}

/**
 * 兼容旧调用方：只返回消息数组。
 *
 * 新代码必须用 `readAllSafe()`；需要区分“没有消息”和“读失败”时，
 * 这个兼容包装无法提供足够信息。
 *
 * @param {string} chatFile
 * @returns {Array<object>}
 */
export function readAll(chatFile) {
  return readAllSafe(chatFile).messages;
}

/**
 * 追加一条消息。**只追加，永不重写。**
 *
 * @param {string} chatFile
 * @param {{from:string, text:string, kind?:string, at?:number}} msg
 * @returns {{ok:boolean, id?:string, error?:string}}
 */
export function append(chatFile, msg) {
  const from = String(msg?.from ?? '');
  const text = String(msg?.text ?? '');
  if (from === '') return { ok: false, error: 'from 不能为空' };
  if (text === '') return { ok: false, error: 'text 不能为空' };
  const obj = {
    from,
    at: Number(msg?.at ?? Date.now()),
    kind: String(msg?.kind ?? 'chat'),
    text,
  };
  /**
   * 2026-11-16 **修「agent 的回复没有收件人」**：
   * 原来这里**重建**对象，只留上面四个字段——调用方传的 `to` 被静默吃掉。
   * 于是 owner 在面板里永远看不到 agent 的回复（面板靠 `to` 区分两条线）。
   * 现在按白名单保留附加字段。
   */
  if (typeof msg?.to === 'string' && msg.to !== '') obj.to = msg.to;
  if (typeof msg?.sig === 'string' && msg.sig !== '') obj.sig = msg.sig;
  if (typeof msg?.via === 'string' && msg.via !== '') obj.via = msg.via;
  if (msg?.file !== null && typeof msg?.file === 'object' && !Array.isArray(msg.file)) {
    obj.file = {
      name: String(msg.file.name ?? ''),
      path: String(msg.file.path ?? ''),
      rel: String(msg.file.rel ?? ''),
      size: Number(msg.file.size ?? 0),
    };
  }
  const line = JSON.stringify(obj);
  try {
    mkdirSync(dirname(chatFile), { recursive: true });
    appendFileSync(chatFile, `${line}\n`, 'utf8');
    return { ok: true, id: idOf(line) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 按方向取未读。
 *
 * @param {string} chatFile
 * @param {'ashu'|'koi'} from 谁发的
 * @param {Set<string>} seen 已经处理过的 id
 * @returns {Array<object>}
 */
export function unread(chatFile, from, seen) {
  const all = readAll(chatFile);
  return all.filter((m) => m.from === from && !seen.has(m._id));
}

/**
 * 某个人最后一条消息的位置。用来算「从哪开始算新」。
 *
 * @param {string} chatFile
 * @param {'ashu'|'koi'} from
 * @returns {number} 下标，没有返回 -1
 */
export function lastIndexOf(chatFile, from) {
  const all = readAll(chatFile);
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i].from === from) return i;
  }
  return -1;
}

/**
 * 默认路径。
 *
 * @param {string} dataDir
 * @returns {string}
 */
export function chatPath(dataDir) {
  return join(dataDir, 'chat.jsonl');
}
