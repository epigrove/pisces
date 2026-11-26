#!/usr/bin/env node
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, writeLexiconStateAtomic } from './lib/index.js';
import { curveForZero } from './lib/impression.js';

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

function boot(dir, useV3 = true) {
  const tools = {};
  const promptHandlers = [];
  const ctx = {
    tools: { register: (def) => { tools[def.name] = def; } },
    on: (event, fn) => { if (event === 'system-prompt/assemble') promptHandlers.push(fn); },
    effect: () => {},
    get: () => {},
  };
  apply(ctx, { dir, useV3, migrateFromAffect: true, platform: 'test' });
  return { tools, promptHandlers };
}

async function assemble(promptHandlers, sid = 'test-session') {
  let next = async () => ({ sections: [] });
  for (const fn of promptHandlers) {
    const inner = next;
    next = () => fn({}, { agent: { id: sid } }, inner);
  }
  return next();
}

const baseState = () => ({
  version: 3,
  migrated: true,
  people: {
    11223344: { name: '熟人', oid: '11223344', turns: 5, traits: [], history: [], items: [] },
  },
  things: {},
  self: [],
  curves: { score: { baseDays: 5, reinforce: 0.8, shape: 1.6 } },
  archive: [],
});

const D = mkdtempSync(join(tmpdir(), 'koi-lexicon-reg-'));
process.on('exit', () => { try { rmSync(D, { recursive: true, force: true }); } catch {} });
writeFileSync(join(D, 'lexicon.json'), JSON.stringify(baseState()), 'utf8');
const { tools, promptHandlers } = boot(D);

console.log('=== 原型污染 ===');
const probe = '__koi_lexicon_pollution_probe__';
delete Object.prototype[probe];
const oidMsg = await tools.remember_person.execute({
  who: '坏 id', oid: '__proto__', trait: '不该写进去',
});
const nameMsg = await tools.remember_person.execute({
  who: '__proto__', trait: '不该写进去',
});
const thingMsg = await tools.remember_impression.execute({
  who: '__proto__', domain: 'thing', face: '坏键', delta: 0.5,
});
let lex = JSON.parse(readFileSync(join(D, 'lexicon.json'), 'utf8'));
ok('oid=__proto__ 被拒', oidMsg.includes('不合法'), oidMsg);
ok('人名=__proto__ 被拒', nameMsg.includes('不合法'), nameMsg);
ok('物事名=__proto__ 被拒', thingMsg.includes('不合法'), thingMsg);
ok('people 没有 __proto__ 自有键', !Object.hasOwn(lex.people, '__proto__'));
ok('things 没有 __proto__ 自有键', !Object.hasOwn(lex.things, '__proto__'));
ok('Object.prototype 未被污染', Object.prototype[probe] === undefined);

console.log('\n=== 关系上限 ===');
const strangerPerson = await tools.remember_person.execute({
  who: '陌生人', oid: 'aabbccdd11223344aabbccdd11223344', trait: '刚见一面', alpha: 1e-12,
});
ok('极小 alpha 按陌生人上限收紧并说明', strangerPerson.includes('陌生人关系上限 14 天'), strangerPerson);
lex = JSON.parse(readFileSync(join(D, 'lexicon.json'), 'utf8'));
const strangerDesc = lex.people.aabbccdd.items.find((it) => it.type === 'desc');
ok('陌生人写入 alpha 不低于 14 天线', strangerDesc.alpha >= curveForZero(14).alpha - 1e-12, String(strangerDesc.alpha));

const knownMessage = await tools.remember_impression.execute({
  who: '熟人', face: '靠谱', delta: 0.4, days: 99999,
});
ok('熟人超大 days 按上限收紧并说明', knownMessage.includes('熟人关系上限 60 天'), knownMessage);
lex = JSON.parse(readFileSync(join(D, 'lexicon.json'), 'utf8'));
const knownImp = lex.people['11223344'].items.find((it) => it.type === 'impression');
ok('熟人写入 alpha 按 60 天夹紧', knownImp.alpha === curveForZero(60).alpha, String(knownImp.alpha));

const thingClamp = await tools.remember_impression.execute({
  who: '旧物', domain: 'thing', face: '有意思', delta: 0.5, alpha: 1e-12,
});
ok('物事同样按陌生人上限收紧', thingClamp.includes('陌生人关系上限 14 天'), thingClamp);
lex = JSON.parse(readFileSync(join(D, 'lexicon.json'), 'utf8'));
ok('旧 curve.shape 再保存时不再写出', !Object.hasOwn(lex.curves.score, 'shape'));

console.log('\n=== 死代码 ===');
const source = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8');
ok('pushOrMerge 已删除', !source.includes('pushOrMerge'));
ok('pushHistory 已删除', !source.includes('pushHistory'));

console.log('\n=== 旧 loves/hates 在 V3 注入 ===');
const M = mkdtempSync(join(tmpdir(), 'koi-lexicon-migrate-'));
writeFileSync(join(M, 'affect.json'), JSON.stringify({
  affection: {
    loves: [{ text: '深烘咖啡', w: 0.7 }],
    hates: [{ text: '被叫错名字', w: 0.6 }],
    people: {},
  },
}), 'utf8');
writeFileSync(join(M, 'lexicon.json'), JSON.stringify({
  version: 3, migrated: false, people: {}, things: {}, self: [], curves: {}, archive: [],
}), 'utf8');
const migrated = boot(M, true);
const migratedPrompt = await assemble(migrated.promptHandlers);
const migratedText = (migratedPrompt.sections ?? []).find((s) => s.name === 'koi:lexicon')?.text ?? '';
ok('迁移的喜欢出现在 V3 注入', migratedText.includes('【我喜欢】') && migratedText.includes('深烘咖啡'), migratedText);
ok('迁移的讨厌出现在 V3 注入', migratedText.includes('【我讨厌】') && migratedText.includes('被叫错名字'), migratedText);
rmSync(M, { recursive: true, force: true });

console.log('\n=== 损坏文件保护 ===');
{
  const C = mkdtempSync(join(tmpdir(), 'koi-lexicon-corrupt-'));
  const file = join(C, 'lexicon.json');
  const badText = '{"people": {';
  writeFileSync(file, badText, 'utf8');
  const logs = [];
  const oldLog = console.log;
  console.log = (line) => { logs.push(String(line)); };
  try {
    boot(C, true);
  } finally {
    console.log = oldLog;
  }
  const backups = readdirSync(C).filter((f) => f.startsWith('lexicon.json.corrupt-'));
  ok('损坏的 lexicon 原文件未被覆盖', readFileSync(file, 'utf8') === badText);
  ok('损坏的 lexicon 已备份为 .corrupt-*', backups.length === 1);
  ok('启动日志明确报告禁止写回', logs.some((line) => line.includes('[koi-lexicon]') && line.includes('禁止迁移和写回')));
  rmSync(C, { recursive: true, force: true });
}

console.log('\n=== 影子人全字段合并 ===');
{
  const P = mkdtempSync(join(tmpdir(), 'koi-lexicon-shadow-'));
  writeFileSync(join(P, 'lexicon.json'), JSON.stringify({
    version: 3,
    migrated: true,
    people: {
      'name:影子': {
        name: '影子',
        traits: [{ text: '旧特征', at: Date.now() }],
        history: [],
        turns: 2,
        mentionDay: '2026-11-25',
        items: [{
          type: 'desc',
          domain: 'person',
          subject: 'aabbccdd11223344aabbccdd11223344',
          text: '影子记录里的 V3 描述',
          alpha: 0.2,
          at: Date.now(),
        }],
      },
      aabbccdd: {
        name: '影子',
        oid: 'aabbccdd11223344aabbccdd11223344',
        identity: { platform: 'test', value: 'aabbccdd11223344aabbccdd11223344' },
        display: '影子',
        traits: [],
        history: [],
        turns: 1,
        items: [],
      },
    },
    things: {},
    self: [],
    curves: {},
    archive: [],
  }), 'utf8');
  const shadowBoot = boot(P, true);
  const mergedMsg = await shadowBoot.tools.remember_person.execute({
    who: '影子',
    oid: 'aabbccdd11223344aabbccdd11223344',
    trait: '新特征',
  });
  const merged = JSON.parse(readFileSync(join(P, 'lexicon.json'), 'utf8'));
  const person = merged.people.aabbccdd;
  ok('影子记录合并成功', mergedMsg.startsWith('记住了'), mergedMsg);
  ok('影子 V3 desc 合并不丢', person.items.some((it) => it.text === '影子记录里的 V3 描述'));
  ok('影子 mentionDay 合并不丢', person.mentionDay === '2026-11-25');
  ok('影子 turns 合并求和', person.turns === 3, String(person.turns));
  ok('影子人键已归一', !Object.hasOwn(merged.people, 'name:影子'));
  rmSync(P, { recursive: true, force: true });
}

console.log('\n=== 原子写与写失败 ===');
{
  const A = mkdtempSync(join(tmpdir(), 'koi-lexicon-atomic-'));
  const file = join(A, 'atomic.json');
  writeFileSync(file, '{"old":true}', 'utf8');
  const beforeIno = statSync(file).ino;
  const wrote = writeLexiconStateAtomic(file, { old: true, next: true });
  ok('原子写成功', wrote === true);
  ok('原子写通过 rename 替换文件', statSync(file).ino !== beforeIno);
  ok('原子写不残留固定临时文件', readdirSync(A).every((f) => !f.endsWith('.tmp')));

  const F = mkdtempSync(join(tmpdir(), 'koi-lexicon-writefail-'));
  writeFileSync(join(F, 'lexicon.json'), JSON.stringify(baseState()), 'utf8');
  const failBoot = boot(F, true);
  chmodSync(F, 0o500);
  let failedMsg = '';
  try {
    failedMsg = await failBoot.tools.remember_person.execute({
      who: '写失败的人',
      oid: 'deadbeefdeadbeefdeadbeefdeadbeef',
      trait: '不该假成功',
    });
  } finally {
    chmodSync(F, 0o700);
  }
  ok('写失败不再回复“记住了”', !failedMsg.startsWith('记住了') && failedMsg.includes('没记下'), failedMsg);
  rmSync(A, { recursive: true, force: true });
  rmSync(F, { recursive: true, force: true });
}

console.log('\n=== recall 侧车失败隔离 ===');
{
  const R = mkdtempSync(join(tmpdir(), 'koi-lexicon-touchfail-'));
  writeFileSync(join(R, 'lexicon.json'), JSON.stringify(baseState()), 'utf8');
  writeFileSync(join(R, 'medium.jsonl'), JSON.stringify({
    id: 'fact1',
    text: '深烘咖啡很好喝',
    at: Date.now(),
    scope: 'medium',
    alpha: 0.3,
  }) + '\n', 'utf8');
  mkdirSync(join(R, 'medium.index.json'));
  const touchBoot = boot(R, true);
  const recallText = await touchBoot.tools.recall.execute({ query: '深烘' });
  ok('touch 抛错时命中事实仍然返回', recallText.includes('深烘咖啡很好喝'), recallText);
  rmSync(R, { recursive: true, force: true });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
