#!/usr/bin/env node
/**
 * test-stability.mjs —— 把「稳定度 → α」的换算钉死
 *
 * 2026-11-13 写这个的原因（codex review 抓到）：抽包时我把
 * `stabilityToAlpha` 从 `alphaFromHalfLife(s * LN2)` 简化成 `1 / ln(s+1)`，
 * 两者不等价，记忆衰减快了约 2 倍（stability=20 天：13.9 天 → 7.3 天掉一半）。
 * 测试全过，因为**没有一条测这个换算**。
 *
 * 所以这里直接钉数值：等于半衰期 0.693×s 的那个 α。
 * 以后谁再想「顺手简化」，会在这里撞墙。
 */
import { stabilityToAlpha, alphaFromHalfLife } from './lib/index.js';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass += 1; console.log(`✅ ${n}`); } else { fail += 1; console.log(`❌ ${n}${e ? ` — ${e}` : ''}`); } };

/** 由 α 反推半衰期（天） */
const halfDaysOf = (alpha) => Math.pow(2, 1 / alpha) - 1;

// ── 1. 语义：半衰期 ≈ LN2 × stability ────────────────────────
for (const s of [3, 7, 14, 20, 30, 60]) {
  const alpha = stabilityToAlpha(s);
  const half = halfDaysOf(alpha);
  const expect = s * Math.LN2;
  ok(`stability=${s} → 半衰期 ≈ ${expect.toFixed(1)} 天（实测 ${half.toFixed(1)}）`,
    Math.abs(half - expect) / expect < 0.12,
    `偏了 ${((half - expect) / expect * 100).toFixed(0)}%`);
}

// ── 2. 和直接算 α 等价 ──────────────────────────────────────
ok('等价于 alphaFromHalfLife(s × LN2)',
  Math.abs(stabilityToAlpha(20) - Number(alphaFromHalfLife(20 * Math.LN2).toFixed(6))) < 1e-9);

// ── 3. 非法输入的兜底（原来是 1，不是 0.6）─────────────────
ok('stability=0 → α=1（不是 0.6）', stabilityToAlpha(0) === 1);
ok('stability=NaN → α=1', stabilityToAlpha(NaN) === 1);
ok('stability=-5 → α=1', stabilityToAlpha(-5) === 1);

// ── 4. 单调性：越稳定衰减越慢 ───────────────────────────────
ok('越稳定 α 越小（衰减越慢）', stabilityToAlpha(7) > stabilityToAlpha(20) && stabilityToAlpha(20) > stabilityToAlpha(60));

// ── 5. 那只差点没被发现的差异，钉住 ─────────────────────────
const wrong = (s) => 1 / Math.log(s + 1);
ok('不等于 1/ln(s+1)（那是抽包时写错的式子）',
  Math.abs(stabilityToAlpha(20) - wrong(20)) > 0.05,
  '又变成快 2 倍的那个版本了');

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
