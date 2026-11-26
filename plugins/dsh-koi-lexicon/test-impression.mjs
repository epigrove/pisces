/**
 * 印象曲线测试（幂律版，2026-11-08）
 *
 *   y = (x + 1)^(-α)
 *
 * 重点验证：
 *   1. 永不归零
 *   2. 开头掉得慢（这正是换掉对数的原因）
 *   3. 落到阈值的算法
 *   4. 三态和渲染
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const m = await import(join(here, 'lib/impression.js'));
const {
  weight, dayAtWeight, alphaFromHalfLife, alphaForThreshold,
  score, validateCurve, validateDelta, describeCurve,
  daysSince, remainingDays, MS_PER_DAY, halfToCurve, curveForZero,
  validateItem, validateSubject, hasAliveDesc, effectiveImpressions,
  recallImpressions, effectiveImpressionsIgnoringDesc,
  descState, hookOf, renderSubject, renderV3, renderFaceGroup,
  PERSON_STATE, FADE_THRESHOLD, DOMAINS, TYPES, accumulate,
} = m;

let pass = 0;
let fail = 0;
const eq = (name, got, want, tol = 1e-9) => {
  const ok = typeof want === 'number' ? Math.abs(got - want) <= tol : got === want;
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};

const now = Date.now();

// ── 1. 基本形状 ────────────────────────────────────────────────
console.log('=== 1. 基本形状 ===');
const a33 = alphaFromHalfLife(33); // 33 天掉一半
eq('x=0 → 1', weight(0, a33), 1);
eq('x=33 → 0.5（半衰期定义）', weight(33, a33), 0.5, 1e-9);
eq('x=-5 当 0', weight(-5, a33), 1);
eq('α<=0 → 0', weight(10, 0), 0);
eq('α 非法 → 0', weight(10, NaN), 0);

// ── 2. 永不归零（这是换幂律的核心原因）────────────────────────
console.log('=== 2. 永不归零 ===');
eq('1000 天 > 0', weight(1000, a33) > 0, true);
eq('100000 天 > 0', weight(100000, a33) > 0, true);
eq('100000 天仍可观', weight(100000, a33) > 0.05, true);
console.log(`     1000 天 = ${(weight(1000, a33) * 100).toFixed(1)}%`);
console.log(`     3650 天 = ${(weight(3650, a33) * 100).toFixed(1)}%`);

// ── 3. 开头掉得慢（换掉对数的直接依据）────────────────────────
console.log('=== 3. 开头掉得慢 ===');
eq('1 天后 > 80%', weight(1, a33) > 0.8, true);
eq('3 天后 > 70%', weight(3, a33) > 0.7, true);
eq('7 天后 > 60%', weight(7, a33) > 0.6, true);
console.log(`     1天=${(weight(1, a33) * 100).toFixed(1)}%  3天=${(weight(3, a33) * 100).toFixed(1)}%  7天=${(weight(7, a33) * 100).toFixed(1)}%`);
console.log('     （旧对数公式：80.3% / 60.7% / 41.0%）');

// ── 4. 单调递减 ────────────────────────────────────────────────
console.log('=== 4. 单调递减 ===');
let prev = 2;
let monoOk = true;
for (let d = 0; d <= 200; d += 1) {
  const w = weight(d, a33);
  if (w > prev) { monoOk = false; console.log(`  ❌ 在 d=${d} 不单调`); }
  prev = w;
}
if (monoOk) { pass += 1; console.log('  ✅ 单调递减'); } else { fail += 1; }

// ── 5. 阈值与落灰点 ────────────────────────────────────────────
console.log('=== 5. 落灰点 ===');
const d10 = dayAtWeight(a33, 0.1);
eq('掉到 0.1 是个有限值', Number.isFinite(d10), true);
console.log(`     α=${a33.toFixed(4)} → 掉到 0.1 需要 ${d10.toFixed(0)} 天`);
eq('阈值越小天数越多', dayAtWeight(a33, 0.01) > d10, true);
eq('非法阈值 → Infinity', dayAtWeight(a33, 0) === Infinity, true);

// ── 6. 两个反推函数互为逆 ─────────────────────────────────────
console.log('=== 6. 参数反推 ===');
for (const h of [3, 7, 33, 90, 365]) {
  const al = alphaFromHalfLife(h);
  eq(`半衰期 ${h} 天 → 反推正确`, weight(h, al), 0.5, 1e-9);
}
for (const d of [10, 33, 110, 365]) {
  const al = alphaForThreshold(d, 0.1);
  eq(`掉到 0.1 需 ${d} 天 → 反推正确`, weight(d, al), 0.1, 1e-9);
}
eq('halfToCurve 返回 alpha', typeof halfToCurve(33).alpha, 'number');
eq('curveForZero 返回 alpha', typeof curveForZero(33).alpha, 'number');

// ── 7. 单位陷阱 ────────────────────────────────────────────────
console.log('=== 7. 单位 ===');
eq('daysSince 2 天前 → 2', daysSince(now - 2 * MS_PER_DAY, now), 2);
eq('score 用毫秒当天的坑', score({ delta: 1, at: now - 2 * MS_PER_DAY, alpha: a33 }, now), weight(2, a33), 1e-9);
// 幂律的尾很厚：即使把毫秒当天数（x 变成 1.7 亿），
// 也还有 2% —— 所以单位错误在幂律下**不容易暴露**，
// 只能靠 daysSince() 是唯一入口来防。
const wrong = weight(now - (now - 2 * MS_PER_DAY), a33);
eq('忘了除 → 掉到 2-3%（不归零，所以不易发现）', wrong > 0.01 && wrong < 0.05, true);
console.log(`     忘了除时 x = ${now - (now - 2 * MS_PER_DAY)} 天，权重还有 ${(wrong * 100).toFixed(2)}%`);
console.log('     ⚠ 幂律尾部厚 → 单位错不会立刻崩，只能靠 daysSince() 统一入口防');

// ── 8. 参数校验 ────────────────────────────────────────────────
console.log('=== 8. 参数校验 ===');
eq('alpha 正数通过', validateCurve({ alpha: 0.3 }).ok, true);
eq('alpha=0 拒绝', validateCurve({ alpha: 0 }).ok, false);
eq('alpha 负数拒绝', validateCurve({ alpha: -0.3 }).ok, false);
eq('alpha 缺失拒绝', validateCurve({}).ok, false);
eq('delta=0.5 通过', validateDelta(0.5).ok, true);
eq('delta=-1 通过', validateDelta(-1).ok, true);
eq('delta=1.5 拒绝', validateDelta(1.5).ok, false);

// ── 9. 人话描述 ────────────────────────────────────────────────
console.log('=== 9. 人话描述 ===');
for (const h of [1, 7, 33, 365]) {
  console.log(`     半衰期 ${h} 天: ${describeCurve(alphaFromHalfLife(h))}`);
}
eq('描述里提「落灰」不说「清零」', describeCurve(0.2).includes('落灰'), true);

// ── 10. 结构校验 ───────────────────────────────────────────────
console.log('=== 10. 结构校验 ===');
const goodDesc = { type: 'desc', domain: 'person', subject: '00000002', text: '护着人物甲', alpha: 0.18, at: now };
const goodImp = { type: 'impression', domain: 'person', subject: '00000002', face: '爱呛人', delta: -0.6, alpha: 0.5, at: now };
eq('合法 desc', validateItem(goodDesc).ok, true);
eq('合法 impression', validateItem(goodImp).ok, true);
eq('domain 非法', validateItem({ ...goodDesc, domain: 'x' }).ok, false);
eq('desc 缺 text', validateItem({ ...goodDesc, text: '' }).ok, false);
eq('impression 缺 face', validateItem({ ...goodImp, face: '' }).ok, false);
eq('delta 超界', validateItem({ ...goodImp, delta: 2 }).ok, false);
eq('alpha<=0', validateItem({ ...goodDesc, alpha: 0 }).ok, false);

const subject = { identity: { platform: 'qq', value: '00000002' }, display: '人物乙', items: [goodDesc, goodImp] };
eq('合法 subject', validateSubject(subject).ok, true);
eq('缺 identity', validateSubject({ items: [] }).ok, false);

// ── 11. 描述归零 → 印象作废（幂律下永不归零，用极小 α 模拟）──
console.log('=== 11. 描述与印象 ===');
const mkSub = (ageDays, alpha = 0.333333) => ({
  identity: { platform: 'qq', value: 'x' },
  items: [
    { type: 'desc', domain: 'person', subject: 'x', text: '爱吹牛', alpha, at: now - ageDays * MS_PER_DAY },
    { type: 'impression', domain: 'person', subject: 'x', face: '烦人', delta: -0.8, alpha: 0.25, at: now },
  ],
});
eq('描述新鲜 → hasAliveDesc', hasAliveDesc(mkSub(0), now), true);
// hasAliveDesc 现在按【显示线】判断（幂律永不归零，不能再用 > 0）
// α=0.333 掉到 0.1 要 1000 天左右
eq('描述 1000 天后已落灰', hasAliveDesc(mkSub(1000), now), false);
eq('描述 100 天后还在显示线上', hasAliveDesc(mkSub(100), now), true);
eq('描述新鲜 → 印象返回', effectiveImpressions(mkSub(0), now).length, 1);
eq('描述新鲜 → orphaned=false', effectiveImpressions(mkSub(0), now)[0]?.orphaned, false);

// ── 12. 同一 face 求和 ────────────────────────────────────────
console.log('=== 12. 求和 ===');
const sumSub = {
  identity: { platform: 'qq', value: 'x' },
  items: [
    { type: 'desc', domain: 'person', subject: 'x', text: 'd', alpha: 0.18, at: now },
    { type: 'impression', domain: 'person', subject: 'x', face: '爱呛人', delta: -0.6, alpha: 0.5, at: now },
    { type: 'impression', domain: 'person', subject: 'x', face: '爱呛人', delta: -0.2, alpha: 0.5, at: now },
    { type: 'impression', domain: 'person', subject: 'x', face: '护短', delta: 0.3, alpha: 0.25, at: now },
  ],
};
const eff = effectiveImpressions(sumSub, now);
eq('两个 face', eff.length, 2);
// 2026-11-08：叠加公式从「简单求和」改成「并集概率」 d = 1-∏(1-aᵢ)
// 旧值 -0.8（-0.6 + -0.2），新值 -(1-(1-0.6)(1-0.2)) = -0.68
eq('爱呛人 = -0.68', eff.find((x) => x.face === '爱呛人')?.score, -0.68, 1e-6);
eq('条数还是 2', eff.find((x) => x.face === '爱呛人')?.counts, 2);
eq('护短 = 0.3', eff.find((x) => x.face === '护短')?.score, 0.3, 1e-6);
eq('counts', eff.find((x) => x.face === '爱呛人')?.counts, 2);

// ── 13. 三态 ──────────────────────────────────────────────────
console.log('=== 13. 三态 ===');
const mkP = (ageDays) => ({
  identity: { platform: 'qq', value: 'x' },
  display: '测试君',
  items: [
    { type: 'desc', domain: 'person', subject: 'x', text: '爱吹牛', alpha: 0.5, at: now - ageDays * MS_PER_DAY },
    { type: 'impression', domain: 'person', subject: 'x', face: '烦人', delta: -0.8, alpha: 0.25, at: now },
  ],
});
eq('0 天 → clear', descState(mkP(0), now), PERSON_STATE.CLEAR);
// 半衰期时权重还是 0.5（> 0.3），所以仍是 clear
eq('半衰期时仍是 clear', descState(mkP(1), now), PERSON_STATE.CLEAR);
// α=0.5 要掉到 0.3 以下需要 (d+1)^-0.5 < 0.3 → d > 10.1 天
eq('11 天后 → fading', descState(mkP(11), now), PERSON_STATE.FADING);
eq('很久 → fading 或 forgotten', [PERSON_STATE.FADING, PERSON_STATE.FORGOTTEN].includes(descState(mkP(1000), now)), true);
eq('没有 desc → forgotten', descState({ items: [] }, now), PERSON_STATE.FORGOTTEN);

// ── 14. 钩子 ──────────────────────────────────────────────────
console.log('=== 14. 钩子 ===');
eq('clear 时钩子=原话', hookOf(mkP(0), now), '爱吹牛');
eq('很老时钩子仍在', hookOf(mkP(1000), now), '爱吹牛');
eq('没有 desc → null', hookOf({ items: [] }, now), null);

// ── 15. 渲染 ──────────────────────────────────────────────────
console.log('=== 15. 渲染 ===');
const clearLine = renderSubject(mkP(0), { now });
eq('clear 含描述', clearLine.includes('爱吹牛'), true);
eq('clear 含印象', clearLine.includes('烦人'), true);
const thing = {
  identity: { platform: 'thing', value: '被叫agent' },
  display: '被叫agent',
  items: [{ type: 'impression', domain: 'thing', subject: '被叫agent', face: '被叫agent', delta: 0.85, alpha: 0.2, at: now }],
};
const thingLine = renderSubject(thing, { now });
eq('物事能渲染', thingLine !== null, true);
eq('物事不重复名字', (thingLine.match(/被叫agent/g) || []).length, 1);

// ── 16. 权重为 0 的描述不漏进来 ───────────────────────────────
console.log('=== 16. 描述过滤 ===');
const mixed = {
  identity: { platform: 'qq', value: 'x' },
  display: '某君',
  items: [
    { type: 'desc', domain: 'person', subject: 'x', text: '活的', alpha: 0.5, at: now - 1 * MS_PER_DAY },
    { type: 'impression', domain: 'person', subject: 'x', face: '烦人', delta: -0.5, alpha: 0.25, at: now },
  ],
};
eq('活描述在里面', renderSubject(mixed, { now }).includes('活的'), true);



// ── 17. 多条账的渲染（参考 agent 2026-11-08 定的）───────────────────
console.log('=== 17. 多条账渲染 ===');
eq('4 条 -0.2 显示条数', renderFaceGroup({face:'爱呛人',score:-0.8,counts:4}), '爱呛人 -0.80（4 条）');
eq('带快没了', renderFaceGroup({face:'护短',score:0.42,counts:2,fading:1}), '护短 +0.42（2 条，1 条快没了）');
eq('单条快没了不带「1条」', renderFaceGroup({face:'旧事',score:0.05,counts:1,fading:1}), '旧事 +0.05（快没了）');
// 2026-11-08：叠加公式改成并集概率后，分数到不了 1，
// 「超过 1 不报数」这条规则已经删掉——现在直接报数。
// 就算传进来一个超 1 的（不该发生），也照实显示，不再换成一句话。
eq('正常范围照实报', renderFaceGroup({face:'好',score:0.87,counts:10}), '好 +0.87（10 条）');
// 2026-11-08 codex review：光测 0.87 不算「超 1」。真要测那个被删掉的
// 分支，得喂一个 >1 的值——它现在不该再被换成「越来越顺眼」。
// （accumulate 保证不会产出这种值，但外部手改数据时可能撞上，不该崩也不该说谎。）
eq('传进 5.0 也照实报', renderFaceGroup({face:'好',score:5,counts:10}), '好 +5.00（10 条）');
eq('传进 -1.6 也照实报', renderFaceGroup({face:'烦',score:-1.6,counts:3}), '烦 -1.60（3 条）');
eq('单条正常', renderFaceGroup({face:'靠谱',score:0.42,counts:1}), '靠谱 +0.42');
eq('空 face 返回空', renderFaceGroup({face:'',score:1,counts:1}), '');

// 集成：renderSubject 里也用这个格式
const multi = {
  identity: { platform: 'qq', value: 'x' }, display: '某人',
  items: [
    { type:'desc', domain:'person', subject:'x', text:'见过几次', alpha:0.227, at: now },
    { type:'impression', domain:'person', subject:'x', face:'爱呛人', delta:-0.2, alpha:0.404, at: now },
    { type:'impression', domain:'person', subject:'x', face:'爱呛人', delta:-0.2, alpha:0.404, at: now },
  ],
};
const rl = renderSubject(multi, { now });
eq('renderSubject 带条数', rl.includes('（2 条）'), true);
console.log('     ' + rl);


// ── 13. 叠加公式（2026-11-08 主人给的并集概率）──────────────
console.log('\n=== 13. 叠加公式 ===');
eq('单条不变', accumulate([{ delta: 0.3, w: 1 }]), 0.3, 1e-9);
eq('两条 0.3 = 0.51', accumulate([{ delta: 0.3, w: 1 }, { delta: 0.3, w: 1 }]), 0.51, 1e-9);
eq('四条 0.3 = 0.760', accumulate([{ delta: 0.3, w: 1 }, { delta: 0.3, w: 1 }, { delta: 0.3, w: 1 }, { delta: 0.3, w: 1 }]), 0.7599, 1e-4);
// 关键：永远不超 1
{
  const many = Array.from({ length: 50 }, () => ({ delta: 0.9, w: 1 }));
  const v = accumulate(many);
  // 数学上无限接近 1；50 条时 (0.1)^50 已经下溢到浮点 0，所以正好等于 1。
  // 实际用不到这么多（FACE_MAX=12），但断言写成 <= 才是对的。
  eq('50 条也不超过 1', v <= 1, true);
  eq('但非常接近 1', v > 0.99, true);
}
{
  // 12 条（FACE_MAX）极端情况：每条都 0.9
  // (1-0.9)^12 = 1e-12，浮点下 1-1e-12 就是 1，所以会饱和到 1.00。
  // 这是公式的极限，不是 bug——但要知道它存在。
  const cap = Array.from({ length: 12 }, () => ({ delta: 0.9, w: 1 }));
  eq('12 条 0.9 不超过 1', accumulate(cap) <= 1, true);
}
{
  // 正常情况（2-4 条，delta 0.3-0.5）不会饱和
  eq('3 条 0.5 = 0.875', accumulate(Array.from({length:3},()=>({delta:0.5,w:1}))), 0.875, 1e-9);
  eq('4 条 0.5 = 0.9375', accumulate(Array.from({length:4},()=>({delta:0.5,w:1}))), 0.9375, 1e-9);
}
// 正负抵消
eq('+0.3 和 -0.3 抵消', accumulate([{ delta: 0.3, w: 1 }, { delta: -0.3, w: 1 }]), 0, 1e-9);
// 权重参与
eq('权重 0 等于没记', accumulate([{ delta: 0.9, w: 0 }]), 0, 1e-9);
eq('权重 0.5 减半效应', accumulate([{ delta: 0.6, w: 0.5 }]), 0.3, 1e-9);
// 空
eq('空数组 = 0', accumulate([]), 0, 1e-9);

console.log('\n=== 18. 物事容量与排序 ===');
{
  const mkThing = (name, delta) => ({
    identity: { platform: 'thing', value: name },
    display: name,
    items: [{
      type: 'impression', domain: 'thing', subject: name,
      face: name, delta, alpha: 0.2, at: now,
    }],
  });
  const rendered = renderV3({
    people: {},
    things: {
      weak: mkThing('弱的', 0.1),
      strong: mkThing('强的', 0.9),
      middle: mkThing('中间', 0.5),
    },
    mood: {},
  }, { now, maxThings: 2 });
  eq('maxThings 截断到 2 条', rendered.things.length, 2);
  eq('最强的物事排第一', rendered.things[0].includes('强的'), true);
  eq('最弱的被容量截掉', rendered.things.some((line) => line.includes('弱的')), false);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
