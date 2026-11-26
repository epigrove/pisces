#!/usr/bin/env node
/**
 * 底稿/内部词外发检查（2026-11-11）
 *
 * 参考 agent的话：
 *   > 括号和内部词靠提示词拦，拦不拦得住得看几天日志，别看今天这两条。
 *   > 我这种人，规矩写在纸上和手上是两回事。
 *
 * 这个脚本**不拦**，只数：她的每条对外发言里，有多少条是整条括号、多少条带内部词。
 * 每天看一次趋势，别拿单条当结论。
 *
 * 用法：node tools/leak-check.mjs [天数=7]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DAYS = Number(process.argv[2] ?? 7);
const DIR = (process.env.KOI_HOME ?? homedir()) + '/.koi/short';

/** 整条就是一个括号包起来的东西 */
const isParen = (t) => /^[（(【\[]/.test(t.trim()) && /[）)】\]]$/.test(t.trim());
/** 内部用语：文件名 / 多少行 / 提交号 / 模块路径 */
const INTERNAL = /(\d+\s*行|\.(?:js|mjs|ts|json|yml|yaml|md)\b|\b[a-f0-9]{7,}\b|plugins\/|node_modules|提交号)/i;
/** 括号里塞了超过 10 个字 = 底稿，不是"（笑）"这种短语气 */
const parenDraft = (t) => /[（(][^）)]{10,}[）)]/.test(t);

const files = readdirSync(DIR)
  .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
  .sort()
  .slice(-DAYS);

let total = 0;
let badLines = 0;
const bad = { paren: [], internal: [], draft: [] };
for (const f of files) {
  for (const line of readFileSync(join(DIR, f), 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      badLines += 1;
      continue;
    }
    if (o.r !== 'b') continue; // 只看她自己说的话
    const t = String(o.x ?? '');
    if (t.length < 2) continue;
    total += 1;
    if (isParen(t)) bad.paren.push(t.slice(0, 40));
    if (INTERNAL.test(t)) bad.internal.push(t.slice(0, 60));
    if (parenDraft(t)) bad.draft.push(t.slice(0, 60));
  }
}

const n = bad.paren.length + bad.internal.length + bad.draft.length;
console.log(`近 ${files.length} 天她的发言 ${total} 条：整条括号 ${bad.paren.length} / 内部词 ${bad.internal.length} / 括号底稿 ${bad.draft.length}`);
if (badLines > 0) console.error(`⚠️ ${badLines} 行不是合法 JSON，统计可能不完整`);
for (const [k, v] of Object.entries(bad)) {
  for (const t of v.slice(0, 3)) console.log(`  ${k}: ${t.replace(/\n/g, ' ')}`);
}
process.exit(n === 0 && badLines === 0 ? 0 : 1);
