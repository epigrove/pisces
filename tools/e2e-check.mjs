#!/usr/bin/env node
/**
 * 端到端检查（2026-11-08）
 *
 * 不是单元测试——它跑的是**她真实会走的路径**：
 * 记描述 / 记印象 / 记心情 / 查心情 / 查人 / 并发写 / 注入内容。
 *
 * 用法：
 *   node tools/e2e-check.mjs
 *
 * 2026-11-12：**删掉了 `--live`。**
 * 它注释写「只读，不改」，实际 `D` 直接指向私有数据目录，
 * 第 66 行 `writeFileSync(D/lexicon.json, ...)` 会往**她的真实记忆**里塞
 * 一条「外部改的」印象和一句「再记一条」特征。跑一次就污染。
 * 这个开关能提供的信息（真实数据形状），下面的临时目录拷贝已经给了。
 */
import { rmSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { apply as lexApply } from '../plugins/dsh-koi-lexicon/lib/index.js';
import { apply as affApply } from '../plugins/dsh-koi-affect/lib/index.js';

// 2026-11-12：只跑临时副本。真实数据只读、只拷贝，**永不写回**。
const SRC = (process.env.KOI_HOME ?? homedir()) + '/.koi';
const D = '/tmp/e2e-check/.koi';
rmSync('/tmp/e2e-check', { recursive: true, force: true });
mkdirSync(D, { recursive: true });
for (const f of ['profile.core.md', 'profile.persona.md', 'lexicon.json', 'affect.json']) {
  try {
    copyFileSync(`${SRC}/${f}`, `${D}/${f}`);
  } catch {
    // 源文件不存在（全新环境）：跳过，测试会用空数据兜底
  }
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`); }
};

const lt = {};
const at = {};
lexApply({ on() {}, tools: { register: (t) => { lt[t.name] = t; } }, effect() {}, get() {} },
  { dir: D, coreFile: `${D}/profile.core.md`, cardFile: `${D}/profile.persona.md`, useV3: true });
affApply({ on() {}, tools: { register: (t) => { at[t.name] = t; } }, effect() {}, get() {} },
  { dir: D, file: `${D}/affect.json`, lexiconFile: `${D}/lexicon.json` });

console.log(`\n=== 工具面（临时目录）===`);
console.log('  lexicon:', Object.keys(lt).sort().join(', '));
console.log('  affect :', Object.keys(at).sort().join(', '));

console.log('\n=== 她实际会走的路径 ===');
const r1 = await lt.remember_person.execute({ who: '人物乙', trait: '护着某人', why: '她说过' });
check('记描述', r1.includes('记住了'), r1);

const r2 = await lt.remember_impression.execute({ who: '人物乙', face: '爱呛人', delta: -0.5 });
check('记印象', r2.includes('记下了'), r2);

const r3 = await at.feel_dimension.execute({ mood: '烦躁', delta: -0.6, why: 'e2e' });
check('记心情', r3.includes('记下了'), r3);

const r4 = await at.recall_mood.execute({ query: '烦躁' });
check('查心情', r4.includes('烦躁'), r4);

const r5 = await lt.recall.execute({ query: '人物乙' });
check('查人', r5.includes('人物乙'), r5);

console.log('\n=== 并发写（两个插件写同一文件）===');
const disk = JSON.parse(readFileSync(`${D}/lexicon.json`, 'utf8'));
const p = Object.values(disk.people).find((x) => x.name === '人物乙') ?? Object.values(disk.people)[0];
p.items ??= [];
p.items.push({ type: 'impression', domain: 'person', subject: p.identity?.value ?? '', face: '外部改的', delta: 0.3, alpha: 0.4, at: Date.now() });
writeFileSync(`${D}/lexicon.json`, JSON.stringify(disk, null, 2));
await lt.remember_person.execute({ who: '人物乙', trait: '再记一条' });
const after = JSON.parse(readFileSync(`${D}/lexicon.json`, 'utf8'));
const ap = Object.values(after.people).find((x) => x.name === '人物乙') ?? Object.values(after.people)[0];
check('外部写入没被覆盖', (ap.items ?? []).some((i) => i.face === '外部改的'));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
