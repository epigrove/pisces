#!/usr/bin/env node
/**
 * relay 回归：chat.jsonl 暂时不可读时，不能把水位重置成“空文件尾部”。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from './lib/index.js';
import { idOf } from '../dsh-koi-chat/lib/chat-store.js';

const dirs = [];
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

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ashu-relay-unreadable-'));
  dirs.push(dir);
  return dir;
}

function fakeContext(list = []) {
  let effect = null;
  return {
    ctx: {
      get: () => ({ list: () => list }),
      effect(fn) { effect = fn; },
    },
    runEffect() { return effect?.(); },
  };
}

// 已有水位 7；读失败不能因 tail=-1 误判为文件被截断。
{
  const dir = tempDir();
  const chatFile = join(dir, 'chat.jsonl');
  const stateFile = join(dir, 'state.json');
  mkdirSync(chatFile);
  writeFileSync(stateFile, JSON.stringify({ version: 2, lastLine: 7, lastId: 'keep' }), 'utf8');
  const env = fakeContext();
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let cleanup;
  try {
    apply(env.ctx, {
      chatFile,
      stateFile,
      legacyStateFile: join(dir, 'legacy.json'),
      minutes: 60,
    });
    cleanup = env.runEffect();
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    console.log = originalLog;
    cleanup?.();
  }
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  ok('读失败时水位保持不变', state.lastLine === 7 && state.lastId === 'keep', JSON.stringify(state));
  ok('读失败不进入“截断→重置基线”分支',
    logs.some((line) => line.includes('会话记录暂不可读，本轮跳过'))
      && !logs.some((line) => line.includes('检测到水位回退')),
    logs.join('\n'));
}

// 首次启动就读不到：不能写一个空文件基线把历史永久跳过。
{
  const dir = tempDir();
  const chatFile = join(dir, 'chat.jsonl');
  const stateFile = join(dir, 'state.json');
  mkdirSync(chatFile);
  const env = fakeContext();
  const originalLog = console.log;
  console.log = () => {};
  let cleanup;
  try {
    apply(env.ctx, {
      chatFile,
      stateFile,
      legacyStateFile: join(dir, 'legacy.json'),
      minutes: 60,
    });
    cleanup = env.runEffect();
  } finally {
    console.log = originalLog;
    cleanup?.();
  }
  ok('首次启动读失败时不写入错误基线', !existsSync(stateFile),
    existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : '');
}

// ── followup 已入队但保存失败：不报已提醒，保留旧水位并退避 ────────
{
  const dir = tempDir();
  const chatFile = join(dir, 'chat.jsonl');
  const stateFile = join(dir, 'state.json');
  const got = [];
  const agent = {
    session: { id: 'main-session', header: { delegationDepth: 0 }, snapshotEvents: () => [] },
    followup(event) { got.push(event); },
  };
  writeFileSync(chatFile, `${JSON.stringify({ from: 'koi', to: 'ashu', text: '保存失败也要重放' })}\n`, 'utf8');
  writeFileSync(stateFile, JSON.stringify({ version: 2, lastLine: -1, lastId: '' }), 'utf8');
  const env = fakeContext([agent]);
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let cleanup;
  try {
    apply(env.ctx, {
      chatFile,
      stateFile,
      legacyStateFile: join(dir, 'legacy.json'),
      minutes: 1,
    });
    // 状态已在 load() 读取完；现在让最终 rename 失败。
    rmSync(stateFile, { force: true });
    mkdirSync(stateFile);
    cleanup = env.runEffect();
    await new Promise((resolve) => setTimeout(resolve, 40));
  } finally {
    console.log = originalLog;
    cleanup?.();
  }
  ok('followup 已经真正入队', got.length === 1, `followups=${got.length}`);
  ok('保存失败时不打印“已提醒”',
    !logs.some((line) => line.includes('已提醒 1 条')), logs.join('\n'));
  ok('保存失败时记录未提交水位',
    logs.some((line) => line.includes('未提交水位 -1 → 0')), logs.join('\n'));
  ok('保存失败后退避重试并说明宁可重复',
    logs.some((line) => line.includes('分钟后仍从 -1 重试') && line.includes('宁可重复')),
    logs.join('\n'));
}

// ── 坏状态：先备份，沿可恢复的 lastId 锚点重放积压 ────────────────
{
  const dir = tempDir();
  const chatFile = join(dir, 'chat.jsonl');
  const stateFile = join(dir, 'state.json');
  const firstLine = JSON.stringify({ from: 'koi', to: 'ashu', text: '已经提醒过的旧消息' });
  const secondLine = JSON.stringify({ from: 'koi', to: 'ashu', text: '坏状态后的积压消息' });
  const anchorId = idOf(firstLine);
  writeFileSync(chatFile, `${firstLine}\n${secondLine}\n`, 'utf8');
  writeFileSync(stateFile, `{"version":2,"lastId":"${anchorId}",`, 'utf8');

  const got = [];
  const agent = {
    session: { id: 'main-session', header: { delegationDepth: 0 }, snapshotEvents: () => [] },
    followup(event) { got.push(event); },
  };
  const env = fakeContext([agent]);
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let cleanup;
  try {
    apply(env.ctx, {
      chatFile,
      stateFile,
      legacyStateFile: join(dir, 'legacy.json'),
      minutes: 60,
    });
    cleanup = env.runEffect();
    await new Promise((resolve) => setTimeout(resolve, 40));
  } finally {
    console.log = originalLog;
    cleanup?.();
  }

  const backups = readdirSync(dir).filter((name) => name.startsWith('state.json.corrupt-'));
  ok('坏状态先备份为 .corrupt-*', backups.length === 1, backups.join(','));
  ok('日志明确恢复锚点选择了可恢复的 lastId',
    logs.some((line) => line.includes('坏状态恢复锚点：消息 id')
      && line.includes(anchorId) && line.includes('第 0 行')),
    logs.join('\n'));
  ok('锚点后的积压消息仍会投递', got.some((event) => JSON.stringify(event).includes('坏状态后的积压消息')));
  ok('已提醒锚点后的积压后有成功日志',
    logs.some((line) => line.includes('已提醒 1 条')), logs.join('\n'));
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  ok('成功投递后水位才提交到尾部', state.lastLine === 1, JSON.stringify(state));
}

for (const dir of dirs) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 测试清理 */ }
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
