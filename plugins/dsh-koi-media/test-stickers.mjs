import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { StickerStore } from './lib/stickers.js';
import { apply, koiDataDir } from './lib/index.js';
import { isInsideMediaRoot } from './lib/media-root.js';
import {
  chmodSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
  statSync,
  symlinkSync,
} from 'node:fs';
// 2026-11-13 review：原来写死 /tmp/stickertest，并发跑会互删。
const D = mkdtempSync(join(tmpdir(), 'koi-test-sticker-'));
mkdirSync(D + '/src', { recursive: true });
process.on('exit', () => { try { rmSync(D, { recursive: true, force: true }); } catch {} });

// 造假图
writeFileSync(D+'/src/a.jpg', Buffer.from([0xff,0xd8,0xff,0xe0,1,2,3]));
writeFileSync(D+'/src/b.jpg', Buffer.from([0xff,0xd8,0xff,0xe0,9,9,9]));

const storeCfg = { dir: D, mediaRoot: join(D, 'src') };
const S = new StickerStore(storeCfg);
let pass=0, fail=0;
const eq=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?pass++:fail++;console.log(`${ok?'✅':'❌'} ${n}${ok?'':`: got ${JSON.stringify(g)}`}`);};

console.log('=== 收图 ===');
const r1 = S.keep({image: D+'/src/a.jpg', desc:'白猫竖中指', from:'人物甲'});
eq('收成功', r1.ok, true);
console.log('   ', r1.message);
eq('图复制到持久目录', r1.item?.path?.includes('/media/'), true);
eq('文件真的存在', readFileSync(r1.item.path).length, 7);

console.log('=== 重复收 ===');
const r2 = S.keep({image: D+'/src/a.jpg', desc:'白猫竖中指'});
eq('重复被识别', r2.message.includes('早就收过'), true);
eq('不新增条目', S.items.length, 1);

console.log('=== 收第二张 ===');
const r3 = S.keep({image: D+'/src/b.jpg', desc:'熊猫头冒汗', from:'运维方'});
eq('第二张成功', r3.ok, true);
eq('总共 2 张', S.items.length, 2);

console.log('=== 捞图 ===');
eq('按描述捞', S.recall('白猫').total, 1);
eq('按发送人捞', S.recall('运维方').total, 1);
eq('空查询返回全部', S.recall('').total, 2);
eq('捞不到返回 0', S.recall('不存在的东西').total, 0);

console.log('=== 未登记的老图（2026-11-27 修「库存里一张也找不着」）===');
// 模拟：换 mediaRoot 之前就躺在库存目录里、但没进索引的老图
writeFileSync(join(D, 'media', 'legacy-1.gif'), Buffer.from([0x47,0x49,0x46,0x38,1]));
writeFileSync(join(D, 'media', 'legacy-2.png'), Buffer.from([0x89,0x50,0x4e,0x47,2]));
{
  const miss = S.recall('风堇');
  eq('搜不到时仍报 0 条登记命中', miss.total, 0);
  eq('但会列出未登记的老图', miss.unregistered.length, 2);
  eq('未登记总数对得上', miss.unregisteredTotal, 2);
  eq('返回的是绝对路径', miss.unregistered.every((it) => it.path.startsWith(join(D, 'media'))), true);
  const hitOne = S.recall('白猫');
  eq('命中时也带未登记提示', hitOne.unregisteredTotal, 2);
  eq('空查询不列未登记（避免刷屏）', S.recall('').unregisteredTotal, 0);
}
// 从库存目录里重新登记老图（原来只认 QQ 临时媒体根，会把她自己拦在外面）
{
  const legacyPath = join(D, 'media', 'legacy-1.gif');
  const r = S.keep({ image: legacyPath, desc: '风堇竖中指（补登记）' });
  eq('能从库存目录补登记', r.ok, true);
  eq('补登记后按描述搜得到', S.recall('风堇').total, 1);
  // 2026-11-27 review P2：补登记后原件要清掉，否则它会一直算「未登记」，能反复重复登记
  eq('补登记后原件不再算未登记', S.recall('风堇').unregistered.some((it) => it.path === legacyPath), false);
  eq('未登记只剩另一张', S.recall('风堇').unregisteredTotal, 1);
}

console.log('=== 边界 ===');
eq('不存在的图被拒', S.keep({image:'/nope.jpg', desc:'x'}).ok, false);
eq('无描述被拒', S.keep({image: D+'/src/a.jpg', desc:''}).ok, false);
eq('非图片被拒', (()=>{writeFileSync(D+'/src/x.txt','hi');return S.keep({image:D+'/src/x.txt',desc:'x'}).ok;})(), false);
writeFileSync(D+'/outside.jpg', Buffer.from([0xff,0xd8,0xff,0xe0,4,5,6]));
eq('mediaRoot 外图片被拒', S.keep({image:D+'/outside.jpg', desc:'越界'}).ok, false);
symlinkSync(D+'/outside.jpg', D+'/src/link.jpg');
eq('经符号链接逃出 mediaRoot 也被拒', S.keep({image:D+'/src/link.jpg', desc:'链接越界'}).ok, false);
symlinkSync('/etc/passwd', D+'/src/escape.jpg');
eq('统一边界函数拒绝软链逃逸', isInsideMediaRoot(D+'/src/escape.jpg', join(D, 'src')), false);
mkdirSync(D+'/outside-dir');
symlinkSync(D+'/outside-dir', D+'/src/outside-dir-link');
eq('不存在文件按最近存在祖先拦软链逃逸',
  isInsideMediaRoot(D+'/src/outside-dir-link/not-yet.jpg', join(D, 'src')), false);
eq('纯不存在路径若祖先仍在 root 内则允许', isInsideMediaRoot(D+'/src/not-yet.jpg', join(D, 'src')), true);

console.log('=== 持久化 ===');
const S2 = new StickerStore(storeCfg);
// 2026-11-27：前面补登记了一张老图，所以用 S.items.length 而不是写死 2
 eq('重载条数与内存一致', S2.items.length, S.items.length);
console.log('   stats:', JSON.stringify(S2.stats()));
{
  const beforeIno = statSync(join(D, 'stickers.json')).ino;
  eq('索引原子写成功', S2.save(), true);
  eq('索引写通过 rename 替换文件', statSync(join(D, 'stickers.json')).ino !== beforeIno, true);
  eq('索引没有固定 .tmp 残留', readdirSync(D).every((f) => !f.endsWith('.tmp')), true);
}
{
  chmodSync(D, 0o500);
  let failed;
  try {
    failed = S2.keep({ image: D+'/src/a.jpg', desc:'白猫竖中指' });
  } finally {
    chmodSync(D, 0o700);
  }
  eq('索引写失败时重复收图返回失败', failed.ok, false);
  eq('索引写失败时不冒充“收好了”', failed.message.includes('收好了'), false);
}
{
  const F = mkdtempSync(join(tmpdir(), 'koi-sticker-index-fail-'));
  mkdirSync(join(F, 'media'), { recursive: true });
  const failStore = new StickerStore({ dir: F, mediaRoot: join(D, 'src') });
  chmodSync(F, 0o500);
  let failed;
  try {
    failed = failStore.keep({ image: D+'/src/b.jpg', desc:'新图但索引写失败' });
  } finally {
    chmodSync(F, 0o700);
  }
  eq('索引写失败时新收图返回失败', failed.ok, false);
  eq('索引写失败时新收图不冒充“收好了”', failed.message.includes('收好了'), false);
  rmSync(F, { recursive: true, force: true });
}

console.log('=== 数据目录 ===');
const oldKoiHome = process.env.KOI_HOME;
process.env.KOI_HOME = join(D, 'koi-home');
eq('config.dir 优先', koiDataDir({ dir: join(D, 'configured') }), join(D, 'configured'));
eq('KOI_HOME 次优先并补 .koi', koiDataDir({}), join(D, 'koi-home', '.koi'));
if (oldKoiHome === undefined) delete process.env.KOI_HOME;
else process.env.KOI_HOME = oldKoiHome;
if (oldKoiHome === undefined) eq('无 KOI_HOME 时回退 ~/.koi', koiDataDir({}), join(homedir(), '.koi'));

console.log('=== 识图大小上限 ===');
{
  process.env.MODEL_PROVIDER = 'test-provider';
  process.env.MODEL_NAME = 'test-model';
  const handlers = new Map();
  let saveCalls = 0;
  const tools = [];
  const ctx = {
    get(name) {
      if (name === 'llm') {
        return {
          stream: async function* () {
            yield { type: 'text-delta', text: '不该走到模型调用' };
          },
        };
      }
      if (name === 'attachments') {
        return {
          async saveImage() {
            saveCalls += 1;
            return { id: 'saved' };
          },
        };
      }
      return undefined;
    },
    on(type, fn) {
      const list = handlers.get(type) ?? [];
      list.push(fn);
      handlers.set(type, list);
    },
    effect(fn) { fn(); },
    tools: { register(tool) { tools.push(tool); } },
  };
  apply(ctx, {
    dir: join(D, 'media-data'),
    mediaRoot: join(D, 'src'),
    maxBytes: 3,
  });
  const keepImage = tools.find((t) => t.name === 'keep_image');
  const keepOutside = await keepImage.execute({ image: join(D, 'outside.jpg'), desc: '越界' });
  eq('keep_image 工具注册时继承 mediaRoot 限制', keepOutside.includes('允许的媒体目录'), true);
  const emit = (type, ...args) => {
    for (const fn of handlers.get(type) ?? []) fn(...args);
  };
  emit('session/event', { id: 'vision-session' }, {
    type: 'agent/inbox/spliced',
    data: {
      inserted: [{
        id: 'vision-message',
        source: { kind: 'user' },
        content: [{ type: 'text', text: `Image: ${D}/src/a.jpg` }],
      }],
    },
  });
  emit('agent/inbox/claimed', { agent: { id: 'vision-session' }, message: { id: 'vision-message' } });
  const assembled = await handlers.get('system-prompt/assemble')[0](
    null,
    { agent: { id: 'vision-session' } },
    async () => ({ sections: [] }),
  );
  const text = [...(assembled.sections ?? []), ...(assembled.contexts ?? [])].map((s) => s.text).join('\n');
  const visionContext = (assembled.contexts ?? []).find((s) => s.name === 'koi:vision-feed');
  eq('识图转述走 contexts', visionContext?.text.includes('超过识图大小上限 3 字节'), true);
  eq('识图转述不再进 sections', !(assembled.sections ?? []).some((s) => s.name === 'koi:vision-feed'), true);
  eq('识图转述保留 interpolate:false', visionContext?.interpolate, false);
  eq('超过 maxBytes 返回明确错误', text.includes('超过识图大小上限 3 字节'), true);
  eq('超限文件没有被送进 attachments', saveCalls, 0);
  eq('新配置上限 8MB 可用', readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8').includes('8 * 1024 * 1024'), true);

  emit('session/event', { id: 'vision-session' }, { type: 'turn/end', data: {} });
  emit('session/event', { id: 'vision-session' }, {
    type: 'agent/inbox/spliced',
    data: {
      inserted: [{
        id: 'vision-escape-message',
        source: { kind: 'user' },
        content: [{ type: 'text', text: `Image: ${D}/src/escape.jpg` }],
      }],
    },
  });
  emit('agent/inbox/claimed', { agent: { id: 'vision-session' }, message: { id: 'vision-escape-message' } });
  const escaped = await handlers.get('system-prompt/assemble')[0](
    null,
    { agent: { id: 'vision-session' } },
    async () => ({ sections: [] }),
  );
  const escapedText = [...(escaped.sections ?? []), ...(escaped.contexts ?? [])].map((s) => s.text).join('\n');
  eq('自动识图拒绝 mediaRoot 内指向 /etc/passwd 的软链', escapedText.includes('不在允许的目录里'), true);
  eq('软链逃逸文件没有被送进 attachments', saveCalls, 0);
}

console.log('=== 压缩死链 ===');
{
  const source = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8');
  eq('loadSharp/shouldShrink/silent 压缩链已删除',
    !/loadSharp|shouldShrink|sharpPromise|const silent\s*=/.test(source),
    true);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail>0?1:0);
