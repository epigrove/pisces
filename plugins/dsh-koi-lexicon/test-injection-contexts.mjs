#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from './lib/index.js';

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

async function runBranch(useV3) {
  const D = mkdtempSync(join(tmpdir(), `koi-lexicon-contexts-${useV3 ? 'v3' : 'v2'}-`));
  writeFileSync(join(D, 'profile.core.md'), 'koi：测试用 agent。\n', 'utf8');
  writeFileSync(join(D, 'lexicon.json'), JSON.stringify({
    version: 3,
    migrated: true,
    people: {},
    things: {},
    self: [],
    curves: {},
    archive: [],
  }), 'utf8');

  const promptHandlers = [];
  const eventHandlers = [];
  const ctx = {
    on(name, fn) {
      if (name === 'system-prompt/assemble') promptHandlers.push(fn);
      else eventHandlers.push([name, fn]);
    },
    tools: { register() {} },
    effect() {},
    get() {},
  };
  apply(ctx, {
    dir: D,
    coreFile: join(D, 'profile.core.md'),
    useV3,
    migrateFromAffect: false,
  });
  const onEvent = eventHandlers.find(([name]) => name === 'session/event')?.[1];
  onEvent?.({ id: 's1' }, {
    type: 'user/message',
    data: {
      source: { kind: 'user' },
      content: [{
        type: 'text',
        text: '[当前甲 (AABBCCDD11223344AABBCCDD11223344)] 在吗',
      }],
    },
  });

  let next = async () => ({ sections: [] });
  for (const fn of promptHandlers) {
    const inner = next;
    next = () => fn({}, { agent: { id: 's1' } }, inner);
  }
  const out = await next();
  return { D, out };
}

for (const useV3 of [true, false]) {
  const { D, out } = await runBranch(useV3);
  const label = useV3 ? 'V3' : 'V2';
  const speakers = (out.contexts ?? []).filter((item) => item.name === 'koi:speaker');
  const lexicons = (out.contexts ?? []).filter((item) => item.name === 'koi:lexicon');
  const identity = (out.sections ?? []).filter((item) => item.name === 'koi:identity');
  ok(`${label} speaker 走 contexts`, speakers[0]?.text.startsWith('[aabbccdd] 当前甲'), JSON.stringify(out));
  // 2026-11-27：核心身份（【我是谁·不可改】）留在系统提示词（sections），
  // 只有会变的部分（人/喜恶/心情/读法）走 contexts。
  ok(`${label} 核心身份留在 sections`, identity[0]?.text.includes('【我是谁·不可改】'), JSON.stringify(out));
  ok(`${label} 核心身份不再重复进 contexts`,
    !(lexicons[0]?.text ?? '').includes('【我是谁·不可改】'), JSON.stringify(out));
  ok(`${label} 动态段都不再进 sections`,
    !(out.sections ?? []).some((item) => item.name === 'koi:speaker' || item.name === 'koi:lexicon'));
  // 没有动态内容时不会生成 koi:lexicon 段，那种情况不参与顺序比较
  const speakerIdx = (out.contexts ?? []).findIndex((item) => item.name === 'koi:speaker');
  const lexiconIdx = (out.contexts ?? []).findIndex((item) => item.name === 'koi:lexicon');
  ok(`${label} speaker 在 lexicon 之前（有 lexicon 段时）`,
    lexiconIdx < 0 || speakerIdx < lexiconIdx, `speaker=${speakerIdx} lexicon=${lexiconIdx}`);
  ok(`${label} context 不携带 order`,
    [...speakers, ...lexicons].every((item) => !Object.hasOwn(item, 'order')));
  rmSync(D, { recursive: true, force: true });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
