import { validateImpression, appendImpression, FACE_MAX, DEFAULT_IMPRESSION_CURVE } from './lib/impression-write.js';

let pass=0, fail=0;
const eq=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?pass++:fail++;console.log(`${ok?'✅':'❌'} ${n}${ok?'':`: got ${JSON.stringify(g)} want ${JSON.stringify(w)}`}`);};

console.log('=== 校验 ===');
eq('正常通过', validateImpression({face:'爱呛人', delta:-0.6}).ok, true);
eq('face 空被拒', validateImpression({face:'', delta:-0.6}).ok, false);
eq('face 太长被拒', validateImpression({face:'她肯拿方案来问认下我说得对的地方做事像样', delta:0.4}).ok, false);
eq('face 恰好 12 字', validateImpression({face:'一二三四五六七八九十十一', delta:0.5}).ok, true);
eq('face 13 字被拒', validateImpression({face:'一二三四五六七八九十十一二', delta:0.5}).ok, false);
eq('delta 超界被拒', validateImpression({face:'x', delta:2}).ok, false);
eq('alpha<=0 被拒', validateImpression({face:'x', delta:0.5, alpha:0}).ok, false);
eq('alpha 正数通过', validateImpression({face:'x', delta:0.5, alpha:0.3}).ok, true);
eq('不给曲线也通过', validateImpression({face:'x', delta:0.5}).ok, true);

console.log('=== 追加 ===');
const subj = { identity:{platform:'qq',value:'00000002'}, display:'人物乙', items:[] };
const r1 = appendImpression(subj, { face:'爱呛人', delta:-0.6, why:'聊天时总怼我' });
eq('追加成功', r1.ok, true);
eq('items 里 1 条', subj.items.length, 1);
eq('类型对', subj.items[0].type, 'impression');
eq('face 对', subj.items[0].face, '爱呛人');
eq('why 对', subj.items[0].why, '聊天时总怼我');
eq('消息里提到落灰点', r1.message.includes('落灰') || r1.message.includes('掉到'), true);

const r2 = appendImpression(subj, { face:'靠谱', delta:0.4 });
eq('不给 why 也行', r2.ok, true);
eq('没有 why 就是 undefined', subj.items[1].why, undefined);

const r3 = appendImpression(subj, { face:'太长太长太长太长太长的形容', delta:0.5 });
eq('太长的被拒', r3.ok, false);
eq('被拒后 items 还是 2 条', subj.items.length, 2);

console.log('=== 物事 ===');
const thing = { identity:{platform:'thing',value:'猫'}, display:'猫', items:[] };
const r4 = appendImpression(thing, { face:'猫', delta:0.5 });
eq('物事追加成功', r4.ok, true);
eq('物事 domain 对', thing.items[0].domain, 'thing');

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail>0?1:0);
