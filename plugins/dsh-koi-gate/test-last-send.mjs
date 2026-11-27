#!/usr/bin/env node
/**
 * 「最近一次发图」那行（2026-11-28，koi 提案 A）
 *
 * 要三件事：一行、说清成败和时间、旧的被覆盖。
 * 由 `installSendLog` 写 `.koi/last-send.json`，`apply()` 的 assemble 里读出来注入 contexts。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const D = mkdtempSync(join(tmpdir(), 'koi-gate-lastsend-'));
process.env.KOI_HOME = D;
process.on('exit', () => { try { rmSync(D, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ } });
mkdirSync(join(D, '.koi'), { recursive: true });
const STATE = join(D, '.koi', 'last-send.json');

const { apply, createGate } = await import('./lib/index.js');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const assemblers = [];
const ctx = {
  on: (ev, fn) => { if (ev === 'system-prompt/assemble') assemblers.push(fn); return () => {}; },
  get: () => undefined,
  tools: { register() {} },
  effect: () => {},
};
apply(ctx);
ok('assemble 钩子已注册', assemblers.length === 1);

const run = async () => {
  let next = async () => ({ sections: [], contexts: [] });
  for (const fn of assemblers) {
    const inner = next;
    next = () => fn({}, {}, inner);
  }
  return next();
};
const lineOf = (out) => (out.contexts ?? []).find((c) => c.name === 'koi:last-send')?.text ?? '';

// ① 没有记录 → 不注入
{
  const out = await run();
  ok('没有记录时不注入', lineOf(out) === '', JSON.stringify(out.contexts));
  ok('出口规则段仍在系统提示里', (out.sections ?? []).some((s) => s.name === 'koi:outbound'));
}

// ② 成功记录 → 一行，带时间与「群」
{
  writeFileSync(STATE, JSON.stringify({ at: Date.now(), ok: true, scope: 'group', err: '' }), 'utf8');
  const line = lineOf(await run());
  ok('成功记录注入一行', line.startsWith('【最近一次发图】'), line);
  ok('成功记录带「成功（群）」', line.includes('成功') && line.includes('群'), line);
  ok('成功记录不含换行（只有一行）', !line.includes('\n'), line);
}

// ③ 失败记录覆盖旧记录，带原因与「私聊」
{
  writeFileSync(STATE, JSON.stringify({ at: Date.now(), ok: false, scope: 'c2c', err: '富媒体文件下载失败' }), 'utf8');
  const line = lineOf(await run());
  ok('失败记录覆盖旧记录', line.includes('失败') && line.includes('私聊'), line);
  ok('失败原因带出来', line.includes('富媒体文件下载失败'), line);
}

// ④ 状态文件坏掉时不能炸，也不能注入半截
{
  writeFileSync(STATE, '{不是 json', 'utf8');
  let threw = false;
  let out;
  try { out = await run(); } catch { threw = true; /* 组装抛错也不该有半截注入 */ }
  ok('状态文件坏了不影响组装', threw === false);
  ok('状态文件坏了就不注入', threw === true || lineOf(out) === '');
}

// ⑤ 文件被删掉 → 回到不注入
{
  try { unlinkSync(STATE); } catch { /* already gone */ }
  ok('状态文件删掉后不注入', lineOf(await run()) === '');
}

// ⑥ 真的走一遍发送回执：包住 bot.sendMedia，成功写 ok:true，失败写 ok:false
{
  try { unlinkSync(STATE); } catch { /* 不存在也行 */ }
  const fakeBot = { use() {}, on() {}, send: async () => ({}), sendMedia: async () => ({}) };
  const fakeCtx = { on() {}, get: () => undefined, tools: { register() {} }, effect() {} };
  createGate(fakeBot, fakeCtx, {});
  await fakeBot.sendMedia({ target: { scope: 'group' }, content: 'x' });
  const st = JSON.parse(readFileSync(STATE, 'utf8'));
  ok('发送成功后落盘 ok:true', st.ok === true && st.scope === 'group', JSON.stringify(st));
  ok('注入行跟着更新为成功', lineOf(await run()).includes('成功'));

  // 换一只新 bot：同一个 bot 已装过 hook（__koiSendLogged），不会重复包
  const failingBot = {
    use() {}, on() {},
    send: async () => ({}),
    sendMedia: async () => { throw new Error('富媒体文件下载失败'); },
  };
  createGate(failingBot, fakeCtx, {});
  try { await failingBot.sendMedia({ target: { scope: 'c2c' }, content: 'y' }); } catch { /* 预期抛错 */ }
  const st2 = JSON.parse(readFileSync(STATE, 'utf8'));
  ok('发送失败后落盘 ok:false 并记原因', st2.ok === false && String(st2.err).includes('富媒体'), JSON.stringify(st2));
  ok('注入行跟着更新为失败', lineOf(await run()).includes('失败'));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
