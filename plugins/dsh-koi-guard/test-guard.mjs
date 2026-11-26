#!/usr/bin/env node
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
/**
 * koi-guard 测试：只测 fs 规则（路径白名单）
 *
 * send 规则 2026-11-10 删了——那是"用正则解中文语义"的错误方向。
 * 详见 lib/index.js 头部。
 */
import { apply } from './lib/index.js';

let h;
apply(
  { on: (e, f) => { if (e === 'tools/execute') h = f; }, get: () => undefined },
  { home: '/tmp/koi-guard-test/.koi', allow: ['workspace', 'profile.core.md', 'lexicon.json'] },
);

const next = async () => ({ value: 'ok' });

// 不是随手编的 .events —— 编的形状会让测试和生产代码一起错。
const OWNER = 'a1b2c3d40e5f6';
const OTHER = '11112222333344445555666677778888';
const groupMsg = (who, text, openid) => `[${who} (${openid})] ${text}`;
const mkExec = (name, args, userText = null) => ({
  name,
  arguments: args,
  agent: {
    session: {
      snapshotEvents: () =>
        userText === null
          ? []
          : [{ type: 'user/message', data: { content: [{ type: 'text', text: userText }] } }],
    },
  },
});

let pass = 0;
let fail = 0;
async function check(label, exec, want) {
  const r = await h(exec, next);
  const got = r?.isError === true ? '拦' : '放行';
  const ok = got === want;
  ok ? pass += 1 : fail += 1;
  console.log(`${ok ? '✅' : '❌'} ${label.padEnd(34)} ${got}${ok ? '' : ` (期望 ${want})`}`);
}

console.log('=== fs 规则 ===');
await check('read 白名单内', mkExec('read', { file_path: '/tmp/koi-guard-test/.koi/workspace/a.md' }), '放行');
await check('read .env', mkExec('read', { file_path: '/tmp/koi-guard-test/.koi/.env' }), '拦');
await check('read 凭据', mkExec('read', { file_path: '/tmp/koi-guard-test/.koi/.credentials.yaml' }), '拦');
await check('glob 白名单内', mkExec('glob', { pattern: '*.md', path: '/tmp/koi-guard-test/.koi/workspace' }), '放行');
await check('glob 根目录', mkExec('glob', { pattern: '*', path: '/' }), '拦');
await check('grep 白名单内', mkExec('grep', { pattern: 'x', path: '/tmp/koi-guard-test/.koi/workspace' }), '放行');
await check('grep 掏 .env', mkExec('grep', { pattern: 'sk-', path: '/tmp/koi-guard-test/.koi/.env' }), '拦');
await check('grep 伸到 .dsh-home', mkExec('grep', { pattern: 'x', path: '/tmp/koi-guard-test/.dsh-home' }), '拦');
await check('read 相对路径外逃', mkExec('read', { file_path: '../../../.env' }), '拦');
await check('read 根目录', mkExec('read', { file_path: '/' }), '拦');
await check('read 空路径', mkExec('read', { file_path: '' }), '拦');
await check('glob 不给 path（用 cwd）', mkExec('glob', { pattern: '*.md' }), '拦');

console.log('\n=== fs 规则：符号链接穿越 ===');
{
  // 白名单里放一个指向 .env 的软链，必须被拒 —— 只判字面路径会放过去。
  const { mkdirSync, symlinkSync, rmSync, existsSync } = await import('node:fs');
  // 2026-11-13 review：原来写死 /tmp/guardtest，并发跑会互删。
  const BASE = mkdtempSync(join(tmpdir(), 'koi-test-guard-'));
  process.on('exit', () => { try { rmSync(BASE, { recursive: true, force: true }); } catch {} });
  const ws = join(BASE, '.koi/workspace');
  const secret = join(BASE, '.koi/.env');
  try {
    rmSync(BASE, { recursive: true, force: true });
    mkdirSync(ws, { recursive: true });
    (await import('node:fs')).writeFileSync(secret, 'sk-test');
    if (!existsSync(`${ws}/x`)) symlinkSync(secret, `${ws}/x`);
    let h2;
    apply(
      { on: (e, f) => { if (e === 'tools/execute') h2 = f; }, get: () => undefined },
      { home: join(BASE, '.koi'), allow: ['workspace'] },
    );
    const r = await h2({ name: 'read', arguments: { file_path: `${ws}/x` }, agent: undefined }, next);
    const got = r?.isError === true ? '拦' : '放行';
    const ok = got === '拦';
    ok ? pass += 1 : fail += 1;
    console.log(`${ok ? '✅' : '❌'} ${'workspace/x -> .env 软链'.padEnd(34)} ${got}${ok ? '' : ' (期望 拦)'}`);
  } catch (e) {
    // 等于这条安全测试**可以静默消失**。现在算失败。
    fail += 1;
    console.log(`❌ 软链测试 setup 失败: ${e.message}`);
  } finally {
    rmSync(BASE, { recursive: true, force: true });
  }
}

console.log('\n=== fs 规则：符号链接 + .. 穿越（review 2026-11-26 P1）===');
{
  /**
   * `workspace/link` 指向 `/`，路径写 `workspace/link/../etc/hostname`：
   * 字面 normalize 是 `workspace/etc/hostname`（不在白名单外），
   * 但内核解析成 `/etc/hostname`。原来只对**存在**的路径做 realpath，
   * 这个不存在的字面目标拿不到真实路径 → 判成放行 → 读到了白名单外。
   */
  const { mkdirSync, symlinkSync, rmSync } = await import('node:fs');
  const BASE = mkdtempSync(join(tmpdir(), 'koi-test-guard-dotdot-'));
  process.on('exit', () => { try { rmSync(BASE, { recursive: true, force: true }); } catch {} });
  const ws = join(BASE, '.koi/workspace');
  try {
    mkdirSync(ws, { recursive: true });
    try { symlinkSync('/', join(ws, 'up')); } catch { /* 已存在 */ }
    let h3;
    apply(
      { on: (e, f) => { if (e === 'tools/execute') h3 = f; }, get: () => undefined },
      { home: join(BASE, '.koi'), allow: ['workspace'] },
    );
    const r = await h3({ name: 'read', arguments: { file_path: `${ws}/up/../etc/hostname` }, agent: undefined }, next);
    const got = r?.isError === true ? '拦' : '放行';
    const ok = got === '拦';
    ok ? pass += 1 : fail += 1;
    console.log(`${ok ? '✅' : '❌'} ${'软链 + .. 穿越'.padEnd(34)} ${got}${ok ? '' : ' (期望 拦)'}`);
  } catch (e) {
    fail += 1;
    console.log(`❌ 软链+..测试 setup 失败: ${e.message}`);
  } finally {
    rmSync(BASE, { recursive: true, force: true });
  }
}

console.log('\n=== 写规则：符号链接 + .. 穿越（2026-11-26 第二轮 review）===');
{
  const { mkdirSync, symlinkSync, rmSync } = await import('node:fs');
  const BASE = mkdtempSync(join(tmpdir(), 'koi-test-guard-write-'));
  process.on('exit', () => { try { rmSync(BASE, { recursive: true, force: true }); } catch {} });
  const ws = join(BASE, 'workspace');
  const outside = join(BASE, 'outside');
  try {
    mkdirSync(ws, { recursive: true });
    mkdirSync(outside, { recursive: true });
    try { symlinkSync(BASE, join(ws, 'up')); } catch { /* 已存在 */ }
    let hw;
    apply(
      { on: (e, f) => { if (e === 'tools/execute') hw = f; }, get: () => undefined },
      { home: BASE, allow: ['workspace'] },
    );
    // 正常写：放行
    const okWrite = await hw({ name: 'write', arguments: { file_path: join(ws, 'a.md') }, agent: undefined }, next);
    const gotOk = okWrite?.isError === true ? '拦' : '放行';
    gotOk === '放行' ? pass += 1 : fail += 1;
    console.log(`${gotOk === '放行' ? '✅' : '❌'} ${'workspace 内正常写'.padEnd(34)} ${gotOk}`);
    // 穿越写：必须拒
    const esc = await hw({ name: 'write', arguments: { file_path: `${ws}/up/../outside/x.md` }, agent: undefined }, next);
    const gotEsc = esc?.isError === true ? '拦' : '放行';
    gotEsc === '拦' ? pass += 1 : fail += 1;
    console.log(`${gotEsc === '拦' ? '✅' : '❌'} ${'workspace/up/../outside 穿越写'.padEnd(34)} ${gotEsc}${gotEsc === '拦' ? '' : ' (期望 拦)'}`);
  } catch (e) {
    fail += 1;
    console.log(`❌ 写穿越测试 setup 失败: ${e.message}`);
  } finally {
    rmSync(BASE, { recursive: true, force: true });
  }
}

// 2026-11-10：send 规则已删（见 lib/index.js 头部说明）。
// 语义类判定不归代码管——原位置应该是 qqbot/通道层的确认。
// 这里不再测「谁说要发」，因为**代码不再判这件事**。

console.log('\n=== 不管的工具 ===');
await check('bash 不归它管', mkExec('bash', { command: 'ls' }), '放行');
await check('unknown 工具', mkExec('some_other_tool', {}), '放行');

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
