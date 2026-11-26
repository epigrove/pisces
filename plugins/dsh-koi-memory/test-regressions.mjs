#!/usr/bin/env node
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, ShortTerm } from './lib/index.js';
import { MemoryLayer } from './lib/layers.js';
import { updateLexiconStateAtomic } from 'dsh-koi-lexicon';

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

const DAY = 86400000;
const now = Date.now();
const dirs = [];
const tempDir = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
process.on('exit', () => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

console.log('=== 跨会话隔离 ===');
{
  const D = tempDir('koi-mem-cross-');
  const shortDir = join(D, 'short');
  const short = new ShortTerm({ dir: shortDir, maxItems: 20, flushMs: 60000 });
  short.push({ sid: 'private-A', t: now, w: '甲', oid: 'aabbccdd', x: 'A 私聊秘密', r: 'u' });
  ok('已知 sid 命中自己的消息', short.latest({ limit: 10, now, sids: new Set(['private-A']) }).some((m) => m.x === 'A 私聊秘密'));
  ok('已知 sid 无命中时返回空，不全局回退', short.latest({ limit: 10, now, sids: new Set(['private-B']) }).length === 0);
  ok('明确 sids=null 的旧路径仍可取全局', short.latest({ limit: 10, now, sids: null }).some((m) => m.x === 'A 私聊秘密'));
  short.stop();
}

{
  const D = tempDir('koi-mem-apply-');
  writeFileSync(
    join(D, 'profile.core.md'),
    'openid AABBCCDD11223344AABBCCDD11223344\n',
    'utf8',
  );
  const promptHandlers = [];
  const eventHandlers = [];
  let cleanup = () => {};
  const ctx = {
    tools: { register: () => {} },
    on: (event, fn) => {
      if (event === 'system-prompt/assemble') promptHandlers.push(fn);
      else eventHandlers.push([event, fn]);
    },
    effect: (fn) => { cleanup = fn() ?? (() => {}); },
    get: () => {},
  };
  apply(ctx, { dir: D, shortDir: join(D, 'short'), shortMaxItems: 20 });
  const onEvent = eventHandlers.find(([event]) => event === 'session/event')?.[1];
  onEvent?.({ id: 'private-A' }, {
    type: 'user/message',
    time: now,
    data: {
      source: { kind: 'user' },
      content: [{ type: 'text', text: '[主人 (AABBCCDD11223344AABBCCDD11223344)] 别把这条带到别的会话' }],
    },
  });

  const assemble = async (sid) => {
    let next = async () => ({ sections: [] });
    for (const fn of promptHandlers) {
      const inner = next;
      next = () => fn({}, { agent: { id: sid } }, inner);
    }
    return next();
  };

  const own = JSON.stringify(await assemble('private-A'));
  const other = JSON.stringify(await assemble('private-B'));
  ok('当前会话仍能看见自己的短期消息', own.includes('别把这条带到别的会话'), own);
  ok('当前会话仍能认出主人', own.includes('【正在跟你说话】主人'), own);
  ok('另一个已知会话看不到私聊内容', !other.includes('别把这条带到别的会话'), other);
  ok('另一个已知会话不会用 lastAny 冒充 lastUser', !other.includes('正在跟你说话'), other);
  cleanup();
}

console.log('\n=== 短期活跃窗口 ===');
{
  const D = tempDir('koi-mem-short-');
  const short = new ShortTerm({ dir: D, maxItems: 3, flushMs: 60000 });
  for (let i = 1; i <= 5; i += 1) {
    short.push({ sid: 's', t: now + i, w: '甲', oid: 'aabbccdd', x: `第 ${i} 条`, r: 'u' });
  }
  ok('活跃数组严格裁到 maxItems', short.items.length === 3, String(short.items.length));
  ok('活跃数组保留最新三条', short.items.map((m) => m.x).join('|') === '第 3 条|第 4 条|第 5 条');
  short.stop();
  const disk = readFileSync(short.file(now + 5), 'utf8').trim().split('\n').filter(Boolean);
  ok('被挤出活跃窗口的历史仍写入 JSONL', disk.length === 5, String(disk.length));
}

console.log('\n=== recall 侧车同步 ===');
{
  const D = tempDir('koi-mem-sidecar-');
  writeFileSync(
    join(D, 'medium.jsonl'),
    `${JSON.stringify({ id: 'old1', text: '旧事实', at: now - 9999 * DAY, layer: 'medium', alpha: 0.001 })}\n`,
    'utf8',
  );
  const layers = new MemoryLayer({ dir: D });
  const first = layers.visibleMedium(now);
  ok('旧记忆先被判 rested 隐藏', !first.some((x) => x.id === 'old1'));
  const indexFile = join(D, 'medium.index.json');
  const index = JSON.parse(readFileSync(indexFile, 'utf8'));
  index.touch.old1 = now;
  delete index.stale.old1;
  writeFileSync(indexFile, JSON.stringify(index), 'utf8');
  const second = layers.visibleMedium(now);
  ok('侧车 touch 更新后无需重建对象即可复活', second.some((x) => x.id === 'old1'));
  ok('内存 recallAt 已同步侧车最新值', layers.medium.find((x) => x.id === 'old1')?.recallAt === now);
}

console.log('\n=== 注释与版本 ===');
{
  const indexSource = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8');
  const layersSource = readFileSync(new URL('./lib/layers.js', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  ok('文件头版本为 v8', indexSource.includes('dsh-koi-memory v8'), indexSource.slice(0, 60));
  ok('启动日志版本为 v8', indexSource.includes('v8 ready'));
  ok('package 描述版本为 v8', pkg.description.includes('v8'), pkg.description);
  ok('7/40/90 注释标明是降到 10% 的天数', layersSource.includes('降到 10% 的天数'));
  ok('不再把 7/40/90 标成半衰期', !layersSource.includes('价值档 → 半衰期'));
}

console.log('\n=== 侧车损坏保护 ===');
{
  const D = tempDir('koi-mem-sidecar-corrupt-');
  writeFileSync(
    join(D, 'medium.jsonl'),
    `${JSON.stringify({ id: 'fresh1', text: '新记忆', at: now, scope: 'medium', alpha: 0.3 })}\n`,
    'utf8',
  );
  const indexFile = join(D, 'medium.index.json');
  const badText = '{"stale":';
  writeFileSync(indexFile, badText, 'utf8');
  const layers = new MemoryLayer({ dir: D });
  layers.visibleMedium(now);
  const saveOk = layers.saveIndex();
  const backups = readdirSync(D).filter((f) => f.startsWith('medium.index.json.corrupt-'));
  ok('损坏侧车拒绝写回', saveOk === false);
  ok('损坏侧车原文件未被空桶覆盖', readFileSync(indexFile, 'utf8') === badText);
  ok('损坏侧车已备份', backups.length === 1);
}

console.log('\n=== 侧车原子写 ===');
{
  const D = tempDir('koi-mem-sidecar-atomic-');
  writeFileSync(join(D, 'long.jsonl'), `${JSON.stringify({
    id: 'long1', text: '长期事实', at: now, scope: 'long', body: { text: '长期事实' },
  })}\n`, 'utf8');
  const layers = new MemoryLayer({ dir: D });
  ok('首次标记废弃成功', layers.markObsolete('long1', true) === true);
  const beforeIno = statSync(join(D, 'medium.index.json')).ino;
  ok('第二次侧车写入成功', layers.markObsolete('long1', false) === true);
  ok('侧车写入通过 rename 替换文件', statSync(join(D, 'medium.index.json')).ino !== beforeIno);
  ok('侧车没有固定临时文件残留', readdirSync(D).every((f) => !f.endsWith('.tmp')));
}

console.log('\n=== memory 写 lexicon API ===');
{
  const D = tempDir('koi-mem-lex-api-');
  const lexFile = join(D, 'lexicon.json');
  writeFileSync(lexFile, JSON.stringify({ version: 3, migrated: true, people: { keep: { name: '保留' } }, things: {}, self: [] }), 'utf8');
  const beforeIno = statSync(lexFile).ino;
  updateLexiconStateAtomic(lexFile, (lex) => {
    lex.self ??= [];
    lex.self.push({ text: 'API 写入', why: '测试', at: now });
  });
  const updated = JSON.parse(readFileSync(lexFile, 'utf8'));
  ok('lexicon API 保留其它字段', updated.people.keep.name === '保留');
  ok('lexicon API 追加 self', updated.self.some((x) => x.text === 'API 写入'));
  ok('lexicon API 通过 rename 替换文件', statSync(lexFile).ino !== beforeIno);
  ok('lexicon API 不残留固定 .tmp', !existsSync(`${lexFile}.tmp`));
}

console.log('\n=== memory_add(self) 走 lexicon 原子 API ===');
{
  const D = tempDir('koi-mem-add-lex-');
  const lexFile = join(D, 'lexicon.json');
  writeFileSync(lexFile, JSON.stringify({ version: 3, migrated: true, people: {}, things: {}, self: [] }), 'utf8');
  const tools = {};
  let cleanup = () => {};
  const ctx = {
    tools: { register: (def) => { tools[def.name] = def; } },
    on: () => {},
    effect: (fn) => { cleanup = fn() ?? (() => {}); },
    get: () => {},
  };
  apply(ctx, { dir: D, shortDir: join(D, 'short') });
  const msg = await tools.memory_add.execute({ scope: 'self', text: '原子追加的自我认知', why: '验证写入 API' });
  cleanup();
  const updated = JSON.parse(readFileSync(lexFile, 'utf8'));
  ok('memory_add(self) 返回成功', msg.startsWith('记下了'), msg);
  ok('memory_add(self) 真的写进 lexicon', updated.self.some((x) => x.text === '原子追加的自我认知'));
  ok('memory_add(self) 不残留固定 .tmp', !existsSync(`${lexFile}.tmp`));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
