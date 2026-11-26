/**
 * 记忆侧车索引（2026-11-15）——过时标记 / 召回时间 的共享存储工具。
 *
 * 与纯数学（index.js）分开：这里只做「读改写一个独立索引文件」。
 * **绝不触碰记忆账本（medium/long.jsonl）**——账本只增不删，是参考 agent的红线。
 * 索引是派生数据，可整体重写；坏了可丢（丢标记=回到全量计算，不丢记忆）。
 *
 * 结构：{ stale: { [id]: {at, reason} }, touch: { [id]: recallAt } }
 * 无 id 的记录不建索引（避免 "undefined" 键串标）。
 */
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, basename } from 'node:path';

/** 同一进程重复读取同一个坏文件时复用备份，别每算一次可见性就多留一份。 */
const corruptBackups = new Map();

/**
 * 2026-11-18 codex review P1：
 *   原来只认 stale / touch 两个桶，`touch()` 写回时会把别的桶整个抹掉——
 *   memory 新加的 `obsolete`（长期废弃标记）就是这样被静默清掉的：
 *   她 recall 一次中期记忆 → 写回索引 → 所有废弃标记消失 → 下次重启又全被注入。
 *
 * 现在：**未知的桶原样保留**（spread 原对象），谁往里加新桶都不会被邻居写没。
 */
function emptyIndex() {
  return { stale: {}, touch: {} };
}

/**
 * 读侧车并报告「文件不存在 / 损坏且备份成功 / 损坏且备份失败」。
 *
 * `ok:false` 表示调用方**不得**把空桶写回去。尤其是备份失败时，原文件
 * 仍是唯一副本，任何自动覆盖都会把恢复线索一起丢掉。
 */
export function readIndexResult(file) {
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    if (d === null || typeof d !== 'object' || Array.isArray(d)) {
      throw new SyntaxError('侧车索引不是 JSON 对象');
    }
    return {
      ok: true,
      exists: true,
      index: { ...d, stale: d.stale ?? {}, touch: d.touch ?? {} },
      corrupt: false,
      backup: '',
      error: null,
    };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        ok: true,
        exists: false,
        index: emptyIndex(),
        corrupt: false,
        backup: '',
        error: null,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (existsSync(file)) {
      const cachedBackup = corruptBackups.get(file);
      if (cachedBackup && existsSync(cachedBackup)) {
        try {
          if (readFileSync(cachedBackup).equals(readFileSync(file))) {
            return {
              ok: false,
              exists: true,
              index: emptyIndex(),
              corrupt: true,
              backup: cachedBackup,
              backupFailed: false,
              error: err,
            };
          }
        } catch { /* 缓存备份不可读就重新备份 */ }
      }
      const backup = `${file}.corrupt-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        copyFileSync(file, backup);
        corruptBackups.set(file, backup);
        console.log(`[sidecar] 索引解析失败，已备份到 ${backup}，拒绝用空桶覆盖原文件：${message}`);
        return {
          ok: false,
          exists: true,
          index: emptyIndex(),
          corrupt: true,
          backup,
          backupFailed: false,
          error: err,
        };
      } catch (backupErr) {
        const backupMessage = backupErr instanceof Error ? backupErr.message : String(backupErr);
        console.log(`[sidecar] 索引解析失败且备份失败（${backupMessage}），拒绝覆盖原文件：${message}`);
        return {
          ok: false,
          exists: true,
          index: emptyIndex(),
          corrupt: true,
          backup: '',
          backupFailed: true,
          error: err,
        };
      }
    }
    return {
      ok: false,
      exists: false,
      index: emptyIndex(),
      corrupt: false,
      backup: '',
      backupFailed: false,
      error: err,
    };
  }
}

/** 兼容旧调用：返回内容，但损坏时只读为空桶；写路径必须用 readIndexResult。 */
export function readIndex(file) {
  return readIndexResult(file).index;
}

export function writeIndex(file, index) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(index), 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* 已经关了 */ }
    }
    try { unlinkSync(tmp); } catch { /* 临时文件可能还没创建 */ }
    throw err;
  }
}

/** 记一次召回（被想起）。无 id 不记。返回是否改动。 */
export function touch(file, id, now) {
  if (!id) return false;
  const loaded = readIndexResult(file);
  if (!loaded.ok) throw new Error(`侧车索引不可写：${loaded.error instanceof Error ? loaded.error.message : String(loaded.error)}`);
  const idx = loaded.index;
  idx.touch[id] = now;
  // 想起即复活：清掉 rested 过时标记
  if (idx.stale[id]?.reason === 'rested') delete idx.stale[id];
  writeIndex(file, idx);
  return true;
}

/**
 * 账本完整性（2026-11-15 参考 agent审：别把「测试盯着」当「不会发生」）。
 *
 * 测试只测想到的路；有人绕过侧车直接改账本，测试照样绿。所以要有**事后可见**的指纹：
 * 合法追加（remember）时更新快照；体检对比当前 行数/字节/sha256 与快照，
 * 不一致 = 账本被旁路改过 → 报出来。看不见的才叫丢。
 *
 * 快照存 `${file}.integrity.json`，与账本分离；首次无快照=建基线（不报）。
 */
import { createHash } from 'node:crypto';

export function fingerprint(file) {
  if (!existsSync(file)) return { lines: 0, bytes: 0, sha: '' };
  const buf = readFileSync(file);
  const lines = buf.toString('utf8').split('\n').filter((l) => l.trim() !== '').length;
  return { lines, bytes: buf.length, sha: createHash('sha256').update(buf).digest('hex') };
}

const integrityFile = (file) => `${file}.integrity.json`;
const auditFile = (file) => `${file}.integrity.audit.jsonl`;

/**
 * 刷新基线。actor 标明「谁刷的」（remember / check.init / …）。
 * 参考 agent 2026-11-15：指纹查「被改过」查不出「改得对不对」；基线刷新若错了会把错的记成对的。
 * 所以每次刷新都留一条 append-only 审计（谁、几点、刷成什么），事后可核对。
 */
export function recordLedger(file, actor = 'unknown') {
  try {
    const fp = fingerprint(file);
    writeIndex(integrityFile(file), fp);
    appendFileSync(auditFile(file), JSON.stringify({ at: Date.now(), actor, file: basename(file), ...fp }) + '\n', 'utf8');
  } catch { /* 记不上不阻断写入 */ }
}

/** 读基线刷新审计（append-only）。 */
export function readRefreshAudit(file) {
  try {
    return readFileSync(auditFile(file), 'utf8').split('\n').filter((l) => l.trim() !== '')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** 体检调用：对比当前与基线。返回 {ok, drift, baseline}。无基线=建立并 ok。 */
export function checkLedger(file) {
  const cur = fingerprint(file);
  let base = null;
  if (existsSync(integrityFile(file))) {
    try { base = JSON.parse(readFileSync(integrityFile(file), 'utf8')); }
    catch (e) { console.log('[sidecar] 基线读失败：' + String(e)); }
  }
  if (base === null || base.sha === undefined) {
    recordLedger(file, 'check.init');
    return { ok: true, drift: null, baseline: 'initialized' };
  }
  const drift = (cur.lines !== base.lines || cur.bytes !== base.bytes || cur.sha !== base.sha)
    ? { was: base, now: cur } : null;
  return { ok: drift === null, drift, baseline: 'existing' };
}
