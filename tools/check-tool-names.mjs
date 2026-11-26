#!/usr/bin/env node
/**
 * 工具名一致性检查（2026-11-08）
 *
 * 起因：注入提示词里写「更早的用 memory_recall 查」，但那个工具当天已经删了。
 * 她照着提示词调，会直接报「工具不存在」——**提示词在教她用不存在的工具**。
 *
 * 这类错误没有运行时告警：提示词照样注入，她照样照做，只是每次都失败。
 *
 * 规则（收紧过，第一版误报 21 处全是普通单词）：
 *   1. **只查提示词**（插件代码里的 `keep` 是变量名，不是工具）
 *   2. 只查**反引号包裹**的词——那是明确在说命令
 *   3. 排除 dsh 内置工具和其他 agent 的工具
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = (process.env.KOI_HOME ?? homedir());
const PLUGINS = join(ROOT, 'plugins');
const PROMPT = join(ROOT, '.dsh-home/profiles/koi/cordis.patch.yml');

/** 我们注册的工具 */
const registered = new Set();
for (const dir of readdirSync(PLUGINS)) {
  const f = join(PLUGINS, dir, 'lib/index.js');
  if (!existsSync(f)) continue;
  for (const m of readFileSync(f, 'utf8').matchAll(/name:\s*'([a-z_][a-z0-9_]*)'/g)) registered.add(m[1]);
}
/** qqbot 插件 + dsh 内置 + 其他 agent 的工具（她也在用/能看到的） */
const EXTERNAL = new Set([
  'qqbot_describe_image', 'qqbot_send_file', 'qqbot_logo',
  'web_search', 'web_fetch',
  'talk_to_sister',
  'memory_add', 'recall', 'recall_mood', 'feel_dimension',
]);

const src = readFileSync(PROMPT, 'utf8');
const problems = [];
src.split('\n').forEach((line, i) => {
  if (/^\s*#/.test(line)) return; // yml 注释不算
  for (const m of line.matchAll(/`([a-z][a-z0-9_]{3,})`/g)) {
    const w = m[1];
    if (!w.includes('_')) continue;
    if (registered.has(w) || EXTERNAL.has(w)) continue;
    problems.push({ line: i + 1, word: w, text: line.trim().slice(0, 70) });
  }
});

console.log(`注册的工具 ${registered.size} 个：${[...registered].filter((n) => !n.startsWith('koi:')).sort().join(', ')}`);

if (problems.length === 0) {
  console.log('\n✅ 提示词里没有指向不存在工具的引用');
  process.exit(0);
}
console.log(`\n❌ ${problems.length} 处指向不存在的工具：`);
for (const p of problems) {
  console.log(`  第${p.line}行 \`${p.word}\``);
  console.log(`     ${p.text}`);
}
process.exit(1);
