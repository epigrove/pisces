/**
 * 印象的写入与校验（2026-11-08）
 *
 * 为什么单独写这个，而不是继续用 feel：
 *
 *   feel 的接口是 `who + delta + why`，没有 face 的概念——
 *   于是整句 why 被直接当成了 face，
 *   渲染出来像一句评价，而不是一个短形容。
 *
 * 这个模块只做三件事：
 *   1. 校验一条印象（face 必须短、delta 在 ±1、曲线合法）
 *   2. 往 v3 结构里追加
 *   3. 把它渲染成她看得懂的一行
 *
 * 不碰 v2 的 traits/history——那边由 feel 继续管，直到完全切换。
 */
import {
  validateDelta,
  validateCurve,
  describeCurve,
  halfToCurve,
  dayAtWeight,
  DEFAULT_HALF_DAYS,
} from './impression.js';

/** face 最长几个字。超过这个长度就不是形容了，是句子。 */
export const FACE_MAX = 12;

/** 印象的默认曲线：7 天清零 */
/**
 * 默认印象曲线（2026-11-12 修）。
 *
 * 原来写的是 `curveForZero(7)`。注意两个函数**含义不同**：
 *   curveForZero(d) —— d 天后降到「落灰线」（权重 0.1，几乎看不见）
 *   halfToCurve(d)  —— d 天掉一半
 * 原来用 curveForZero(7)，实际比「7 天掉一半」还短得多。
 *
 * 参考 agent 11-11 明确否掉的是**短**这件事：
 *   > 印象七天掉一半，等于我对一个人的感觉只活一星期，那不算印象，算情绪。
 *
 * 而且「统一 40 天」那次只改到了 lexicon 的 desc 路径，印象这条漏了。
 * 现在和 `V3_DEFAULT_CURVE` 用同一个数、同一个函数（半衰期 40 天）。
 */
export const DEFAULT_IMPRESSION_CURVE = halfToCurve(DEFAULT_HALF_DAYS);

/**
 * 校验一条印象。
 *
 * @param {object} args
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateImpression(args) {
  const errors = [];

  const face = String(args?.face ?? '').trim();
  if (face === '') {
    errors.push('face（形容）不能为空，比如「爱呛人」「靠谱」「怕生」');
  } else if (face.length > FACE_MAX) {
    errors.push(
      `face 太长了（${face.length} 字，上限 ${FACE_MAX}）。形容要短，一整句放 why 里。`,
    );
  }

  const d = validateDelta(args?.delta);
  errors.push(...d.errors);

  if (args?.alpha !== undefined) {
    const c = validateCurve({ alpha: args?.alpha });
    errors.push(...c.errors);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 往一个 v3 subject 里追加一条印象。
 *
 * @param {object} subject v3 结构（{identity, display, items}）
 * @param {object} args   {face, delta, why?, a?, b?, at?}
 * @returns {{ok:boolean, message:string}}
 */
export function appendImpression(subject, args) {
  if (subject === null || typeof subject !== 'object') {
    return { ok: false, message: '找不到这个对象。' };
  }
  const check = validateImpression(args);
  if (!check.ok) return { ok: false, message: check.errors.join('；') };

  const face = String(args.face).trim();
  const delta = Number(args.delta);
  const why = String(args.why ?? '').trim().slice(0, 100);
  const alpha = Number.isFinite(Number(args.alpha))
    ? Number(args.alpha)
    : DEFAULT_IMPRESSION_CURVE.alpha;

  subject.items ??= [];
  subject.items.push({
    type: 'impression',
    domain: subject.identity?.platform === 'thing' ? 'thing' : 'person',
    subject: subject.identity?.value ?? '',
    face,
    delta,
    why: why || undefined,
    alpha,
    at: Number.isFinite(Number(args.at)) ? Number(args.at) : Date.now(),
  });

  const life = describeCurve(alpha);
  return {
    ok: true,
    message: `记下了：${face} ${delta > 0 ? '+' : ''}${delta.toFixed(2)}${why ? `（${why}）` : ''}。${life}`,
  };
}
