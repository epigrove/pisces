/**
 * 印象曲线 —— koi人格系统的唯一衰减公式
 *
 *   y = (x + 1)^(-α)
 *
 *   x : 已经过去的时间，单位【天】
 *   α : 大于 0，越大掉得越快
 *   y : 权重，0..1，**永不归零**
 *
 * 为什么是幂律而不是对数（2026-11-08 定）
 * -----------------------------------------
 * 旧公式 y = a·log_b(x+1)+1 有致命问题：**刚记住的东西掉得最快**。
 *
 *     写入 1 天 → 80%
 *     写入 3 天 → 61%
 *     写入 7 天 → 41%
 *     写入 33 天 → 0%（没了）
 *
 * 这跟人的记忆正好相反：
 *
 *   > 长期记忆应保留模糊但可触发的钩子，而不是在一年内精确归零。
 *
 * 所以改用**幂律**（长尾分布，像地震强度、网络流量、财富分布）：
 *
 *     1 个月后  51%
 *     3 个月后  41%
 *     一年后    31%   ← 还在
 *     五年后    23%   ← 还在
 *
 * 永不归零，但会越掉越慢，永远剩一点。
 *
 * 「不注入」靠的是阈值，不是归零
 * ------------------------------
 * 注入需要明确的停止阈值，否则记忆一多就会挤占上下文；
 * 幂律衰减到 0.1 或其他配置值后停止主动注入即可。
 *
 * 所以：
 *   - **曲线本身不负责截断**，它只负责权重
 *   - 注入时按阈值筛（见 SHOW_THRESHOLD）
 *   - 低于阈值的东西**不是删了**，是「落灰」——recall 随时能捞回来
 *
 * 因此使用幂律，同时保留「落灰」路径，不做清零删除。
 *
 * 参数为什么只有一个
 * ------------------
 * α 一个参数就够：α 越大掉得越快。用「半衰期」反推它更好理解：
 *
 *     α = log(2) / log(halfDays + 1)
 *
 * 想说「多少天掉一半」就说半衰期，曲线自己算 α。
 */

;

// ── 渲染：把 v3 结构变成注入文本 ─────────────────────────────────

// ── 数据结构 ─────────────────────────────────────────────────────

/**
 * 一条项的合法形状。
 *
 *   desc        描述。没有 delta。
 *   impression  印象。有 delta。
 *
 * domain 决定这条属于哪一类 subject：
 *   person  某人    subject = 平台标识
 *   thing   物事    subject = 物事名
 *   mood    情绪    subject = 情绪名
 */

export const DOMAINS = ['person', 'thing', 'mood'];
export const TYPES = ['desc', 'impression'];

/**
 * 校验一条项。
 *
 * @param {object} item
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateItem(item) {
  const errors = [];
  if (item === null || typeof item !== 'object') {
    return { ok: false, errors: ['项必须是对象'] };
  }

  if (!DOMAINS.includes(item.domain)) {
    errors.push(`domain 必须是 ${DOMAINS.join(' / ')} 之一`);
  }
  if (!TYPES.includes(item.type)) {
    errors.push(`type 必须是 ${TYPES.join(' / ')} 之一`);
  }
  if (typeof item.subject !== 'string' || item.subject.trim() === '') {
    errors.push('subject 不能为空');
  }
  if (!Number.isFinite(Number(item.at)) || Number(item.at) <= 0) {
    errors.push('at 必须是正数毫秒时间戳');
  }

  // alpha（新）或 a+b（旧数据，允许通过但会被当成 alpha）
  const alphaRaw = Number(item.alpha ?? item.a);
  if (!Number.isFinite(alphaRaw)) {
    errors.push('alpha 必须是数字');
  } else if (alphaRaw <= 0) {
    // 旧数据里 a 是负数，允许它通过（只是权重会算成 0，不会崩）
    if (item.a === undefined) errors.push('alpha 必须大于 0');
  }

  if (item.type === 'desc') {
    if (typeof item.text !== 'string' || item.text.trim() === '') {
      errors.push('desc 的 text 不能为空');
    }
  } else if (item.type === 'impression') {
    if (typeof item.face !== 'string' || item.face.trim() === '') {
      errors.push('impression 的 face（形容）不能为空');
    }
    const d = validateDelta(item.delta);
    errors.push(...d.errors);
    if (item.why !== undefined && typeof item.why !== 'string') {
      errors.push('why 如果填了必须是字符串');
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 校验一个 subject 的记录。
 *
 * @param {object} subject
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateSubject(subject) {
  const errors = [];
  if (subject === null || typeof subject !== 'object') {
    return { ok: false, errors: ['subject 记录必须是对象'] };
  }
  if (!subject.identity || typeof subject.identity !== 'object') {
    errors.push('缺 identity 字段');
  } else {
    if (typeof subject.identity.platform !== 'string' || subject.identity.platform === '') {
      errors.push('identity.platform 不能为空');
    }
    if (typeof subject.identity.value !== 'string' || subject.identity.value === '') {
      errors.push('identity.value 不能为空');
    }
  }
  if (!Array.isArray(subject.items)) {
    errors.push('items 必须是数组');
    return { ok: false, errors };
  }
  subject.items.forEach((item, i) => {
    const r = validateItem(item);
    if (!r.ok) errors.push(`items[${i}]: ${r.errors.join('; ')}`);
  });
  return { ok: errors.length === 0, errors };
}

/**
 * 一个人还有没有活着的描述。
 *
 * 幂律下权重永不归零，所以「活着」用**落灰线**判断：
 * 权重低于 SHOW_THRESHOLD 就算落灰了。
 *
 * @param {object} subject
 * @param {number} [now]
 * @returns {boolean}
 */
export function hasAliveDesc(subject, now = Date.now()) {
  const items = Array.isArray(subject?.items) ? subject.items : [];
  // 2026-11-12：**落灰看「多久没被想起」，不看权重。**
  // 幂律尾巴永远到不了 0.1（40 天半衰期要二十几万天），拿 SHOW_THRESHOLD 当终点是死路。
  return items.some((it) => it.type === 'desc' && !isRested(it, now));
}

/**
 * 一个 subject 的有效印象（已求和、已分组）。
 *
 * - 描述全落灰 → 返回空（不删，recall 还能查）
 * - 同一 face 的多条求和
 *
 * @param {object} subject
 * @param {number} [now]
 * @returns {Array<{face:string, score:number, counts:number, orphaned:boolean}>}
 */
export function effectiveImpressions(subject, now = Date.now()) {
  const items = Array.isArray(subject?.items) ? subject.items : [];
  const impressions = items.filter((it) => it.type === 'impression');
  // 2026-11-08 **解耦**（主人提的）：
  // 原来这里看 `hasAliveDesc`——描述没了，印象就一律不返回。
  // 但描述和印象是**两种独立的项**，各有各的曲线，
  // 凭什么印象的生死由描述决定？
  //
  // 现在：印象只看自己的权重。描述没了照样显示「我对 TA：xxx」。

  // 先按 face 分组收集，再一次性算分——
  // 2026-11-08：从「简单求和」改成 `accumulate()`（主人给的并集概率公式）。
  // 旧算法 4 条 0.3 会算出 1.2，超过 1 只能不报数；现在永远 < 1，能报数。
  const groups = new Map();
  for (const it of impressions) {
    if (it.voided) continue; // reset 过的：记录留着，不再算分
    const face = String(it.face ?? '').trim();
    if (face === '') continue;
    const w = weight(daysSince(it.at, now), Number(it.alpha ?? it.a));
    if (w < SHOW_THRESHOLD) continue; // 已经落灰，不参与注入
    const g = groups.get(face) ?? { face, parts: [], counts: 0, fading: 0, orphaned: false };
    g.parts.push({ delta: Number(it.delta ?? 0), w });
    g.counts += 1;
    // 「快没了」= 单条权重已经低于清晰线（还没落灰，但快了）
    if (w < FADE_THRESHOLD) g.fading += 1;
    groups.set(face, g);
  }
  return [...groups.values()].map((g) => {
    const { parts, ...rest } = g;
    return { ...rest, score: accumulate(parts) };
  });
}


// ── 描述的三段状态（2026-11-08 koi定）────────────────────────────


/**
 * 显示线：低于它就不出现在提示词里。
 *
 * **为什么不靠归零**：换幂律之后，权重永远大于 0，
 * 所以旧代码里「> 0 才算活着」的过滤全部失效了（2026-11-08 codex review 抓到 5 处）。
 *
 * 幂律下必须显式定一条线。
 *
 * 注意：**这是显示线，不是遗忘线。**
 * 低于它照样 recall 得到——koi说的「落灰」。
 */
/**
 * 印象曲线 —— **数学已经搬去 `dsh-koi-decay`**（2026-11-12）
 *
 * 这个文件现在只剩「本插件的业务层」：
 *   - 数据结构契约（DOMAINS / TYPES / validateItem …）
 *   - 三态判定（descState / hookOf）
 *   - 渲染成中文注入文本（renderSubject / renderV3）
 *   - 并集累积后用在本插件语义上的包装（effectiveImpressions …）
 *
 * 为什么拆：memory 和 affect 也要算衰减，原来它们从
 * `../../dsh-koi-lexicon/lib/impression.js` 相对路径 import——
 * 单独装就不成立，目录一改就崩。数学下沉到 koi-decay 后，
 * 三个插件按包名依赖它，谁都和谁不绑。
 *
 * 下面 `export *` 是为了**向后兼容**：还有地方按老路径 import
 * （包括测试），一次性改完容易漏，先留着这批再逐步清。
 */
export * from 'dsh-koi-decay';

/**
 * 曲线的人话说法 —— **这里的落灰是「多久没被想起」，不是权重**
 *
 * koi 2026-11-12：
 *   > 落灰不该靠权重算，靠「多久没被想起」算。幂律尾巴永远到不了 0.1，
 *   > 那就别拿 0.1 当终点——那条路本来就是数学上走不通的。
 *   > 两个都叫「天」是名字的错，不是数的错。改名叫「半衰期」和「落灰期」。
 *
 * 所以 lexicon 这边两句话分开说：
 *   半衰期 —— 多久掉一半（管多清晰、管排序）
 *   落灰期 —— 多久没被想起就不再注入（管还出不出现在提示词里）
 *
 * 注意：这是**本地覆盖**。`dsh-koi-decay` 那份按权重算的说法仍然给 memory 用
 * （medium 层给了短半衰期就该早点退出注入，否则「省点钱」是空话）。
 */
export function describeCurve(alpha) {
  const half = halfDaysOf(alpha);
  const halfText = !Number.isFinite(half)
    ? '不会淡'
    : half < 1
      ? '半衰期一小时以内'
      : half < 2
        ? '半衰期约一天'
        : `半衰期约 ${Math.round(half)} 天`;
  return `${halfText}；${REST_DAYS} 天没被想起才落灰（落灰不是删，recall 还能捞回来）`;
}

// 这些是本文件内部还要用的数学（`export *` 只转出、不引入作用域）
import {
  MS_PER_DAY,
  daysSince,
  weight,
  dayAtWeight,
  accumulate,
  score,
  validateDelta,
  FADE_THRESHOLD,
  SHOW_THRESHOLD,
  DEFAULT_HALF_DAYS,
  REST_DAYS,
  isRested,
  halfDaysOf,
  dayKey,
  markMentioned,
  isMentionedToday,
} from 'dsh-koi-decay';


/** 一个人现在的状态 */
export const PERSON_STATE = {
  CLEAR: 'clear', // 清晰：完整描述 + 印象
  FADING: 'fading', // 迷糊：降级成钩子，印象不再注入
  FORGOTTEN: 'forgotten', // 忘掉：只剩钩子，recall 能查
};

/**
 * 一个人（或物事）现在处于哪种状态。
 *
 * @param {object} subject
 * @param {number} [now]
 * @returns {'clear'|'fading'|'forgotten'}
 */
export function descState(subject, now = Date.now()) {
  const items = Array.isArray(subject?.items) ? subject.items : [];
  const descs = items.filter((it) => it.type === 'desc');
  if (descs.length === 0) return PERSON_STATE.FORGOTTEN;

  // 落灰：所有描述都过了落灰期（400 天没被想起）→ 只剩钩子
  const alive = descs.filter((d) => !isRested(d, now));
  if (alive.length === 0) return PERSON_STATE.FORGOTTEN;

  let best = 0;
  for (const d of alive) {
    best = Math.max(best, weight(daysSince(d.at, now), Number(d.alpha ?? d.a)));
  }
  // 没落灰，但已经淡过清晰线 → 迷糊（降级成钩子）
  return best > FADE_THRESHOLD ? PERSON_STATE.CLEAR : PERSON_STATE.FADING;
}

/**
 * 钩子：当描述进入迷糊/落灰时，留下那一句能勾起记忆的话。
 *
 * 钩子不能只是名字加「对我不错」这种空话；
 * 应保留能触发记忆的具体片段，而不是重新生成摘要。
 *
 * 做法：取当前权重最高的那条 desc 的原文，不生成、不摘要。
 *
 * @param {object} subject
 * @param {number} [now]
 * @returns {string|null}
 */
export function hookOf(subject, now = Date.now()) {
  const items = Array.isArray(subject?.items) ? subject.items : [];
  const descs = items.filter((it) => it.type === 'desc' && String(it.text ?? '').trim() !== '');
  if (descs.length === 0) return null;

  let best = null;
  let bestW = -1;
  for (const d of descs) {
    const w = weight(daysSince(d.at, now), Number(d.alpha ?? d.a));
    if (w > bestW) { bestW = w; best = d; }
  }
  if (best === null) {
    best = descs.reduce((x, y) => (Number(x.at) <= Number(y.at) ? x : y));
  }
  return String(best.text).trim();
}

/**
 * 把一组同一 face 的印象渲染成一个片段。
 *
 * 显示要求：
 *   - 一条 -0.8 和四条 -0.2 凑出的 -0.8 不是同一件事，
 *     显示为「-0.8（4 条）」能看出形成方式。
 *
 *   - 单条已压到底时明确标记，避免误认为由多条旧记录累积而成。
 *
 *   - 原始分数超过 1 时不再直接报数，使用封顶后的自然语言表达。
 *
 * @param {{face:string, score:number, counts:number, fading?:number}} g
 * @returns {string}
 */
export function renderFaceGroup(g) {
  const face = String(g.face ?? '').trim();
  if (face === '') return '';

  const abs = Math.abs(g.score);
  const count = Number(g.counts ?? 1);
  const fading = Number(g.fading ?? 0);

  // 2026-11-08：**删掉「超过 1 不报数」这条规则。**
  //
  // 原来超过 1 只显示「越来越顺眼」之类的自然语言，不报原始数字。
  //
  // 但叠加公式换成并集概率之后，**分数永远到不了 1**（最多浮点饱和到 1.00），
  // 所以这条规则再也不会触发——留着是死代码。
  //
  // 极限情况（12 条都 0.9）会饱和到 1.00，直接显示数字比换成一句话更诚实。

  const sign = g.score > 0 ? '+' : '';
  const notes = [];
  if (count > 1) notes.push(`${count} 条`);
  if (fading > 0) notes.push(count > 1 ? `${fading} 条快没了` : '快没了');
  const note = notes.length > 0 ? `（${notes.join('，')}）` : '';
  return `${face} ${sign}${g.score.toFixed(2)}${note}`;
}

/**
 * 把一个人 / 物事渲染成一行注入文本。
 *
 * 三态决定渲染成什么样（koi定的）：
 *   clear      完整描述 + 印象
 *   fading     只给钩子
 *   forgotten  只给钩子（并标「只剩个影子」）
 *
 * @param {object} subject   v3 结构的一条记录
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {number} [opts.descPerPerson] 最多显示几条描述
 * @returns {string|null} 没有内容可渲染时返回 null
 */
export function renderSubject(subject, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxDesc = opts.descPerPerson ?? 2;
  // 2026-11-17 codex review P2：老记录可能只有 name（ensurePerson 建的），
  // 没有 display / identity —— 原来这里直接 return null，
  // 被提到的恰好就是这类"分低没描述"的人，功能等于对它无效。
  const name = String(subject?.display ?? subject?.identity?.value ?? subject?.name ?? '').trim();
  if (name === '') return null;

  // 物事和情绪没有「描述」这个概念，直接按印象渲染
  //
  // 2026-11-10 去 QQ 化：**原来这里是白名单** `['person','qq','name','discord','wechat']`，
  // 每接一个平台就得往里加一个值——这是把「人」定义成"已知平台列表"。
  //
  // 现在反过来：**只有 'thing' / 'mood' 不是人**，其他一律当人。
  // 接新平台不用改这里。
  const platform = String(subject?.identity?.platform ?? 'person');
  const NON_PERSON_PLATFORMS = ['thing', 'mood'];
  if (NON_PERSON_PLATFORMS.includes(platform)) {
    const imps = effectiveImpressionsIgnoringDesc(subject, now)
      .filter((x) => x.score !== 0)
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .map((x) => `${x.face} ${x.score > 0 ? '+' : ''}${x.score.toFixed(2)}`);
    if (imps.length === 0) return null;
    // 物事/情绪的 face 常和名字是同一个词，去掉重复的文字，但**分数要留**
    const groups = effectiveImpressionsIgnoringDesc(subject, now)
      .filter((x) => Math.abs(x.score) >= 0.01)
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .map((x) => {
        const rendered = renderFaceGroup(x);
        // face 和名字一样时，去掉重复的形容，只留分数部分
        return x.face === name ? rendered.slice(name.length).trim() : rendered;
      });
    return `- ${name}：${groups.join('、')}`;
  }

  // ── 2026-11-08 重构：描述和印象**各自判断** ──
  //
  // 主人说的：
  //   「新增项不是可选描述或印象吗，描述的衰减曲线与描述这一栏解耦，与项挂钩」
  //
  // 原来的毛病：`descState(整个人)` 定三态，然后按三态决定给什么——
  // 没描述就整条不显示，描述迷糊就**连印象都不给**。
  // 但描述和印象是两种独立的项，各有各的 alpha，凭什么互相决定生死？
  //
  // 现在：每一项按自己的曲线算，各自决定自己显示成什么样。
  // 整条只在一件事上统一——**一项都显示不出来时才返回 null**。
  const items = Array.isArray(subject.items) ? subject.items : [];

  // 2026-11-12：整个 subject 都过了落灰期 → 不进注入（钩子还在数据里，recall 能捞）
  // 落灰是淡掉，不是删；钩子仍然保留。
  // 今天被提到过的人：哪怕整本账都落灰了，也要露个头——
  // 只给名字 + 「没印象就 recall」，不编任何内容。
  const force = opts.force === true;
  /** 活着的 traits（旧说法不算）。force 渲染和「没印象」判定都要用它。 */
  const liveTraits = (subject?.traits ?? [])
    .filter((tr) => tr?.superseded !== true && String(tr?.text ?? '').trim() !== '' && !isRested(tr, now))
    .map((tr) => String(tr.text).trim());
  if (items.length > 0 && items.every((it) => isRested(it, now))) {
    // 2026-11-17 codex review P3：印象全落灰，但 traits 可能还活着——
    // 先给 traits，别一句「想不起细节」把记得的东西也盖掉。
    if (!force) return null;
    return liveTraits.length > 0
      ? `- ${name}（${liveTraits.slice(0, 2).join('；')}）`
      : `- ${name}（想不起细节了，要用先 recall）`;
  }

  // 描述层：清晰的全显示，迷糊的挑一条当钩子；落灰的那条不再当钩子
  const descsWeighted = items
    .filter((it) => it.type === 'desc' && String(it.text ?? '').trim() !== '')
    .filter((it) => !isRested(it, now))
    .map((it) => ({ text: String(it.text).trim(), w: weight(daysSince(it.at, now), Number(it.alpha ?? it.a)) }))
    .sort((a, b) => b.w - a.w);

  // 2026-11-08 codex review P2：钩子**不设阈值**。
  // 幂律永不归零，但会掉到很小；掉到 SHOW_THRESHOLD 以下就不显示钩子
  // 等于又回到「冷死循环」——她连「有这么个人」都不知道了。
  // 原 hookOf() 也不看权重，这里保持一致。
  const clearDescs = descsWeighted.filter((x) => x.w >= FADE_THRESHOLD).slice(0, maxDesc);
  const hook = descsWeighted.length > 0 && clearDescs.length < descsWeighted.length
    ? descsWeighted[clearDescs.length].text
    : null;

  // 印象层：只看自己的权重，和描述在不在**无关**
  const maxImp = opts.impPerPerson ?? 6;
  const imps = effectiveImpressions(subject, now)
    // 2026-11-08 codex review P3：分数抵消到 0 的不提（记了正反各一笔等于没看法）
    .filter((x) => Math.abs(x.score) >= 0.01)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, maxImp) // P2：每人最多几条，防止注入被一个人占满
    .map((x) => renderFaceGroup(x));

  // 一项都显示不出来 → 不提这个人
  if (clearDescs.length === 0 && hook === null && imps.length === 0) {
    if (!force) return null;
    /**
     * 2026-11-17 codex review P1：老记录可能只有 traits、没有 v3 的 items。
     * 这时候照样说「没印象」就是误报——她明明记着这人。
     */
    return liveTraits.length > 0
      ? `- ${name}（${liveTraits.slice(0, 2).join('；')}）`
      : `- ${name}（没印象，先 recall 一次）`;
  }

  // 描述全掉光了，只剩钩子：括号收在整条末尾，别在中间断开
  if (clearDescs.length === 0 && hook !== null) {
    const parts = [`只记得：${hook}`];
    if (imps.length > 0) parts.push(`我对 TA：${imps.join('、')}`);
    return `- ${name}（想不起细节了，${parts.join('；')}）`;
  }

  const bits = [];
  if (clearDescs.length > 0) bits.push(clearDescs.map((x) => x.text).join('；'));
  if (imps.length > 0) bits.push(`我对 TA：${imps.join('、')}`);
  return `- ${name}：${bits.join('；')}`;
}

export function renderV3(data, opts = {}) {
  const now = opts.now ?? Date.now();
  const out = { people: [], things: [], mood: [] };

  /**
   * 2026-11-17 codex review P1：我原来只在**旧 v2 分支**里加了「今天被提到 → 露头」，
   * 而她的 profile 是 `useV3: true`，走的正是这条路径——等于功能完全没生效。
   *
   * 现在 V3 也认：今天被提到的人无条件渲染，并且排在最前面。
   * （不改变分数、不改变描述，只是"让他露个头"）
   */
  const mentioned = opts.mentioned ?? null;
  const first = [];
  const rest = [];
  for (const [key, subject] of Object.entries(data?.people ?? {})) {
    const isMentioned = mentioned !== null && mentioned.has(key);
    const line = renderSubject(subject, { ...opts, now, force: isMentioned });
    if (line === null) continue;
    (isMentioned ? first : rest).push(line);
  }
  // 2026-11-17 codex review P2：被提到的人优先，但要受同样的上限约束，
  // 否则一天提到一百个名字，【我认识的人】会无限长、白烧上下文。
  const cap = Number(opts.maxPeople ?? 40);
  out.people = [...first, ...rest].slice(0, cap);
  const thingLines = [];
  for (const subject of Object.values(data?.things ?? {})) {
    const line = renderSubject(subject, { ...opts, now });
    if (line === null) continue;
    const salience = effectiveImpressionsIgnoringDesc(subject, now)
      .reduce((sum, x) => sum + Math.abs(x.score), 0);
    thingLines.push({ line, salience });
  }
  const thingCap = Number(opts.maxThings ?? 40);
  out.things = thingLines
    .sort((a, b) => b.salience - a.salience)
    .slice(0, Number.isFinite(thingCap) ? Math.max(0, thingCap) : 40)
    .map((x) => x.line);
  for (const subject of Object.values(data?.mood ?? {})) {
    const line = renderSubject(subject, { ...opts, now });
    if (line !== null) out.mood.push(line);
  }
  return out;
}


/**
 * 不管描述、直接求和印象。
 *
 * 给物事和情绪用——它们没有「描述」这个概念，
 * 三态规则只适用于人。
 *
 * @param {object} subject
 * @param {number} [now]
 * @returns {Array<{face:string, score:number, counts:number}>}
 */
export function effectiveImpressionsIgnoringDesc(subject, now = Date.now()) {
  const items = Array.isArray(subject?.items) ? subject.items : [];
  // 同上：改用 accumulate（2026-11-08，和 effectiveImpressions 保持一致）
  const groups = new Map();
  for (const it of items) {
    if (it.type !== 'impression') continue;
    if (it.voided) continue; // reset 过的
    const face = String(it.face ?? '').trim();
    if (face === '') continue;
    const w = weight(daysSince(it.at, now), Number(it.alpha ?? it.a));
    const g = groups.get(face) ?? { face, parts: [], counts: 0 };
    g.parts.push({ delta: Number(it.delta ?? 0), w });
    g.counts += 1;
    groups.set(face, g);
  }
  return [...groups.values()].map((g) => {
    const { parts, ...rest } = g;
    return { ...rest, score: accumulate(parts) };
  });
}


/**
 * 把旧的「半衰期（天）」转成新的曲线参数。
 *
 * 原则：让新曲线在 x = half 时穿过 0.5。
 *   a·log_b(half+1) + 1 = 0.5  →  a = -0.5 / log₂(half+1)
 *
 * 固定 b = 2（底数取 2 好算也好解释）。
 *
 * @param {number} halfDays 半衰天数
 * @returns {{a:number, b:number}}
 */
