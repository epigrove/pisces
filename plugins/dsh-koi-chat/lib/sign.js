/**
 * chat-sign — 给「运维方写进来的消息」加签名（2026-11-09）
 *
 * 为什么要有它
 * ------------
 * `chat.jsonl` 是纯文件，同一个 uid 下**任何进程都能往里写一行 `from: ashu`**。
 * 曾发生过另一条会话冒用来源名连续写入的情况；
 * 读取方无法区分来源，只能按「野消息」处理。
 *
 * 做法：写入方用共享密钥对 `from/at/kind/text` 做 HMAC-SHA256，落一个 `sig` 字段；
 * 读取方（chat 插件注入前）逐条验，验不过的**标出来**，不丢。
 *
 * 边界（别把它吹成隔离）
 * ----------------------
 * 密钥在 `~/.koi/chat.key`（0600），同一个 uid 仍读得到——签名挡的是**随手写**，
 * 挡不住刻意伪造。真正的隔离要把「谁能写这个文件」变成权限问题（独立 uid / socket 权限）。
 * 这一步是抬价 + 留痕，不是加密通道。
 */
import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const KEY_RE = /^[0-9a-f]{64}$/i;

/** 读密钥；没有就生成一个 0600 的。生成失败返回 ''（调用方当作「不能签名」） */
export function loadKey(keyFile) {
  try {
    if (existsSync(keyFile)) {
      const k = readFileSync(keyFile, 'utf8').trim();
      if (KEY_RE.test(k)) {
        // 已有的密钥也要收紧：复制/还原过来的文件可能是 0644
        try {
          const mode = statSync(keyFile).mode & 0o777;
          if (mode !== 0o600) chmodSync(keyFile, 0o600);
        } catch {
          /* 改不动不阻断，但要让人知道 */
          console.log('[koi-chat/sign] ⚠️ 密钥权限没收紧: ' + keyFile);
        }
        return k.toLowerCase();
      }
    }
  } catch {
    /* 落到下面生成 */
  }
  try {
    const k = randomBytes(32).toString('hex');
    mkdirSync(dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, `${k}\n`, { mode: 0o600 });
    try {
      chmodSync(keyFile, 0o600);
    } catch {
      /* 某些文件系统不支持 chmod，不阻断 */
    }
    return k;
  } catch {
    return '';
  }
}

/** 参与签名的字段顺序固定，别改；改了等于所有历史签名作废 */
function payloadOf(o) {
  return [o?.from ?? '', o?.at ?? '', o?.kind ?? '', o?.text ?? ''].join('\n');
}

export function sign(o, key) {
  if (!key) return '';
  return createHmac('sha256', key).update(payloadOf(o), 'utf8').digest('hex').slice(0, 32);
}

/**
 * 'ok' 签名对得上 · 'bad' 有签名但对不上 · 'unsigned' 没签名
 */
export function verify(o, key) {
  const sig = typeof o?.sig === 'string' ? o.sig : '';
  if (sig === '') return 'unsigned';
  if (!key) return 'bad';
  return sig === sign(o, key) ? 'ok' : 'bad';
}

/**
 * 来源线索：**只是线索，不是铁证**。
 *
 * 同一个 uid 下，写入方能随手改自己进程的命令行，所以这里给不出「是谁写的」的定论。
 * 能给的是：写的时候，机器上同时跑着哪些 `dsh --profile ...` 进程。
 * 如果只有一条，基本能对上；如果有好几条，就只能列出来让人自己判。
 *
 * @returns {{candidates: Array<{pid:number, uptime:string, cmd:string}>|null}}
 *   null = 读不到 /proc（不是 Linux，或者被隔离）
 */
export function procHint() {
  let names;
  try {
    names = readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {
    return { candidates: null };
  }
  const out = [];
  for (const pid of names) {
    let cmd = '';
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch {
      continue;
    }
    if (!/dsh\b.*--profile/.test(cmd)) continue;
    let uptime = '?';
    try {
      const st = statSync(`/proc/${pid}`);
      const age = Math.round((Date.now() - st.ctimeMs) / 1000);
      uptime = age < 3600 ? `${Math.round(age / 60)}m` : `${Math.round(age / 3600)}h`;
    } catch {
      /* 进程刚退，算了 */
    }
    out.push({ pid: Number(pid), uptime, cmd: cmd.slice(0, 160) });
  }
  return { candidates: out };
}

/**
 * 把一条验不过的消息记进账本（JSONL，一行一条）。
 * 同一行反复被注入会重复调用，所以**按 msg id 去重**（读窗口内已有的 id）。
 */
export function logSuspect(file, entry, { windowLines = 400 } = {}) {
  try {
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').slice(-windowLines);
      for (const l of lines) {
        try {
          if (JSON.parse(l)?.id === entry.id) return false;
        } catch {
          /* 坏行跳过 */
        }
      }
    }
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch (err) {
    console.log('[koi-chat/sign] ⚠️ 嫌疑账本写不进去: ' + (err instanceof Error ? err.message : String(err)));
    return false;
  }
}
