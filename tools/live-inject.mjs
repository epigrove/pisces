#!/usr/bin/env node
/**
 * 看她现在实际收到的注入内容（只读）
 *
 * 每次改完注入相关的东西，跑这个看一眼——比读代码可靠。
 */
import { apply } from '../plugins/dsh-koi-lexicon/lib/index.js';
import { homedir } from 'node:os';
import { apply as m } from '../plugins/dsh-koi-memory/lib/index.js';
import { apply as a } from '../plugins/dsh-koi-affect/lib/index.js';

const D = (process.env.KOI_HOME ?? homedir()) + '/.koi';
// 每个插件都会注册 system-prompt/assemble，要全部收下来串成链
const chain = [];
const ctx = {
  on: (e, f) => { if (e === 'system-prompt/assemble') chain.push(f); },
  tools: { register() {} },
  effect() {},
  get() {},
};

apply(ctx, { dir: D, coreFile: `${D}/profile.core.md`, cardFile: `${D}/profile.persona.md`, useV3: true });
m(ctx, { dir: D, coreFile: `${D}/profile.core.md`, cardFile: `${D}/profile.persona.md` });
a(ctx, { dir: D, file: `${D}/affect.json`, lexiconFile: `${D}/lexicon.json` });

// 串成 next() 链，和 dsh 的 waterfall 一样：后面的包前面的
let next = async () => ({ sections: [] });
for (let i = chain.length - 1; i >= 0; i -= 1) {
  const fn = chain[i];
  const inner = next;
  next = () => fn({}, { agent: { id: 'x' } }, inner);
}
const out = await next();
const sections = (out.sections ?? []).sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
console.log(`（共 ${sections.length} 段）`);
for (const s of sections) {
  console.log(`\n── ${s.name}（order ${s.order}）──`);
  console.log(s.text);
}
process.exit(0);
