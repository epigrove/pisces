/**
 * 清理旧字段 → 归档（不删）
 *
 * 2026-11-08
 *
 * 需求文档里做完的设计，和线上数据结构对不上：
 *
 *   P4  turns   —— 设计说删，代码已经不用了
 *   S4  hits    —— 设计说不用了（改成靠她自行加项）
 *   S3  imp     —— 设计说删掉（imp 在公式里乘了两遍）
 *   traits      —— 迁到 items[].type=desc 之后不再注入
 *   history     —— 迁到 items + archive 之后不再注入
 *
 * **但这个脚本不删，只搬。**
 *
 * 搬进 `archive[]`，每条带上 `archivedAt` 和 `why`，
 * 说明它是什么、为什么搬走。想查随时 recall 得到。
 *
 * 用法：
 *   node tools/cleanup-legacy.mjs --dry-run    # 只看，不写（默认）
 *   node tools/cleanup-legacy.mjs --apply      # 真的搬（先备份）
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

function resolveKoiRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  let cur = here;
  for (let i = 0; i < 5; i += 1) {
    if (existsSync(join(cur, '.koi'))) return cur;
    cur = dirname(cur);
  }
  return process.env.KOI_HOME || homedir();
}

const KOI = resolveKoiRoot();
const LEX_FILE = join(KOI, '.koi', 'lexicon.json');
const BACKUP_DIR = join(KOI, '.koi', 'cleanup-legacy');

const APPLY = process.argv.includes('--apply');
const now = Date.now();

/**
 * 清什么，由命令行决定（2026-11-08 定）。
 *
 *   --turns    安全，随时可以清（从来没参与过判断）
 *   --traits   要等 v3 验证通过（清掉之后旧路径就没记忆了，回退不了）
 *   --history  同上
 *
 * 不给参数 = 只清 turns。
 */
const DO_TURNS = process.argv.includes('--turns') || !process.argv.some((a) => /^--(traits|history)$/.test(a));
const DO_TRAITS = process.argv.includes('--traits');
const DO_HISTORY = process.argv.includes('--history');

const j = (p) => JSON.parse(readFileSync(p, 'utf8'));

function main() {
  if (!existsSync(LEX_FILE)) {
    console.error(`找不到 ${LEX_FILE}`);
    process.exit(1);
  }
  const lex = j(LEX_FILE);
  const archive = Array.isArray(lex.archive) ? lex.archive : [];
  const added = [];
  const removed = { turns: 0, hits: 0, imp: 0, traits: 0, history: 0 };

  for (const [key, p] of Object.entries(lex.people ?? {})) {
    // P4: turns —— 从来没拿来判断过什么，只是计数器
    if (DO_TURNS && Object.hasOwn(p, 'turns')) {
      added.push({
        who: p.name ?? key,
        kind: 'legacy-turns',
        archivedAt: now,
        why: 'P4：turns 只是说话计数，没参与过任何判断，设计里定为删',
        value: p.turns,
        original: { at: p.at ?? null, value: p.turns },
      });
      delete p.turns;
      removed.turns += 1;
    }

    // traits → 搬进 archive（已经迁到 items 了，这里不再注入）
    // **要等 v3 验证通过才能清**：旧路径靠 traits 显示人，清掉之后回退不了
    for (const t of (DO_TRAITS ? p.traits ?? [] : [])) {
      added.push({
        who: p.name ?? key,
        kind: 'legacy-trait',
        archivedAt: now,
        why: '已迁到 items[].type=desc，旧字段不再注入',
        text: t.text,
        original: t,
      });
      removed.traits += 1;
    }
    if (DO_TRAITS && Array.isArray(p.traits) && p.traits.length > 0) p.traits = [];

    // history → 搬进 archive（S3: imp 乘了两遍；S4: hits 不用了）
    // **同样要等 v3 验证通过**
    for (const h of (DO_HISTORY ? p.history ?? [] : [])) {
      const flags = [];
      if (h.imp !== undefined) flags.push('S3：imp 在公式里乘了两次');
      if (h.hits !== undefined) flags.push('S4：hits 不再参与计算');
      added.push({
        who: p.name ?? key,
        kind: 'legacy-history',
        archivedAt: now,
        why: flags.length > 0 ? flags.join('；') : '旧的记账流水，已迁到 archive',
        text: h.text,
        delta: h.delta,
        original: h,
      });
      if (h.imp !== undefined) removed.imp += 1;
      if (h.hits !== undefined) removed.hits += 1;
      removed.history += 1;
    }
    if (DO_HISTORY && Array.isArray(p.history) && p.history.length > 0) p.history = [];
  }

  console.log('=== 要归档的 ===');
  console.log(`  turns:   ${removed.turns} 人`);
  console.log(`  traits:  ${removed.traits} 条`);
  console.log(`  history: ${removed.history} 条（其中带 imp 的 ${removed.imp}，带 hits 的 ${removed.hits}）`);
  console.log(`  新增 archive 条目: ${added.length}`);
  console.log(`  archive 总数会变成: ${archive.length} → ${archive.length + added.length}`);

  if (added.length > 0) {
    console.log('\n=== 前 3 条样例 ===');
    for (const a of added.slice(0, 3)) {
      console.log(`  [${a.kind}] ${a.who}: ${String(a.text ?? a.value ?? '').slice(0, 40)}`);
      console.log(`     why: ${a.why}`);
    }
  }

  if (!DO_TRAITS || !DO_HISTORY) {
    console.log('\n（traits / history 没动——要清它们得加 --traits --history）');
    console.log('  为什么：旧路径靠这两个字段显示人和好感，清掉之后 useV3 出问题就回退不了了。');
  }

  if (!APPLY) {
    console.log('\n[dry-run] 没有写任何文件。加 --apply 才会动手。');
    return;
  }

  lex.archive = [...archive, ...added];
  lex.cleanedAt = now;

  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(LEX_FILE, join(BACKUP_DIR, `lexicon.before-cleanup-${stamp}.json`));
  writeFileSync(LEX_FILE, JSON.stringify(lex, null, 2));

  console.log(`\n[apply] 已写回 ${LEX_FILE}`);
  console.log(`[apply] 原文件备份在 ${BACKUP_DIR}`);
  console.log('[apply] 旧字段已搬进 archive，没有删除');
}

main();
