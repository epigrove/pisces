/**
 * dsh-koi-decay —— 衰减数学（纯函数，零依赖）
 *
 * 为什么要单独一个包
 * ------------------
 * 这套系统里有三个插件都要算「一条记忆现在还值多少」：
 *
 *   koi-lexicon  —— 人对人的描述与印象
 *   koi-memory   —— 中期/长期事实
 *   koi-affect   —— 心情与情绪残留
 *
 * 原来这三家都从 `../../dsh-koi-lexicon/lib/impression.js` 相对路径 import，
 * 而 lexicon 的 package.json 也没声明这个依赖。后果：
 *   - 单独装 koi-memory（不装 lexicon）→ 模块解析失败，插件加载不了
 *   - 目录结构一改 → 全崩
 *   - npm 按包名装 → 更不可能
 *
 * 现在数学下沉到这里，三个插件都按包名依赖它。
 *
 * 边界
 * ----
 * **这里只放数学**：数、公式、阈值、换算。
 * 不放「人的样子」「印象」「落灰」这类概念词，也不放任何中文提示词——
 * 那些是 koi 的业务措辞，共享出去会把库绑死在一种人格上。
 * 渲染和数据契约留在 koi-lexicon。
 *
 * 公式
 * ----
 *   y = (x + 1)^(-α)
 *
 *   x : 已经过去的时间，单位【天】
 *   α : 大于 0，越大掉得越快
 *   y : 权重，0..1，**永不归零**（幂律的尾巴很长，这是有意的）
 */

export const MS_PER_DAY = 86_400_000;

/**
 * 默认半衰期（天）——**全系统一个数**。
 *
 * 2026-11-11 定的：不再按「描述 / 印象」给不同默认，只有一个数。
 * 理由不是「描述该比印象活得久」，而是：
 *   描述是这人长期的样子，印象是某一次的感觉。
 *   一次的感觉本来就该散，一个人的样子不该。
 *
 * 2026-11-12 审计：这个决定当时只落到了 lexicon 的 desc 路径，
 * `impression-write.js` 里印象默认还是 7 天，现网数据里 `alpha≈1.107` 就是它。
 * 现在统一到这里。
 */
export const DEFAULT_HALF_DAYS = 40;

/** 权重低于这个值就当「看不见」（落灰） */
export const SHOW_THRESHOLD = 0.1;

/** 权重低于这个值就降级成一行钩子（还记得有这么个人，细节想不起了） */
export const FADE_THRESHOLD = 0.3;

/**
 * 落灰期（天）——**多久没被想起，就当它落了灰**。
 * 注意归属：400 这个阈值是系统默认；
 * 产品契约只规定「落灰之后怎么显示」——描述清零后降级成一行钩子。
 *
 *   要 40 天掉一半，也要落灰；落灰按「多久没被想起」算，而不是按权重算。
 *   幂律尾巴永远到不了 0.1，所以另外定义：400 天没被 recall 过就落灰。
 *
 * 这是两个不同的数，别混：
 *   半衰期  40 天   —— 权重掉一半（管「多清晰」，管排序）
 *   落灰期 400 天   —— 多久没被想起（管「还注不注进去」）
 *
 * 幂律的尾巴很长，靠权重永远到不了 0.1（40 天半衰期要算到二十几万天），
 * 所以「看不见」这件事只能另立一条线，不能赖在 SHOW_THRESHOLD 上。
 */
/**
 * 短期记忆在内存/注入窗口里最多留多少条（2026-11-18）。
 *
 * 放这里是因为它现在是**共享契约**：memory 用它决定谁被挤出，
 * lexicon 的 recall 用同一个数**推导**哪些条目「已退出注入」——
 * 而不是各自存一个可能对不上的 muted 标志。
 */
export const SHORT_MAX_ITEMS = 300;
export const REST_DAYS = 400;

/**
 * 这条最后一次「被想起」是什么时候：写入时间和被 recall 时间取晚的。
 *
 * 落灰由**回忆驱动**：有人提起过的记录不应落灰，无论过去多久。
 */
export function lastTouchOf(item) {
  return Math.max(Number(item?.at ?? 0), Number(item?.recallAt ?? 0));
}

/**
 * 落灰了没有：最后一次被想起之后过了多久。
 *
 * @param {object} item 至少要 {at, recallAt?}
 * @param {number} [now]
 * @param {number} [restDays] 默认 REST_DAYS
 */
export function isRested(item, now = Date.now(), restDays = REST_DAYS) {
  const last = lastTouchOf(item);
  if (!Number.isFinite(last) || last <= 0) return false;
  return daysSince(last, now) >= restDays;
}

/**
 * α → 半衰期（天）。和 `dayAtWeight` 不是一回事：
 *   这个答「多久掉一半」（清晰度）
 *   dayAtWeight 答「多久掉到某条线」（阈值）
 *
 *   (h + 1)^(-α) = 1/2  →  h = 2^(1/α) - 1
 */
export function halfDaysOf(alpha) {
  const a = Number(alpha);
  if (!Number.isFinite(a) || a <= 0) return Number.POSITIVE_INFINITY;
  return Math.pow(2, 1 / a) - 1;
}

/**
 * 毫秒时间戳 → 距今多少天。
 *
 * 所有需要 x 的地方都必须经过这个函数，
 * 防止出现「忘了除 86400000」导致全部归零的事故。
 *
 * @param {number} at   事件发生的毫秒时间戳
 * @param {number} [now] 当前毫秒时间戳，默认 Date.now()
 * @returns {number} 已经过去的天数（可能是负数，时钟回拨时）
 */
export function daysSince(at, now = Date.now()) {
  return (now - at) / MS_PER_DAY;
}

/**
 * 这条记录的权重。
 *
 *   y = (x + 1)^(-α)
 *
 * @param {number} xDays 已经过去的天数（用 daysSince 算，别自己除）
 * @param {number} alpha 大于 0，越大掉得越快
 * @returns {number} 0..1，永不归零
 */
export function weight(xDays, alpha) {
  if (!Number.isFinite(xDays) || !Number.isFinite(alpha)) return 0;
  if (alpha <= 0) return 0;
  const x = Math.max(0, xDays);
  return Math.pow(x + 1, -alpha);
}

/**
 * 多少天后掉到某个阈值以下。
 *
 * 幂律永不归零，所以没有「清零点」——只有「掉到多少以下」。
 *
 *   threshold = (d + 1)^(-α)
 *   d = threshold^(-1/α) - 1
 *
 * @param {number} alpha 大于 0
 * @param {number} [threshold] 目标权重，默认 0.1
 * @returns {number} 天数；参数非法或到不了返回 Infinity
 */
export function dayAtWeight(alpha, threshold = 0.1) {
  const a = Number(alpha);
  const t = Number(threshold);
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(t) || t <= 0 || t >= 1) return Infinity;
  return Math.pow(t, -1 / a) - 1;
}

/**
 * 还剩多少天掉到阈值（负数表示已经过了）。
 *
 * @param {{at:number, alpha?:number, a?:number}} item
 * @param {number} [now]
 * @param {number} [threshold]
 */
export function remainingDays(item, now = Date.now(), threshold = 0.1) {
  const alpha = Number(item?.alpha ?? item?.a ?? 0);
  if (!Number.isFinite(alpha) || alpha <= 0) return Infinity;
  const left = dayAtWeight(alpha, threshold) - daysSince(item?.at ?? now, now);
  return left;
}

/**
 * 多条证据的**并集概率**累积。
 *
 *   d = 1 - ∏(1 - aᵢ)
 *
 * 正负分开累积，再相减。为什么不直接相加：
 * 线性相加会超过 1（「三条各 0.5 的印象」应该是 0.875，不是 1.5），
 * 而且会让「同一个人说三句同类的话」比「三个不同的人都这么说」更重。
 *
 * @param {Array<{delta?:number, w?:number}>} pairs delta 是方向（正/负），w 是权重
 * @returns {number} -1..1
 */
export function accumulate(pairs) {
  let prodPos = 1;
  let prodNeg = 1;
  for (const p of pairs ?? []) {
    const delta = Number(p?.delta ?? 0);
    const w = p?.w === undefined ? 1 : Number(p.w);
    if (!Number.isFinite(delta) || !Number.isFinite(w)) continue;
    // a 不能到 1：那样 (1-a)=0，乘积直接归零，后面全白算
    const a = Math.min(Math.abs(delta * w), 0.999);
    if (a === 0) continue;
    if (delta >= 0) prodPos *= 1 - a;
    else prodNeg *= 1 - a;
  }
  return 1 - prodPos - (1 - prodNeg);
}

/**
 * 一条记录的当前分。
 *
 *   delta × weight
 *
 * 描述类（desc）没有 delta，调用方传 delta = 1 即可。
 *
 * @param {{delta?:number, at:number, alpha?:number, a?:number}} item
 * @param {number} [now]
 * @returns {number}
 */
export function score(item, now = Date.now()) {
  const alpha = Number(item?.alpha ?? item?.a ?? 0);
  const delta = Number(item?.delta ?? 1);
  return delta * weight(daysSince(item?.at ?? now, now), alpha);
}

/**
 * 参数范围。
 *
 * 注意：**返回结构是 `{ ok, errors }`，不是 `{ ok, message }`**。
 * 2026-11-12 拆包时我自作聪明改成了 message，结果 lexicon 的 validateItem
 * 直接 `d.errors is not iterable` 崩掉——测试抓到了。
 * 迁移常量时连 API 形状一起对齐，别顺手"改好"。
 */
export const LIMITS = {
  /** α 必须大于 0 */
  alphaMin: 0,
  /** delta 的范围（单条印象的变化值） */
  deltaMin: -1,
  deltaMax: 1,
};

/** @returns {{ok:boolean, errors:string[]}} */
export function validateCurve(params) {
  const errors = [];
  const alpha = Number(params?.alpha);
  if (!Number.isFinite(alpha)) errors.push('alpha 必须是数字');
  else if (alpha <= LIMITS.alphaMin) errors.push('alpha 必须大于 0（越大掉得越快）');
  return { ok: errors.length === 0, errors };
}

/** @returns {{ok:boolean, errors:string[]}} */
export function validateDelta(delta) {
  const errors = [];
  const d = Number(delta);
  if (!Number.isFinite(d)) errors.push('delta 必须是数字');
  else if (d < LIMITS.deltaMin || d > LIMITS.deltaMax) {
    errors.push(`delta 必须在 ${LIMITS.deltaMin} ~ ${LIMITS.deltaMax} 之间（要大就多写几条）`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 把一个 α 翻译成人能懂的话。
 *
 * @param {number} alpha
 * @param {number} [threshold]
 * @returns {string}
 */
export function describeCurve(alpha, threshold = 0.1) {
  const a = Number(alpha);
  if (!Number.isFinite(a) || a <= 0) return '参数无效';
  const days = dayAtWeight(a, threshold);
  const pct = Math.round(threshold * 100);
  // 措辞里必须出现「落灰」——测试盯着这个词；产品统一说「落灰」，不说「清零」。
  if (!Number.isFinite(days)) return `掉不到 ${pct}%——这组参数下基本不会落灰。`;
  if (days < 1) return `大约 ${Math.round(days * 24)} 小时后掉到 ${pct}% 以下（落灰，不是删）。`;
  if (days < 60) return `大约 ${Math.round(days)} 天后掉到 ${pct}% 以下（落灰，不是删）。`;
  if (days < 365 * 2) return `大约 ${(days / 30).toFixed(1)} 个月后掉到 ${pct}% 以下（落灰，不是删）。`;
  return `大约 ${(days / 365).toFixed(1)} 年后掉到 ${pct}% 以下（落灰，不是删）。`;
}

/**
 * 「多少天掉一半」→ α。
 *
 *   (h + 1)^(-α) = 0.5   →   α = ln2 / ln(h + 1)
 *
 * 注意：这跟 `curveForZero` **不是一个意思**。
 *   halfToCurve(40)   —— 40 天掉一半，之后还有 50%、33%、22%…（幂律尾巴很长）
 *   curveForZero(40)  —— 40 天掉到落灰线（0.1），基本看不见了
 *
 * @param {number} halfDays
 */
export function halfToCurve(halfDays) {
  return { alpha: Number(alphaFromHalfLife(halfDays).toFixed(6)) };
}

/** @param {number} halfDays */
export function alphaFromHalfLife(halfDays) {
  const h = Number(halfDays);
  if (!Number.isFinite(h) || h <= 0) return 1;
  return Math.log(2) / Math.log(h + 1);
}

/**
 * 「多少天掉到 threshold」→ α。
 *
 *   (d + 1)^(-α) = threshold  →  α = ln(1/threshold) / ln(d + 1)
 *
 * @param {number} days
 * @param {number} [threshold]
 */
export function alphaForThreshold(days, threshold = 0.1) {
  const d = Number(days);
  const t = Number(threshold);
  if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(t) || t <= 0 || t >= 1) return 1;
  return Math.log(1 / t) / Math.log(d + 1);
}

/**
 * 「多少天后落灰」→ 曲线。语义见上（和 halfToCurve 不同）。
 *
 * @param {number} zeroDays
 * @param {number} [threshold]
 */
export function curveForZero(zeroDays, threshold = 0.1) {
  return { alpha: Number(alphaForThreshold(zeroDays, threshold).toFixed(6)) };
}

/**
 * 旧字段 `stability`（天数，越大活得越久）→ α。
 *
 * @deprecated 迁移用。新代码别用这个，直接用 alpha。
 */
export function stabilityToAlpha(stabilityDays) {
  /**
   * 2026-11-13 **修回归**（codex review 抓到）。
   *
   * 11-12 我把衰减数学抽成这个包时，把它「顺手简化」成 `1 / ln(s+1)`，
   * 以为和原来等价 —— **不等价**：原来半衰期 ≈ 0.693 × stability，
   * 简化后半衰期 ≈ 0.44 × stability，也就是**记忆衰减快了约 2 倍**。
   *
   * 实测（stability=20 天的记忆卡片）：
   *   原来 13.9 天掉一半 → 改后 7.3 天。表现只会是「最近忘得快」，很难定位原因。
   *
   * 抽包是重构，不该改行为。恢复原式。
   */
  const s = Number(stabilityDays);
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Number(alphaFromHalfLife(s * Math.LN2).toFixed(6));
}

/**
 * 更旧的字段（半衰期按**小时**记）→ α。
 *
 * @deprecated 迁移用，只给 mood 那套旧数据用。
 */
export function legacyHalfToAlpha(halfHours) {
  const h = Number(halfHours);
  if (!Number.isFinite(h) || h <= 0) return 1;
  return Number((Math.log(2) / Math.log(h / 24 + 1)).toFixed(6));
}

/**
 * 记录信封——统一「记录型」存储的外层元数据。
 *
 * 信封 = 元数据外壳（id/at/recallAt/why/scope/curve/tier/stale 相关），内容放 body。
 * 只约束记录（会衰减、可召回），不约束单例运行状态（heartbeat 等）。
 * normalizeRecord 把旧平铺形状（medium/long.jsonl）与新信封形状归一成同一内存对象，
 * 并保留派生 .text/.alpha 供旧读取方兼容。on-disk 迁移另行协调（iterate/lexicon 同读）。
 */
/**
 * 「今天」的日期键（YYYY-MM-DD，本地时区）。
 *
 * 数据结构归 decay，要改统一改：
 * 「被提到过」这个状态属于**记录契约**的一部分——谁记、谁读都得按同一个定义，
 * 所以放在 decay，不和 lexicon 各写一份。
 */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/**
 * 记下「今天被提到过」。
 *
 * 语义边界：
 *   - 只动时间戳，**不动清晰度分数**，也不算一次「我主动回忆过」
 *   - 同一天只算一次（靠 dayKey 比对）
 *   - 不顺带改描述内容
 */
/**
 * 这个人是不是**空壳**：账本里没有任何记忆内容。
 *
 * ensurePerson 会给每个说话的人建记录，只是不再顶行。空记录会一直攒，
 * 所以查「认不认识这人」时必须能一眼区分空壳。
 *
 * 判据（turns 不算内容——那只是"说过几次话"，不是"我记住了什么"）：
 *   没有 traits、没有 items、分数为 0 → 空壳。
 *
 * 放在 decay 是因为这是**记录契约**的一部分：谁说"空"，都得按同一个定义。
 */
/**
 * 把账本里的键规整成「人的 id」。
 *
 * 已知缺陷：peopleOf 只认 `/^[0-9a-f]{8}$/`，`name:ashu` 会被直接跳过；
 * 注入侧又使用另一套过滤，导致同一本账两种键、两套行为。
 *
 * 结论：**键有两类，不是格式不一致**——
 *   - 有 id 的（8 位 hex）：能被 @ 到，通道能把它解析成人名
 *   - 无 id 的（`name:xxx`、空）：早期迁移/手写条目，只能注入，永远不可能被 @
 *
 * 这个函数只回答"这条记录有没有 id"，不判断别的。
 * 两个消费方（通道认人、注入渲染）都调它，就不再各写一套正则。
 */
export function personKeyOf(raw) {
  const key = String(raw ?? '').trim().toLowerCase();
  if (/^[0-9a-f]{8}$/.test(key)) return key;
  if (/^[0-9a-f]{32}$/.test(key)) return key.slice(0, 8);
  return null;
}

export function isEmptyPerson(rec) {
  if (rec === null || typeof rec !== 'object') return true;
  const traits = Array.isArray(rec.traits) ? rec.traits : [];
  const items = Array.isArray(rec.items) ? rec.items : [];
  /**
   * 能被 recall 到 ≠ 算「还活着」。搁置的、停用的记录可以 recall，
   * 但不应参与「我记不记得这个人」的判断。查得到是检索能力，不是活跃证据。
   *
   * 所以这里只数**还算数的**条目：
   *   - 被新说法取代的（superseded）不算
   *   - 被搁到一边的（ignored / state=muted）不算
   *   - 被 reset 掉的印象（voided）不算
   * 只剩这些"死记录"的人，和空壳一样——不能因为他有一条 recall 查得到的历史，
   * 就当成"我认识他"。
   */
  const liveTrait = traits.some(
    (t) => t?.superseded !== true && t?.ignored !== true && t?.state !== 'muted',
  );
  const liveItem = items.some((it) => it?.voided !== true && it?.ignored !== true && it?.state !== 'muted');
  return !liveTrait && !liveItem && Number(rec.score ?? 0) === 0;
}

export function markMentioned(rec, now = Date.now()) {
  if (rec === null || typeof rec !== 'object') return false;
  const today = dayKey(now);
  if (rec.mentionDay === today) return false;
  rec.mentionDay = today;
  rec.mentionAt = Number(now);
  return true;
}

/** 今天有没有被提到过。 */
export function isMentionedToday(rec, now = Date.now()) {
  return rec?.mentionDay === dayKey(now);
}

export function normalizeRecord(raw) {
  const r = raw ?? {};
  const body = r.body ?? { text: r.text };
  const curve = r.curve ?? { alpha: r.alpha ?? r.a };
  return {
    id: r.id,
    at: Number(r.at ?? 0),
    why: r.why,
    scope: r.scope ?? r.layer,
    curve,
    tier: r.tier,
    unverified: r.unverified === true,
    recallAt: Number(r.recallAt ?? 0) || undefined,
    // 2026-11-17：被提到过的日子（本地日期键）+ 时间戳。见 markMentioned()
    mentionDay: typeof r.mentionDay === 'string' ? r.mentionDay : undefined,
    mentionAt: Number(r.mentionAt ?? 0) || undefined,
    // 2026-11-14 新增的三个记录字段（只保留必要语义）：
    // source：亲眼看见 / 别人说的 / 推出来的——推的不许跟看见的混一起
    source: r.source ?? (r.unverified === true ? 'inferred' : 'unknown'),
    // verified：核过没有，默认未核
    verified: r.verified === true,
    // who：关于谁，recall 按人筛不用再去正文猜
    who: r.who ?? undefined,
    body,
    text: body?.text ?? r.text,
    alpha: curve?.alpha,
  };
}

/**
 * 写入闸（2026-11-14 参考 agent：闸设在写入那头，别等公式里兜）。
 * days / alpha / delta 越界就拒。初始权重=1 是定义不是输入，不防它。
 */
export function validateWrite({ delta, alpha, days } = {}) {
  const errors = [];
  if (delta !== undefined) {
    const d = Number(delta);
    if (!Number.isFinite(d) || d < LIMITS.deltaMin || d > LIMITS.deltaMax) {
      errors.push(`delta 必须在 ${LIMITS.deltaMin} ~ ${LIMITS.deltaMax}`);
    }
  }
  if (alpha !== undefined) {
    const a = Number(alpha);
    if (!Number.isFinite(a) || a <= LIMITS.alphaMin) errors.push('alpha 必须大于 0');
  }
  if (days !== undefined) {
    const d = Number(days);
    if (!Number.isFinite(d) || d <= 0) errors.push('days 必须大于 0');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 这条记录当前是否「过时」（该隐藏）。返回原因或 null。
 * 长期（scope=long）永不隐藏。两条独立线：权重低于 SHOW_THRESHOLD，或落灰期没被想起。
 */
export function hiddenReason(rec, now = Date.now()) {
  if (rec?.scope === 'long') return null;
  const w = weight(daysSince(rec.at, now), Number(rec.alpha));
  if (w < SHOW_THRESHOLD) return 'weight';
  if (isRested(rec, now)) return 'rested';
  return null;
}

/**
 * 有过时标记时能否跳过数值计算（省算力）。
 *  - weight 原因：权重单调下降，一旦低于阈值不会回升 → 直接跳过。
 *  - rested 原因：若标记后又被想起（lastTouch > mark.at）→ 不能跳，需重算。
 * 标记存侧车索引（不改动 append-only 的记忆账本）。
 */
export function shouldSkipComputation(rec, mark, now = Date.now()) {
  if (!mark) return false;
  if (mark.reason === 'weight') return true;
  if (mark.reason === 'rested') return lastTouchOf(rec) <= Number(mark.at ?? 0);
  return false;
}
