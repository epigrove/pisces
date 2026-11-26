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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 2026-11-27：**路径按脚本位置推导**。
 * 原来用 `KOI_HOME ?? homedir()`：从运维 shell 里跑 health 时 HOME 是运维方家目录，
 * 于是去 <家目录>/plugins 找插件，直接 ERR_MODULE_NOT_FOUND。
 * 脚本在 `<agent>/tools/` 下，所以上一级就是 agent 根。
 */
const KOI = process.env.KOI_HOME ?? join(dirname(fileURLToPath(import.meta.url)), '..');
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

const base = { sections: [], contexts: [] };
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

const sections = [
  ...(out.sections ?? []),
  ...(out.contexts ?? []),
].filter((s) => typeof s.text === 'string' && s.text !== '');
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
  /**
   * 2026-11-27：段名从 `qqbot:memory` 改成 `koi:memory`（注入通道也换成 contexts）。
   * 旧基线里存的是旧名，直接比对会报一次「缺了 qqbot:memory 段」的假警报。
   * 这里按迁移表把旧名映射到新名。
   */
  const RENAMED = { 'qqbot:memory': 'koi:memory' };
  /** 旧的 koi:lexicon 现在拆成 koi:identity（系统段）+ koi:lexicon（上下文），字数要合并比 */
  const SPLIT = { 'koi:lexicon': ['koi:identity', 'koi:lexicon'] };
  for (const p of prev.shape) {
    const want = RENAMED[p.name] ?? p.name;
    const names = SPLIT[want] ?? [want];
    const found = names.map((n) => shape.find((s) => s.name === n)).filter(Boolean);
    const nowChars = found.reduce((n, s) => n + s.chars, 0);
    if (found.length === 0) problems.push(`缺了 ${want} 段`);
    else if (p.chars >= 80 && nowChars < p.chars * 0.6) problems.push(`${p.name} 字数 ${p.chars} → ${nowChars}`);
  }
}

const line = `共 ${shape.length} 段 / ${total} 字 / ${shape.map((s) => `${s.name.replace(/^.*:/, '')}${s.chars}`).join(' ')}`;
if (problems.length > 0 && !UPDATE) {
  console.log(`❌ 注入缩水：${problems.join('；')}`);
  console.log(`   现在：${line}`);
  process.exit(1);
}
/**
 * 2026-11-27 修：--update 原来**只打印 ✅、不写基线**（写状态被 `!UPDATE` 挡住了），
 * 于是"更新基线"这个动作是假的，下一次照旧报缩水。
 * 现在：--update 明确重写基线（这是它的全部意义）。
 */
if (UPDATE || problems.length === 0) writeFileSync(STATE, JSON.stringify({ at: Date.now(), total, shape }, null, 1));
console.log(`✅ ${line}`);
