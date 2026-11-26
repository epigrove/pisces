import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAll, readAllSafe, append, unread, lastIndexOf, idOf } from './lib/chat-store.js';
import { rmSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
// 2026-11-13 review：原来写死 /tmp/storetest，并发跑会互删。
const D = mkdtempSync(join(tmpdir(), 'koi-test-store-'));
process.on('exit', () => { try { rmSync(D, { recursive: true, force: true }); } catch {} });
const f=D+'/chat.jsonl';
let p=0,fl=0;
const eq=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?p++:fl++;console.log(`${ok?'✅':'❌'} ${n}${ok?'':` got ${JSON.stringify(g)}`}`)};

eq('空文件', readAll(f), []);
const missing = readAllSafe(f);
eq('不存在的文件是可读的空通道', [missing.readable, missing.messages.length, missing.error], [true, 0, '']);
eq('追加1', append(f,{from:'ashu',text:'你好'}).ok, true);
eq('追加2', append(f,{from:'koi',text:'哼'}).ok, true);
eq('追加3', append(f,{from:'ashu',text:'在吗'}).ok, true);
eq('空 text 被拒', append(f,{from:'ashu',text:''}).ok, false);
eq('空 from 被拒', append(f,{from:'',text:'x'}).ok, false);

const all = readAll(f);
eq('读到3条', all.length, 3);
eq('有 id', typeof all[0]._id, 'string');
eq('有行号', all[0]._line, 0);
eq('from=ashu 2条', all.filter(m=>m.from==='ashu').length, 2);

// 权限/I/O 失败不能伪装成空文件；用目录稳定触发 EISDIR，root 下也不受 chmod 影响。
mkdirSync(join(D, 'unreadable', 'chat.jsonl'), { recursive: true });
const broken = readAllSafe(join(D, 'unreadable', 'chat.jsonl'));
eq('读失败明确标记不可读', [broken.readable, broken.messages.length, broken.error !== ''], [false, 0, true]);
eq('兼容 readAll 对读失败仍不抛', readAll(join(D, 'unreadable', 'chat.jsonl')), []);

// 面板写消息需要的既有字段仍经统一白名单落盘；未知字段不能透传。
const extra = join(D, 'extra', 'chat.jsonl');
eq('统一 append 保留 file/via', append(extra, {
  from: 'master', to: 'koi', text: '带文件', via: 'panel', file: { name: 'a.txt', path: '/tmp/a', rel: 'a', size: 3 },
  unexpected: 'drop',
}).ok, true);
const [extraLine] = readAll(extra);
eq('既有附加字段保留', [extraLine.via, extraLine.file?.name, extraLine.file?.rel], ['panel', 'a.txt', 'a']);
eq('未知字段被白名单拒绝', Object.hasOwn(extraLine, 'unexpected'), false);

// 坏行
writeFileSync(f, readAll(f).map(m=>JSON.stringify(m)).join('\n')+'\n{坏行}\n');
eq('坏行不影响读', readAll(f).length, 3);

const seen=new Set([readAll(f)[0]._id]);
eq('未读跳过 seen', unread(f,'ashu',seen).length, 1);
eq('最后 ashu 在 index 2', lastIndexOf(f,'ashu'), 2);


// 2026-11-08 codex review：「blank-line test cannot catch the line-number regression」。
// **原测试只断言「递增」，而 off-by-one 的 bug 也是递增的**（0,1 而不是 0,3），抓不到。
// 现在断言**具体行号**——必须等于在文件里的真实行号。
{
  const { appendFileSync, readFileSync: rf } = await import('node:fs');
  appendFileSync(f, '\n\n');   // 两个空行
  appendFileSync(f, JSON.stringify({ from: 'koi', at: 9, text: '空行之后' }) + '\n');
  const a2 = readAll(f);
  const last = a2[a2.length - 1];
  // 直接数它在原始文件里是第几行（0-based）
  const rawLines = rf(f, 'utf8').split('\n');
  const realIndex = rawLines.findIndex((l) => l.includes('空行之后'));
  eq('行号 = 文件里的真实行号', last._line, realIndex);
  eq('行号确实跳过了空行', last._line > a2[a2.length - 2]._line + 1, true);
}

console.log(`\n${p} 通过 / ${fl} 失败`);
process.exit(fl>0?1:0);
