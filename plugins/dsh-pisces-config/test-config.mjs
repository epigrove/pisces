#!/usr/bin/env node
/**
 * dsh-pisces-config 的单测 —— 纯函数，零 IO。
 *
 * 为什么必须有：
 *   这个包回答两个问题（用哪个模型、投给哪个会话），被 koi 的插件和 ashu 的 relay
 *   同时 import。它一旦算错，表现是「消息投到没人看的会话」或「用错模型」——
 *   **不报错**，只是行为慢慢不对。这种问题只能靠判据挡住。
 *
 * 2026-11-17 补：此前这个包完全没有测试，而 QUICKSTART 还指向已删除的包。
 */
import { isSubAgent, idOf, lastHumanAt, pickAgent, pickModel, resolveKoiDataDir } from './lib/ai-config.mjs';
import { join, resolve } from 'node:path';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

/** 造一个 agent：给定事件序列和委派深度。 */
function mkAgent(id, { events = [], depth = 0, followup = true, lastActivity = 0 } = {}) {
  return {
    ...(followup ? { followup() {} } : {}),
    lastActivity,
    session: {
      id,
      header: { delegationDepth: depth, createdAt: 0 },
      ownEvents: () => events,
    },
  };
}

const human = (time) => ({ type: 'user/message', time, data: { source: { kind: 'user' } } });
const injected = (time, kind) => ({ type: 'user/message', time, data: { source: { kind } } });
const relayed = (time, id) => ({ type: 'user/message', time, id, data: { source: { kind: 'user' } } });

// ── 身份字段 ──────────────────────────────────────────
ok('idOf 取 session.id', idOf(mkAgent('session-a')) === 'session-a');
ok('idOf 兜底取 id', idOf({ id: 'plain' }) === 'plain');
ok('idOf 空对象不抛', idOf({}) === '');
ok('主 agent：delegationDepth 0', isSubAgent(mkAgent('a')) === false);
ok('子 agent：delegationDepth > 0', isSubAgent(mkAgent('a', { depth: 2 })) === true);

// ── lastHumanAt：谁算「人真的说了话」 ──────────────────
ok('人说的话 → 取时间', lastHumanAt(mkAgent('a', { events: [human(1000)] })) === 1000);
ok('空事件 → 0', lastHumanAt(mkAgent('a')) === 0);
for (const kind of ['time-context', 'agent-instructions', 'skill-catalog', 'runtime-context', 'model-selection', 'schedule', 'subagent-settled', 'tool-jobs']) {
  ok(`${kind} 不算人说话`, lastHumanAt(mkAgent('a', { events: [injected(9999, kind)] })) === 0);
}
ok('relay 注入的消息不算人说话',
  lastHumanAt(mkAgent('a', { events: [relayed(9999, 'ashu-relay-x')] })) === 0);
ok('多个来源取最后一条人的',
  lastHumanAt(mkAgent('a', { events: [human(100), injected(5000, 'time-context'), human(300)] })) === 300);

// ── pickAgent：投给谁 ────────────────────────────────
ok('空列表 → null', pickAgent([]) === null);
ok('没有 followup 的会话不能用', pickAgent([mkAgent('a', { followup: false })]) === null);
ok('钉住的优先', pickAgent([
  mkAgent('old', { events: [human(100)] }),
  mkAgent('pinned', { events: [] }),
], { sessionId: 'pinned' })?.session.id === 'pinned');
ok('钉住的不在列表 → 退回自动挑', pickAgent([
  mkAgent('a', { events: [human(500)] }),
], { sessionId: 'gone' })?.session.id === 'a');
ok('人最后说话的优先', pickAgent([
  mkAgent('early', { events: [human(100)] }),
  mkAgent('late', { events: [human(900)] }),
])?.session.id === 'late');
ok('子 agent 不会被选中', pickAgent([
  mkAgent('sub', { events: [human(9999)], depth: 3 }),
  mkAgent('main', { events: [human(100)] }),
])?.session.id === 'main');
ok('只被注入唤醒过的会话不抢主会话',
  pickAgent([
    mkAgent('injectedOnly', { events: [injected(9999, 'schedule')], lastActivity: 9999 }),
    mkAgent('talked', { events: [human(100)] }),
  ])?.session.id === 'talked');

// ── pickModel：默认模型怎么来 ────────────────────────
ok('没有活会话 → 用 fallback',
  pickModel([], { provider: 'p1', model: 'm1' }).provider === 'p1');
ok('没有活会话也没有 fallback → 空',
  pickModel([]).provider === '');
ok('从活会话里继承最近用过的模型', (() => {
  const a = mkAgent('a', {
    events: [{ type: 'model/selection', time: 500, data: { provider: 'p2', model: 'm2' } }],
  });
  const r = pickModel([a], { provider: 'p1', model: 'm1' });
  return r.provider === 'p2' && r.model === 'm2';
})());

console.log('\n=== 数据目录 ===');
const dataRoot = '/tmp/koi-resolve-test';
ok('config.dir 最优先', resolveKoiDataDir({
  dir: join(dataRoot, 'configured/'),
  koiHome: join(dataRoot, 'koi-home'),
  home: join(dataRoot, 'home'),
}) === resolve(dataRoot, 'configured'));
ok('KOI_HOME 次优先并补 .koi', resolveKoiDataDir({
  koiHome: join(dataRoot, 'koi-home/'),
  home: join(dataRoot, 'home'),
}) === resolve(dataRoot, 'koi-home', '.koi'));
ok('HOME 最后兜底并补 .koi', resolveKoiDataDir({
  home: join(dataRoot, 'home/'),
}) === resolve(dataRoot, 'home', '.koi'));
ok('末尾斜杠返回归一化绝对路径', resolveKoiDataDir({
  dir: `${dataRoot}/configured///`,
}) === resolve(dataRoot, 'configured'));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
