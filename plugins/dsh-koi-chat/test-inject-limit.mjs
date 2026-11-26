#!/usr/bin/env node
/**
 * 回归测试：积压超过 injectLimit 时不许丢消息（2026-11-12）
 *
 * 11-08 修过一次「游标越过未注入的消息」，但取的是 `slice(-N)`（最后 N 条），
 * 于是最早那几条没注入、游标却已越过 —— 只是从「中间丢」变成「最早丢」。
 *
 * 这个测试构造 10 条未读、injectLimit=6，跑两轮注入，要求 10 条全部出现过。
 */
import { rmSync, writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from './lib/index.js';

// 2026-11-13 review：原来写死 /tmp/chatinject，并发跑会互删。
// （同一个改动里我已经把另外四个测试改成 mkdtemp 了，偏偏漏了自己新写的这个。）
const D = mkdtempSync(join(tmpdir(), 'koi-test-inject-'));
process.on('exit', () => { try { rmSync(D, { recursive: true, force: true }); } catch { /* 忽略 */ } });
const chatFile = `${D}/chat.jsonl`;

// 10 条运维方的消息
const lines = [];
for (let i = 1; i <= 10; i += 1) {
  lines.push(JSON.stringify({ from: 'ashu', at: Date.now() + i, text: `第${i}条` }));
}
writeFileSync(chatFile, `${lines.join('\n')}\n`, 'utf8');

// 假 ctx：接 assemble 与 session/event（成功结束时才提交本批游标）
let assemble = null;
let sessionEvent = null;
const ctx = {
  on(ev, fn) {
    if (ev === 'system-prompt/assemble') assemble = fn;
    if (ev === 'session/event') sessionEvent = fn;
  },
  get() { return undefined; },
  effect() {},
  tools: { register() {} },
};

apply(ctx, {
  dir: D,
  chatFile,
  injectLimit: 6,
  // 关掉自建会话，别真去连 agent
  wake: false,
});

let pass = 0;
let fail = 0;
const ok = (n, c) => { c ? pass += 1 : fail += 1; console.log(`${c ? '✅' : '❌'} ${n}`); };

const runOnce = async () => {
  const sessionId = 'session-chat-inject-limit';
  const out = await assemble(
    { sections: [] },
    { session: { id: sessionId } },
    async () => ({ sections: [] }),
  );
  sessionEvent({ id: sessionId }, { type: 'turn/end', data: {} });
  return (out.sections ?? []).map((s) => String(s.text)).join('\n');
};

const first = await runOnce();
ok('第一轮注入 6 条（最早的）', /第1条/.test(first) && /第6条/.test(first));
ok('第一轮不含第 7 条', !/第7条/.test(first));

const second = await runOnce();
ok('第二轮补上第 7 条', /第7条/.test(second));
ok('第二轮含第 10 条', /第10条/.test(second));

const third = await runOnce();
ok('第三轮不再重复', !/第\d+条/.test(third) || third.trim() === '');

// 汇总：两次注入合起来必须覆盖全部 10 条
const all = first + second;
const missing = [];
for (let i = 1; i <= 10; i += 1) if (!new RegExp(`第${i}条`).test(all)) missing.push(i);
ok(`10 条一条不丢（缺：${missing.join(',') || '无'}）`, missing.length === 0);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
