#!/usr/bin/env node
/** 漏话硬过滤 + 退场同日同类去重 回归（2026-11-15 参考 agent（ki）） */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const D=mkdtempSync(join(tmpdir(),'koi-leak-')); process.env.KOI_HOME=D;
process.on('exit',()=>{try{rmSync(D,{recursive:true,force:true});}catch{}});
import { mkdirSync } from 'node:fs';
mkdirSync(join(D,'.koi'),{recursive:true});
const NOW=Date.now();
writeFileSync(join(D,'.koi','outbound-whitelist.json'), JSON.stringify([
  {w:'豁免词', until:NOW+14*86400000},
  {w:'过期词', until:NOW-1000},
]));
// 2026-11-17 分层说清楚：
//   · 谓词（丢不丢）  → dsh-koi-gate/lib/rules，纯函数
//   · 白名单的读取/到期清理 → dsh-koi-gate/lib/says.js，有 IO
// 所以两个都要导入，但**判定从 rules 拿**。这条测试同时覆盖两层，是有意的。
const { shouldDropLeak, guardExit } = await import('dsh-koi-gate');
const { allow } = await import('dsh-koi-gate');
let p=0,f=0; const ok=(n,c)=>{c?p++:f++;console.log(`${c?'✅':'❌'} ${n}`);};

ok('括号底稿丢', shouldDropLeak('（ashu要问我拍板。）')===true);
// 2026-11-17 改：**含**括号不再等于旁白（astrum（星星）会被误杀）。
// 只有整句就是旁白才丢。
ok('半角括号不再误杀', shouldDropLeak('等下(内部)')===false);
ok('调度自述丢', shouldDropLeak('话已发出去。等ashu看到，02:45 再醒一次。')===true);
// 2026-11-17 改：「这次没事」「没动静」都是正常中文，曾误杀正常回复。
ok('日常短语不再误杀', shouldDropLeak('这次没事。群里一晚没动静')===false);
ok('正常聊天放行', shouldDropLeak('今天天气不错，出去走走？')===false);
ok('白名单豁免', shouldDropLeak('（豁免词）')===false);
ok('到期白名单不豁免', shouldDropLeak('（过期词）')===true);
// 触发一次出口判定：says 读白名单时会顺手清掉到期条目
allow('随便说一句', { target: 'c2c' });
ok('到期条目被清理', JSON.parse(readFileSync(join(D,'.koi','outbound-whitelist.json'),'utf8')).every(e=>e.w!=='过期词'));

ok('退场首次放行', guardExit('睡了','g')===false);
ok('同日睡类变体丢', guardExit('睡了，睡到天亮','g')===true);
ok('leave 首次放行', guardExit('告辞','g')===false);
ok('同日 leave 同类丢', guardExit('退下了','g')===true);
ok('实质内容清标记', guardExit('正常一句实质内容','g')===false);
ok('清后睡类可再发', guardExit('睡了','g')===false);

// codex P1/P2 回归：正常回复不被吞
ok('「没睡，在呢」不吞', guardExit('没睡，在呢','h')===false);
ok('「睡不着」不吞', guardExit('睡不着','h')===false);
ok('「等我回来」不漏', shouldDropLeak('等我回来')===false);
ok('「一晚没睡」不漏', shouldDropLeak('昨晚一晚没睡')===false);

// 2026-11-16 参考 agent（ki）：内部词不带括号也拦
ok('v2 不拦(词表已撤，A案)', shouldDropLeak('这次 v2 里那些分数和描述我先记着，等会儿再说。')===false);
ok('锚点/那栏不拦(日常话)', shouldDropLeak('主人是锚点，不是打分对象。他那栏空着才对。')===false);
ok('给你打八分不拦', shouldDropLeak('给你打八分')===false);
ok('定了。不拦(交给提示词)', shouldDropLeak('定了。')===false);
ok('带上下文的定了不拦', shouldDropLeak('那就这么定了，明天见')===false);

// 2026-11-16 参考 agent（ki）②：退场连击抑制
ok('退场1放行', guardExit('睡了','s')===false);
ok('退场2异类放行', guardExit('告辞','s')===false);
ok('退场3连击抑制', guardExit('退下了','s')===true);
ok('实在话清零连击', guardExit('今天聊点别的','s')===false);
console.log(`\n${p} 通过 / ${f} 失败`); process.exit(f>0?1:0);
