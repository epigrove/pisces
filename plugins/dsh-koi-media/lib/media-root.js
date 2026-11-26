import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * 解析路径最近的存在祖先；不存在的尾段按原样追加。
 * 这样候选文件尚不存在时，也能把它已有的父目录软链完整解析掉。
 */
function realpathNearestExisting(candidate) {
  const tail = [];
  let current = resolve(candidate);
  for (;;) {
    try {
      lstatSync(current);
      break;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      const parent = dirname(current);
      if (parent === current) throw err;
      tail.unshift(basename(current));
      current = parent;
    }
  }
  return resolve(realpathSync(current), ...tail);
}

/**
 * 统一的 mediaRoot 边界判定。
 *
 * 返回解析后的真实路径；调用方读取时必须使用 `path`，不要再用原始候选路径。
 * root 自身不算「在 root 内」，因为它不是可收/可读的媒体文件。
 */
export function resolveInsideMediaRoot(candidate, mediaRoot) {
  const root = String(mediaRoot ?? '').trim();
  if (root === '') return { ok: false, path: '', root: '', reason: 'mediaRoot 未配置' };
  try {
    const realRoot = realpathSync(resolve(root));
    const realCandidate = realpathNearestExisting(candidate);
    const rel = relative(realRoot, realCandidate);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return { ok: false, path: realCandidate, root: realRoot, reason: '路径越出 mediaRoot' };
    }
    return { ok: true, path: realCandidate, root: realRoot, reason: '' };
  } catch (err) {
    return {
      ok: false,
      path: '',
      root: '',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Boolean convenience for callers that only need the boundary decision. */
export function isInsideMediaRoot(candidate, mediaRoot) {
  return resolveInsideMediaRoot(candidate, mediaRoot).ok;
}
