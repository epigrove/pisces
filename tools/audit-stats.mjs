#!/usr/bin/env node
/**
 * 外发审计统计（2026-11-22）
 *
 * 读 `.koi/audit.jsonl`，回答两个问题：
 *   1. 带图的回复里，多少条没提任何视觉细节？
 *   2. 括号里出现内部词的，有几条？
 *
 * **数字只能当线索，不能当结论**：
 * 判定用的是一张手写词表，它判不准。所以每一条都带原文抽样，
 * 人自己看，别看百分比。
 *
 * 用法：
 *   node ops/audit-stats.mjs            # 近 7 天
 *   node ops/audit-stats.mjs --days 30
 *   node ops/audit-stats.mjs --json     # 给别的程序读
 *   node ops/audit-stats.mjs --file <路径>  # 指定流水文件
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（ops/ 的上一级）——默认路径要靠它，否则在仓库里跑会找错 HOME */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const allowEmpty = args.includes('--allow-empty');
const die = (msg) => {
  if (asJson) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error(msg);
  process.exit(2);
};
const daysArg = args.indexOf('--days');
let days = 7;
if (daysArg !== -1) {
  const v = Number(args[daysArg + 1]);
  // 参数写错就报错退出，别拿 NaN 当成"零条结果"——那会被误当成"很干净"
  if (!Number.isFinite(v) || v <= 0) die(`--days 要一个正数，收到「${args[daysArg + 1] ?? ''}」`);
  days = v;
}

const fileArg = args.indexOf('--file');
if (fileArg !== -1 && (args[fileArg + 1] === undefined || String(args[fileArg + 1]).startsWith('--'))) {
  die('--file 后面要跟一个路径');
}
const file = fileArg !== -1
  ? String(args[fileArg + 1])
  : join(process.env.KOI_HOME ?? REPO_ROOT, '.koi', 'audit.jsonl');
if (!existsSync(file)) {
  const msg = `没有审计流水：${file}（插件 dsh-koi-audit 起来之后才会有）`;
  // 缺流水默认是失败；只有调用方明确允许空数据时才返回 0。
  if (asJson) console.log(JSON.stringify({ ok: allowEmpty, empty: allowEmpty, error: allowEmpty ? undefined : msg, file, rows: 0 }));
  else console.log(msg);
  process.exit(allowEmpty ? 0 : 2);
}

let raw;
try {
  raw = readFileSync(file, 'utf8');
} catch (err) {
  // 目录、没权限、特殊文件：existsSync 都会说"在"，读到才炸
  die(`审计流水读不了：${file}（${err instanceof Error ? err.message : String(err)}）`);
}

const since = Date.now() - days * 86400_000;
const rows = [];
let bad = 0;
let legacy = 0;
for (const line of raw.split('\n')) {
  if (line.trim() === '') continue;
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    bad += 1; // 坏行计数，不静默
    continue;
  }
  // 合法 JSON 但不是对象（null、数字、字符串）也算坏行，别让报告崩在半路
  if (r === null || typeof r !== 'object' || Array.isArray(r)) {
    bad += 1;
    continue;
  }
  // at 缺失/非数字也算坏行：否则它会悄悄消失，只让总数变少
  // 不能用 Number() 强制：null / '' / false / [] 都会被转成 0，混成 1970 年的记录
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) {
    bad += 1;
    continue;
  }
  if (Number(r.at) >= since) {
    // schema < 2 的是旧判据写的：单独计数，不进百分比（否则会把旧误判算成她的历史）
    if (Number(r.schema ?? 1) < 2) legacy += 1;
    else rows.push(r);
  }
}

// 排序键用 YYYY-MM-DD（可字典序比较），显示才用 M/D
const dayKey = (ts) => {
  const d = new Date(Number(ts ?? 0));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// 仅用于展示
const day = (ts) => {
  const d = new Date(Number(ts ?? 0));
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
const hhmm = (ts) => {
  const d = new Date(Number(ts ?? 0));
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * 2026-11-26 codex review P2：ops 通道的行也在这份流水里，
 * 但"外发 N 条"必须只算 QQ 外发，否则统计口径会虚高。
 */
/**
 * 2026-11-26 schema 3：**外发的口径以平台回执为准**。
 *   - `sendOk === false` → 发送失败，不算外发（单列 sendFailed）
 *   - `dropped` 非空 → 被 allow 拦下（静默词/退场），不算外发（单列 dropped）
 *   - `sendOk === null`（旧行或 gate 未装上）→ 兼容，算外发但要能量出占比
 * 只有旧行（schema<3）没有这些字段，保持原来的"channel !== ops"判据。
 */
const isOutbound = (r) => {
  if (r.channel === 'ops') return false;
  if (r.dropped !== undefined && r.dropped !== null && r.dropped !== '') return false;
  if (r.sendOk === false) return false;
  return true;
};
const outboundRows = rows.filter(isOutbound);
const opsRows = rows.filter((r) => r.channel === 'ops');
const sendFailed = rows.filter((r) => r.sendOk === false);
const droppedRows = rows.filter((r) => r.dropped !== undefined && r.dropped !== null && r.dropped !== '');
const unmeasuredSend = outboundRows.filter((r) => r.sendOk === null || r.sendOk === undefined);
const imageRows = outboundRows.filter((r) => r.hasImageContext === true);
const imageNoDetail = imageRows.filter((r) => r.hasVisualDetail === false);
const bracketRows = rows.filter((r) => r.bracketInternal === true);
/** 引号里的话在短期记忆里找不到原文（= 照印象转述），需要保留供回看 */
const quoteRows = rows.filter((r) => r.quoteUnverified === true);
/** 张冠李戴：话确实有，但不是当前这个人说的 */
const misattributed = rows.filter((r) => r.quoteMisattributed === true);
/** 三档里"aged"（记忆淡了但确实说过）单独数，避免误判为编造 */
const quoteAged = rows.filter((r) => Array.isArray(r.quoteTiers) && r.quoteTiers.some((t) => t.tier === 'aged'));
/** 引号里是自己的概念（给东西起名那类），不是引用别人 */
const quoteSelf = rows.filter((r) => Array.isArray(r.quoteTiers) && r.quoteTiers.length > 0
  && r.quoteTiers.every((t) => t.tier === 'self'));
/** 更早的记忆读不到时，"查不到"不能算定论（和 aged 那档同一个道理） */
const quoteAgedUnreadable = rows.filter((r) => r.olderCorpusReadable === false);
// ops 通道的引号检查也在这份流水里（channel: 'ops'）
/** 有引号但没测成的（短期记忆读不到）——要单独报，别让 0 看起来像"很干净" */
const quoteUnmeasured = rows.filter((r) => r.quoteUnverified === null && Number(r.quotes ?? 0) > 0);

const pct = (a, b) => (b === 0 ? '—' : `${Math.round((a / b) * 100)}%`);

// 按天趋势：能看出"有没有越改越好"
const byDay = new Map();
for (const r of outboundRows) {
  const k = dayKey(r.at);
  const cur = byDay.get(k) ?? { out: 0, img: 0, noDetail: 0, bracket: 0 };
  cur.out += 1;
  if (r.hasImageContext === true) {
    cur.img += 1;
    if (r.hasVisualDetail === false) cur.noDetail += 1;
  }
  if (r.bracketInternal === true) cur.bracket += 1;
  byDay.set(k, cur);
}

const result = {
  file,
  days,
  rows: outboundRows.length,
  sendFailed: sendFailed.length,
  dropped: droppedRows.length,
  sendUnmeasured: unmeasuredSend.length,
  opsRows: opsRows.length,
  badLines: bad,
  legacyRows: legacy,
  imageTurns: imageRows.length,
  imageWithoutDetail: imageNoDetail.length,
  imageWithoutDetailRate: pct(imageNoDetail.length, imageRows.length),
  bracketInternal: bracketRows.length,
  quoteUnverified: quoteRows.length,
  quoteMisattributed: misattributed.length,
  quoteAged: quoteAged.length,
  quoteSelf: quoteSelf.length,
  quoteUnmeasured: quoteUnmeasured.length,
  samples: {
    imageWithoutDetail: imageNoDetail.slice(-10).map((r) => ({
      at: r.at, when: `${day(r.at)} ${hhmm(r.at)}`, sample: r.sample, auditId: r.auditId,
    })),
    bracketInternal: bracketRows.slice(-10).map((r) => ({
      at: r.at, when: `${day(r.at)} ${hhmm(r.at)}`, sample: r.sample, hits: r.bracketHits, auditId: r.auditId,
    })),
  },
  byDay: [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => ({ day: k, label: `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`, ...v })),
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

console.log(`外发审计 · 近 ${days} 天（读 ${file}）`);
console.log(`外发 ${result.rows} 条${result.opsRows > 0 ? `（另有 ops 通道 ${result.opsRows} 条，单独统计）` : ''}${bad > 0 ? `（另有 ${bad} 行读不了）` : ''}`
  + `${legacy > 0 ? `；旧判据记录 ${legacy} 条，未计入（v1 用单字词表，会误判）` : ''}`);
console.log('');
if (imageRows.length === 0) {
  console.log('带图轮次：这段时间没有（没什么可看的）');
} else {
  console.log(`带图轮次：${imageRows.length} 条`);
  console.log(`  其中提了视觉细节：${imageRows.length - imageNoDetail.length} 条`);
  console.log(`  没提：${imageNoDetail.length} 条（${result.imageWithoutDetailRate}）`);
  if (imageNoDetail.length > 0) {
    console.log('  原文抽样（自己看，别只看百分比）：');
    for (const s of result.samples.imageWithoutDetail) console.log(`   - ${s.when}「${String(s.sample).replace(/\n/g, ' ').slice(0, 50)}」`);
  }
}
console.log('');
console.log(`括号里出现内部词：${bracketRows.length} 条`);
for (const s of result.samples.bracketInternal) {
  console.log(`   - ${s.when}「${String(s.sample).replace(/\n/g, ' ').slice(0, 50)}」← ${(s.hits ?? []).join(' / ')}`);
}
console.log('');
if (sendFailed.length > 0 || droppedRows.length > 0 || unmeasuredSend.length > 0) {
  console.log(
    `外发口径：发送失败 ${sendFailed.length} 条 / 被拦下 ${droppedRows.length} 条 / 未测（旧行或无回执）${unmeasuredSend.length} 条`,
  );
}
console.log(`引号有出处、但不是当前这个人说的（张冠李戴）：${misattributed.length} 条`);
for (const m of misattributed.slice(-5)) {
  const who = (m.quoteTiers ?? []).filter((t) => t.tier === 'found' && (t.by ?? []).length > 0)
    .map((t) => `「${String(t.q).slice(0, 16)}」=${(t.by ?? []).join('/')}`);
  console.log(`   - ${day(m.at)} ${hhmm(m.at)} ← ${who.join(' ')}`);
}
console.log(`引号只在更早的记忆里找得到（记忆淡了，不是编的）：${quoteAged.length} 条`);
console.log(`引号里是自己的概念（不是引用别人）：${quoteSelf.length} 条`
  + `${quoteAgedUnreadable.length > 0 ? `；另有 ${quoteAgedUnreadable.length} 条更早记忆读不到，"查不到"不算定论` : ''}`);
console.log(`引号哪里都查不到：${quoteRows.length} 条`
  + `${quoteUnmeasured.length > 0 ? `（另有 ${quoteUnmeasured.length} 条没测成：语料读不到——QQ 行看短期记忆，ops 行看 chat.jsonl）` : ''}`);
for (const s2 of quoteRows.slice(-10).map((r) => ({
  when: `${day(r.at)} ${hhmm(r.at)}`,
  sample: String(r.sample ?? '').replace(/\n/g, ' ').slice(0, 50),
  misses: r.quoteMisses ?? [],
}))) {
  console.log(`   - ${s2.when}「${s2.sample}」← ${s2.misses.join(' / ')}`);
}
console.log('');
if (byDay.size > 0) {
  console.log('按天（看趋势，不看不出一两条的波动）：');
  for (const d of result.byDay) {
    console.log(`   ${d.label}：外发 ${d.out}｜带图 ${d.img}｜没描述 ${d.noDetail}｜括号内部词 ${d.bracket}`);
  }
  console.log('');
}
console.log('提醒：判定用的是一张手写词表，它判不准。数字只能当线索，原文才算证据。');
