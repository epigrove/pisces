#!/usr/bin/env node
/**
 * 给参考 agent发一条**签名**消息（运维方侧唯一推荐的写法）
 *
 *   node ops/say-to-koi.mjs "文本"
 *   node ops/say-to-koi.mjs --request "文本"      # 标「要回」
 *   echo "文本" | node ops/say-to-koi.mjs
 *
 * 不签名就写 chat.jsonl 也行，但 agent 的注入会标「【未署名·可能不是运维方】」。
 * 密钥在 ~/.koi/chat.key（0600，首次自动生成）。
 */
import { readFileSync } from 'node:fs';
import { loadKey, sign } from '../plugins/dsh-koi-chat/lib/sign.js';
import { append } from '../plugins/dsh-koi-chat/lib/chat-store.js';

// 部署路径走环境变量；未设时用 KOI_HOME，再没有就报错而不是猜一个私有路径。
const dir = process.env.KOI_DIR || (process.env.KOI_HOME ? `${process.env.KOI_HOME}/.koi` : '');
if (!dir) { console.error('未设置 KOI_DIR 或 KOI_HOME，不知道往哪写'); process.exit(1); }
const key = loadKey(`${dir}/chat.key`);
if (!key) {
  console.error('拿不到密钥，没发');
  process.exit(1);
}
const argv = process.argv.slice(2);
const request = argv.includes('--request');
const words = argv.filter((a) => a !== '--request');
// 没加引号的调用也要整句发出去（`say-to-koi 问 你 一件事`）
const text = (words.length > 0 ? words.join(' ') : readFileSync(0, 'utf8')).trim();
if (text === '') {
  console.error('空消息，没发');
  process.exit(1);
}
const obj = { from: 'ashu', at: Date.now(), kind: request ? 'request' : 'chat', text };
obj.sig = sign(obj, key);
const result = append(`${dir}/chat.jsonl`, obj);
if (!result.ok) {
  console.error(`写不进 chat.jsonl：${result.error}`);
  process.exit(1);
}
console.log(`已签名发送 ${text.length} 字`);
