#!/usr/bin/env node
/** 退场语守卫回归。 */
// 这些是纯谓词/标记，住在 rules；从 says 拿等于绕道
import { guardExit, markImage, markNamed, isSilenceToken } from 'dsh-koi-gate';
let p=0,f=0;
const ok=(n,c)=>{c?p++:f++;console.log(`${c?'✅':'❌'} ${n}`);};

// 带图 → 退场被丢
markImage('g1', true);
// 退场语已从退出表删除，后来也彻底移出静默词流程。
// 换一个仍在表里的退场语来测「带图时不许用退场语敷衍」。
ok('带图时「告辞」被丢', guardExit('告辞','g1')===true);
ok('带图时「退下了」被丢', guardExit('退下了','g1')===true);
ok('带图时实质描述放行', guardExit('人物甲发了张猫脸表情，眯着眼','g1')===false);
ok('实质输出后标记清除，退场不再因图被丢', guardExit('退下了','g1')===false);

// 点名 → 退场被丢
markNamed('g2', true);
ok('点名时退场被丢', guardExit('告辞','g2')===true);
ok('点名时认真接话放行', guardExit('98.6 是华氏体温，不是分数啦','g2')===false);

// 重复退场 → 第二次丢
ok('无标记第一次退场放行', guardExit('睡了','g3')===false);
ok('同句退场第二次被丢', guardExit('睡了','g3')===true);
ok('换一句退场放行', guardExit('告辞','g3')===false);

// 正常短句不误伤
ok('正常短回复不判退场', guardExit('行，知道了','g4')===false);
ok('空字符串放行', guardExit('','g4')===false);
ok('长句不判退场', guardExit('今天不想聊这个，你们继续，我去看看图','g4')===false);

console.log(`\n${p} 通过 / ${f} 失败`);
process.exit(f>0?1:0);
