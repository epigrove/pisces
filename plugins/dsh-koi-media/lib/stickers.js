/**
 * 图片库存（2026-11-08）
 *
 * 设计目标：
 *
 *   说了「收了」就得真能找回来。历史上只有识图描述进了记忆，
 *   原图仍躺在临时目录里，超时清掉后无法兑现「原样还给你」。
 *   期望：说话之后，下次能按描述或发送人把图捞出来；捞不回来就不要承诺。
 *
 * 这个模块只做两件事：收图（复制到持久目录 + 记索引）、捞图（按关键词找回来）。
 *
 * 临时目录 `~/.dsh-qqbot/media/` 有 24 小时 TTL，会被清。
 * 所以收图时必须**复制**到 `.koi/media/`，不能只存路径。
 */
import {
  copyFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveInsideMediaRoot } from './media-root.js';

/** 收哪些扩展名 */
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

export class StickerStore {
  /**
   * @param {{dir: string, mediaDir?: string, mediaRoot: string}} config
   */
  constructor(config) {
    this.dir = String(config.dir);
    this.indexFile = join(this.dir, 'stickers.json');
    this.mediaDir = config.mediaDir ?? join(this.dir, 'media');
    this.mediaRoot = String(config.mediaRoot ?? '').trim();
    /** @type {Array<object>} */
    this.items = [];
    this.silent = { loadError: 0, copyError: 0, saveError: 0 };
    this.load();
  }

  load() {
    try {
      if (!existsSync(this.indexFile)) return;
      const raw = JSON.parse(readFileSync(this.indexFile, 'utf8'));
      this.items = Array.isArray(raw?.items) ? raw.items : [];
    } catch (err) {
      // 坏了先备份再重来，别默默清空
      this.silent.loadError += 1;
      try {
        copyFileSync(this.indexFile, `${this.indexFile}.broken-${Date.now()}`);
      } catch { /* 备份失败就算了 */ }
      console.log(`[koi-stickers] 索引读取失败：${err instanceof Error ? err.message : String(err)}`);
      this.items = [];
    }
  }

  save() {
    let fd;
    let tmp = '';
    try {
      mkdirSync(this.dir, { recursive: true });
      tmp = join(
        dirname(this.indexFile),
        `.${basename(this.indexFile)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      fd = openSync(tmp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, items: this.items }, null, 2), 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, this.indexFile);
      return true;
    } catch (err) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* 已经关了 */ }
      }
      if (tmp !== '') {
        try { unlinkSync(tmp); } catch { /* 临时文件可能没创建 */ }
      }
      this.silent.saveError += 1;
      console.log(`[koi-stickers] 索引保存失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * 收一张图。
   *
   * @param {object} args
   * @param {string} args.image 源路径（一般是 ~/.dsh-qqbot/media/xxx）
   * @param {string} args.desc  描述（她识图看到的，或自己起的名）
   * @param {string} [args.from] 谁发的
   * @returns {{ok:boolean, message:string, item?:object}}
   */
  keep({ image, desc, from }) {
    const src = String(image ?? '').trim();
    const description = String(desc ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (src === '') return { ok: false, message: '要说是哪张图。' };
    if (description === '') return { ok: false, message: '图得有个描述，不然以后捞不回来。' };
    if (!existsSync(src)) return { ok: false, message: `原图不在了（${src}），收不了。` };
    const checked = resolveInsideMediaRoot(src, this.mediaRoot);
    if (!checked.ok) {
      return {
        ok: false,
        message: `原图不在允许的媒体目录（${this.mediaRoot}）里，或者路径无法校验（${checked.reason}），收不了。`,
      };
    }
    const realSrc = checked.path;

    const ext = extname(realSrc).toLowerCase();
    if (!IMG_EXT.has(ext)) return { ok: false, message: `这个扩展名（${ext}）不是图片。` };

    // 同一张图别收两遍：按内容 hash 判重
    let hash = '';
    try {
      hash = createHash('sha1').update(readFileSync(realSrc)).digest('hex').slice(0, 12);
    } catch (err) {
      this.silent.copyError += 1;
      return { ok: false, message: `图读不了：${err instanceof Error ? err.message : String(err)}` };
    }
    const dup = this.items.find((it) => it.hash === hash);
    if (dup) {
      // 重复收：只加一次「被提到」
      const prevTimes = dup.times;
      const prevLastAt = dup.lastAt;
      dup.times = Number(dup.times ?? 1) + 1;
      dup.lastAt = Date.now();
      if (!this.save()) {
        dup.times = prevTimes;
        dup.lastAt = prevLastAt;
        return { ok: false, message: '这张图识别成重复了，但库存索引没写进去；这次不算收好。' };
      }
      return { ok: true, message: `这张早就收过了（${dup.desc}），又记了一次。`, item: dup };
    }

    // 复制到持久目录
    const name = `${hash}${ext}`;
    const dest = join(this.mediaDir, name);
    try {
      mkdirSync(this.mediaDir, { recursive: true });
      copyFileSync(realSrc, dest);
    } catch (err) {
      this.silent.copyError += 1;
      // 复制失败就退化成「只记描述」——捞不回来就不要承诺原图可恢复
      this.items.push({
        hash, desc: description, from: String(from ?? '').slice(0, 20) || undefined,
        at: Date.now(), path: null, note: '复制失败，只记了描述',
      });
      if (!this.save()) {
        this.items.pop();
        return { ok: false, message: '原图没复制下来，描述也没写进库存索引；这次没记住。' };
      }
      return {
        ok: true,
        message: `只记了长什么样（${description}），**图没存下来**。以后别说「收好了」，说「只记了样子」。`,
      };
    }

    const item = {
      hash,
      desc: description,
      from: String(from ?? '').slice(0, 20) || undefined,
      at: Date.now(),
      path: dest,
      bytes: statSync(dest).size,
    };
    this.items.push(item);
    if (!this.save()) {
      this.items.pop();
      return { ok: false, message: '图复制了，但库存索引没写进去；index 不可信，这次不算收好。' };
    }
    return { ok: true, message: `收好了：${description}（${(item.bytes / 1024).toFixed(0)}KB）。要的时候 recall_image 能找回来。`, item };
  }

  /**
   * 捞图。
   *
   * @param {string} query 关键词（描述或发送人）
   * @param {number} [limit]
   * @returns {{hits:Array<object>, total:number}}
   */
  recall(query, limit = 5) {
    const q = String(query ?? '').trim().toLowerCase();
    const hit = (it) => {
      if (q === '') return true;
      return String(it.desc ?? '').toLowerCase().includes(q)
        || String(it.from ?? '').toLowerCase().includes(q);
    };
    const all = this.items.filter(hit);
    // 最近的排前面
    all.sort((a, b) => Number(b.lastAt ?? b.at ?? 0) - Number(a.lastAt ?? a.at ?? 0));
    return { hits: all.slice(0, limit), total: all.length };
  }

  stats() {
    const withPath = this.items.filter((it) => it.path && existsSync(it.path));
    const lost = this.items.filter((it) => it.path && !existsSync(it.path));
    return {
      total: this.items.length,
      alive: withPath.length,
      lost: lost.length,
      descOnly: this.items.filter((it) => !it.path).length,
      loadError: this.silent.loadError,
      copyError: this.silent.copyError,
      saveError: this.silent.saveError,
    };
  }
}
