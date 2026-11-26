/**
 * 数据迁移 v2 → v3
 *
 * 把旧的「指数衰减」数据结构迁到新的「印象曲线」。
 *
 *   旧：weight = 2^(-(Δt/half)^shape)          —— 永远到不了 0
 *   新：weight = a·log_b(x+1) + 1              —— 会真正归零
 *
 * 这个脚本只做数据搬运，不改插件代码。
 *
 * 用法：
 *   node tools/migrate-v2.mjs --dry-run    # 只看对比，不写文件（默认）
 *   node tools/migrate-v2.mjs --apply      # 真的写（先备份）
 *
 * 迁移目标：
 *   lexicon.people[*].traits     → items[] type=desc       ✅ 迁
 *   lexicon.people[*].history    → archive（不迁）          ❌ 账归账，看法归看法
 *   lexicon.things[*]            → items[] type=impression ✅ 迁（这是她的喜恶，不是账）
 *   affect.moodEvents[*]         → archive（不迁）          ❌ 情绪事件是账
 *
 * 事件流水是账，不是看法；不能拿单次「这人让我舒服」直接充当人物印象。
 * 账可以保留为参考，但不要放进「我怎么看这人」的评价栏。
 *
 * 账不删，挪进 archive，recall 时能翻到原样。
 *
 * 注意区分（2026-11-08 修正过一次）：
 *   people.history  = 账（说话让我舒服）→ 归档
 *   things          = 喜恶（被叫agent）→ 迁移
 *
 * 硬约束：迁移后**分数必须能复算**。
 * 但新旧公式不同，分数本来就会变——所以这里只保证：
 *   1. 条目一条不少（除明确跳过的 dormant/superseded/decay）
 *   2. 每条的 delta / 时间 原样保留
 *   3. 新参数与原参数在半衰点对齐（见 halfToCurve）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const KOI = resolveKoiRoot();
const LEX_FILE = join(KOI, '.koi', 'lexicon.json');
const AFF_FILE = join(KOI, '.koi', 'affect.json');
const OUT_DIR = join(KOI, '.koi', 'migrate-v2');

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const DRY = !APPLY; // 默认 dry-run

function resolveKoiRoot() {
  // 显式指定优先。否则脚本从仓库里运行时可能先撞上用户的 ~/.koi，
  // 命令行的 KOI_HOME 就被静默忽略，隔离测试也失去意义。
  if (process.env.KOI_HOME) return process.env.KOI_HOME;
  // 从本文件位置往上找 .koi 目录
  const here = dirname(fileURLToPath(import.meta.url));
  let cur = here;
  for (let i = 0; i < 5; i += 1) {
    if (existsSync(join(cur, '.koi'))) return cur;
    cur = dirname(cur);
  }
  // 兜底：脚本被放在任意位置时用 HOME
  return homedir();
}

const j = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

function writeTextAtomic(p, text) {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, p);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* 临时文件可能还没创建 */ }
    throw err;
  }
}

// ── 曲线参数转换 ────────────────────────────────────────────────

/**
 * 把旧的 (half, shape) 指数曲线，转成新的 (a, b) 对数曲线。
 *
 * 原则：**让新的曲线在「半衰点」穿过 0.5**，也就是 x = half 时 weight = 0.5。
 *
 *   a·log_b(half + 1) + 1 = 0.5
 *   a·log_b(half + 1) = -0.5
 *
 * 一个方程两个未知数，所以固定 b = 2（log 底数取 2，好算也好解释），
 * 解出 a：
 *
 *   a = -0.5 / log₂(half + 1)
 *
 * shape 旧参数在新公式里没有直接对应物，丢弃（但记进 migration note）。
 *
 * @param {number} half 旧半衰天数
 * @param {number} shape 旧形状参数
 * @returns {{a:number, b:number}}
 */
export function halfToCurve(half, shape) {
  const h = Number(half);
  if (!Number.isFinite(h) || h <= 0) return { a: -0.5, b: 2 };
  const a = -0.5 / Math.log2(h + 1);
  return { a: Number(a.toFixed(6)), b: 2 };
}

// ── 旧结构的半衰期 ──────────────────────────────────────────────

/** 从 entry 里推出旧的 half（天）。没有就用传入的默认值。 */
function halfOf(entry, fallbackDays) {
  if (Number.isFinite(Number(entry?.half))) return Number(entry.half);
  return fallbackDays;
}

// ── 迁移 ────────────────────────────────────────────────────────

const stats = {
  people: 0,
  desc: 0,
  impression: 0,
  thing: 0,
  mood: 0,
  skipped: [],
  /** 不迁的账：原样保留，recall 能查 */
  archived: [],
};

const now = Date.now();

/** 迁移一个人 */
function migratePerson(oid, p, curves) {
  const items = [];
  const traitsCurve = curves.traits ?? { baseDays: 20, shape: 1 };

  // traits → desc
  for (const t of p.traits ?? []) {
    if (t.superseded) { stats.skipped.push(`superseded trait: ${p.name}/${t.text}`); continue; }
    if (t.state === 'muted' || t.muted) { stats.skipped.push(`muted trait: ${p.name}/${t.text}`); continue; }
    const half = halfOf(t, traitsCurve.baseDays);
    const { a, b } = halfToCurve(half, t.shape ?? traitsCurve.shape ?? 1);
    items.push({
      type: 'desc',
      domain: 'person',
      subject: oid,
      text: String(t.text ?? '').trim(),
      a, b,
      at: Number(t.at ?? now),
      // 溯源：迁移前是什么样
      _from: { kind: 'trait', half, shape: t.shape ?? traitsCurve.shape, w0: t.w0, hits: t.hits },
    });
    stats.desc += 1;
  }

  // history 不迁 —— 账归账。
  // 参考 agent：「说话让我舒服」是账，不是看法。
  // 挪进 archive 原样保存，recall 能查，但不进「我怎么看这人」那一栏。
  for (const h of p.history ?? []) {
    // 账全部归档（不迁成印象），保持原样，recall 能查
    stats.archived.push({ who: p.name, kind: 'history', ...h });
  }

  stats.people += 1;
  return { identity: { platform: p.oid ? 'qq' : 'name', value: p.oid || `name:${p.name}` }, display: p.name, items };
}

/**
 * 物事要迁 —— 这是她的喜恶，不是记账。
 *
 * 2026-11-08 修正：一开始我把 things 和 people.history 当成一类一起归档了，
 * 那是错的。参考 agent说的「账不是看法」指的是 history（说话让我舒服/不痛快），
 * 不包括 things（被叫agent、被当成猫）—— **喜恶是她人格的一部分**。
 *
 * 迁移方式：
 *   face  = 原词（「被叫agent」）
 *   delta = 原 history 的 delta
 *   why   = 原样保留
 */
function migrateThing(key, t, curves) {
  const items = [];
  const thingsCurve = curves.things ?? { baseDays: 8, shape: 1.4 };
  for (const h of t.history ?? []) {
    // 跳过的一律进 archive（不丢），不是直接扔掉
    if (h.state === 'muted') {
      stats.skipped.push(`muted thing: ${key}`);
      stats.archived.push({ who: key, kind: 'thing-muted', ...h });
      continue;
    }
    if (h.collapsed === true) {
      // 旧 scoreOf 忽略 collapsed 的；迁移也要忽略，否则它们会重新"活"起来
      stats.skipped.push(`collapsed thing: ${key}`);
      stats.archived.push({ who: key, kind: 'thing-collapsed', ...h });
      continue;
    }
    const delta = Number(h.delta ?? 0);
    if (!Number.isFinite(delta) || delta === 0) {
      stats.skipped.push(`zero-delta thing: ${key}`);
      stats.archived.push({ who: key, kind: 'thing-zero', ...h });
      continue;
    }
    // 物事的 half 是【小时】不是天（见 index.js 里 baseDays: e.half / 24）
    // 2026-11-08 codex review 抓到：直接当天数会慢 24 倍
    const rawHalf = Number(h.half);
    const halfDays = Number.isFinite(rawHalf) && rawHalf > 0 ? rawHalf / 24 : thingsCurve.baseDays;
    const { a, b } = halfToCurve(halfDays, h.shape);
    items.push({
      type: 'impression',
      domain: 'thing',
      subject: key,
      face: key, // 喜恶本身就是「形容」：被叫agent / 被当成猫
      delta: Math.max(-1, Math.min(1, delta)),
      why: String(h.text ?? '').slice(0, 60) || undefined,
      a, b,
      at: Number(h.at ?? now),
      _from: { kind: 'thing', halfDays, rawHalf: h.half, delta, srcText: h.text },
    });
    stats.thing += 1;
  }
  if (items.length === 0) return null;
  return { identity: { platform: 'thing', value: key }, display: key, items };
}

/** 情绪事件也不迁，原样进 archive */
function archiveMood(e, i) {
  stats.archived.push({ who: 'mood', kind: 'moodEvent', ...e });
  return null;
}

// ── 主流程 ──────────────────────────────────────────────────────

function main() {
  const lex = j(LEX_FILE);
  const aff = j(AFF_FILE);
  if (lex === null) {
    console.error(`找不到 ${LEX_FILE}`);
    process.exit(1);
  }

  const curves = lex.curves ?? {};
  const out = {
    version: 3,
    migratedFrom: { schema: 'v2', at: now },
    people: {},
    things: {},
    mood: {},
    self: lex.self ?? [],
    curves,
    /** 不迁成印象的账，原样保留；recall 能查到 */
    archive: [],
  };

  for (const [oid, p] of Object.entries(lex.people ?? {})) {
    out.people[oid] = migratePerson(oid, p, curves);
  }
  for (const [key, t] of Object.entries(lex.things ?? {})) {
    const r = migrateThing(key, t, curves);
    if (r !== null) out.things[key] = r;
  }
  if (aff !== null) {
    const moodItems = (aff.moodEvents ?? []).map((e, i) => archiveMood(e, i)).filter(Boolean);
    if (moodItems.length > 0) {
      // 情绪按 face 分组
      const byFace = new Map();
      for (const it of moodItems) {
        const cur = byFace.get(it.face) ?? { identity: { platform: 'mood', value: it.face }, display: it.face, items: [] };
        cur.items.push(it);
        byFace.set(it.face, cur);
      }
      out.mood = {};
    }
    stats.mood = moodItems.length;
  }

  // 账写进 archive（不删，recall 能查）
  out.archive = stats.archived;

  // ── 校验 ──
  const totalItems =
    Object.values(out.people).reduce((s, p) => s + p.items.length, 0) +
    Object.values(out.things).reduce((s, t) => s + t.items.length, 0) +
    Object.values(out.mood).reduce((s, m) => s + m.items.length, 0);

  console.log('=== 迁移统计 ===');
  console.log(`  人: ${stats.people}`);
  console.log(`  描述(desc): ${stats.desc}`);
  console.log(`  印象 来自物事（喜恶）: ${stats.thing}`);
  console.log(`  账（进 archive，不迁成印象）: ${stats.archived.length}`);
  console.log(`  条目合计: ${totalItems}`);
  console.log(`  跳过: ${stats.skipped.length}`);
  for (const s of stats.skipped.slice(0, 10)) console.log(`    - ${s}`);
  if (stats.skipped.length > 10) console.log(`    ... 还有 ${stats.skipped.length - 10} 条`);

  // ── 逐条对比 ──
  console.log('\n=== 旧 → 新 逐条对比（前 5 条）===');
  let shown = 0;
  for (const p of Object.values(out.people)) {
    for (const it of p.items) {
      if (shown >= 5) break;
      const f = it._from;
      console.log(`  ${p.display} / ${it.type}:`);
      console.log(`    旧: half=${f.half}天 shape=${f.shape ?? '-'} delta=${f.delta ?? '无'} text=${(f.srcText ?? it.text ?? '').slice(0, 30)}`);
      console.log(`    新: a=${it.a} b=${it.b} delta=${it.delta ?? '无'} face=${it.face ?? it.text ?? '-'}`);
      shown += 1;
    }
    if (shown >= 5) break;
  }

  if (DRY) {
    console.log('\n[dry-run] 没有写任何文件。加 --apply 才会写。');
    return;
  }

  // ── 写入 ──
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // 备份原文件
  if (existsSync(LEX_FILE)) copyFileSync(LEX_FILE, join(OUT_DIR, `lexicon.before-${stamp}.json`));
  if (existsSync(AFF_FILE)) copyFileSync(AFF_FILE, join(OUT_DIR, `affect.before-${stamp}.json`));
  // 写入新结构（写到单独文件，不覆盖原 lexicon，等插件改造完再切换）
  const target = join(OUT_DIR, `lexicon.v3-${stamp}.json`);
  writeTextAtomic(target, JSON.stringify(out, null, 2));
  console.log(`\n[apply] 已写入 ${target}`);
  console.log('[apply] 原文件已备份到同目录');
  console.log('[apply] 注意：没有覆盖 lexicon.json——等插件改造完再切换');
}

main();
