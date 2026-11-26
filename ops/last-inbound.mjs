#!/usr/bin/env node
/**
 * 最后一次收到**人话**是什么时候。
 *
 * 用途：群一直没动静时，能自检「我这边到底在不在线」——
 * 光看"没有回复"分不清是没人说话、还是我没收到。
 *
 * 只读会话记录，不改任何状态。
 * 用法：node ops/last-inbound.mjs [--json]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KOI = process.env.KOI_HOME ?? REPO;
const asJson = process.argv.includes('--json');

const root = join(KOI, '.dsh-home', 'sessions');
const rows = [];

function failRead(path, err) {
  console.error(`读不了会话目录 ${path}：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

let rootEntries;
try {
  rootEntries = readdirSync(root);
} catch (err) {
  if (err?.code === 'ENOENT') {
    if (asJson) console.log(JSON.stringify({ newest: null, newestQQ: null, all: [], note: '无会话记录' }, null, 2));
    else console.log('无会话记录');
    process.exit(0);
  }
  failRead(root, err);
}

if (rootEntries.length > 0) {
  for (const dir of rootEntries) {
    const base = join(root, dir);
    try {
      if (!statSync(base).isDirectory()) continue;
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      failRead(base, err);
    }
    let subEntries;
    try {
      subEntries = readdirSync(base);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      failRead(base, err);
    }
    for (const sub of subEntries) {
      const f = join(base, sub, 'session.v4.jsonl.zstd');
      let lines;
      try {
        lines = zstdDecompressSync(readFileSync(f)).toString('utf8').trim().split('\n');
      } catch {
        continue; // 读不了就跳过（会话可能在写）
      }
      /** 只认人说的（source.kind === 'user'），注入/定时都不算 */
      let last = 0;
      let lastText = '';
      for (const line of lines) {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e?.type !== 'user/message') continue;
        if (e?.data?.source?.kind !== 'user') continue;
        const t = Number(e.time ?? 0);
        if (t <= last) continue;
        last = t;
        lastText = (e.data.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join(' ').slice(0, 40);
      }
      if (last === 0) continue;
      rows.push({
        // 会话目录名带 cwd，群聊是 .koi-workspace，ops 是 _no-cwd/chat-*
        kind: sub.startsWith('session-chat-') ? 'ops' : sub.startsWith('session-hb-') ? 'heartbeat' : 'qq',
        session: sub.slice(0, 24),
        at: last,
        sample: lastText,
      });
    }
  }
}

rows.sort((a, b) => b.at - a.at);
const newest = rows[0];
const newestQQ = rows.find((r) => r.kind === 'qq');

if (asJson) {
  console.log(JSON.stringify({ newest: newest ?? null, newestQQ: newestQQ ?? null, all: rows.slice(0, 5) }, null, 2));
  process.exit(0);
}

const fmt = (ts) => new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const ago = (ts) => {
  const h = (Date.now() - ts) / 3600000;
  return h < 1 ? `${Math.round(h * 60)} 分钟前` : h < 48 ? `${h.toFixed(1)} 小时前` : `${(h / 24).toFixed(1)} 天前`;
};

if (newest === undefined) {
  console.log('没有任何「人说的话」记录。');
} else {
  console.log(`最后一次收到人话：${fmt(newest.at)}（${ago(newest.at)}，${newest.kind}）`);
}
if (newestQQ === undefined) {
  console.log('QQ 通道：**从没有过**人话记录');
} else {
  const flag = (Date.now() - newestQQ.at) / 3600000 > 48 ? '  ← 超过两天没收到，注意是不是掉线了' : '';
  console.log(`QQ 通道最后一次：${fmt(newestQQ.at)}（${ago(newestQQ.at)}）${flag}`);
}
