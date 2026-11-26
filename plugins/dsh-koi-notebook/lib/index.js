/**
 * dsh-koi-notebook —— 笔记本（2026-11-18）
 *
 * 为什么要有
 * ----------
 * agent 的 `tool-fs` 里 write/edit/applyPatch 全是关的——**没有通用写文件入口**。
 * 技能步骤、事件经过、机制状态这类长内容，塞进记忆会占每轮的注入预算，还会衰减。
 *
 * 设计约束：
 *   - 工具尽量少（工具定义每轮都吃 token）。当前有三个：
 *     `note_archive` 是「清单上标废弃、但正文还能读」的开关，
 *     塞进 note_open 的参数里会让语义打架，宁可多花一份 schema 成本。
 *     代价：约 +150 token/轮，接受。
 *   - **平时零注入**：不进提示词、不占上下文，用的时候才查
 *   - **指针自足**：记忆里留的那句要有「动作 + 触发条件 + id」，
 *     不能只给 id —— 只给 id 等于给一个密码，而不是可理解的内存索引
 *   - **单篇限长**：`note_open(id)` 超过 4000 字就只回小节目录 + 第一节，
 *     `note_open(id, 节名)` 只回那一节且同样限制 4000 字。
 *     否则笔记本会在打开时一次性挤占上下文。
 *
 * 存储（只增不删）
 * ----------------
 *   .koi/notebook/index.jsonl    只追加：{id, at, kind, tags, title, summary, file, when}
 *                               归档也走追加一行 {id, archived:true}；
 *                               读的时候按 id 合并、后写的覆盖先写的（只增不删）
 *   .koi/notebook/<id>.md        正文，一篇一个文件，写完不动
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'koi-notebook';
export const inject = ['tools'];

/** 单篇一次最多回多少字 */
const MAX_BODY_CHARS = 4000;

/** 清单一次最多列多少篇 */
const MAX_LIST = 30;

const KINDS = new Set(['skill', 'event', 'state']);

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function slugOf(title) {
  return String(title ?? '')
    .replace(/[\s/\\:*?"<>|]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * 拼指针（2026-11-18 codex review P3）：
 * 记忆层 `remember` 会把超过 200 字的正文静默截断——指针一旦超长，
 * **被砍掉的正好是末尾的 id**，而 id 是唯一能重新打开它的东西。
 * 所以这里先算长度，挤不下就压标题和触发条件（优先保触发条件），
 * 但 **id 永远完整保留**。
 */
export function pointerOf(title, when, keywords, id) {
  /**
   * 上限 96（不是 180）。codex review P2：
   * 中期记忆注入时 `clip(text, 100)`，指针本身没有句末标点 → 会被硬剪 → **尾部的 id 丢失**。
   * 96 字以内就不会触发注入端的截断，id 永远在。
   */
  const MAXP = 96;
  // 四段，缺一不可：指针要给人看，必须有触发条件；
  // 也要给 recall 查，必须保留原字。
  const build = (t, w, k) => `笔记本｜${t}｜${w}｜${k}｜${id}`;
  let t = String(title ?? '');
  let w = String(when ?? '');
  let k = Array.isArray(keywords) ? keywords.join(' ') : String(keywords ?? '');
  if (build(t, w, k).length <= MAXP) return build(t, w, k);
  const budget = MAXP - '笔记本｜'.length - '｜'.length * 3 - String(id ?? '').length;
  // 分配顺序：原字（recall 摸得到的锚）> 触发条件 > 标题
  const kMax = Math.max(10, Math.floor(budget * 0.4));
  const wMax = Math.max(12, Math.floor(budget * 0.35));
  const tMax = Math.max(10, budget - Math.min(k.length, kMax) - Math.min(w.length, wMax));
  const cutSeg = (x, max) => (x.length <= max ? x : `${x.slice(0, Math.max(1, max - 1))}…`);
  t = cutSeg(t, tMax);
  w = cutSeg(w, wMax);
  k = cutSeg(k, kMax);
  const out = build(t, w, k);
  // 极短 id 预算下仍可能超；此时再压严格一点，但绝不动 id
  return out.length <= MAXP + 20 ? out : build(cutSeg(t, 10), cutSeg(w, 12), cutSeg(k, 10));
}

/** 摘要：正文第一段，最多 60 字（供清单显示） */
function summaryOf(body) {
  const first = String(body ?? '').split('\n').find((l) => l.trim() !== '') ?? '';
  return first.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** 按 markdown 二级标题切小节：返回 [{title, text}]，无标题时整篇算一节 */
export function splitSections(md) {
  const text = String(md ?? '');
  const lines = text.split('\n');
  const out = [];
  let cur = { title: '', lines: [] };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (cur.lines.length > 0 || cur.title !== '') out.push(cur);
      cur = { title: m[1], lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur.lines.length > 0 || cur.title !== '') out.push(cur);
  return out
    .map((s) => ({ title: s.title, text: s.lines.join('\n').trim() }))
    .filter((s) => s.title !== '' || s.text !== '');
}

export function apply(ctx, config = {}) {
  const home = () => process.env.KOI_HOME ?? homedir();
  const dir = () => (String(config.dir ?? '').trim() !== '' ? String(config.dir) : join(home(), '.koi', 'notebook'));
  const indexFile = () => join(dir(), 'index.jsonl');
  const log = (m) => (ctx?.logger?.info ? ctx.logger.info(m) : console.log(m));

  function ensureDir() {
    mkdirSync(dir(), { recursive: true });
  }

  /** 读索引（只读，不修）。坏行跳过但计数，不静默。 */
  /**
   * 读索引。**按 id 合并、后写的覆盖先写的**（2026-11-18）：
   * 索引是只追加的 JSONL，标「已归档」也走追加一行 `{id, archived:true}`，
   * 不回头改旧行——只增不删。读的时候后写的生效。
   */
  function readIndex() {
    const f = indexFile();
    if (!existsSync(f)) return [];
    const out = [];
    const byId = new Map();
    let bad = 0;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const rec = JSON.parse(line);
        const id = String(rec?.id ?? '');
        if (id !== '' && byId.has(id)) byId.set(id, { ...byId.get(id), ...rec });
        else if (id !== '') byId.set(id, rec);
        else out.push(rec);
      } catch {
        bad += 1; // 坏行跳过（计数，不静默吞掉）
      }
    }
    out.push(...byId.values());
    if (bad > 0) log(`[koi-notebook] 索引里有 ${bad} 行读不了，已跳过`);
    return out;
  }

  /** 下一篇的 id：n-YYYY-MM-DD-XX（当天顺延） */
  function nextId(now = Date.now()) {
    const day = dayKey(now);
    const prefix = `n-${day}-`;
    const used = readIndex()
      .map((r) => String(r?.id ?? ''))
      .filter((id) => id.startsWith(prefix))
      .map((id) => Number(id.slice(prefix.length)) || 0);
    const seq = (used.length > 0 ? Math.max(...used) : 0) + 1;
    return `${prefix}${pad2(seq)}`;
  }

  // ── 工具 1：写 ────────────────────────────────────────────
  ctx.tools.register({
    name: 'note_save',
    description:
      '写一篇笔记本。适合**长内容**：操作步骤（skill）、一次性事件经过（event）、'
      + '某个机制现在是什么状态/哪个结论被推翻了（state）。'
      + '写完它不会出现在提示词里，只在 note_open 时才读——所以别把每句话都要用的原则搬进来。'
      + '返回一个 id 和一条四段指针（笔记本｜标题｜触发条件｜原字关键词｜id），以后靠它找回来。'
      + '**tags 就是"原字关键词"那栏**：放工具名/文件名/原话里的词——recall 是按字面找的，'
      + '只写你自己的说法（"看图""识图"）以后就查不回来。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: '标题。将来靠它和指针决定打不打开，写清"干什么用的"' },
        body: { type: 'string', description: '正文。可以用 ## 小节分段（超长时按节读）' },
        kind: {
          type: 'string',
          enum: ['skill', 'event', 'state'],
          description: 'skill=操作步骤；event=发生过什么事；state=某机制现在什么状态/哪个结论被推翻',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '「原字关键词」：工具名、文件名、别人的原话——recall 按字面匹配，'
            + '这些原词是它唯一摸得到的锚。别只写自己的说法（"看图"），要写 read_image。',
        },
        when: {
          type: 'string',
          description: '什么时候该打开这篇（触发条件）。给了才会生成一条能用的指针；'
            + '不给就只回一个模板，并明说触发条件要你自己补——别指望标题替你写。',
        },
      },
      required: ['title', 'body'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args) {
      const title = String(args?.title ?? '').trim();
      const body = String(args?.body ?? '').trim();
      if (title === '') return '标题得有——将来靠它决定打不打开。';
      if (body === '') return '正文是空的。';
      const kind = KINDS.has(String(args?.kind ?? '')) ? String(args.kind) : 'event';
      const tags = Array.isArray(args?.tags) ? args.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8) : [];
      const now = Date.now();
      const id = nextId(now);
      const file = `${id}-${slugOf(title) || 'note'}.md`;
      try {
        ensureDir();
        // 正文只写一次，之后不动（只增不删）
        appendFileSync(join(dir(), file), `${body}\n`, 'utf8');
        const when = String(args?.when ?? '').trim();
        const entry = { id, at: now, kind, tags, title, summary: summaryOf(body), file, chars: body.length, when };
        appendFileSync(indexFile(), `${JSON.stringify(entry)}\n`, 'utf8');
        /**
         * 2026-11-18 她挑出来的毛病：自动指针直接拿标题拼，看起来像系统写好了，
         * 但标题里往往没有触发条件——**一条没用的指针被生成得很顺滑**。
         * 现在：给了 when 才拼一条完整指针；没给就只给模板并明说要她补。
         */
        const head = `记下了：${id}（${kind}，${body.length} 字）`;
        if (when !== '') {
          const kw = tags.length > 0 ? tags : '<原字关键词>';
          const extra = tags.length === 0 ? '\n（「原字关键词」那栏要填 recall 能摸到的原词：工具名/文件名/原话里的词）' : '';
          return `${head}\n指针：${pointerOf(title, when, kw, id)}${extra}`;
        }
        return `${head}\n指针模板（**触发条件要你自己补**，标题里通常没有）：\n`
          + `${pointerOf(title, '<什么时候该打开这篇>', tags.length > 0 ? tags : '<原字关键词>', id)}\n`
          + `（补好再写进中期记忆；只写 id 没用——那是密码，不是记忆。）`;
      } catch (err) {
        return `没写进去：${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // ── 工具 2：归档（清单上标「废弃」，正文仍读得到）──────────
  //
  // 笔记本不衰减，需要在清单上提供「标记废弃、不再注入」的方案。
  // 笔记本不衰减，清单会一直涨——这就是把旧的请出清单、但**不删**的开关。
  ctx.tools.register({
    name: 'note_archive',
    description:
      '把一篇**笔记**标成「已归档」：不再出现在 note_open() 的清单里，但 note_open(id) 照样读得到全文。'
      + '用于：过时了、写错了、只剩占地方的旧结论。**不是删除**，undo=true 随时拿回来。'
      + '**这是笔记本的开关**——你自己认下的事用 set_aside，长期记忆用 memory_obsolete。三个账本三个开关。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '笔记 id，比如 n-2026-11-18-02' },
        undo: { type: 'boolean', description: 'true=从归档里拿回来，重新出现在清单里' },
      },
      required: ['id'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args) {
      const id = String(args?.id ?? '').trim();
      if (id === '') return '要说是哪一篇。';
      const rec = readIndex().find((r) => String(r?.id ?? '') === id);
      if (!rec) return `没有 ${id} 这篇。`;
      const undo = args?.undo === true;
      try {
        ensureDir();
        // 只追加一行覆盖，不回头改旧行（只增不删）
        appendFileSync(indexFile(), `${JSON.stringify({ id, archived: !undo, archivedAt: undo ? null : Date.now() })}\n`, 'utf8');
        return undo
          ? `${id} 已拿回清单。`
          : `${id}「${String(rec.title ?? '').slice(0, 20)}」已归档：不出现在清单里，note_open(id) 仍读得到，可撤销。`;
      } catch (err) {
        return `没写进去：${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // ── 工具 3：查 ────────────────────────────────────────────
  ctx.tools.register({
    name: 'note_open',
    description:
      '查笔记本。不带参数列最近的；给关键词按标题/标签/摘要搜；给 id 读正文'
      + '（正文超过 4000 字只回小节目录 + 第一节）；给 id + section 只读那一节'
      + '（单次同样最多 4000 字，超出会标明已截断）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '关键词（标题/标签/摘要里找）' },
        id: { type: 'string', description: '笔记 id，比如 n-2026-11-18-01' },
        section: { type: 'string', description: '小节名（配合 id 用），只读那一节' },
        include_archived: { type: 'boolean', description: '列清单时把已归档的也算进来（默认不算）' },
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args) {
      const index = readIndex();
      if (index.length === 0) return '笔记本还是空的。';

      const id = String(args?.id ?? '').trim();
      const q = String(args?.query ?? '').trim().toLowerCase();
      const section = String(args?.section ?? '').trim();

      // 读正文
      if (id !== '') {
        const rec = index.find((r) => String(r?.id ?? '') === id);
        if (!rec) return `没有 ${id} 这篇。`;
        const path = join(dir(), String(rec.file ?? `${id}.md`));
        if (!existsSync(path)) return `${id} 的正文文件丢了（索引还在，file=${rec.file}）。`;
        const md = readFileSync(path, 'utf8');
        // 三条读取路径（整篇 / 指定节 / 分节目录）都要带这个标记——
        // 归档的正文仍可读，但不标出来就会被当成现在的结论（codex review P2）
        const archTag = rec.archived === true ? '〔已归档·不在清单里〕' : '';

        if (section !== '') {
          const secs = splitSections(md);
          const hit = secs.find((s) => s.title === section) ?? secs.find((s) => s.title.includes(section));
          if (!hit) {
            return `这篇没有叫「${section}」的节。有：${secs.map((s) => s.title).filter(Boolean).join('、') || '（没有小节）'}`;
          }
          if (hit.text.length <= MAX_BODY_CHARS) {
            return `【${rec.title} › ${hit.title}】${archTag}\n${hit.text}`;
          }
          return `【${rec.title} › ${hit.title}】${archTag}（本节 ${hit.text.length} 字，已截断，可继续分段；全文见 ${rec.file}）\n`
            + hit.text.slice(0, MAX_BODY_CHARS);
        }

        if (md.length <= MAX_BODY_CHARS) {
          return `【${rec.title}】${archTag}（${rec.kind}，${md.length} 字）\n${md}`;
        }
        const secs = splitSections(md).filter((s) => s.title !== '');
        if (secs.length === 0) {
          // 没小节又超长：只能截断，并明说
          return `【${rec.title}】${archTag}（${md.length} 字，太长已截断，全文见 ${rec.file}）\n${md.slice(0, MAX_BODY_CHARS)}`;
        }
        const first = secs[0];
        return `【${rec.title}】${archTag}共 ${secs.length} 节（${rec.kind}，${md.length} 字）\n`
          + `小节：${secs.map((s) => s.title).join('、')}\n`
          + `—— 第一节 ——\n## ${first.title}\n${first.text}\n`
          + `（要看其它节：note_open(id="${id}", section="节名")）`;
      }

      // 列表 / 搜索
      const includeArchived = args?.include_archived === true;
      const matchQ = (r) => q === '' || String(r.title ?? '').toLowerCase().includes(q)
        || String(r.summary ?? '').toLowerCase().includes(q)
        || (Array.isArray(r.tags) && r.tags.some((t) => String(t).toLowerCase().includes(q)));
      // 归档数也要按同一个查询词算——否则搜索时底部那句"另有 N 篇"是虚的
      const archivedCount = index.filter((r) => r.archived === true && matchQ(r)).length;
      const list = index
        .filter((r) => includeArchived || r.archived !== true)
        .filter(matchQ)
        .sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0));

      if (list.length === 0) {
        // 全部命中的都归档了，也不能只说"没有"——那正是"没看到≠没有"的坑
        if (archivedCount > 0) {
          return `「${q === '' ? '清单' : q}」里没找到没归档的，但有 ${archivedCount} 篇已归档的匹配；`
            + '加 include_archived=true 再看一次。';
        }
        return `笔记本里没有匹配「${q}」的。`;
      }
      const shown = list.slice(0, MAX_LIST);
      const lines = shown.map((r) => {
        const d = new Date(Number(r.at ?? 0));
        const day = `${d.getMonth() + 1}/${d.getDate()}`;
        const when = String(r.when ?? '').trim();
        const arch = r.archived === true ? '〔已归档〕' : '';
        return `- ${r.id}｜${day}·${r.kind}${arch}｜${r.title}${when !== '' ? `｜${when}` : ''}${Array.isArray(r.tags) && r.tags.length > 0 ? `（${r.tags.join('/')}）` : ''}\n    ${r.summary ?? ''}`;
      });
      const more = list.length > MAX_LIST ? `\n…还有 ${list.length - MAX_LIST} 篇，加个关键词再查。` : '';
      const arch = archivedCount > 0 && !includeArchived
        ? `\n（另有 ${archivedCount} 篇已归档，没列出来；要看看就加 include_archived=true）`
        : '';
      return `笔记本里 ${list.length} 篇：\n${lines.join('\n')}${more}${arch}\n（读某一篇：note_open(id="…")）`;
    },
  });

  log(`[koi-notebook] ready → ${dir()}（${readIndex().length} 篇；单篇上限 ${MAX_BODY_CHARS} 字）`);
}
