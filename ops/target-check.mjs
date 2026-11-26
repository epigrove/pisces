/**
 * 核对发送目标（运维方侧，2026-11-09）
 *
 * 为什么要有它
 * ------------
 * 参考 agent要发文件，`qqbot_send_file` 必须显式给 target（`group:<openid>`）。
 * agent 只有打码前缀时无法自行拼出目标；照记忆补一个字符就可能指向另一个群。
 * 所以由**运维方这边**从配置核出整串，不交给 agent 猜。
 *
 * 注意：这里只做「这一串确实配在 bot 底下」的核对，不需要真的发消息。
 */
import { existsSync, readFileSync } from 'node:fs';

/** bot 的会话映射：`qqbot:<appId>:group:<openid>` → sessionId */
export function knownTargets(mappingFile) {
  try {
    if (!existsSync(mappingFile)) return { groups: [], c2c: [] };
    const j = JSON.parse(readFileSync(mappingFile, 'utf8'));
    const groups = [];
    const c2c = [];
    for (const key of Object.keys(j?.sessionIds ?? {})) {
      const m = /^qqbot:\d+:group:([0-9A-F]+)$/i.exec(key);
      if (m) groups.push({ appId: key.split(':')[1], openid: m[1].toUpperCase() });
      const c = /^qqbot:\d+:c2c:([0-9A-F]+)$/i.exec(key);
      if (c) c2c.push({ appId: key.split(':')[1], openid: c[1].toUpperCase() });
    }
    return { groups, c2c };
  } catch {
    return { groups: [], c2c: [] };
  }
}

/** 给出完整 target 字符串，例如 `group:AB63...` */
export function targetOf(entry) {
  return `group:${entry.openid}`;
}
