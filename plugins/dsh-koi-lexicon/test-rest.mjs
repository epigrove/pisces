#!/usr/bin/env node
/**
 * 落灰期测试（2026-11-12 koi定的）
 *
 *   > 落灰不该靠权重算，靠「多久没被想起」算。
 *   > 400 天没被 recall 过，就落灰。落灰是淡掉，不是删，钩子还在。
 *   > 要的是回忆驱动的落灰，不是时间驱动的：有人提起过的，就不该灰——哪怕三年。
 */
import { descState, renderSubject, hasAliveDesc, PERSON_STATE } from './lib/impression.js';
import { isRested, REST_DAYS, lastTouchOf, halfDaysOf } from 'dsh-koi-decay';

let p = 0, f = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? p++ : f++; console.log(`${ok ? '✅' : '❌'} ${n}${ok ? '' : ` got ${JSON.stringify(g)} want ${JSON.stringify(w)}`}`); };

const now = Date.now();
const DAY = 86400000;
const ALPHA40 = Math.log(2) / Math.log(41); // 40 天半衰期

const person = (descOver) => ({
  type: 'person',
  identity: { value: 'x', platform: 'person' },
  name: '测试',
  items: [{ type: 'desc', text: '爱吹牛', at: now - 500 * DAY, alpha: ALPHA40, ...descOver }],
});

console.log('=== 1. 「半衰期」和「落灰期」是两个数 ===');
eq('40 天半衰期', Math.round(halfDaysOf(ALPHA40)), 40);
eq('落灰期常量', REST_DAYS, 400);

console.log('\n=== 2. 落灰按「多久没被想起」，不按权重 ===');
{
  // 500 天，40 天半衰期：权重还有 ~0.35（远没到 0.1），但落灰期到了
  const p1 = person({});
  eq('500 天没想起 → 落灰', descState(p1, now), PERSON_STATE.FORGOTTEN);
  eq('落灰的不进注入', renderSubject(p1, { now }), null);
  eq('hasAliveDesc 也认落灰', hasAliveDesc(p1, now), false);
}

console.log('\n=== 3. 被想起过就不该灰（哪怕三年）===');
{
  const p2 = person({ at: now - 1100 * DAY, recallAt: now - 10 * DAY });
  // 三年后权重只剩 ~0.27，清晰度确实掉了（会降级成一行钩子），
  // 但**没落灰**——这就是「回忆驱动」和「时间驱动」的区别：
  // 权重管多清晰（半衰期），落灰管还出不出现在注入里（落灰期）。
  eq('1100 天前写的、10 天前想起过 → 没落灰（只是降级成钩子）', descState(p2, now), PERSON_STATE.FADING);
  eq('照样注入', renderSubject(p2, { now }) !== null, true);
  // 三年没想起 → 灰
  const p3 = person({ at: now - 1100 * DAY, recallAt: now - 1100 * DAY });
  eq('1100 天没想起 → 落灰', descState(p3, now), PERSON_STATE.FORGOTTEN);
}

console.log('\n=== 4. 两个时间取晚的那个 ===');
eq('写入晚', lastTouchOf({ at: 100, recallAt: 50 }), 100);
eq('想起晚', lastTouchOf({ at: 50, recallAt: 100 }), 100);
eq('没想起过', lastTouchOf({ at: 50 }), 50);
eq('399 天没想起还没灰', isRested({ at: now - 399 * DAY }), false);
eq('401 天没想起灰了', isRested({ at: now - 401 * DAY }), true);

console.log(`\n${p} 通过 / ${f} 失败`);
process.exit(f === 0 ? 0 : 1);
