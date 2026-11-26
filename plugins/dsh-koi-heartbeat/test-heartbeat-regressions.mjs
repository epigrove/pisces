#!/usr/bin/env node
/**
 * heartbeat 回归：
 *   1. dailyCap 用最近 24 小时时间戳，而不是本地自然日计数。
 *   2. 自建会话模型按 配置 > 活会话继承 > 明确失败 选择。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from './lib/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const dirs = [];
let pass = 0;
let fail = 0;
const ok = (name, condition, extra = '') => {
  if (condition) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'koi-heartbeat-regression-'));
  dirs.push(dir);
  return dir;
}

function context({ listResults = [], onCreate, deferEffect = false } = {}) {
  const tools = {};
  const cleanups = [];
  const followups = [];
  let effectFn = null;
  let listCall = 0;
  const agents = {
    list() {
      const index = Math.min(listCall, Math.max(0, listResults.length - 1));
      listCall += 1;
      return listResults[index] ?? [];
    },
    resume: async () => { throw new Error('resume miss'); },
    create: async (options) => {
      if (onCreate) onCreate(options);
      return { agent: fakeAgent };
    },
  };
  const fakeAgent = {
    session: { id: 'heartbeat-fake', header: { delegationDepth: 0 }, snapshotEvents: () => [] },
    followup(event) { followups.push(event); },
  };
  const ctx = {
    get(name) {
      if (name === 'agents') return agents;
      return undefined;
    },
    tools: { register(tool) { tools[tool.name] = tool; } },
    effect(fn) {
      if (deferEffect) {
        effectFn = fn;
        return;
      }
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
  };
  return {
    ctx,
    tools,
    followups,
    runEffect() {
      const cleanup = effectFn?.();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return cleanup;
    },
    cleanup() {
      for (const fn of cleanups) {
        try { fn(); } catch { /* 测试清理 */ }
      }
    },
  };
}

function modelAgent(provider, model) {
  return {
    session: {
      id: `${provider}-${model}`,
      header: { delegationDepth: 0 },
      snapshotEvents: () => [{
        type: 'model/selection',
        time: Date.now(),
        data: { provider, model },
      }],
    },
    followup() {},
  };
}

async function waitFor(condition, timeoutMs = 1600) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

// ── 最近 24 小时窗口 ────────────────────────────────────────
{
  const dir = tempDir();
  const now = Date.now();
  writeFileSync(
    join(dir, 'heartbeat.json'),
    JSON.stringify({
      nextAt: now + 3600_000,
      wakeTimes: [now - 25 * 3600_000, now - 23 * 3600_000],
    }),
    'utf8',
  );
  const env = context();
  apply(env.ctx, {
    dir,
    dailyCap: 2,
    nightStartHour: 0,
    nightEndHour: 0,
    minGapMinutes: 1,
    maxGapMinutes: 2,
  });
  const status = await env.tools.heartbeat_status.execute({});
  ok('25 小时前的唤醒已移出额度窗口', status.includes('最近 24 小时已醒 1/2'), status);
  env.cleanup();
}

// ── 显式配置优先于活会话继承 ────────────────────────────────
{
  const dir = tempDir();
  const now = Date.now();
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({
    nextAt: now - 30_000,
    wakeTimes: [],
  }));
  const created = [];
  const live = modelAgent('inherited-p', 'inherited-m');
  const env = context({
    // 第一次 list 给 findAgent（空，触发 solo）；第二次给 ensureSoloAgent（可继承）。
    listResults: [[], [live]],
    onCreate(options) { created.push(options); },
  });
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    apply(env.ctx, {
      dir,
      provider: 'configured-p',
      model: 'configured-m',
      allowSolo: true,
      dailyCap: 8,
      nightStartHour: 0,
      nightEndHour: 0,
      minGapMinutes: 1,
      maxGapMinutes: 2,
    });
    await waitFor(() => env.followups.length > 0 || logs.some((line) => line.includes('跳过本次心跳')));
  } finally {
    console.log = originalLog;
    env.cleanup();
  }
  ok('显式 provider/model 优先', created[0]?.agentOptions?.provider === 'configured-p'
    && created[0]?.agentOptions?.model === 'configured-m', JSON.stringify(created[0]?.agentOptions));
  ok('模型解析后真正触发心跳', env.followups.length > 0, `followups=${env.followups.length}`);
  const source = readFileSync(join(HERE, 'lib/index.js'), 'utf8');
  ok('不再写死 provider/model', !source.includes('qwen-token-plan-cn')
    && !source.includes('deepseek-v4.1-flash-1017'));
}

// ── 无显式配置时从活会话继承 ────────────────────────────────
{
  const dir = tempDir();
  const now = Date.now();
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({
    nextAt: now - 30_000,
    wakeTimes: [],
  }));
  const created = [];
  const env = context({
    listResults: [[], [modelAgent('session-p', 'session-m')]],
    onCreate(options) { created.push(options); },
  });
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    apply(env.ctx, {
      dir,
      allowSolo: true,
      dailyCap: 8,
      nightStartHour: 0,
      nightEndHour: 0,
      minGapMinutes: 1,
      maxGapMinutes: 2,
    });
    await waitFor(() => created.length > 0 || logs.some((line) => line.includes('跳过本次心跳')));
  } finally {
    console.log = originalLog;
    env.cleanup();
  }
  ok('无配置时继承活会话模型', created[0]?.agentOptions?.provider === 'session-p'
    && created[0]?.agentOptions?.model === 'session-m', JSON.stringify(created[0]?.agentOptions));
}

// ── 配置和活会话都没有：明确报错并跳过，不创建会话 ──────────
{
  const dir = tempDir();
  const now = Date.now();
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({
    nextAt: now - 30_000,
    wakeTimes: [],
  }));
  const created = [];
  const logs = [];
  const originalLog = console.log;
  const env = context({
    listResults: [[], []],
    onCreate(options) { created.push(options); },
  });
  console.log = (...args) => logs.push(args.join(' '));
  try {
    apply(env.ctx, {
      dir,
      allowSolo: true,
      dailyCap: 8,
      nightStartHour: 0,
      nightEndHour: 0,
      minGapMinutes: 1,
      maxGapMinutes: 2,
    });
    await waitFor(() => logs.some((line) => line.includes('跳过本次心跳')));
  } finally {
    console.log = originalLog;
    env.cleanup();
  }
  ok('无模型来源时明确报错',
    logs.some((line) => line.includes('没有可用的 provider/model 配置') && line.includes('跳过本次心跳')),
    logs.join('\n'));
  ok('无模型来源时不创建会话', created.length === 0);
}

// ── 无会话契约：默认跳过并排下次，只有 allowSolo=true 才自建 ───────
{
  const dir = tempDir();
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({
    nextAt: Date.now() - 30_000,
    wakeTimes: [],
  }));
  const created = [];
  const logs = [];
  const originalLog = console.log;
  const env = context({
    listResults: [[]],
    onCreate(options) { created.push(options); },
  });
  console.log = (...args) => logs.push(args.join(' '));
  try {
    apply(env.ctx, {
      dir,
      provider: 'configured-p',
      model: 'configured-m',
      dailyCap: 8,
      nightStartHour: 0,
      nightEndHour: 0,
      minGapMinutes: 1,
      maxGapMinutes: 2,
    });
    await waitFor(() => logs.some((line) => line.includes('按契约跳过本次心跳')));
  } finally {
    console.log = originalLog;
    env.cleanup();
  }
  ok('默认无活会话时不自建会话', created.length === 0, JSON.stringify(created));
  ok('默认无活会话时不 followup', env.followups.length === 0);
  ok('默认无活会话时明确记日志并排下次',
    logs.some((line) => line.includes('按契约跳过本次心跳'))
      && logs.some((line) => line.includes('排定下一次')),
    logs.join('\n'));
}

// ── followup 同步抛错：不记 wakeTimes 配额 ─────────────────────
{
  const dir = tempDir();
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({
    nextAt: Date.now() - 30_000,
    wakeTimes: [],
  }));
  const throwing = {
    session: { id: 'main-throw', header: { delegationDepth: 0 }, snapshotEvents: () => [] },
    followup() { throw new Error('sync followup boom'); },
  };
  const logs = [];
  const originalLog = console.log;
  const env = context({ listResults: [[throwing]] });
  console.log = (...args) => logs.push(args.join(' '));
  try {
    apply(env.ctx, {
      dir,
      dailyCap: 8,
      nightStartHour: 0,
      nightEndHour: 0,
      minGapMinutes: 1,
      maxGapMinutes: 2,
    });
    await waitFor(() => logs.some((line) => line.includes('sync followup boom')));
  } finally {
    console.log = originalLog;
    env.cleanup();
  }
  const persisted = JSON.parse(readFileSync(join(dir, 'heartbeat.json'), 'utf8'));
  ok('followup 同步抛错不消耗唤醒额度',
    Array.isArray(persisted.wakeTimes) && persisted.wakeTimes.length === 0,
    JSON.stringify(persisted));
  ok('followup 同步抛错有日志', logs.some((line) => line.includes('sync followup boom')), logs.join('\n'));
}

// ── 状态保存失败不能静默：日志说明可能重排 ─────────────────────
{
  const dir = tempDir();
  const stateFile = join(dir, 'heartbeat.json');
  writeFileSync(stateFile, JSON.stringify({
    nextAt: Date.now() + 60,
    wakeTimes: [],
  }));
  const live = modelAgent('live-p', 'live-m');
  const logs = [];
  const originalLog = console.log;
  const env = context({ listResults: [[live]], deferEffect: true });
  console.log = (...args) => logs.push(args.join(' '));
  try {
    apply(env.ctx, {
      dir,
      dailyCap: 8,
      nightStartHour: 0,
      nightEndHour: 0,
      minGapMinutes: 1,
      maxGapMinutes: 2,
    });
    // 加载完成后把目标换成目录，让临时文件 fsync/rename 的最终提交失败。
    rmSync(stateFile, { force: true });
    mkdirSync(stateFile);
    env.runEffect();
    await waitFor(() => logs.some((line) => line.includes('状态保存失败')));
  } finally {
    console.log = originalLog;
    env.cleanup();
  }
  ok('状态保存失败明确打日志', logs.some((line) => line.includes('状态保存失败')), logs.join('\n'));
  ok('状态保存失败说明可能重排',
    logs.some((line) => line.includes('可能重排') && line.includes('重复唤醒')),
    logs.join('\n'));
}

for (const dir of dirs) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 测试清理 */ }
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
