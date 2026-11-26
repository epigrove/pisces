#!/usr/bin/env node
/**
 * test-deliver.mjs —— 姐妹通道真的能把消息送到吗（端到端）
 *
 * 2026-11-13 写这个的原因：codex review 抓到 P1 ——
 *   chat 里调用了 pickAgent / pickModel，但 import 那行漏了。
 *   `node --check` 查不出（语法没错），调用又都在 try/catch 里，
 *   所以 ReferenceError 被吞成一个 null：消息送不出去，一个字都不报。
 *
 *   真实日志里的样子（抓之前已经在发生）：
 *     [koi-chat] 建会话失败: pickModel is not defined
 *     [koi-chat] 没有可用会话，下轮再试
 *
 * 原有测试都在测零件（store / sign / inject-limit），没有一个测**主流程**。
 * 这个文件测三条：
 *   A. 静态：dsh-pisces-session 的函数必须真的被 import（不是注释里提一下）
 *   B. assemble 路径：运维方的消息要出现在注入给她的提示词里
 *   C. wake 路径：要真的调用 agent.followup（这条就是漏 import 时挂的）
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { apply } from './lib/index.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const HERE = dirname(fileURLToPath(import.meta.url));

// ── A. 静态：跨包调用真的 import 了 ─────────────────────────
//
// 2026-11-16 起不写死函数名（原来断言 'pickModel'，改名后测试就假失败）。
// 改成**从源码推导**：找出所有「被调用、且不是本地定义的」标识符，
// 逐个核对它出现在某个 import 语句里。
//
// 这类错误的杀伤力：漏 import 的 ReferenceError 会被外层 catch 吞掉，
// 表现只是"投递没发生"，日志里看不出原因。
{
  const src = readFileSync(join(HERE, 'lib/index.js'), 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')       // 去块注释
    .replace(/(?<![:\w])\/\/[^\n]*/g, '');  // 去行注释


  // 本地定义的（function / const / let / class）不算
  const localDefs = new Set(
    [...code.matchAll(/(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  );
  // 从 import 里绑定的名字
  const imported = new Set(
    [...code.matchAll(/import\s*\{([^}]*)\}\s*from/g)]
      .flatMap((m) => m[1].split(','))
      .map((x) => x.trim().split(/\s+as\s+/).pop().trim())
      .filter(Boolean),
  );

  // 被调用的标识符里，既不是本地定义、也不是内置的
  // 关键词/常见回调参数名不是调用；漏掉它们会在括号前误判。
  const BUILTIN = new Set(['require', 'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON',
    'Math', 'Date', 'Set', 'Map', 'Promise', 'Error', 'RegExp', 'parseInt', 'parseFloat',
    'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'Symbol', 'WeakMap', 'WeakSet',
    // 关键词
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'async', 'await',
    // 常见回调形参
    'next', 'execute', 'handler', 'cb', 'resolve', 'reject', 'log', 'map', 'filter', 'forEach',
    // 全局定时器
    'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask']);
  const called = new Set(
    [...code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]),
  );
  const suspect = [...called].filter((n) => !localDefs.has(n) && !imported.has(n) && !BUILTIN.has(n));

  ok('跨包调用都有对应 import',
    suspect.length === 0,
    suspect.length ? `这些被调用但没 import：${suspect.join(', ')}` : '');
  // 从「去掉 import 行之后」的正文里找，否则 code.includes(n) 恒真（import 语句本身就在 code 里）
  const body = code.split('\n').filter((l) => !/^\s*import\s/.test(l)).join('\n');
  const unused = [...imported].filter((n) => !new RegExp('(?<![.\\w$])' + n + '\\b').test(body));
  ok('import 的符号真的在正文里用到',
    unused.length === 0,
    unused.length ? `导入了但没用到：${unused.join(', ')}` : '');
}

/**
 * 每条路径用一个**独立环境**。
 * 不能共用：assemble 跑完会把消息标成已读并推进游标，wake 就没东西可送了。
 */
function makeEnv(text = '你在吗') {
  const D = mkdtempSync(join(tmpdir(), 'koi-test-deliver-'));
  process.on('exit', () => { try { rmSync(D, { recursive: true, force: true }); } catch { /* 忽略 */ } });
  writeFileSync(join(D, 'chat.jsonl'), JSON.stringify({ from: 'ashu', at: Date.now(), text }) + '\n');
  writeFileSync(
    join(D, 'chat.state.json'),
    JSON.stringify({ chatSessionId: 'session-chat-ashu-fixed' }),
    'utf8',
  );

  const got = [];
  const fakeAgent = {
    session: {
      id: 'session-chat-ashu-fixed',
      header: { delegationDepth: 0 },
      snapshotEvents: () => [{ type: 'user/message', time: Date.now(), data: { id: 'm1', source: { kind: 'user' } } }],
    },
    lastActivity: Date.now(),
    followup(ev) { got.push(ev); },
  };
  const hooks = {};
  const ctx = {
    on(name, fn) { hooks[name] = fn; },
    tool() {},
    tools: { register() {} },
    // effect 必须真的调用回调：wake 的定时器就注册在里面，空实现等于不启动
    effect(fn) { const cleanup = fn(); return cleanup; },
    get(name) { return name === 'agents' ? { list: () => [fakeAgent] } : undefined; },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { D, hooks, got, ctx };
}

// ── B. assemble 路径 ─────────────────────────────────────
{
  const { D, hooks, ctx } = makeEnv();
  apply(ctx, { dir: D, injectLimit: 10, wakeMinutes: 60 });
  const handler = hooks['system-prompt/assemble'];
  ok('注册了 system-prompt/assemble', typeof handler === 'function');
  if (typeof handler === 'function') {
    const out = await handler(
      { sections: [] },
      { session: { id: 'session-chat-ashu-fixed' } },
      async () => ({ sections: [] }),
    );
    ok('注入内容包含运维方的原话', JSON.stringify(out).includes('你在吗'),
      '注入路径没把消息放进提示词');
  }
}

// ── C. wake 路径（漏 import 时挂的就是这条）────────────────
const wakeEnv = makeEnv('这条走 wake');  // 独立目录，不跟 assemble 抢消息
const { got } = wakeEnv;
apply(wakeEnv.ctx, { dir: wakeEnv.D, injectLimit: 10, wakeMinutes: 0.002 });
await new Promise((r) => setTimeout(r, 500));
ok('wake 路径调用了 agent.followup', got.length > 0,
  '没调用 —— 通常是 pickAgent/pickModel 未定义被 catch 吞了');
ok('交给 agent 的正文包含原话', got.some((e) => JSON.stringify(e).includes('这条走 wake')));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
