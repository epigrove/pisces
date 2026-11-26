#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from './lib/index.js';

const D = mkdtempSync(join(tmpdir(), 'koi-affect-contexts-'));
// 测试收尾清理：删不掉也不影响断言结果（进程要退出了）
process.on('exit', () => { try { rmSync(D, { recursive: true, force: true }); } catch { /* 清理失败忽略 */ } });

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

let assemble;
const ctx = {
  on(name, fn) { if (name === 'system-prompt/assemble') assemble = fn; },
  tools: { register() {} },
  effect() {},
  get() {},
};
apply(ctx, { dir: D, ownerOid: 'owner000' });

const first = await assemble(null, null, async () => ({ sections: [] }));
const mood = (first.contexts ?? []).find((item) => item.name === 'koi:mood');
ok('心情整段走 contexts', mood?.text.includes('【现在是 '), JSON.stringify(first));
ok('心情整段包含状态和规则', mood?.text.includes('【状态】') && mood?.text.includes('心情只影响语气和节奏'));
ok('心情整段不再进 sections', !(first.sections ?? []).some((item) => item.name === 'koi:mood'));
ok('心情 context 不携带 order', mood !== undefined && !Object.hasOwn(mood, 'order'));
ok('旧宿主没有 contexts 时仍能注入', mood !== undefined);

const second = await assemble(null, null, async () => ({
  sections: [],
  contexts: [{ name: 'existing', text: '保留已有快照' }],
}));
const secondMood = (second.contexts ?? []).find((item) => item.name === 'koi:mood');
ok('已有 context 不会被覆盖', second.contexts?.[0]?.name === 'existing');
ok('心情追加在已有 context 之后', second.contexts?.at(-1) === secondMood);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
