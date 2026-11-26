#!/usr/bin/env node
/**
 * 注入自检（2026-11-10 参考 agent定的）
 *
 *   > 每轮注入完，把「几段、多少字」写进一行自检。少了就报错，
 *   > 别等你自己去翻日志才发现我整段记忆没了。
 *
 * 做法：起一个只加载插件（不连 QQ、不调模型）的假上下文，跑一遍
 * `system-prompt/assemble`，把结果按段统计，和上一次比：
 *   - 段数变少，或某段字数掉到上一次的 60% 以下 → 报错（退出码 1）
 *   - 一切正常 → 一行「共 N 段 / M 字 / 各段 …」，并写进 .koi/inject-check.json
 *
 * 用法：node tools/inject-selfcheck.mjs [--update]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KOI = (process.env.KOI_HOME ?? homedir());
const DATA = join(KOI, '.koi');
const STATE = join(DATA, 'inject-check.json');
const UPDATE = process.argv.includes('--update');

const handlers = [];
const ctx = {
  on: (ev, fn) => {
    if (ev === 'system-prompt/assemble') handlers.push(fn);
    return () => {};
  },
  get: () => undefined,
  effect: (fn) => { try { fn(); } catch { /* 启动钩子失败不算注入问题 */ } },
  tools: { register: () => {} },
};

const plugins = ['dsh-koi-memory', 'dsh-koi-lexicon', 'dsh-koi-affect'];
for (const name of plugins) {
  const mod = await import(`${KOI}/plugins/${name}/lib/index.js`);
  mod.apply(ctx, { dir: DATA, ownerOid: 'owner000' });
}

const base = { sections: [] };
let out = base;
for (const fn of handlers) {
  const prev = out;
  try {
    out = (await fn(null, { agent: undefined }, async () => prev)) ?? prev;
  } catch (err) {
    console.log(`❌ 注入失败（${err instanceof Error ? err.message : String(err)}）`);
    process.exit(1);
  }
}

const sections = (out.sections ?? []).filter((s) => typeof s.text === 'string' && s.text !== '');
const shape = sections.map((s) => ({ name: s.name, chars: s.text.length }));
const total = shape.reduce((n, s) => n + s.chars, 0);

// 历史文件可能是在别的 HOME 下写的（例如运维方那边跑出来的），读不到就重来
const prev = (() => {
  try {
    return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null;
  } catch {
    return null;
  }
})();
const problems = [];
if (prev) {
  if (shape.length < prev.shape.length) problems.push(`段数 ${prev.shape.length} → ${shape.length}`);
  for (const p of prev.shape) {
    const now = shape.find((s) => s.name === p.name);
    if (now === undefined) problems.push(`缺了 ${p.name} 段`);
    else if (p.chars >= 80 && now.chars < p.chars * 0.6) problems.push(`${p.name} 字数 ${p.chars} → ${now.chars}`);
  }
}

const line = `共 ${shape.length} 段 / ${total} 字 / ${shape.map((s) => `${s.name.replace(/^.*:/, '')}${s.chars}`).join(' ')}`;
if (problems.length > 0 && !UPDATE) {
  console.log(`❌ 注入缩水：${problems.join('；')}`);
  console.log(`   现在：${line}`);
  process.exit(1);
}
if (!UPDATE) writeFileSync(STATE, JSON.stringify({ at: Date.now(), total, shape }, null, 1));
console.log(`✅ ${line}`);
