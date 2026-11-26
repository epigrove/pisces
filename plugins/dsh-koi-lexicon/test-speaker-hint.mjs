#!/usr/bin/env node
/**
 * 「谁在说话」那行的「没印象」空位。
 *
 *   群里出现一个完全没印象的名字时，应先提示 recall 一次，而不是直接当陌生人。
 *   只补一句「没印象」，不追加关于此人的结论或近期发言摘要。
 *
 * 判据只有一条：这个人有没有**活着的描述**。
 *   没有 → 补「（没印象，先 recall 一次）」
 *   有   → 一个字都不加
 */
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from './lib/index.js';

// 测试自己造一份临时身份文件，不读部署里的真文件（开源仓库不该依赖真实部署）
const SRC = mkdtempSync(join(tmpdir(), 'koi-core-'));
const D = mkdtempSync(join(tmpdir(), 'koi-hint-'));
// 造一份中性的假身份文件（真实身份属于部署，不进仓库）
writeFileSync(join(SRC, 'profile.core.md'),
  'koi：测试用 agent。\n主人：测试用 master。\nashu：另一个 agent。\n', 'utf8');
writeFileSync(join(SRC, 'profile.persona.md'), '测试用角色设定。\n', 'utf8');
// 合成一份词条：一个人有描述（覆盖「有描述 → 不加提示」那条用例），
// 另一个人没描述（覆盖「没印象 → recall」）。**没有任何真实人物数据。**
writeFileSync(join(SRC, 'lexicon.json'), JSON.stringify({
  version: 3,
  people: {
    aabbccdd: { name: '路人甲', items: [] },
    '11112222': {
      name: '熟人乙',
      items: [{ type: 'desc', at: Date.now() - 86400000, text: '测试用的描述' }],
    },
  },
  things: {}, self: [], curves: {}, archive: [],
}), 'utf8');
mkdirSync(join(D, 'workspace'), { recursive: true });
copyFileSync(join(SRC, 'lexicon.json'), join(D, 'lexicon.json'));
copyFileSync(join(SRC, 'profile.core.md'), join(D, 'profile.core.md'));
copyFileSync(join(SRC, 'profile.persona.md'), join(D, 'profile.persona.md'));

const chain = [];
const handlers = [];
const ctx = {
  on: (e, f) => { if (e === 'system-prompt/assemble') chain.push(f); else handlers.push([e, f]); },
  tools: { register() {} },
  effect() {},
  get() {},
};
apply(ctx, { dir: D, coreFile: join(D, 'profile.core.md'), cardFile: join(D, 'profile.persona.md'), useV3: true });

const onEvent = handlers.find(([e]) => e === 'session/event')?.[1];
const onClaimed = handlers.find(([e]) => e === 'agent/inbox/claimed')?.[1];
const say = (name, oid) => onEvent?.({ id: 's1' }, {
  type: 'user/message',
  // 2026-11-17：真实事件**一定带** source.kind（实测她 969 条真人消息全是 user）。
  // 空的这里原来没带，改成 fail-closed 后就被正确地挡掉了——所以补上。
  data: {
    source: { kind: 'user' },
    content: [{ type: 'text', text: `[${name} (${oid.toUpperCase()})] 在吗` }],
  },
});
const claim = (name, oid) => onClaimed?.({
  agent: { id: 's1' },
  message: {
    source: { kind: 'user' },
    content: [{ type: 'text', text: `[${name} (${oid.toUpperCase()})] 在吗` }],
  },
});

async function speakerLine() {
  let next = async () => ({ sections: [] });
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const fn = chain[i];
    const inner = next;
    next = () => fn({}, { agent: { id: 's1' } }, inner);
  }
  const out = await next();
  return (out.sections ?? []).find((s) => s.name === 'koi:speaker')?.text ?? '';
}

let p = 0, f = 0;
const ok = (n, c, extra = '') => { c ? p++ : f++; console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : ` — ${extra}`}`); };

// 0) rc.5：claim 发生在 assemble 前，首轮必须已经看到这条消息的说话人
claim('当前甲', 'DDDDDDDD11223344DDDDDDDD11223344');
const firstClaimed = await speakerLine();
ok('claim(A) 后首个 assemble 使用 A', firstClaimed.startsWith('[dddddddd] 当前甲'), firstClaimed);
claim('当前乙', 'EEEEEEEE11223344EEEEEEEE11223344');
const secondClaimed = await speakerLine();
ok('claim(B) 后 assemble 切换为 B', secondClaimed.startsWith('[eeeeeeee] 当前乙'), secondClaimed);

// 1) 完全没记录的人
say('路人甲', 'AABBCCDD11223344AABBCCDD11223344');
const l1 = await speakerLine();
ok('陌生人 → 带「没印象，先 recall」', l1.includes('没印象') && l1.includes('recall'), l1);
ok('只给 id + 名字，不加别的结论', /^\[aabbccdd\] 路人甲（没印象，先 recall 一次）$/.test(l1.trim()), l1);

// 2) 有活着的描述的人（用真实数据里有的）
const lex = JSON.parse(readFileSync(join(D, 'lexicon.json'), 'utf8'));
const withDesc = Object.entries(lex.people ?? {}).find(([, v]) =>
  (v.items ?? []).some((it) => it.type === 'desc' && !it.recallAt === false || (it.type === 'desc' && (Date.now() - Math.max(it.at, it.recallAt ?? 0)) < 400 * 86400000)),
);
if (withDesc) {
  const [key, v] = withDesc;
  const oid = String(v.oid ?? key).padEnd(32, '0').slice(0, 32);
  say(v.name, oid);
  const l2 = await speakerLine();
  ok('有描述的人 → 不加任何提示', !l2.includes('没印象'), l2);
}

rmSync(D, { recursive: true, force: true });
console.log(`\n${p} 通过 / ${f} 失败`);
process.exit(f === 0 ? 0 : 1);
