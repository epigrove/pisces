#!/usr/bin/env node
/**
 * chat 回归：来源标签、原子已处理快照、超长消息拒收、旧实现清理。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from './lib/index.js';
import { resolveIterateRoute } from './lib/iterate.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'koi-chat-regression-'));
  dirs.push(dir);
  return dir;
}

function fakeContext() {
  const hooks = {};
  const tools = {};
  const cleanups = [];
  return {
    hooks,
    tools,
    ctx: {
      on(name, fn) { hooks[name] = fn; },
      get() { return undefined; },
      tools: { register(tool) { tools[tool.name] = tool; } },
      effect(fn) {
        const cleanup = fn();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
      },
      logger: { info() {}, warn() {}, error() {} },
    },
    cleanup() {
      for (const fn of cleanups) {
        try { fn(); } catch { /* 测试清理 */ }
      }
    },
  };
}

async function assembleOnce(hooks, sessionId = 'session-chat-regression') {
  const out = await hooks['system-prompt/assemble'](
    { sections: [] },
    { session: { id: sessionId }, agent: { id: sessionId } },
    async () => ({ sections: [] }),
  );
  return (out.sections ?? []).map((section) => String(section.text)).join('\n');
}

function emitTurnEnd(hooks, sessionId = 'session-chat-regression', data = {}) {
  hooks['session/event']?.({ id: sessionId }, { type: 'turn/end', data });
}

// ── ops 会话隔离：只有 session-chat-* 能读取和提交 ops 消息 ─────────
{
  const dir = tempDir();
  writeFileSync(
    join(dir, 'chat.jsonl'),
    `${JSON.stringify({ from: 'ashu', at: Date.now(), text: '只给专用聊天会话的私聊' })}\n`,
    'utf8',
  );
  writeFileSync(join(dir, 'chat.sign.json'), JSON.stringify({ v: 2, legacyLine: -1 }), 'utf8');
  const env = fakeContext();
  apply(env.ctx, { dir, injectLimit: 10, wakeMinutes: 60, masterPollSeconds: 0 });
  const unrelated = await assembleOnce(env.hooks, 'session-xyz');
  ok('非 chat 会话拿不到 ops 注入', !unrelated.includes('只给专用聊天会话的私聊'), unrelated);
  ok('非 chat 会话 assemble 不创建已读快照', !existsSync(join(dir, 'chat.read-state.koi.json')));
  emitTurnEnd(env.hooks, 'session-xyz');
  const chat = await assembleOnce(env.hooks, 'session-chat-abc');
  ok('session-chat-abc 仍拿到同一条 ops 注入', chat.includes('只给专用聊天会话的私聊'), chat);
  env.cleanup();
}

// ── 来源标签：主人必须显示成主人，不能冒充运维方 ────────────────
{
  const dir = tempDir();
  writeFileSync(
    join(dir, 'chat.jsonl'),
    `${JSON.stringify({ from: 'master', at: Date.now(), text: '面板里说的话' })}\n`,
    'utf8',
  );
  // 新消息且未签名，顺带验证可信度提示也使用来源标签。
  writeFileSync(join(dir, 'chat.sign.json'), JSON.stringify({ v: 2, legacyLine: -1 }), 'utf8');
  const env = fakeContext();
  apply(env.ctx, { dir, injectLimit: 10, wakeMinutes: 60, masterPollSeconds: 0 });
  const text = await assembleOnce(env.hooks);
  ok('主人来源标题使用来源标签', text.includes('【主人找你说话】'), text);
  ok('主人来源消息前缀使用来源标签', text.includes('- 主人【未署名·可能不是主人】：面板里说的话'), text);
  ok('主人来源提示句使用来源标签', text.includes('是主人在跟你说话'), text);
  ok('主人消息不冒充运维方', !text.includes('运维方') && !text.includes('ashu'), text);
  env.cleanup();
}

// ── 一个原子快照同时提交 cursor 和 seen ───────────────────────
{
  const dir = tempDir();
  writeFileSync(
    join(dir, 'chat.jsonl'),
    `${JSON.stringify({ from: 'master', at: Date.now(), text: '快照测试' })}\n`,
    'utf8',
  );
  const env = fakeContext();
  apply(env.ctx, { dir, injectLimit: 10, wakeMinutes: 60, masterPollSeconds: 0 });
  await assembleOnce(env.hooks);
  emitTurnEnd(env.hooks);
  const statePath = join(dir, 'chat.read-state.koi.json');
  ok('已处理位置快照已写入', existsSync(statePath));
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  ok('快照内同时有游标', state.cursors?.master === 1, JSON.stringify(state));
  ok('快照内同时有 seen', Array.isArray(state.seen) && state.seen.length === 1, JSON.stringify(state));
  ok(
    '不再写旧的分布式游标/seen 文件',
    !existsSync(join(dir, 'chat.seen.koi'))
      && !existsSync(join(dir, 'chat.cursor.koi'))
      && !existsSync(join(dir, 'chat.cursor.koi.master')),
  );
  env.cleanup();
}

// ── assemble 只暂存；失败轮重放，成功轮只注入一次 ───────────────
{
  const dir = tempDir();
  writeFileSync(
    join(dir, 'chat.jsonl'),
    `${JSON.stringify({ from: 'master', at: Date.now(), text: '交付成功才推进' })}\n`,
    'utf8',
  );
  const env = fakeContext();
  apply(env.ctx, { dir, injectLimit: 10, wakeMinutes: 60, masterPollSeconds: 0 });
  const first = await assembleOnce(env.hooks);
  ok('assemble 阶段先注入但不写快照', first.includes('交付成功才推进')
    && !existsSync(join(dir, 'chat.read-state.koi.json')), first);
  emitTurnEnd(env.hooks, 'session-chat-regression', { status: 'failed', error: '模拟请求失败' });
  ok('turn/end(error) 后仍不写快照', !existsSync(join(dir, 'chat.read-state.koi.json')));
  const retry = await assembleOnce(env.hooks);
  ok('失败后的下一轮重放同一条消息', retry.includes('交付成功才推进'), retry);
  emitTurnEnd(env.hooks);
  ok('成功 turn/end 后才提交快照', existsSync(join(dir, 'chat.read-state.koi.json')));
  const afterSuccess = await assembleOnce(env.hooks);
  ok('成功交付后的下一轮不再重复注入', !afterSuccess.includes('交付成功才推进'), afterSuccess);
  env.cleanup();
}

// ── 快照保存失败：消息重复可见，位置绝不推进 ─────────────────
{
  const dir = tempDir();
  writeFileSync(
    join(dir, 'chat.jsonl'),
    `${JSON.stringify({ from: 'master', at: Date.now(), text: '保存失败也不能丢' })}\n`,
    'utf8',
  );
  // 目标路径是目录，临时文件能写但 rename 替换必然失败。
  mkdirSync(join(dir, 'chat.read-state.koi.json'));
  const env = fakeContext();
  apply(env.ctx, { dir, injectLimit: 10, wakeMinutes: 60, masterPollSeconds: 0 });
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let first = '';
  let second = '';
  try {
    first = await assembleOnce(env.hooks);
    emitTurnEnd(env.hooks);
    second = await assembleOnce(env.hooks);
    emitTurnEnd(env.hooks);
  } finally {
    console.log = originalLog;
  }
  ok('保存失败时第一轮仍能看到消息', first.includes('保存失败也不能丢'), first);
  ok('保存失败时下一轮允许重复，而不是漏消息', second.includes('保存失败也不能丢'), second);
  ok('快照保存失败有日志', logs.some((line) => line.includes('快照保存失败，本轮不推进')), logs.join('\n'));
  env.cleanup();
}

// ── talk_to_sister 不再静默截断 ─────────────────────────────
{
  const dir = tempDir();
  const env = fakeContext();
  apply(env.ctx, { dir, injectLimit: 10, wakeMinutes: 60, masterPollSeconds: 0 });
  const result = await env.tools.talk_to_sister.execute({ text: '长'.repeat(4001) });
  ok('超长消息错误文本与发送失败口径一致',
    result === '没发出去：消息有 4001 字，超过 4000 字上限。请分成几条发。', result);
  ok('超长消息明确拒收', result.includes('没发出去') && result.includes('超过 4000 字上限'), result);
  ok('超长消息提示分段', result.includes('分成几条发'), result);
  ok('拒收后没有写入 chat.jsonl', !existsSync(join(dir, 'chat.jsonl')));
  env.cleanup();
}

// ── chat.jsonl 不可读：注入明说暂不可读，不冒充空会话，也不推进游标 ──
{
  const dir = tempDir();
  mkdirSync(join(dir, 'chat.jsonl'));
  const env = fakeContext();
  apply(env.ctx, { dir, injectLimit: 10, wakeMinutes: 60, masterPollSeconds: 0 });
  const text = await assembleOnce(env.hooks);
  ok('注入侧区分“暂不可读”和“没有对话”', text.includes('会话记录暂不可读'), text);
  ok('读失败不写已处理游标', !existsSync(join(dir, 'chat.read-state.koi.json')));
  const sent = await env.tools.talk_to_sister.execute({ text: '这条不该猜收件人' });
  ok('读失败时发送工具也不假装发出', sent.includes('会话记录暂不可读') && sent.includes('没发出去'), sent);
  env.cleanup();
}

// ── 面板 injectLimit 热更新：每次 assemble 重读 override ─────────────
{
  const dir = tempDir();
  writeFileSync(
    join(dir, 'chat.jsonl'),
    ['一', '二', '三'].map((text) => JSON.stringify({ from: 'master', at: Date.now(), text })).join('\n') + '\n',
    'utf8',
  );
  writeFileSync(join(dir, 'ashu-config.json'), JSON.stringify({ defaults: { injectLimit: 1 } }), 'utf8');
  const env = fakeContext();
  apply(env.ctx, { dir, wakeMinutes: 60, masterPollSeconds: 0 });
  const first = await assembleOnce(env.hooks);
  ok('首轮读取面板 injectLimit=1', first.includes('一') && !first.includes('二'), first);
  emitTurnEnd(env.hooks);
  writeFileSync(join(dir, 'ashu-config.json'), JSON.stringify({ defaults: { injectLimit: 2 } }), 'utf8');
  const second = await assembleOnce(env.hooks);
  ok('修改面板后下一轮 injectLimit=2 立即生效', second.includes('二') && second.includes('三'), second);
  env.cleanup();
}

// ── 面板模型热更新：ensureChatAgent 建会话前重读 override ────────────
{
  const dir = tempDir();
  const chatFile = join(dir, 'chat.jsonl');
  const created = [];
  const agents = {
    list: () => [],
    resume: async () => { throw new Error('no session'); },
    create: async ({ agentOptions }) => {
      created.push(agentOptions);
      return { followup() {} };
    },
  };
  writeFileSync(chatFile, `${JSON.stringify({ from: 'master', at: Date.now(), text: '先建主人会话' })}\n`, 'utf8');
  writeFileSync(
    join(dir, 'ashu-config.json'),
    JSON.stringify({ api: { mode: 'fixed', provider: 'p1', model: 'm1' } }),
    'utf8',
  );
  const env = fakeContext();
  env.ctx.get = (name) => (name === 'agents' ? agents : undefined);
  apply(env.ctx, { dir, wakeMinutes: 0.001, masterPollSeconds: 0.01 });
  const waitFor = async (n) => {
    for (let i = 0; i < 100 && created.length < n; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await waitFor(1);
  writeFileSync(
    join(dir, 'ashu-config.json'),
    JSON.stringify({ api: { mode: 'fixed', provider: 'p2', model: 'm2' } }),
    'utf8',
  );
  appendFileSync(chatFile, `${JSON.stringify({ from: 'ashu', at: Date.now(), text: '再建运维方会话' })}\n`, 'utf8');
  await waitFor(2);
  ok('面板换模型后，下一次 ensureChatAgent 使用新配置',
    created[0]?.provider === 'p1' && created[0]?.model === 'm1'
      && created[1]?.provider === 'p2' && created[1]?.model === 'm2',
    JSON.stringify(created));
  env.cleanup();
}

// ── 找不到专用聊天会话时不能回退到任意群聊主会话 ─────────────────
{
  const dir = tempDir();
  writeFileSync(
    join(dir, 'chat.jsonl'),
    `${JSON.stringify({ from: 'ashu', at: Date.now(), text: '不能塞进群聊' })}\n`,
    'utf8',
  );
  let unrelatedFollowups = 0;
  const unrelated = {
    session: { id: 'session-group-main', header: { delegationDepth: 0 }, snapshotEvents: () => [] },
    followup() { unrelatedFollowups += 1; },
  };
  const env = fakeContext();
  env.ctx.get = (name) => (name === 'agents'
    ? { list: () => [unrelated] }
    : undefined);
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    apply(env.ctx, { dir, injectLimit: 10, wakeMinutes: 0.001, masterPollSeconds: 0 });
    await new Promise((resolve) => setTimeout(resolve, 180));
  } finally {
    console.log = originalLog;
    env.cleanup();
  }
  ok('找不到聊天会话时不向任意主会话 followup', unrelatedFollowups === 0, `followups=${unrelatedFollowups}`);
  ok('找不到聊天会话时明确跳过并打日志',
    logs.some((line) => line.includes('运维方这条线没有可用会话')), logs.join('\n'));
}

// ── 旧 LLM/人设实现已删除 ───────────────────────────────────
{
  const source = readFileSync(join(HERE, 'lib/index.js'), 'utf8');
  ok(
    '死变量和人设读取已删除',
    !/\b(?:AGENT_NAME|personaFile|coreFile|readSafe)\b/.test(source),
  );
  ok('旧「直接调 LLM + 人设」注释已删除', !source.includes('直接用 llm + 她的人设'));
}

// ── 04:00 模型路由：面板 fixed → 活会话 → 环境变量 → 明确未配置 ─────
{
  const live = [{
    session: {
      id: 'live-model',
      header: { delegationDepth: 0 },
      snapshotEvents: () => [{
        type: 'model/selection',
        time: Date.now(),
        data: { provider: 'session-p', model: 'session-m' },
      }],
    },
    followup() {},
  }];
  const panel = resolveIterateRoute({
    override: { api: { mode: 'fixed', provider: 'panel-p', model: 'panel-m' } },
    live,
    env: { MODEL_PROVIDER: 'env-p', MODEL_NAME: 'env-m' },
  });
  ok('提案路由优先使用面板 fixed 配置',
    panel.route?.provider === 'panel-p' && panel.route?.model === 'panel-m',
    JSON.stringify(panel));

  const inherited = resolveIterateRoute({
    override: { api: { mode: 'follow' } },
    live,
    env: { MODEL_PROVIDER: 'env-p', MODEL_NAME: 'env-m' },
  });
  ok('没有面板配置时从活会话 pickModel 继承',
    inherited.route?.provider === 'session-p' && inherited.route?.model === 'session-m',
    JSON.stringify(inherited));

  const fromEnv = resolveIterateRoute({
    override: {},
    live: [],
    env: { MODEL_PROVIDER: 'env-p', MODEL_NAME: 'env-m' },
  });
  ok('没有面板和活会话时使用环境变量',
    fromEnv.route?.provider === 'env-p' && fromEnv.route?.model === 'env-m',
    JSON.stringify(fromEnv));

  const none = resolveIterateRoute({ override: {}, live: [], env: {} });
  ok('三处都没有时不产生空 provider/model 请求',
    none.route === null && none.source === 'none', JSON.stringify(none));
}

for (const dir of dirs) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 测试清理 */ }
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
