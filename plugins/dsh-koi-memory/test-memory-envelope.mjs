#!/usr/bin/env node
/** 记忆信封 + 过时侧车 回归（2026-11-14，参考 agent审） */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryLayer } from './lib/layers.js';
import { checkLedger, readRefreshAudit } from 'dsh-koi-decay/sidecar';
let p=0,f=0; const ok=(n,c)=>{c?p++:f++;console.log(`${c?'✅':'❌'} ${n}`);};
const D=mkdtempSync(join(tmpdir(),'koi-mem-env-')); process.on('exit',()=>{try{rmSync(D,{recursive:true,force:true});}catch{}});
const DAY=86400000, now=Date.now();

// 新写入 = 信封 + 三字段
const L=new MemoryLayer({dir:D});
const r=L.remember({text:'她喜欢深烘', layer:'medium', who:'人物乙', source:'seen', tier:'normal'});
ok('remember ok', r.ok);
const line=readFileSync(join(D,'medium.jsonl'),'utf8').trim().split('\n').pop();
const rec=JSON.parse(line);
ok('on-disk 信封 body', rec.body && rec.body.text==='她喜欢深烘');
ok('on-disk curve/scope', rec.curve && rec.scope==='medium');
ok('三字段 source/verified/who', rec.source==='seen' && rec.verified===false && rec.who==='人物乙');
ok('默认未核', L.remember({text:'x'}).ok && JSON.parse(readFileSync(join(D,'medium.jsonl'),'utf8').trim().split('\n').pop()).verified===false);

// append-only：visibleMedium/recall 不改账本
const before=readFileSync(join(D,'medium.jsonl'),'utf8');
L.visibleMedium(now); L.recall('深烘', now);
ok('账本只增不删（visible/recall 后字节不变）', readFileSync(join(D,'medium.jsonl'),'utf8')===before);
ok('侧车索引存在', existsSync(join(D,'medium.index.json')));

// 旧平铺记录兼容 + rested 过时标记 + recall 复活
const L2=new MemoryLayer({dir:D});
writeFileSync(join(D,'medium.jsonl'), before + JSON.stringify({id:'old1',text:'旧事实',at:now-9999*DAY,why:'',layer:'medium',alpha:0.001})+'\n');
L2.load();
const vis1=L2.visibleMedium(now);
ok('极旧+慢衰减 → rested 隐藏', !vis1.some(x=>x.id==='old1'));
const idx=JSON.parse(readFileSync(join(D,'medium.index.json'),'utf8'));
ok('rested 标记已打', idx.stale['old1'] && idx.stale['old1'].reason==='rested');
const ledgerBefore=readFileSync(join(D,'medium.jsonl'),'utf8');
L2.recall('旧事实', now); // 想起 → 清 rested
const vis2=L2.visibleMedium(now);
ok('recall 后复活可见', vis2.some(x=>x.id==='old1'));
ok('打标/复活不改账本', readFileSync(join(D,'medium.jsonl'),'utf8')===ledgerBefore);

// 写入闸：alpha 越界拒
ok('alpha<=0 拒', L2.remember({text:'y', alpha:0}).ok===false);


// 无 id 旧记录不建 "undefined" 键（codex P3）
{
  const D2=mkdtempSync(join(tmpdir(),'koi-mem-noid-'));
  const L3=new MemoryLayer({dir:D2});
  writeFileSync(join(D2,'medium.jsonl'), JSON.stringify({text:'无id',at:now-9999*DAY,layer:'medium',alpha:0.3})+'\n');
  L3.load(); L3.visibleMedium(now); L3.recall('无id',now);
  const ip=join(D2,'medium.index.json');
  const idx=existsSync(ip)?JSON.parse(readFileSync(ip,'utf8')):{stale:{},touch:{}};
  ok('无 id 不产生 undefined 键', !('undefined' in idx.stale) && !('undefined' in idx.touch));
  rmSync(D2,{recursive:true,force:true});
}
// 账本完整性：合法追加 ok；旁路追加被检出（参考 agent审）
{
  const D3=mkdtempSync(join(tmpdir(),'koi-mem-int-'));
  const L4=new MemoryLayer({dir:D3});
  L4.remember({text:'合法一条'});
  ok('合法追加后基线一致', checkLedger(join(D3,'medium.jsonl')).ok===true);
  appendFileSync(join(D3,'medium.jsonl'), JSON.stringify({id:'evil',text:'旁路',at:now,layer:'medium',alpha:0.3})+'\n');
  ok('旁路追加被检出', checkLedger(join(D3,'medium.jsonl')).ok===false);
  rmSync(D3,{recursive:true,force:true});
}
// 基线刷新审计：谁/几点刷的可见（参考 agent审）
{
  const D4=mkdtempSync(join(tmpdir(),'koi-mem-aud-'));
  const L5=new MemoryLayer({dir:D4});
  L5.remember({text:'审计一条'});
  const aud=readRefreshAudit(join(D4,'medium.jsonl'));
  ok('刷新留审计', aud.length>=1);
  ok('审计记 actor=remember', aud[aud.length-1].actor==='remember');
  ok('审计记时间', Number(aud[aud.length-1].at)>0);
  rmSync(D4,{recursive:true,force:true});
}
console.log(`\n${p} 通过 / ${f} 失败`); process.exit(f>0?1:0);
