import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MOOD_CURVE, MoodDims } from './lib/mood-dims.js';
import {
  chmodSync,
  rmSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
// 2026-11-13 review：原来写死 /tmp/moodtest，两个人（或两个 CI job）同时跑就互删。
// 用 mkdtemp 拿唯一目录，退出时自己清。
const D = mkdtempSync(join(tmpdir(), 'koi-test-mood-'));
process.on('exit', () => { try { rmSync(D, { recursive: true, force: true }); } catch {} });
let pass=0, fail=0;
function eq(n,g,w) {
  const ok = JSON.stringify(g)===JSON.stringify(w);
  if (ok) pass++; else fail++;
  console.log((ok?'✅ ':'❌ ')+n+(ok?'':'  got='+JSON.stringify(g)+' want='+JSON.stringify(w)));
}

const m = new MoodDims({dir: D});
eq('初始为空', m.stats().dims, 0);

const r1 = m.add({mood:'烦躁', delta:-0.6, why:'人物乙 又怼我'});
eq('加烦躁成功', r1.ok, true);
const r2 = m.add({mood:'松快', delta:0.4, why:'图读出来了'});
eq('加松快成功', r2.ok, true);

const cur = m.current();
eq('两个维度共存', cur.length, 2);
console.log('  当前: ' + cur.map(x => x.mood+' '+x.score.toFixed(2)).join(' / '));

const sum = cur.reduce((s,x)=>s+x.score,0);
eq('烦躁和松快各自独立', Math.abs(sum) < 0.5 && cur.length === 2, true);

eq('recall 烦躁', m.recall('烦躁').length, 1);
eq('recall 空串全查', m.recall('').length, 2);
eq('非法 delta 被拒', m.add({mood:'x', delta:5}).ok, false);
eq('空情绪名被拒', m.add({mood:'', delta:0.3}).ok, false);

const r3 = m.add({mood:'无聊', delta:0.3, days:1});
eq('days 参数生效', r3.message.includes('小时') || r3.message.includes('天后'), true);

const m2 = new MoodDims({dir: D});
eq('重载后还在', m2.current().length, 3);

// ── 原子写 + 写失败不再假成功 ──────────────────────────────
{
  const file = join(D, 'mood-dims.json');
  const beforeIno = statSync(file).ino;
  eq('原子保存成功', m2.save(), true);
  eq('原子保存通过 rename 替换文件', statSync(file).ino !== beforeIno, true);
  eq('原子保存不残留固定 .tmp', readdirSync(D).every((f) => !f.endsWith('.tmp')), true);

  const F = mkdtempSync(join(tmpdir(), 'koi-test-md-writefail-'));
  const failing = new MoodDims({ dir: F });
  eq('写失败前先建立可写索引', failing.add({ mood: '平静', delta: 0.2 }).ok, true);
  chmodSync(F, 0o500);
  let failed;
  try {
    failed = failing.add({ mood: '烦躁', delta: -0.4, why: '目录不可写' });
  } finally {
    chmodSync(F, 0o700);
  }
  eq('多维心情写失败返回失败', failed.ok, false);
  eq('多维心情写失败消息不冒充记下', failed.message.includes('没记下'), true);
  eq('多维心情写失败不改内存状态', failing.data['烦躁'] === undefined, true);
  rmSync(F, { recursive: true, force: true });
}

// ── 外部给的默认衰减（M3，2026-11-24）──────────────────────
{
  const D2 = mkdtempSync(join(tmpdir(), 'koi-test-md2-'));
  const half = 12; // 半衰期 12 小时
  const alpha = Math.log(2) / Math.log(half + 1);
  const m = new MoodDims({ dir: D2, defaultAlpha: alpha });
  m.add({ mood: '烦躁', delta: -0.6, why: '测试外部默认 alpha' });
  const items = m.current();
  const rec = m.data['烦躁']?.items?.[0];
  // alpha 存的是全精度，比较用容差不用等值
  eq('外部默认 alpha 被采纳', Math.abs(Number(rec?.alpha) - alpha) < 1e-9, true);
  rmSync(D2, { recursive: true, force: true });
}

// ── 损坏文件：先备份，再拒绝覆盖 ───────────────────────────
{
  const D3 = mkdtempSync(join(tmpdir(), 'koi-test-md-corrupt-'));
  const badText = '{"烦躁": {"items": [';
  writeFileSync(join(D3, 'mood-dims.json'), badText);
  const bad = new MoodDims({ dir: D3 });
  const rejected = bad.add({ mood: '松快', delta: 0.4 });
  const backups = readdirSync(D3).filter((f) => f.startsWith('mood-dims.json.corrupt-'));
  eq('损坏文件拒绝写入', rejected.ok, false);
  eq('损坏文件已备份', backups.length, 1);
  eq('原损坏文件未被覆盖', readFileSync(join(D3, 'mood-dims.json'), 'utf8'), badText);
  rmSync(D3, { recursive: true, force: true });
}

// ── 活跃数组上限 + archived 不丢数据 ───────────────────────
{
  const D4 = mkdtempSync(join(tmpdir(), 'koi-test-md-archive-'));
  const now = Date.now();
  const items = Array.from({ length: 501 }, (_, i) => ({
    delta: 0.1,
    why: `第 ${i} 条`,
    alpha: DEFAULT_MOOD_CURVE.alpha,
    at: now - (501 - i) * 1000,
  }));
  writeFileSync(join(D4, 'mood-dims.json'), JSON.stringify({ 烦躁: { items } }));
  const archived = new MoodDims({ dir: D4 });
  eq('活跃数组压到 500', archived.data['烦躁'].items.length, 500);
  eq('溢出记录进入 archived', archived.data['烦躁'].archived.length, 1);
  eq('archived 仍可 recall', archived.recall('').length, 501);
  archived.add({ mood: '烦躁', delta: 0.2, why: '第 502 条' });
  const reloaded = new MoodDims({ dir: D4 });
  eq('再次添加后活跃仍为 500', reloaded.data['烦躁'].items.length, 500);
  eq('再次添加后归档保留 2 条', reloaded.data['烦躁'].archived.length, 2);
  eq('重载后累计仍为 502', reloaded.recall('').length, 502);
  rmSync(D4, { recursive: true, force: true });
}

// ── 已停用的单值心情代码不得回潮 ───────────────────────────
{
  const source = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8');
  eq('单值心情死代码已删除',
    !/AFF_BASE_DAYS|AFF_SHAPE|AFF_MAX_HISTORY|pushMoodEvent|moodNow/.test(source),
    true);
}

console.log('\n'+pass+' 通过 / '+fail+' 失败');
process.exit(fail>0?1:0);
