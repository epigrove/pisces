#!/usr/bin/env node
/**
 * walkthrough.mjs —— 一个可以跑起来的最小示例。
 *
 * 仓库里有 300+ 个测试，但它们测的是"某个函数对不对"。
 * 这个脚本不测任何东西，它的目的是**让人在 30 秒内看懂这套东西在干什么**：
 *
 *   写入记忆 → 算它现在值多少 → 时间过去 → 再算一次 → 看到它变淡但没消失
 *
 * 跑法：node examples/walkthrough.mjs
 * 不写任何文件，不连任何服务，纯计算。
 */
import { weight, alphaFromHalfLife, SHOW_THRESHOLD, FADE_THRESHOLD } from 'dsh-koi-decay';
// 2026-11-26：rules/says/selftalk 已合并成 dsh-koi-gate（B2），这里跟着改
import { isPureAside, isSilenceToken, shouldDropLeak } from 'dsh-koi-gate';

const line = (t = '') => console.log(t);
const days = (n) => n * 86400_000;

// ─────────────────────────────────────────────────────────
line('═══ 一、衰减：一条记忆现在值多少 ═══');
line();

// 半衰期 40 天：40 天后权重降到 0.5
const halfDays = 40;
const alpha = alphaFromHalfLife(halfDays);
line(`半衰期 ${halfDays} 天 → 衰减系数 α = ${alpha.toFixed(4)}`);
line('  （α 越小衰减越慢；幂律而不是指数，所以永远不会归零）');
line();

line('再过多久        │ 权重    │ 状态');
line('────────────────┼─────────┼──────────────');
for (const d of [0, 1, 7, 40, 120, 400, 2000]) {
  const w = weight(d, alpha);
  let state = '正常显示';
  if (w < SHOW_THRESHOLD) state = '几乎不提（但没删）';
  else if (w < FADE_THRESHOLD) state = '变淡';
  line(`${String(d).padStart(6)} 天        │ ${w.toFixed(4)}  │ ${state}`);
}
line();
line(`判据：权重 < ${SHOW_THRESHOLD} 就不再主动注入，但账本里那一行永远在。`);
line('     这就是「淡了还在」——指数衰减做不到，因为它在某个时刻精确等于 0。');
line();

// ─────────────────────────────────────────────────────────
line('═══ 二、出口判定：这句话能不能发出去 ═══');
line();

const cases = [
  ['今晚吃点啥', '正常聊天'],
  ['（凌晨，脑子木……）', '括号底稿'],
  ['这次没事，没动静', '空转小结'],
  ['给你打八分', '正常夸人（含数字，不该被误伤）'],
  ['v2 那些分数我先记着', '内部专名（词表已撤，交给提示词判断）'],
];

line('文本                        │ 判定   │ 为什么');
line('────────────────────────────┼────────┼──────────────');
for (const [text, note] of cases) {
  let verdict = '放行';
  if (isSilenceToken(text).silent) verdict = '静默';
  else if (isPureAside(text)) verdict = '拦';
  else if (shouldDropLeak(text)) verdict = '拦';
  line(`${text.padEnd(24)}│ ${verdict.padEnd(6)} │ ${note}`);
}
line();
line('注意最后两条：内部专名**不再由出口拦**。');
line('词表必然误伤，而误伤是无声的——说的人只会觉得"这轮没什么可说"。');
line();

// ─────────────────────────────────────────────────────────
line('═══ 三、这套设计在回答什么问题 ═══');
line();
line('  长期运行的 agent 会烂在同一处：记忆。');
line('    什么都记  → 噪音淹没重点');
line('    只记重点  → 谁来判定什么是重点');
line('    存个分数  → 分数会过期，没人知道信哪个');
line();
line('  这里的答案是：**只增不删 + 幂律衰减现算 + 过期只打标记**。');
line('  账本永不重写，所以"它以前记过什么"永远查得到。');
line();
line('详细的结构与取舍见 docs/ARCHITECTURE.md。');
