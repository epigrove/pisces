#!/usr/bin/env node
/**
 * dsh-koi-gate（原 dsh-koi-selftalk）的回归测试。
 *
 * 门控的两级里，第一级是纯信号判断（不调模型），可以直接测。
 * 第二级要模型，这里用假 ctx 模拟「要 / 不要」两种回答。
 */
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const D = mkdtempSync(join(tmpdir(), 'koi-selftalk-'));
process.env.KOI_HOME = D;
process.env.KOI_AGENT_NAME = '测试agent';
process.env.QQBOT_ALIASES = '测试(agent[1';
mkdirSync(join(D, '.koi'), { recursive: true });
process.on('exit', () => { try { rmSync(D, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

const { createGate } = await import("./lib/index.js");

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

/** createGate 直接返回中间件；bot 参数只是给 installSelftalk 用的壳。 */
function makeGate(ctx = {}, config = {}) {
  return createGate({ use: () => {} }, ctx, config);
}

/**
 * 跑一条消息，返回有没有被放行到下一步。
 * c 需要 stop()——门控用它无声地"掐断"这条消息。
 */
async function run(mw, message) {
  return (await runDetailed(mw, message)).passed;
}

async function runDetailed(mw, message) {
  let passed = false;
  let stopped = false;
  let stoppedBy = '';
  await mw({
    message,
    stop: (reason) => { stopped = true; stoppedBy = String(reason ?? ''); },
  }, async () => { passed = true; });
  return { passed, stopped, stoppedBy };
}

// ── 非群聊：直接放行 ──────────────────────────────────────
{
  const mw = makeGate({});
  ok('私聊 → 放行', await run(mw, { kind: 'c2c', content: '你好' }) === true);
}

// ── @ 别人：不接 ──────────────────────────────────────────
{
  const mw = makeGate({});
  // mentions 全是别人的 openid
  const msg = {
    kind: 'group',
    groupOpenid: 'g-at-other',
    content: '<@other-openid> 你看这个',
    mentions: [{ user_openid: 'other-openid', is_you: false }],
  };
  ok('@ 别人 → 不接', await run(mw, msg) === false);
}

// ── 机器人发的：不接 ──────────────────────────────────────
{
  const mw = makeGate({});
  const msg = {
    kind: 'group', groupOpenid: 'g-bot', content: '定时提醒', senderIsBot: true,
  };
  ok('机器人消息 → 不接', await run(mw, msg) === false);
}

// ── 消息太碎：攒不够不叫 ──────────────────────────────────
{
  const mw = makeGate({});
  const g = 'g-thin';
  // 单条、没 @、没提名字
  const first = await run(mw, { kind: 'group', groupOpenid: g, content: '今天好累' });
  ok('单条无关消息 → 不叫（攒不够）', first === false);
}

// ── 模型说「不要」：不叫 ──────────────────────────────────
{
  const llm = {
    listProviders: () => [{ id: 'test' }],
    stream: async function* () {
      yield { type: 'text-delta', text: '不要' };
    },
  };
  const mw = makeGate({ get: (k) => (k === 'llm' ? llm : undefined), config: {} });
  const g = 'g-judge-no';
  let passed = false;
  // 攒够条数
  for (let i = 0; i < 4; i += 1) {
    passed = await run(mw, { kind: 'group', groupOpenid: g, content: `闲聊第 ${i} 句`, senderName: '某人' });
  }
  ok('模型判「不要」→ 不叫', passed === false);
}

// ── 模型说「要」：叫 ──────────────────────────────────────
{
  const llm = {
    listProviders: () => [{ id: 'test' }],
    stream: async function* () {
      yield { type: 'text-delta', text: '要' };
    },
  };
  const mw = makeGate({ get: (k) => (k === 'llm' ? llm : undefined), config: {} });
  const g = 'g-judge-yes';
  let passed = false;
  for (let i = 0; i < 4; i += 1) {
    passed = await run(mw, { kind: 'group', groupOpenid: g, content: `这件事你怎么看 ${i}`, senderName: '某人' });
  }
  ok('模型判「要」→ 叫', passed === true);
}

// ── 名字被点名：硬放行，不问模型 ───────────────────────────
{
  let asked = false;
  const llm = {
    listProviders: () => [{ id: 'test' }],
    stream: async function* () { asked = true; yield { type: 'text-delta', text: '不要' }; },
  };
  const mw = makeGate({ get: (k) => (k === 'llm' ? llm : undefined), config: {} });
  const passed = await run(mw, {
    kind: 'group',
    groupOpenid: 'g-named',
    content: '测试(agent[1 你来说说',
    senderName: '某人',
  });
  ok('正文点名 → 直接放行', passed === true);
  ok('正文点名 → 没问模型', asked === false);
}

// ── 别名含正则元字符：按字面量初始化并匹配 ─────────────────
{
  const mw = makeGate({});
  const passed = await run(mw, {
    kind: 'group',
    groupOpenid: 'g-regex-alias',
    content: '测试(agent[1 在吗',
    senderName: '某人',
  });
ok('别名含未闭合 ()[ → 初始化不抛错且按字面量命中', passed === true);
}

// ── 对端别名由配置提供，开源默认不包含任何具体昵称 ─────────
{
  const mw = makeGate({}, { rivalAliases: ['甲鱼', '乙鱼'] });
  const first = await run(mw, {
    kind: 'group', groupOpenid: 'g-rival-a', content: '甲鱼 在吗', senderName: '某人',
  });
  const second = await run(mw, {
    kind: 'group', groupOpenid: 'g-rival-b', content: '乙鱼 在吗', senderName: '某人',
  });
  ok('rivalAliases 配置项命中每个配置别名', first === true && second === true, `${first}/${second}`);
}
{
  const mw = makeGate({});
  const passed = await run(mw, {
    kind: 'group',
    groupOpenid: 'g-rival-empty',
    content: '甲鱼 乙鱼 丙鱼 在吗',
    senderName: '某人',
  });
  ok('rivalAliases 默认为空数组，不命中任何词', passed === false);
}

// ── 批窗口按 gid:senderId 分开 ─────────────────────────────
{
  const mw = makeGate({});
  const first = await runDetailed(mw, {
    kind: 'group', groupOpenid: 'g-same-sender', senderId: 'alice', content: '第一句',
  });
  const second = await runDetailed(mw, {
    kind: 'group', groupOpenid: 'g-same-sender', senderId: 'alice', content: '第二句',
  });
  ok('同一人批窗口内的 thin 仍 stop（保留省钱行为）',
    first.stoppedBy === 'selftalk-quiet' && second.stoppedBy === 'selftalk-repeat');
}
{
  const mw = makeGate({});
  await runDetailed(mw, {
    kind: 'group', groupOpenid: 'g-cross-sender', senderId: 'alice', content: '甲先说',
  });
  const bob = await runDetailed(mw, {
    kind: 'group', groupOpenid: 'g-cross-sender', senderId: 'bob', content: '乙接着说',
  });
  ok('同群另一个人的首条 thin 不落进甲的重发窗口', bob.stoppedBy === 'selftalk-quiet');
}

{
  const source = readFileSync(new URL('./lib/selftalk-gate.mjs', import.meta.url), 'utf8');
  ok('gate 死变量与重复批窗口默认值已删除',
    !/\b(CONSEC|MERGE_MS|lastBotText|batchAtByGroup|BATCH_MS|MASTER)\b/.test(source));
}

// ── 说话人事件的顺序边界写清楚；状态归 lexicon，不归 gate ──
{
  const source = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8');
  ok('gate 注释说明 assemble 先于 user/message，修复点在 lexicon 的 agent/inbox/claimed',
    source.includes('system-prompt/assemble') && source.includes('user/message')
      && source.includes('agent/inbox/claimed'));
}

// ── 关掉开关：全部放行 ────────────────────────────────────
{
  process.env.QQBOT_SELFTALK_OFF = '1';
  const mw = makeGate({});
  const passed = await run(mw, { kind: 'group', groupOpenid: 'g-off', content: '随便说说' });
  ok('SELFTALK_OFF=1 → 全部放行', passed === true);
  delete process.env.QQBOT_SELFTALK_OFF;
}


// ── 出站投递日志（B3，2026-11-24）──────────────────────────
{
  const { installSendLog, onSendResult } = await import('./lib/index.js');
  const logs = [];
  const results = [];
  // 按真实 SDK 的形状造：sendMarkdown(target, content) 内部走 this.send({target, markdown:{content}})
  const bot = {
    sent: [],
    async send(opts) {
      if (String(opts?.markdown?.content ?? '').includes('FAIL')) throw new Error('platform blocked');
      this.sent.push(opts);
      return { ok: true };
    },
    sendMarkdown(target, content) {
      return this.send({ target, markdown: { content } });
    },
  };
  const off = onSendResult((r) => results.push(r));
  const first = installSendLog(bot, (m) => logs.push(m), () => ({ session: 's1', turn: 4, step: 2 }));
  const second = installSendLog(bot, (m) => logs.push(m));
  await bot.sendMarkdown({ targetId: 'g1' }, 'hi');
  let threw = false;
  try { await bot.sendMarkdown({ targetId: 'g1' }, 'FAIL'); } catch { threw = true; }
  off();
  ok('投递日志：第一次装上返回 true', first === true);
  ok('投递日志：重复安装幂等', second === false);
  ok('投递日志：sendMarkdown 只记一行（不重复）', logs.filter((l) => l.includes('via=send ')).length === 2);
  ok('投递日志：记到真实 target 和长度', logs.some((l) => l.startsWith('[send] ok') && l.includes('target=g1') && l.includes('len=2')));
  ok('投递日志：带可关联的 session/turn/step/ok/len',
    logs.some((l) => l.startsWith('[send] ok') && /session=s1 turn=4 step=2 target=g1 ok=true len=2/.test(l)),
    logs.join('\n'));
  ok('投递日志：失败记错误信息并原样抛出', threw && logs.some((l) => l.startsWith('[send] failed') && l.includes('platform blocked')));
  ok('发送结果回调：成功和失败都消费同一份真实回执',
    results.length === 2
      && results[0]?.ok === true
      && results[1]?.ok === false
      && results[0]?.session === 's1'
      && results[0]?.turn === '4'
      && results[0]?.step === '2'
      && results.every((r) => 'target' in r && 'len' in r),
    JSON.stringify(results));
}

// ── 日志不能把成功变成失败（codex review P3，2026-11-24）────
{
  const { installSendLog } = await import('./lib/index.js');
  const bot = { async send() { return 'sent'; } };
  // 让 log sink 每次都抛：包装层必须吞掉，不能影响返回值
  installSendLog(bot, () => { throw new Error('log sink down'); });
  let threw = false;
  let value;
  try { value = await bot.send({ target: { targetId: 'g' }, content: 'hi' }); } catch { threw = true; }
  ok('日志 sink 抛错时：发送依然成功', threw === false && value === 'sent');
}
// ── 流式路径也要有记录 ─────────────────────────────────────
{
  const { installSendLog } = await import('./lib/index.js');
  const logs = [];
  const session = { async update(t) { this.text = t; }, async complete() { return 'done'; } };
  const bot = { openStream() { return session; } };  // openStream(opts) → session
  installSendLog(bot, (m) => logs.push(m));
  const s = bot.openStream({ target: { targetId: 'g2' } });
  await s.update('hello');
  await s.complete();
  ok('流式：openStream 打开的 session 上 update/complete 都记了',
    logs.some((l) => l.includes('via=stream.update') && l.startsWith('[send] ok')) &&
    logs.some((l) => l.includes('via=stream.complete') && l.startsWith('[send] ok')));
}


// ── 附件发送也要有记录（review P2，2026-11-24）──────────────
{
  const { installSendLog } = await import('./lib/index.js');
  const logs = [];
  const bot = { async sendMedia() { return 'media-sent'; } };
  installSendLog(bot, (m) => logs.push(m));
  const r = await bot.sendMedia({ target: { targetId: 'g3' } });
  ok('附件：sendMedia 记一行且带 kind=media',
    r === 'media-sent' && logs.some((l) => l.startsWith('[send] ok') && l.includes('via=sendMedia') && l.includes('target=g3')));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
