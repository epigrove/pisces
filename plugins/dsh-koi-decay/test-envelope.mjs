#!/usr/bin/env node
/** 记录信封 + 过时标记跳过计算 回归（2026-11-14） */
import { normalizeRecord, hiddenReason, shouldSkipComputation, weight, daysSince, SHOW_THRESHOLD } from './lib/index.js';
let p=0,f=0; const ok=(n,c)=>{c?p++:f++;console.log(`${c?'✅':'❌'} ${n}`);};
const DAY=86400000, now=Date.now();

// normalize：旧平铺 → 信封（保留派生 text/alpha）
const old={id:'a',text:'x',at:now,why:'w',layer:'medium',alpha:0.3,tier:'normal'};
const n=normalizeRecord(old);
ok('旧形状归一 scope', n.scope==='medium');
ok('旧形状归一 body.text', n.body.text==='x' && n.text==='x');
ok('旧形状归一 curve.alpha', n.curve.alpha===0.3 && n.alpha===0.3);
// 新信封 → 同样内存对象
const env={id:'b',at:now,scope:'medium',curve:{alpha:0.3},body:{text:'y'}};
const n2=normalizeRecord(env);
ok('新信封 text 派生', n2.text==='y');

// hiddenReason：长期永不隐藏
ok('long 不隐藏', hiddenReason({scope:'long',at:now-9999*DAY,alpha:0.3},now)===null);
// 新记录可见
ok('新记录可见', hiddenReason({scope:'medium',at:now,alpha:0.3},now)===null);
// 很久以前 → weight 或 rested
const oldRec={scope:'medium',at:now-9999*DAY,alpha:0.3};
ok('极旧记录隐藏', hiddenReason(oldRec,now)!==null);

// shouldSkip：weight 标记直接跳
ok('weight 标记跳过', shouldSkipComputation(oldRec,{reason:'weight',at:now})===true);
// rested 标记：标记后没被想起 → 跳
ok('rested 未想起跳过', shouldSkipComputation({scope:'medium',at:now-9999*DAY,alpha:0.001},{reason:'rested',at:now-1*DAY},now)===true);
// rested 标记：标记后被想起 → 不跳
ok('rested 被想起不跳', shouldSkipComputation({scope:'medium',at:now-9999*DAY,alpha:0.001,recallAt:now},{reason:'rested',at:now-1*DAY},now)===false);
// 无标记不跳
ok('无标记不跳', shouldSkipComputation(oldRec,null,now)===false);

console.log(`\n${p} 通过 / ${f} 失败`); process.exit(f>0?1:0);
