#!/usr/bin/env node
/** dsh-koi-audit 回归：真实发送回执、签名语料、未测语义。 */
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as koiGate from 'dsh-koi-gate';
import { installSendLog } from 'dsh-koi-gate';
import {
  apply,
  isOutboundRow,
  recentChatText,
  shortRows,
} from './lib/index.js';

const D = mkdtempSync(join(tmpdir(), 'koi-audit-test-'));
process.env.KOI_HOME = D;
const koiDir = join(D, '.koi');
mkdirSync(koiDir, { recursive: true });
process.on('exit', () => { try { rmSync(D, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

function readRows(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function mount(file, gateOverride = undefined) {
  const handlers = new Map();
  const ctx = {
    on(type, fn) {
      const list = handlers.get(type) ?? [];
      list.push(fn);
      handlers.set(type, list);
    },
  };
  apply(ctx, { file }, gateOverride === undefined ? {} : { gate: gateOverride });
  return (session, event) => {
    for (const fn of handlers.get('session/event') ?? []) fn(session, event);
  };
}

function assistant(emit, sid, turn, step, text, source = {}) {
  emit({ id: sid }, {
    type: 'assistant/message',
    time: 123456 + turn * 10 + step,
    data: {
      turn,
      step,
      message: {
        source,
        content: [{ type: 'text', text }],
      },
    },
  });
}

// ── chat.jsonl：只信签名有效行，或 legacyLine 明确覆盖的未签名历史 ──
const chatKey = randomBytes(32).toString('hex');
const sigOf = (row) => createHmac('sha256', chatKey)
  .update([row.from ?? '', row.at ?? '', row.kind ?? '', row.text ?? ''].join('\n'), 'utf8')
  .digest('hex')
  .slice(0, 32);
const legacyRow = { from: 'ashu', at: 1, kind: 'chat', text: '旧话「旧签名」' };
const forgedRow = { from: 'ashu', at: 2, kind: 'chat', text: '手写「假话」' };
const signedRow = { from: 'master', at: 3, kind: 'chat', text: '确认「行吧」' };
const badSigRow = { from: 'ashu', at: 4, kind: 'chat', text: '改过的「坏签名」', sig: '0'.repeat(32) };
const koiRow = { from: 'koi', at: 5, kind: 'chat', text: '「不是语料」' };
writeFileSync(join(koiDir, 'chat.key'), `${chatKey}\n`, 'utf8');
writeFileSync(join(koiDir, 'chat.sign.json'), JSON.stringify({ v: 2, legacyLine: 0 }), 'utf8');
writeFileSync(join(koiDir, 'chat.jsonl'), [
  JSON.stringify(legacyRow),
  JSON.stringify(forgedRow),
  JSON.stringify({ ...signedRow, sig: sigOf(signedRow) }),
  JSON.stringify(badSigRow),
  JSON.stringify(koiRow),
].join('\n'));

const corpus = recentChatText(D);
ok('chat.jsonl 只收签名有效或明确 legacy 的人类行',
  corpus.readable && corpus.rows.length === 2
    && corpus.rows.some((r) => r.text.includes('旧签名'))
    && corpus.rows.some((r) => r.text.includes('行吧')),
  JSON.stringify(corpus));
ok('无签名/坏签名的不可信行都计入 corpusUnsigned',
  corpus.corpusUnsigned === 2 && !corpus.rows.some((r) => r.text.includes('假话')));
ok('坏签名从 corpusUnsigned 中单独再计数',
  corpus.corpusBadSignature === 1 && !corpus.rows.some((r) => r.text.includes('坏签名')));
ok('非人类来源不参与语料', !corpus.rows.some((r) => r.text.includes('不是语料')));

const missing = recentChatText(join(D, 'missing'));
ok('chat.jsonl 不存在时 readable=false', missing.readable === false && missing.rows.length === 0);

// ── 真实发送回执：成功、失败、无 assistant 正文的媒体发送 ──
const sendAudit = join(koiDir, 'audit-send.jsonl');
const emitSend = mount(sendAudit);
const sid = 'session-main-send';
emitSend({ id: sid }, {
  type: 'user/message',
  data: {
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Image: /tmp/flower.png' }],
  },
});

const sentText = '图里是红色的花（guard）';
assistant(emitSend, sid, 10, 1, sentText);
const bot = {
  sent: [],
  async send(opts) {
    const body = String(opts?.markdown?.content ?? '');
    if (body.includes('FAIL')) throw new Error('platform blocked');
    this.sent.push(opts);
    return { ok: true };
  },
  async sendMedia(opts) {
    this.sent.push(opts);
    return { ok: true };
  },
};
ok('gate 投递钩子装上', installSendLog(bot, () => {}));
await bot.send({
  target: { targetId: 'group-main' },
  markdown: { content: sentText },
  audit: { session: sid, turn: 10, step: 1 },
});

let rows = readRows(sendAudit);
let sentRow = rows.find((r) => r.auditId === `${sid}:10.1`);
ok('ok:true 落为 source=send / sendOk=true', sentRow?.source === 'send' && sentRow?.sendOk === true);
ok('真实回执记录 schema 3、target、status', sentRow?.schema === 3 && sentRow?.target === 'group-main' && sentRow?.status === 'sent');
ok('带图与括号分析保留', sentRow?.hasImageContext === true && sentRow?.hasVisualDetail === true && sentRow?.bracketInternal === true);
ok('成功回执计入外发', isOutboundRow(sentRow));

assistant(emitSend, sid, 10, 2, '这条会被平台拒绝');
let threw = false;
try {
  await bot.send({
    target: { targetId: 'group-main' },
    markdown: { content: 'FAIL' },
    audit: { session: sid, turn: 10, step: 2 },
  });
} catch {
  // 这条断言就是"它应该抛"：不关心错误内容，只关心有没有抛
  threw = true;
}
rows = readRows(sendAudit);
const failedRow = rows.find((r) => r.auditId === `${sid}:10.2`);
ok('平台失败仍抛给调用方', threw);
ok('ok:false 落 source=send / sendOk=false / sendFailed',
  failedRow?.source === 'send' && failedRow?.sendOk === false && failedRow?.status === 'sendFailed');
ok('失败回执不计入外发', !isOutboundRow(failedRow));

await bot.sendMedia({
  target: { targetId: 'group-media' },
  content: 'media-1234',
  audit: { session: sid, turn: 10, step: 3 },
});
rows = readRows(sendAudit);
const mediaRow = rows.find((r) => r.auditId === `${sid}:10.3`);
ok('媒体发送无 assistant 正文也不漏记',
  mediaRow?.source === 'send' && mediaRow?.sendOk === true && mediaRow?.chars === 10,
  JSON.stringify(mediaRow));
ok('媒体记录分析字段明确标为未测', mediaRow?.hasImageContext === null && mediaRow?.bracketInternal === null);

assistant(emitSend, sid, 10, 4, '#静默#');
rows = readRows(sendAudit);
const silenceRow = rows.find((r) => r.auditId === `${sid}:10.4`);
ok('静默词记 dropped=silence，不冒充回执',
  silenceRow?.source === 'assistant' && silenceRow?.sendOk === null && silenceRow?.dropped === 'silence');
ok('静默记录不计入外发', !isOutboundRow(silenceRow));

assistant(emitSend, sid, 10, 5, '睡了');
emitSend({ id: sid }, { type: 'turn/end', data: { turn: 10 } });
rows = readRows(sendAudit);
const exitRow = rows.find((r) => r.auditId === `${sid}:10.5`);
ok('退场候选无真实回执时在 turn/end 记 dropped=exit',
  exitRow?.source === 'assistant' && exitRow?.sendOk === null && exitRow?.dropped === 'exit');

// ── 旧 gate 没有 onSendResult：退回 assistant/message ──
const fallbackAudit = join(koiDir, 'audit-fallback.jsonl');
const emitFallback = mount(fallbackAudit, {
  SILENCE_TOKEN: koiGate.SILENCE_TOKEN,
  EXIT_RE: koiGate.EXIT_RE,
});
const fallbackSid = 'session-main-fallback';
assistant(emitFallback, fallbackSid, 1, 1, '旧 gate 下的正常回复');
rows = readRows(fallbackAudit);
const fallbackRow = rows.find((r) => r.auditId === `${fallbackSid}:1.1`);
ok('旧 gate 退回 assistant/message 且 source=assistant',
  fallbackRow?.source === 'assistant' && fallbackRow?.sendOk === null);
ok('兼容记录保留 schema 3 的新字段', fallbackRow?.schema === 3 && fallbackRow?.dropped === null && fallbackRow?.status === 'unmeasured');

const brokenGateAudit = join(koiDir, 'audit-broken-gate.jsonl');
const emitBrokenGate = mount(brokenGateAudit, {
  SILENCE_TOKEN: koiGate.SILENCE_TOKEN,
  EXIT_RE: koiGate.EXIT_RE,
  onSendResult() { throw new Error('old runtime'); },
});
assistant(emitBrokenGate, 'session-main-broken-gate', 1, 1, '订阅失败也要留记录');
rows = readRows(brokenGateAudit);
const brokenGateRow = rows.find((r) => r.auditId === 'session-main-broken-gate:1.1');
ok('onSendResult 订阅抛错时真正退回 assistant/message', brokenGateRow?.source === 'assistant');

// ── ops 引号：未签名或坏签名不能给伪造引号背书 ──
const opsSid = 'session-chat-ops-test';
assistant(emitSend, opsSid, 20, 1, '他说「行吧」，还提了「假话」和「坏签名」。');
rows = readRows(sendAudit);
const opsRow = rows.find((r) => r.auditId === `${opsSid}:20.1`);
ok('ops 记录带 corpusUnsigned 数量', opsRow?.channel === 'ops' && opsRow?.corpusUnsigned === 2);
ok('有效签名引号为 found', opsRow?.quoteTiers?.find((t) => t.q === '行吧')?.tier === 'found');
ok('无签名伪行不能给引号背书', opsRow?.quoteTiers?.find((t) => t.q === '假话')?.tier === 'unknown');
ok('坏签名伪行不能给引号背书', opsRow?.quoteTiers?.find((t) => t.q === '坏签名')?.tier === 'unknown');

// ── shortRows：所有相关文件读完且无坏行才算 measured ──
const measuredHome = mkdtempSync(join(tmpdir(), 'koi-audit-short-'));
const shortDir = join(measuredHome, '.koi', 'short');
mkdirSync(shortDir, { recursive: true });
process.on('exit', () => { try { rmSync(measuredHome, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });
const shortFile = (n) => join(shortDir, `2026-01-0${n}.jsonl`);
for (let i = 1; i <= 5; i += 1) {
  writeFileSync(shortFile(i), `${JSON.stringify({ r: 'u', w: '运维方', x: `历史 ${i}` })}\n`, 'utf8');
}
writeFileSync(shortFile(3), `${JSON.stringify({ r: 'u', w: '运维方', x: '历史 3' })}\n{坏行}\n`, 'utf8');
let short = shortRows(measuredHome);
ok('最近文件里有一行坏 JSON 时 readable=false', short.readable === false && short.recentBadLines === 1);

const shortAudit = join(measuredHome, '.koi', 'audit.jsonl');
const emitShort = mount(shortAudit, {
  SILENCE_TOKEN: koiGate.SILENCE_TOKEN,
  EXIT_RE: koiGate.EXIT_RE,
});
process.env.KOI_HOME = measuredHome;
const shortSid = 'session-main-short';
emitShort({ id: shortSid }, {
  type: 'user/message',
  data: { source: { kind: 'user' }, content: [{ type: 'text', text: '今天还好' }] },
});
assistant(emitShort, shortSid, 1, 1, '她说「并不存在」');
rows = readRows(shortAudit);
let shortRow = rows.find((r) => r.auditId === `${shortSid}:1.1`);
ok('近端语料不完整时 tier=unmeasured',
  shortRow?.quoteTiers?.[0]?.tier === 'unmeasured', JSON.stringify(shortRow?.quoteTiers));
ok('unmeasured 不混成 quoteUnverified=false/unknown',
  shortRow?.quoteUnverified === null && !shortRow?.quoteMisses?.includes('并不存在'));

for (let i = 1; i <= 5; i += 1) {
  writeFileSync(shortFile(i), `${JSON.stringify({ r: 'u', w: '运维方', x: `历史 ${i}` })}\n`, 'utf8');
}
short = shortRows(measuredHome);
ok('五个相关文件都成功且无坏行时 readable=true', short.readable === true);

writeFileSync(join(shortDir, '2025-12-31.jsonl'), '{旧文件坏行}\n', 'utf8');
short = shortRows(measuredHome);
ok('更早文件坏行不污染近端 readable，但 olderReadable=false',
  short.readable === true && short.olderReadable === false && short.olderBadLines === 1);

assistant(emitShort, shortSid, 1, 2, '她说「仍不存在」');
rows = readRows(shortAudit);
shortRow = rows.find((r) => r.auditId === `${shortSid}:1.2`);
ok('远端语料不完整时负结论记 unmeasured',
  shortRow?.quoteTiers?.[0]?.tier === 'unmeasured' && shortRow?.olderCorpusReadable === false);

writeFileSync(join(shortDir, '2025-12-31.jsonl'), `${JSON.stringify({ r: 'u', w: '运维方', x: '旧历史' })}\n`, 'utf8');
assistant(emitShort, shortSid, 1, 3, '她说「确实不存在」');
rows = readRows(shortAudit);
shortRow = rows.find((r) => r.auditId === `${shortSid}:1.3`);
ok('全部语料完整时负结论才记 unknown',
  shortRow?.quoteTiers?.[0]?.tier === 'unknown' && shortRow?.quoteUnverified === true,
  JSON.stringify(shortRow));

const source = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8');
ok('gate 通过包名 dsh-koi-gate 导入', source.includes("await import('dsh-koi-gate')"));
ok('未使用的 MAXQ 常量已移除', !source.includes('const MAXQ'));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
