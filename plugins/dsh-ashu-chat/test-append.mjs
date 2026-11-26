#!/usr/bin/env node
/**
 * ashu-chat / say-to-koi 回归：都经 chat-store.append() 写，不再各拼 JSON 行。
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from './index.js';

const dir = mkdtempSync(join(tmpdir(), 'ashu-chat-append-'));
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理 */ } });

const routes = new Map();
apply({
  webServer: {
    register(route) {
      routes.set(route.path, route);
      return () => {};
    },
  },
}, { koiHome: dir });

function postReq(body) {
  const req = new EventEmitter();
  req.method = 'POST';
  queueMicrotask(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

async function responseOf(path, body) {
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code) { this.statusCode = code; },
    end(value = '') { this.body = String(value); },
  };
  await routes.get(path).handler(postReq(body), res);
  return { ...res, json: res.body ? JSON.parse(res.body) : null };
}

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const chatFile = join(dir, '.koi', 'chat.jsonl');
const sent = await responseOf('/pisces-chat/send', { text: '面板消息' });
const first = JSON.parse(readFileSync(chatFile, 'utf8').trim());
ok('面板发送经统一 append 成功', sent.statusCode === 200 && sent.json?.ok === true, JSON.stringify(sent));
ok('面板发送保留既有 from/to/via/kind 字段',
  first.from === 'master' && first.to === 'koi' && first.via === 'panel' && first.kind === 'chat',
  JSON.stringify(first));
ok('面板发送仍有签名', typeof first.sig === 'string' && first.sig.length > 0, JSON.stringify(first));

const uploaded = await responseOf('/pisces-chat/upload', {
  name: 'a.txt',
  data: Buffer.from('abc').toString('base64'),
  text: '附件',
});
const lines = readFileSync(chatFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const last = lines.at(-1);
ok('附件发送经统一 append 成功', uploaded.statusCode === 200 && uploaded.json?.ok === true, JSON.stringify(uploaded));
ok('附件消息保留 file 结构', last?.file?.name === 'a.txt' && last?.file?.rel?.endsWith('a.txt'), JSON.stringify(last));

const opsSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../ops/say-to-koi.mjs'), 'utf8');
ok('say-to-koi 不再自拼 JSONL，统一调用 append',
  /\bappend\(/.test(opsSource) && !/\bappendFileSync\b/.test(opsSource), opsSource);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
