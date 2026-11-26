/**
 * 多维心情（2026-11-08）
 *
 * 旧设计：mood 是一个数字 0-100，由事件脉冲推高推低。
 * 新设计（设计文档 M2）：**多维**——每次填写「一种情绪 + 一个数 + 一条曲线」，
 * 每种情绪的分数单独算，互不抵消。
 *
 *   {mood: 42}              ← 旧：一个数，烦躁和松快会互相抵消
 *   {烦躁: -0.6, 松快: +0.4} ← 新：两种情绪同时存在，都是真的
 *
 * 为什么这样更对：
 *   「今天被怼得很烦，但图读出来了挺高兴」——人同时烦且高兴，
 *   合成一个 42 分就把这两件事都抹平了。
 *
 * 和印象的关系：结构完全一样（domain=mood）。
 *   subject = 情绪名（烦躁/松快/无聊/得意…）
 *   face    = 情绪名（同一个）
 *   delta   = -1 ~ +1
 *
 * 维度不限，每个维度按自己的衰减曲线计算。
 *
 * 这个模块只管「多维心情」这一层，不碰旧的 moodEvents / mood 数字。
 * 旧的还在跑（energy 之类），多维心情是**额外**的一层。
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { daysSince, weight, curveForZero, describeCurve, SHOW_THRESHOLD, alphaFromHalfLife, accumulate } from 'dsh-koi-decay';

/**
 * 情绪的默认曲线：**半衰期 36 小时**。
 *
 * 演进过程（都在 2026-11-08）：
 *   1. 最初写成「18 小时掉到 10%」（α≈4.11）——6 小时只剩 40%，第二天全没
 *   2. 改成「半衰期 18 小时」——24 小时后 42%，5.4 天落灰
 *   3. **调整为 36 小时半衰期**：
 *
 *      18 小时会让一天内记录的情绪过快消失；36 小时至少跨过一夜仍保留尾部。
 *      夜里 8 小时睡眠占掉一半以上，醒来时只剩四成，这个衰减幅度与新窗口匹配。
 *
 * 现在：36 小时掉一半，一天后 59%，20 天落灰。
 */
export const DEFAULT_MOOD_CURVE = { alpha: Number(alphaFromHalfLife(36 / 24).toFixed(6)) };

/** 每维只让最近这些记录参与现算；更老的仍在 archived 里供 recall。 */
const MAX_ACTIVE_ITEMS = 500;

function compactSlot(slot) {
  if (slot === null || typeof slot !== 'object' || Array.isArray(slot)) return false;
  slot.items = Array.isArray(slot.items) ? slot.items : [];
  slot.archived = Array.isArray(slot.archived) ? slot.archived : [];
  const overflow = slot.items.length - MAX_ACTIVE_ITEMS;
  if (overflow <= 0) return false;
  slot.archived.push(...slot.items.slice(0, overflow));
  slot.items = slot.items.slice(overflow);
  return true;
}

/**
 * 多维心情的存储。
 */
export class MoodDims {
  /**
   * @param {{dir: string, file?: string}} config
   */
  constructor(config) {
    this.file = config.file ?? `${config.dir}/mood-dims.json`;
    /**
     * 默认衰减速度可由外部给（2026-11-24 M3）：
     * `request_mood_tuning` 批下来的半衰期在 affect.json 里，插件算成 alpha 传进来。
     * 不传就用内置的 36 小时半衰期。
     */
    const given = Number(config.defaultAlpha);
    this.defaultAlpha = Number.isFinite(given) && given > 0 ? given : DEFAULT_MOOD_CURVE.alpha;
    /** @type {Record<string, {items: Array<object>}>} */
    this.data = {};
    this.silent = { loadError: 0, badItem: 0 };
    this.writeBlocked = false;
    this.backupFile = '';
    this.load();
  }

  load() {
    try {
      if (!existsSync(this.file)) {
        this.data = {};
        return;
      }
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      // 只保留自有属性，防止原型污染
      this.data = {};
      let compacted = false;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const k of Object.keys(raw)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          this.data[k] = raw[k];
          if (compactSlot(this.data[k])) compacted = true;
        }
      }
      if (compacted) this.save();
    } catch (err) {
      this.silent.loadError += 1;
      this.writeBlocked = true;
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        copyFileSync(this.file, backup);
        this.backupFile = backup;
      } catch (backupErr) {
        console.log(`[koi-affect] 多维心情损坏文件备份失败：${backupErr instanceof Error ? backupErr.message : String(backupErr)}`);
      }
      console.log(`[koi-affect] 多维心情读取失败：${err instanceof Error ? err.message : String(err)}`);
      this.data = {};
    }
  }

  save() {
    if (this.writeBlocked) return false;
    let fd;
    let tmp = '';
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      tmp = join(
        dirname(this.file),
        `.${basename(this.file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      fd = openSync(tmp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(this.data, null, 2));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, this.file);
      return true;
    } catch (err) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* 已经关了 */ }
      }
      if (tmp !== '') {
        try { unlinkSync(tmp); } catch { /* 临时文件可能没创建 */ }
      }
      console.log(`[koi-affect] 多维心情保存失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * 加一种情绪。
   *
   * @param {object} args
   * @param {string} args.mood  情绪名（烦躁 / 松快 / 无聊 …）
   * @param {number} args.delta -1 ~ +1
   * @param {string} [args.why] 为什么
   * @param {number} [args.days] 多少天后清零（不给用默认 18 小时）
   * @param {number} [args.a]
   * @param {number} [args.b]
   * @returns {{ok:boolean, message:string}}
   */
  add({ mood, delta, why, days, alpha }) {
    if (this.writeBlocked) {
      return {
        ok: false,
        message: `多维心情文件损坏，已拒绝写入以免覆盖原数据${this.backupFile ? `（备份：${this.backupFile}）` : '（备份失败，原文件保持不动）'}。`,
      };
    }
    const name = String(mood ?? '').trim().slice(0, 12);
    if (name === '') return { ok: false, message: '要说是什么情绪，比如「烦躁」「松快」。' };

    const d = Number(delta);
    if (!Number.isFinite(d) || d < -1 || d > 1) {
      return { ok: false, message: '强度要是 -1 到 +1 之间的数。' };
    }

    let al = Number.isFinite(Number(alpha)) ? Number(alpha) : this.defaultAlpha;
    if (Number.isFinite(Number(days)) && Number(days) > 0) {
      al = curveForZero(Number(days)).alpha;
    }
    if (al <= 0) {
      return { ok: false, message: 'alpha 必须大于 0（越大掉得越快）。' };
    }

    // 原型链防护：'__proto__' / 'constructor' 这类名字不能当 key 用
    // （2026-11-08 codex review P2）
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
      return { ok: false, message: `「${name}」不能当情绪名。` };
    }
    const hadSlot = Object.hasOwn(this.data, name);
    if (!hadSlot) this.data[name] = { items: [] };
    const slot = this.data[name];
    slot.items ??= [];
    const previousItems = slot.items.slice();
    const previousArchived = Array.isArray(slot.archived) ? slot.archived.slice() : undefined;
    slot.items.push({
      delta: d,
      why: String(why ?? '').trim().slice(0, 100) || undefined,
      alpha: al,
      at: Date.now(),
    });
    compactSlot(slot);
    if (!this.save()) {
      slot.items = previousItems;
      if (previousArchived === undefined) delete slot.archived;
      else slot.archived = previousArchived;
      if (!hadSlot && slot.items.length === 0) delete this.data[name];
      return { ok: false, message: `没记下：${name} 的存储文件写不进去，这次没有算成功。` };
    }

    const life = describeCurve(al);
    return { ok: true, message: `记下了：${name} ${d > 0 ? '+' : ''}${d.toFixed(2)}${why ? `（${why}）` : ''}。${life}` };
  }

  /**
   * 现在有哪些情绪，各多少分。
   *
   * @param {number} [now]
   * @returns {Array<{mood:string, score:number}>}
   */
  current(now = Date.now()) {
    const out = [];
    for (const [mood, slot] of Object.entries(this.data)) {
      // 2026-11-08：和印象用同一个叠加公式 `d = 1 - ∏(1-aᵢ)`。
      // 「同一个情绪记了多次」和「同一个人同一个形容记了多次」是同一种语义：
      // 同类叠加该饱和，不该线性累加。
      const parts = [];
      for (const it of slot.items ?? []) {
        const w = weight(daysSince(it.at, now), Number(it.alpha ?? it.a));
        if (w < SHOW_THRESHOLD) continue; // 落灰的不参与
        parts.push({ delta: Number(it.delta ?? 0), w });
      }
      const total = accumulate(parts);
      if (Math.abs(total) >= SHOW_THRESHOLD) out.push({ mood, score: total });
    }
    return out.sort((x, y) => Math.abs(y.score) - Math.abs(x.score));
  }

  /**
   * 回想：查某种情绪的全部记录，包括已经淡掉的。
   *
   * @param {string} query
   * @param {number} [now]
   * @returns {Array<{mood:string, delta:number, why?:string, at:number, w:number}>}
   */
  recall(query, now = Date.now()) {
    const q = String(query ?? '').trim().toLowerCase();
    const hit = (t) => q === '' || String(t ?? '').toLowerCase().includes(q);
    const out = [];
    for (const [mood, slot] of Object.entries(this.data)) {
      for (const it of [...(slot.archived ?? []), ...(slot.items ?? [])]) {
        if (!hit(mood) && !hit(it.why)) continue;
        out.push({ mood, delta: Number(it.delta ?? 0), why: it.why, at: Number(it.at ?? 0), w: weight(daysSince(it.at, now), Number(it.alpha ?? it.a)) });
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  stats(now = Date.now()) {
    const cur = this.current(now);
    let faded = 0;
    for (const slot of Object.values(this.data)) {
      for (const it of slot.items ?? []) {
        if (weight(daysSince(it.at, now), Number(it.alpha ?? it.a)) === 0) faded += 1;
      }
    }
    return { dims: cur.length, faded, loadError: this.silent.loadError };
  }
}
