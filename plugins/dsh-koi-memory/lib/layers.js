/**
 * 记忆四层（2026-11-08）
 *
 *   短期  short/     按会话、按时间取前 N 条，不衰减（qqbot 规则决定进不进）
 *   中期  medium.jsonl  agent 提交的事实 + 遗忘曲线
 *   长期  long.jsonl    agent 提交的事实 + 不衰减
 *   印象  由 lexicon 管，不在这里
 *
 * 这个文件只负责「中期」和「长期」两层。
 * 短期仍由现有的 ShortTerm 管（qqbot 的自然上下文）。
 *
 * 设计约束（来自设计文档）：
 *   1. 中期和长期**都由 agent 提交**，系统不自动往里写
 *   2. 中期每条自带曲线参数 a/b，由调用方定；不给就用默认
 *   3. 长期永不衰减
 *   4. 只能追加，不能改；要纠正就再写一条
 *   5. `why` 选填——要求她解释每一条，就把记忆变成了述职
 */
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { daysSince, weight, curveForZero, describeCurve, SHOW_THRESHOLD, isRested,
  normalizeRecord, shouldSkipComputation, validateWrite } from 'dsh-koi-decay';
import { readIndexResult, recordLedger, writeIndex } from 'dsh-koi-decay/sidecar';

/**
 * 中期的默认曲线：33 天后权重降到 10%。
 *
 * `curveForZero(33)` 的“33 天”是降到 10% 的时间，不是半衰期。
 * 33 天 = 一个月多一点：够记住"上周说的"、"上个月聊的"，
 * 又不会把她变成一个只进不出的档案柜。
 */
const DEFAULT_COURVE = curveForZero(33);

/**
 * 中期 + 长期记忆。
 */
export class MemoryLayer {
  /**
   * @param {{dir: string, mediumFile?: string, longFile?: string}} config
   */
  constructor(config) {
    const dir = String(config.dir);
    this.mediumFile = config.mediumFile ?? join(dir, 'medium.jsonl');
    this.longFile = config.longFile ?? join(dir, 'long.jsonl');
    this.medium = [];
    this.long = [];
    /** 静默失败计数器：坏了要能看见 */
    this.silent = { badLine: 0, loadError: 0 };
    // 过时标记/召回 侧车索引（2026-11-14）。**只打标、不改账本、只增不删**——
    // 记忆账本（medium/long.jsonl）永远只追加；标记与召回时间存这个独立索引。
    this.indexFile = join(dir, 'medium.index.json');
    this.index = { stale: {}, touch: {}, obsolete: {} };
    this.indexWriteBlocked = false;
    this.load();
  }

  loadIndex() {
    this.index = { stale: {}, touch: {}, obsolete: {} };
    this.indexWriteBlocked = false;
    const loaded = readIndexResult(this.indexFile);
    if (!loaded.ok) {
      this.silent.loadError += 1;
      this.indexWriteBlocked = true;
      const why = loaded.error instanceof Error ? loaded.error.message : String(loaded.error);
      const backup = loaded.backupFailed ? '备份失败' : (loaded.backup ? `已备份到 ${loaded.backup}` : '无法备份');
      console.log(`[koi-memory] 索引读失败（${backup}），拒绝用空桶覆盖原文件：${why}`);
      return;
    }
    const d = loaded.index;
    this.index = { ...d, stale: d.stale ?? {}, touch: d.touch ?? {}, obsolete: d.obsolete ?? {} };
  }
  /**
   * 落盘侧车索引。**返回成败**（2026-11-18 codex review P3）：
   * 原来失败也返回 undefined，上层无从得知——工具会告诉她"已隐藏"，
   * 而标记只活在内存里，重启后又全被注入回去。
   */
  saveIndex() {
    if (this.indexWriteBlocked) {
      console.log('[koi-memory] 索引当前处于损坏保护状态，拒绝写回');
      return false;
    }
    try {
      writeIndex(this.indexFile, this.index);
      return true;
    } catch (e) {
      this.silent.loadError += 1;
      console.log('[koi-memory] 索引写失败：' + String(e));
      return false;
    }
  }

  load() {
    this.loadIndex();
    // 归一成信封（旧平铺/新信封都认），并套用侧车里的召回时间
    this.medium = this.readJsonl(this.mediumFile).map((r) => {
      const n = normalizeRecord(r);
      const t = n.id ? this.index.touch[n.id] : undefined;
      if (t) n.recallAt = Math.max(Number(n.recallAt ?? 0), t);
      return n;
    });
    this.long = this.readJsonl(this.longFile).map((r) => normalizeRecord(r));
  }

  readJsonl(file) {
    try {
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            // 坏行要计数，不能静默吞（2026-11-08 codex review P3）
            this.silent.badLine += 1;
            return null;
          }
        })
        .filter(Boolean);
    } catch (err) {
      // 整个文件读不了，也要记
      this.silent.loadError += 1;
      console.log(`[koi-memory] 记忆层读取失败 ${file}：${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * 记一条事实。
   *
   * @param {object} args
   * @param {string} args.text   内容
   * @param {'medium'|'long'} [args.layer] 中期还是长期，默认 medium
   * @param {string} [args.why]  为什么记（选填）
   * @param {number} [args.alpha] 中期才用：衰减速度，大于 0
   * @returns {{ok:boolean, message:string, id?:string}}
   */
  /**
   * 价值档 → 权重降到 10% 的天数（2026-11-11 参考 agent需求 4）。
   *
   * 无用的中期记忆应使用更短的衰减天数，以控制长期注入成本；
   * 写入时可以直接指定较短的 days。
   *
   * 三档是 `curveForZero()` 的参数，表示降到 10% 所需天数，不是半衰期。
   * 按「这条值多少钱」分，不按「这条有没有情绪」分：
   *   low     7 天   —— 琐碎、一次性、听完就没用的（谁发过什么表情包：14 天，用 low 再自己填 days=14）
   *   normal  40 天  —— 默认（2026-11-11 从 33 改的：33 略短，7 太短——印象七天只剩一成就不叫印象了）
   *   high    90 天  —— 会影响判断的重要教训或长期约束
   *
   * **不做分类**：一个默认 + 调用方填写。显式给 alpha / days 的仍然优先。
   */
  static TIERS = {
    low: 7,
    normal: 40,
    high: 90,
  };

  /**
   * 这条是不是「从对话里推出来的别人」——参考 agent需求 5：
   *   > 凡是从对话里推出来的「还有别人/另一个会话」这类结论，写入时带「未核实」，
   *   > 不写成事实；被推翻时能干净撤掉。
   *
   * 判据只认字面（不猜语义）：出现「另一个/另有/还有别的 + 会话/人/账号/号」，
   * 或者「未核实/不确定/我猜」这类自我保留的字眼。
   */
  static looksSpeculative(text) {
    const t = String(text ?? '');
    const anotherOne = /(另一个|另有个|另有|还有(另)?一个)[^。；\n]{0,12}?(会话|人|账号|号|机器人|bot|进程)/i.test(t);
    const hedged = /(未核实|不确定|我猜|估计是|可能是别的)/.test(t);
    return anotherOne || hedged;
  }

  remember({ text, layer = 'medium', why, alpha, tier, who, source, verified }) {
    /**
     * 2026-11-19：这里原来是静默 `slice(0, 200)`——短期的"太长截了"记号
     * 在自动晋升进中期时会被这一刀连尾巴一起剪掉，中期那条看起来就像完整的。
     * 现在超长**留记号**再切，保证"剪过"这件事跟着内容走。
     * （上游 memory_add 已经会拒收 >200 的事实；这里兜的是自动晋升这条路。）
     */
    const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
    const CAP_MARK = '…（太长，后面截了）';
    const content = raw.length > 200 ? `${raw.slice(0, 200 - CAP_MARK.length)}${CAP_MARK}` : raw;
    if (content === '') return { ok: false, message: '要说什么。' };

    const id = randomUUID().slice(0, 8);
    const at = Date.now();
    const whyC = String(why ?? '').trim().slice(0, 100) || undefined;
    // 参考 agent三字段：source（看见/听说/推的）、verified（默认未核）、who（关于谁）
    const meta = {
      who: who ? String(who).slice(0, 40) : undefined,
      source: source ?? 'unknown',
      verified: verified === true,
    };

    if (layer === 'long') {
      const rec = { id, at, why: whyC, scope: 'long', ...meta, body: { text: content } };
      mkdirSync(dirname(this.longFile), { recursive: true });
      appendFileSync(this.longFile, `${JSON.stringify(rec)}\n`, 'utf8');
      recordLedger(this.longFile, 'remember'); // 合法追加 → 刷新基线（审计记 who/when）
      this.long.push(normalizeRecord(rec));
      return { ok: true, id, message: `记住了（长期，不会淡）：${content}` };
    }

    // 中期：显式 alpha 优先；否则按价值档（low/normal/high）取降到 10% 的天数
    const spec = MemoryLayer.looksSpeculative(content);
    const wantTier = spec ? 'low' : String(tier ?? 'normal');
    if (!(wantTier in MemoryLayer.TIERS)) {
      return { ok: false, message: '档位只认 low / normal / high。' };
    }
    const al = Number.isFinite(Number(alpha))
      ? Number(alpha)
      : curveForZero(MemoryLayer.TIERS[wantTier]).alpha;
    // 写入闸（参考 agent：越界就拒，别等公式兜）
    const gate = validateWrite({ alpha: al });
    if (!gate.ok) return { ok: false, message: gate.errors.join('；') };
    const rec = {
      id, at,
      why: spec ? [whyC, '推测：未核实'].filter(Boolean).join('；') : whyC,
      scope: 'medium',
      curve: { alpha: al },
      tier: wantTier,
      // 推测进来的结论不写成事实（需求 5）；source 标 inferred
      ...(spec ? { unverified: true } : {}),
      ...meta,
      source: spec ? 'inferred' : meta.source,
      body: { text: content },
    };
    mkdirSync(dirname(this.mediumFile), { recursive: true });
    appendFileSync(this.mediumFile, `${JSON.stringify(rec)}\n`, 'utf8');
    recordLedger(this.mediumFile, 'remember'); // 合法追加 → 刷新基线（审计记 who/when）
    this.medium.push(normalizeRecord(rec));
    return {
      ok: true,
      id,
      message:
        `记住了（中期·${wantTier}${spec ? '·未核实' : ''}）：${content}。${describeCurve(al)}`
        + (spec ? '（这是从对话里推出来的，先当未核实记着，别当事实讲。）' : ''),
    };
  }

  /**
   * 中期记忆的当前可见项（权重 > 0），按权重排序。
   *
   * @param {number} [now]
   * @returns {Array<{id:string, text:string, why?:string, at:number, w:number}>}
   */
  /**
   * 召回权重（2026-11-11 参考 agent需求 4/5）：
   *   档位影响排序（high 靠前、low 靠后），**不改衰减**——衰减只由 alpha 决定。
   *   未核实的推测再 ×0.6，排在正常的后面。
   */
  static TIER_WEIGHT = { high: 1.15, normal: 1, low: 0.85 };
  static UNVERIFIED_WEIGHT = 0.6;

  visibleMedium(now = Date.now()) {
    // 侧车可能被 lexicon.recall 等其它进程/实例更新；每次可见性计算都重新读，
    // 并把最新 touch 合到内存记录上，避免刚 recall 的中期记忆又按旧 recallAt 判 rested。
    this.loadIndex();
    // 过时标记跳过计算（2026-11-14）：已打标的条目不再重复算衰减。
    // 标记只写侧车索引，**绝不改 medium.jsonl 账本**（只增不删）。
    let dirty = false;
    const out = [];
    for (const r of this.medium) {
      const touched = r.id ? Number(this.index.touch[r.id] ?? 0) : 0;
      if (touched > Number(r.recallAt ?? 0)) r.recallAt = touched;
      // 无 id 的旧记录不建索引（避免 "undefined" 键串标，codex P3）
      const mark = r.id ? this.index.stale[r.id] : undefined;
      if (shouldSkipComputation(r, mark, now)) continue; // 过时且未被想起 → 跳过
      const w =
        weight(daysSince(r.at, now), Number(r.alpha ?? r.a))
        * (MemoryLayer.TIER_WEIGHT[r.tier] ?? 1)
        * (r.unverified === true ? MemoryLayer.UNVERIFIED_WEIGHT : 1);
      // 两条独立的线，谁先到算谁（阈值为系统默认；参考 agent定的是落灰后显示成一行钩子，不是阈值）
      const reason = w < SHOW_THRESHOLD ? 'weight' : (isRested(r, now) ? 'rested' : null);
      if (reason !== null) {
        if (r.id && (!mark || mark.reason !== reason)) { this.index.stale[r.id] = { at: now, reason }; dirty = true; }
        continue;
      }
      if (r.id && mark) { delete this.index.stale[r.id]; dirty = true; } // 复活
      out.push({ ...r, w });
    }
    if (dirty) this.saveIndex();
    return out.sort((x, y) => y.w - x.w);
  }

  /** 长期记忆全部 */
  /**
   * 长期记忆：**注入用**的列表，跳过被标废弃的。
   *
   * 长期记忆需要「废弃但不删除」的标记：不再注入，但保持可召回。
   * 长期条目按定义不衰减（「一直记得的」），所以过期/没用的永远赖在注入里，
   * 没有任何机制把它们请出去——这个标记就是那个机制。
   *
   * 与中期的过时标记（stale）关键差别：**recall 不复活废弃**。
   * 中期被想起说明还有用，复活合理；长期 recoll 一下就复活，等于废弃了个寂寞。
   */
  allLong() {
    const ob = this.index.obsolete ?? {};
    return this.long.filter((r) => !(r?.id && ob[r.id]));
  }

  /** 长期记忆：**全部**（含废弃），recall 用。 */
  allLongIncludingObsolete() {
    return this.long.slice();
  }

  /**
   * 标/撤销「废弃」：只改这一个字段，原文不动（只增不删）。
   * @returns {boolean} 有没有真的改到
   */
  markObsolete(id, obsolete = true) {
    const key = String(id ?? '');
    const rec = this.long.find((r) => String(r?.id ?? '') === key);
    if (!rec || key === '') return false;
    /**
     * 2026-11-18 codex review P3：saveIndex 序列化的是**启动时**的 this.index 快照。
     * lexicon 的 recall 期间会往同一个侧车写 touch/stale，这里直接 save 会把它们
     * 静默盖回去。所以先读盘合并，再改我们要改的那个键。
     */
    this.loadIndex();
    this.index.obsolete ??= {};
    // 先记下原值，写失败时**原样恢复**（原来失败一律删键，会把先前有效的标记弄丢）
    const prev = this.index.obsolete[key];
    const hadPrev = Object.prototype.hasOwnProperty.call(this.index.obsolete, key);
    if (obsolete) this.index.obsolete[key] = Date.now();
    else delete this.index.obsolete[key];
    // 账本 long.jsonl 一个字不动，只改侧车；**写失败要如实返回**，别报成功
    const ok = this.saveIndex();
    if (!ok) {
      if (hadPrev) this.index.obsolete[key] = prev;
      else delete this.index.obsolete[key];
      return false;
    }
    return true;
  }

  /**
   * 回想：中期 + 长期都查，包括已经淡掉的中期记忆。
   *
   * @param {string} query
   * @param {number} [now]
   * @returns {Array<{layer:string, text:string, at:number, w?:number, why?:string}>}
   */
  recall(query, now = Date.now()) {
    const q = String(query ?? '').trim().toLowerCase();
    const hit = (t) => q === '' || String(t ?? '').toLowerCase().includes(q);

    const out = [];
    let dirty = false;
    for (const r of this.medium) {
      if (!hit(r.text) && !hit(r.why)) continue;
      // 被想起 → 记召回时间（侧车），并清除 rested 过时标记（复活）。无 id 不记。
      if (r.id) {
        this.index.touch[r.id] = now;
        const mark = this.index.stale[r.id];
        if (mark && mark.reason === 'rested') delete this.index.stale[r.id];
        dirty = true;
      }
      r.recallAt = now;
      out.push({ layer: '中期', text: r.text, at: r.at, why: r.why, who: r.who, w: weight(daysSince(r.at, now), Number(r.alpha ?? r.a)) });
    }
    for (const r of this.long) {
      if (!hit(r.text) && !hit(r.why)) continue;
      // 废弃的也查得到（不管打什么标记，都得能 recall 到），只是标出来
      const ob = this.index.obsolete ?? {};
      out.push({ layer: '长期', text: r.text, at: r.at, why: r.why, who: r.who, obsolete: Boolean(r?.id && ob[r.id]) });
    }
    if (dirty) this.saveIndex();
    return out.sort((a, b) => b.at - a.at);
  }

  /** 统计（给体检用） */
  stats(now = Date.now()) {
    return {
      badLine: this.silent.badLine,
      loadError: this.silent.loadError,
      mediumTotal: this.medium.length,
      mediumVisible: this.visibleMedium(now).length,
      mediumFaded: this.medium.length - this.visibleMedium(now).length,
      longTotal: this.long.length,
    };
  }
}
