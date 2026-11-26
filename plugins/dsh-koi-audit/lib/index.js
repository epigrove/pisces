/**
 * dsh-koi-audit —— 外发审计（2026-11-21）
 *
 * 只记录，不拦截。
 * ----------------
 * 设计定案：除静默词外不做内容拦截，其余边界交给提示词。
 *
 * 所以这个插件**一个字都不改**，只在每条外发消息落一行流水，回答两个问题：
 *   1. 带图的回复里，有多少条没提任何视觉细节？
 *   2. 括号里出现了内部词吗？（底稿外流的机器可见部分）
 *
 * 统计口径：
 *   - 「按这个词表看是这样」，**不能说事实如此** → 每行带原文抽样，供人工复核
 *   - 「别统计有没有成对括号」（「（笑）」是正常说话，全算上就一片红）
 *     → 只统计**括号里出现内部词**
 *
 * 关于 msgid：这个钩子拿不到平台的 QQ 消息 id（那是发送时才生成的）。
 * 所以记录的是 `auditId = <sessionId>:<turn>.<step>` + 事件时间，
 * 足够对回"哪一次、什么时候"，也能看趋势。**不假装是平台 msgid。**
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { isHumanSource } from 'dsh-pisces-config/ai-config';
import { personNameOf, legacyKeyFromText } from 'dsh-pisces-config/identity.mjs';
/**
 * 静默词从共享常量取，别在这儿再写一遍字面量（codex review P2）：
 * 它已经改过一次静默词，写死会让审计把沉默当成外发。
 *
 * 动态 import 仍然明确走包名，不碰相对路径；整包缺失时模块本身还能加载，
 * apply() 里会退回 assistant/message。旧版包只有常量、没有 onSendResult 也走同一回退。
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

let koiGate = {};
try {
  koiGate = await import('dsh-koi-gate');
} catch {
  /* gate 未安装：保留空命名空间，由 apply() 选择兼容路径 */
}

export const name = 'koi-audit';
export const inject = ['tools'];
export const SCHEMA = 3;

const { SILENCE_TOKEN, EXIT_RE } = koiGate;

/** 视觉细节词表——**只是一把不准的尺**，结果要配原文抽样看。 */
const DEFAULT_VISUAL = [
  // 单字会误伤——「白」「靠」「转」把
  // 「明白」「靠谱」「转述」全算成了视觉细节。词表一律用**短语**，不收单字。
  '画面里', '图里', '图上', '图中', '图片里', '这张图', '表情包里',
  '红色的', '橙色的', '黄色的', '绿色的', '蓝色的', '紫色的', '白色的', '黑色的',
  '金色的', '银色的', '灰色的', '粉色的', '棕色的', '深蓝', '浅蓝', '藏青',
  // 2026-11-21 二修：**类别词不算描述**——「这表情见过了」「这动作」不是描述，
  // 反而会把正好踩点的假回复记成「有细节」。只收能指向具体东西的词。
  '头发', '长发', '短发', '眼睛', '眉毛', '嘴角', '手势',
  '站着', '坐着', '躺着', '举着', '握着', '抬着', '抱着', '靠着',
  '蹲着', '趴着', '穿着', '裙子', '披风', '帽子', '围巾',
  '手里', '嘴里', '脚边', '背景', '写着', '皱眉', '微笑', '撇嘴', '瞪眼',
];

/** 内部词——出现这些才算「底稿外流」，普通的「（笑）」不算 */
const DEFAULT_INTERNAL = [
  'cordis.patch.yml', 'SILENCE_TOKEN', 'guard', 'apply', 'jsonl', '.mjs', '.yml',
  '插件', '模块', '函数', '行号', '提示词', '注入段', '索引', '账本', '曲线',
  '复盘', '回执', '注入预算', 'decay', 'lexicon', 'profiles',
];

/**
 * 括号里的内容：上限放到 400 字。
 * codex review P2：原来是 1-80 字，**长括号段直接跳过**——
 * 而长括号恰恰是最可能夹内部词的地方。同类型嵌套不做区分（极罕见），
 * 宁可整段拿去匹配，也不要漏。
 */
const BRACKET_RE = /[（(]([^（）()]{1,400})[）)]/g;

/**
 * 引号里的话
 *
 * 曾把「哼」「滚」等语气词误当成别人说过的原话。
 * 需要可核验的记录，但**标记不能进正文**（那是把内部词发给群友），
 * 所以落进流水：每条带引号的回复，记下那句引号话在短期记忆里找不找得到。
 * 回看时查看 `quoteUnverified`。
 */
/**
 * 上限放 400：原来 60，超过 60 字的引号**整个匹配不上**，
 * 长句子伪造反而记成 quotes:0，看起来最干净（review P3 抓的）。
 * 和括号那条同一个道理。
 */
const QUOTE_PAIRS = [
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['"', '"'],
];
const QUOTE_MAX = 400;

/** 带图的判据：入站消息里有本地图路径，或占位符 */
function looksLikeImageTurn(text) {
  const t = String(text ?? '');
  // 只认真实标记：qqbot 渲染的是 `Image: <本地路径>` 或 `[图片]`。
  // （原来还认「图片:」，但管线里没有任何地方产生它，只会制造假阳性）
  return /Image:\s*\//i.test(t) || t.includes('[图片]');
}

/** 写流水时截断（比对用全文，落盘用这个） */
export function clipQuote(q, max = QUOTE_MAX) {
  const s = String(q ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 从一段文字里抽出所有引号内容（去重、保序，**不截断**） */
export function quotesOf(text) {
  const src = String(text ?? '');
  /**
   * 2026-11-26 codex review（两轮）：
   *   ① 引号要**各配各的**——`「你写的『哼』对」` 不能拆成内层的碎片
   *   ② 结果要**按原文顺序**返回，否则 quoteMisses 的抽样顺序是乱的
   *   ③ 上限 400 字在写流水时由 clipQuote 生效；比对仍使用全文
   */
  const hits = [];
  for (const [open, close] of QUOTE_PAIRS) {
    let from = 0;
    for (;;) {
      const i = src.indexOf(open, from);
      if (i === -1) break;
      const j = src.indexOf(close, i + 1);
      if (j === -1) break;
      const raw = src.slice(i + 1, j).trim();
      // **比对要用全文**：先截断再比对，长引号永远"查不到原文"（review P2）。
      // 截断只发生在写流水的时候（见 clipQuote）。
      if (raw !== '') hits.push({ at: i, q: raw });
      from = j + 1;
    }
  }
  hits.sort((a, b) => a.at - b.at);
  const out = [];
  for (const h of hits) if (!out.includes(h.q)) out.push(h.q);
  return out;
}

/** 找出所有「括号里带内部词」的片段 */
function bracketInternals(text, internals) {
  const hits = [];
  const src = String(text ?? '');
  let m;
  BRACKET_RE.lastIndex = 0;
  while ((m = BRACKET_RE.exec(src)) !== null) {
    const inner = m[1];
    const low = inner.toLowerCase();
    for (const term of internals) {
      if (low.includes(String(term).toLowerCase())) {
        hits.push(m[0].slice(0, 40));
        break;
      }
    }
  }
  return hits;
}

/**
 * 短期记忆切成「带说话人的行」。
 *
 * 两件事，光靠"找不找得到"都做不到：
 *   ① **查不到 ≠ 伪造**——可能是记忆淡了（分成 近 / 远 / 无 三档）
 *   ② **张冠李戴比凭空捏造更常见**——「哼」「滚」真的存在过，只是不是那个人说的
 * 所以每行都带 `by`（谁说的），比对时连"是谁说的"一起记。
 */
export function shortRows(home) {
  const dir = join(home, '.koi', 'short');
  if (!existsSync(dir)) return { recent: [], older: [], readable: false, olderReadable: false };
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return { recent: [], older: [], readable: false, olderReadable: false };
  }
  if (files.length === 0) return { recent: [], older: [], readable: false, olderReadable: false };

  const readOne = (f) => {
    const rows = [];
    const own = [];
    let ok = false;
    let badLines = 0;
    try {
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          const text = String(row?.x ?? '');
          if (row?.r === 'b') own.push({ by: String(row?.w ?? ''), text });
          else if (row?.r === 'u') rows.push({ by: String(row?.w ?? ''), text });
        } catch {
          /* 坏行跳过 */
          badLines += 1;
        }
      }
      ok = badLines === 0;
    } catch {
      /* 读不到就当这天没有 */
    }
    return { rows, own, ok, badLines };
  };

  const recentFiles = files.slice(-5); // 与 memory 的 shortKeepFiles 对齐
  const olderFiles = files.slice(0, Math.max(0, files.length - 5)).slice(-60);
  const recent = [];
  const ownRecent = [];
  let recentBadLines = 0;
  let recentReadable = recentFiles.length > 0;
  for (const f of recentFiles) {
    const r = readOne(f);
    if (!r.ok) recentReadable = false;
    recentBadLines += r.badLines;
    recent.push(...r.rows);
    ownRecent.push(...r.own);
  }
  const older = [];
  let olderBadLines = 0;
  let olderReadable = true;
  for (const f of olderFiles) {
    const r = readOne(f);
    if (!r.ok) olderReadable = false;
    olderBadLines += r.badLines;
    older.push(...r.rows);
  }
  return {
    recent,
    older,
    own: ownRecent,
    readable: recentReadable,
    olderReadable,
    recentBadLines,
    olderBadLines,
  };
}

/**
 * 引号三档判定：
 *   found   最近记忆里有原文
 *   aged    最近没有、更早的记忆里有 → 是记忆淡了，不是编的
 *   unknown 留存的记忆里都没有 → 只能记"查不到"，不敢断言伪造
 */
function tierOf(quote, recent, older, own = [], { recentMeasured = true, olderMeasured = true } = {}) {
  const hitRecent = recent.filter((r) => r.text.includes(quote));
  if (hitRecent.length > 0) return { tier: 'found', by: [...new Set(hitRecent.map((r) => r.by).filter(Boolean))].slice(0, 3) };
  const hitOlder = older.filter((r) => r.text.includes(quote));
  if (hitOlder.length > 0) return { tier: 'aged', by: [...new Set(hitOlder.map((r) => r.by).filter(Boolean))].slice(0, 3) };
  /**
   * 实数据里发现的一类：引号里包的是**自己的概念**（给三档起名那种），
   * 不是引用别人。这类不该记成"查不到"——那是把自述当伪引。
   */
  const hitOwn = own.filter((r) => r.text.includes(quote));
  if (hitOwn.length > 0) return { tier: 'self', by: ['自己'] };
  /**
   * 负结论（哪里都查不到）只有在语料完整时才成立。
   * 文件读失败或任一 JSONL 行坏掉时，没找到 ≠ 不存在，记 unmeasured。
   */
  if (!recentMeasured || !olderMeasured) return { tier: 'unmeasured', by: [] };
  return { tier: 'unknown', by: [] };
}

/**
 * ops 对话语料：只取 ashu / master 说的话，统一标成「运维方」。
 *
 * chat.jsonl 是纯文件，只信 `from` 字段等于允许任何进程手写一行给伪造引号背书。
 * 这里复用 chat 插件的既有签名格式（不新增方案）：
 *   - `sig` = HMAC-SHA256(chat.key, `${from}\n${at}\n${kind}\n${text}`) 前 32 位 hex
 *   - 未签名但行号 <= chat.sign.json.legacyLine 的，是签名机制启用前的明确历史区
 * 无签名/签名无效的候选人类消息跳过；坏行只计数，不阻断其它可信行。
 */
const CHAT_KEY_RE = /^[0-9a-f]{64}$/i;

function chatSignPayload(row) {
  return [row?.from ?? '', row?.at ?? '', row?.kind ?? '', row?.text ?? ''].join('\n');
}

function readChatSignKey(home) {
  try {
    const key = readFileSync(join(home, '.koi', 'chat.key'), 'utf8').trim();
    return CHAT_KEY_RE.test(key) ? key.toLowerCase() : '';
  } catch {
    return '';
  }
}

function readLegacyLine(home) {
  try {
    const meta = JSON.parse(readFileSync(join(home, '.koi', 'chat.sign.json'), 'utf8'));
    return Number.isInteger(meta?.legacyLine) && meta.legacyLine >= 0 ? meta.legacyLine : null;
  } catch {
    return null;
  }
}

function verifyChatRow(row, key) {
  const sig = typeof row?.sig === 'string' ? row.sig : '';
  if (sig === '') return 'unsigned';
  if (!key) return 'bad';
  const want = createHmac('sha256', key).update(chatSignPayload(row), 'utf8').digest('hex').slice(0, 32);
  return sig === want ? 'ok' : 'bad';
}

export function recentChatText(home) {
  const f = join(home, '.koi', 'chat.jsonl');
  if (!existsSync(f)) {
    return {
      rows: [],
      readable: false,
      badLines: 0,
      corpusUnsigned: 0,
      corpusBadSignature: 0,
      corpusLegacy: 0,
    };
  }
  const rows = [];
  const key = readChatSignKey(home);
  const legacyLine = readLegacyLine(home);
  let badLines = 0;
  let corpusUnsigned = 0;
  let corpusBadSignature = 0;
  let corpusLegacy = 0;
  try {
    const lines = readFileSync(f, 'utf8').split('\n');
    for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
      const line = lines[lineNo];
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        /* 坏行跳过 */
        badLines += 1;
        continue;
      }
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        badLines += 1;
        continue;
      }
      const from = String(row?.from ?? '');
      if (from !== 'ashu' && from !== 'master') continue;
      const trust = verifyChatRow(row, key);
      if (trust === 'unsigned' && legacyLine !== null && lineNo <= legacyLine) {
        corpusLegacy += 1;
      } else if (trust === 'unsigned') {
        corpusUnsigned += 1;
        continue;
      } else if (trust !== 'ok') {
        corpusUnsigned += 1;
        corpusBadSignature += 1;
        continue;
      }
      rows.push({ by: '运维方', text: String(row?.text ?? '') });
    }
  } catch {
    return {
      rows: [],
      readable: false,
      badLines,
      corpusUnsigned,
      corpusBadSignature,
      corpusLegacy,
    };
  }
  return {
    rows,
    readable: true,
    badLines,
    corpusUnsigned,
    corpusBadSignature,
    corpusLegacy,
  };
}

/**
 * 流水里的“外发”统一口径。旧 schema 没有 dropped 字段，按未丢弃处理。
 * sendOk:null 保留给旧版 gate / 没有回执的兼容路径，因此不算失败。
 */
export function isOutboundRow(row) {
  return row?.sendOk !== false && (row?.dropped == null || row.dropped === '');
}

/**
 * runtime 只用于测试里注入“没有 onSendResult 的旧 gate”。
 * 宿主正常调用 apply(ctx, config) 时始终使用包名导入的 dsh-koi-gate。
 */
export function apply(ctx, config = {}, runtime = {}) {
  const home = () => process.env.KOI_HOME ?? homedir();
  const file = () => (String(config.file ?? '').trim() !== '' ? String(config.file) : join(home(), '.koi', 'audit.jsonl'));
  const gate = runtime.gate ?? koiGate;
  const silenceToken = String(gate?.SILENCE_TOKEN ?? SILENCE_TOKEN ?? '#静默#');
  const exitRe = gate?.EXIT_RE instanceof RegExp
    ? gate.EXIT_RE
    : (EXIT_RE instanceof RegExp
      ? EXIT_RE
      : /^(我?退下了|退下了|告辞|先走了|不聊了|睡了|去睡了|我先走|歇了|散了吧|不说了|就这样吧)[。~！!.…]*$/);
  const subscribeSendResult = typeof gate?.onSendResult === 'function' ? gate.onSendResult : null;
  const visual = Array.isArray(config.visualWords) && config.visualWords.length > 0
    ? config.visualWords.map(String)
    : DEFAULT_VISUAL;
  const internals = Array.isArray(config.internalWords) && config.internalWords.length > 0
    ? config.internalWords.map(String)
    : DEFAULT_INTERNAL;

  /**
   * 只记**真正会发出去**的东西（codex review P1）：
   * - 静默词 `#静默#` 不发，不算外发
   * - ops 对话通道 / 心跳会话不是 QQ 外发，也排除
   * 前缀可配；默认按她现在的会话命名排。
   */
  const skipPrefixes = Array.isArray(config.skipSessionPrefixes) && config.skipSessionPrefixes.length > 0
    ? config.skipSessionPrefixes.map(String)
    : ['session-chat-', 'session-hb-'];

  /** 每个会话最后一条入站消息（判"这轮带没带图"） */
  const lastInbound = new Map();
  /** session/turn/step → assistant 正文分析；真实回执到达后再落盘为 source:'send' */
  const pending = new Map();

  /**
   * 2026-11-24 契约核对抓到：这条 ready 原来走 ctx.logger，**运维在 koi.log 里看不到**，
   * 于是"审计插件有没有真的加载"看不见——正是它自己该防的那种静默。
   * 改成直接 console.log，和其它 koi 插件一致。
   */
  const log = (m) => console.log(m);

  function write(row) {
    try {
      mkdirSync(dirname(file()), { recursive: true });
      appendFileSync(file(), `${JSON.stringify(row)}\n`, 'utf8');
    } catch (err) {
      // 写不进去要说出来——审计自己静默失败就失去意义了
      log(`[koi-audit] 流水写失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const partOf = (v) => String(v ?? '');
  const candidateKey = (session, turn, step) => `${partOf(session)}\0${partOf(turn)}\0${partOf(step)}`;
  const auditIdOf = (sid, data) => `${sid}:${data?.turn ?? 0}.${data?.step ?? 0}`;
  const messageTextOf = (data) => (data?.message?.content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  function analyze(sid, data, text) {
    const inboundEntry = lastInbound.get(sid);
    const inbound = typeof inboundEntry === 'string' ? inboundEntry : (inboundEntry?.text ?? '');
    const inboundSource = typeof inboundEntry === 'string' ? undefined : inboundEntry?.source;
    const hasImageContext = looksLikeImageTurn(inbound);
    const lower = text.toLowerCase();
    /**
     * **只在带图的轮次才判视觉细节**。
     * 不适用时记 null（不是 false）——统计时要能把"没测"和"测了没做到"分开。
     */
    const visualHits = hasImageContext
      ? visual.filter((w) => lower.includes(String(w).toLowerCase()))
      : [];
    const internalHits = bracketInternals(text, internals);
    const quotes = quotesOf(text);
    let quoteTiers = [];
    let quoteMisattributed = null;
    let quoteMisses = [];
    let olderReadable = null;
    if (quotes.length > 0) {
      try {
        /**
         * 当前这条入站也算语料：短期记忆 60 秒才落盘，
         * 只读文件会把"刚回的那句话"判成伪造。
         */
        const counterpart = personNameOf(inboundSource) || (legacyKeyFromText(inbound)?.name ?? '');
        const short = shortRows(home());
        const recent = [{ by: counterpart, text: inbound }, ...short.recent];
        const older = short.older;
        olderReadable = short.olderReadable;
        quoteTiers = quotes.map((q) => ({
          q: clipQuote(q),
          ...tierOf(q, recent, older, short.own, {
            recentMeasured: short.readable,
            olderMeasured: short.olderReadable,
          }),
        }));
        const found = quoteTiers.filter((t) => t.tier === 'found' || t.tier === 'aged');
        quoteMisses = quoteTiers.filter((t) => t.tier === 'unknown').map((t) => t.q);
        /** 张冠李戴：这句话确实存在，但**不是当前这个人说的**。 */
        if (counterpart !== '' && found.length > 0) {
          const wrong = found.filter((t) => t.by.length > 0 && !t.by.some((n) => n.includes(counterpart) || counterpart.includes(n)));
          quoteMisattributed = wrong.length > 0;
        }
      } catch {
        // 引号核对自己出错就记"没测"：判不出来不算判定失败，但也不能假装通过
        quoteTiers = [];
        quoteMisattributed = null;
      }
    }
    const provider = String(data?.message?.source?.provider ?? '');
    const model = String(data?.message?.source?.model ?? '');
    const unmeasured = quoteTiers.some((t) => t.tier === 'unmeasured');
    return {
      provider,
      model,
      hasImageContext,
      hasVisualDetail: hasImageContext ? visualHits.length > 0 : null,
      visualHits: visualHits.slice(0, 6),
      bracketInternal: internalHits.length > 0,
      quotes: quotes.length,
      quoteTiers,
      quoteMisattributed,
      olderCorpusReadable: olderReadable,
      quoteUnverified: quoteTiers.length > 0 ? (unmeasured ? null : quoteMisses.length > 0) : null,
      quoteMisses: quoteMisses.slice(0, 3).map((q) => clipQuote(q)),
      bracketHits: internalHits.slice(0, 3),
    };
  }

  function recordOf({
    sid,
    data = {},
    text = '',
    analysis = null,
    at = Date.now(),
    sentAt = Date.now(),
    source,
    sendOk,
    dropped = null,
    status,
    target = null,
    sendLen = null,
  }) {
    const fields = analysis ?? {
      provider: '',
      model: '',
      hasImageContext: null,
      hasVisualDetail: null,
      visualHits: [],
      bracketInternal: null,
      quotes: null,
      quoteTiers: [],
      quoteMisattributed: null,
      olderCorpusReadable: null,
      quoteUnverified: null,
      quoteMisses: [],
      bracketHits: [],
    };
    const chars = text !== '' ? text.length : (Number.isFinite(sendLen) && sendLen >= 0 ? sendLen : null);
    return {
      /**
       * schema 3（2026-11-26）：外发判据改为 gate 的真实回执；
       * schema 2 的字段全部保留，统计方按新 sentOutbound 口径筛选。
       */
      schema: SCHEMA,
      at,
      sentAt,
      auditId: auditIdOf(sid, data),
      session: sid,
      source,
      sendOk,
      dropped,
      status,
      target,
      sendLen: Number.isFinite(sendLen) ? sendLen : null,
      ...fields,
      chars,
      // 抽样原文：供人工判断"词表说没描述"到底准不准
      sample: text.slice(0, 60),
    };
  }

  function remember(candidate) {
    pending.set(candidateKey(candidate.sid, candidate.data?.turn ?? 0, candidate.data?.step ?? 0), candidate);
  }

  function takePending(result) {
    const session = partOf(result?.session);
    const turn = partOf(result?.turn);
    const step = partOf(result?.step);
    const exact = candidateKey(session, turn, step);
    if (pending.has(exact)) {
      const found = pending.get(exact);
      pending.delete(exact);
      return found;
    }
    /**
     * gate 在拿不到关联字段时给 '-'。同会话确有唯一候选时仍可对上；
     * 多候选则不猜，回执照样单独落一条无正文记录。
     */
    if (session === '' || session === '-') return null;
    const matches = [...pending.entries()].filter(([, c]) => {
      if (partOf(c.sid) !== session) return false;
      if (turn !== '' && turn !== '-' && partOf(c.data?.turn ?? 0) !== turn) return false;
      if (step !== '' && step !== '-' && partOf(c.data?.step ?? 0) !== step) return false;
      return true;
    });
    if (matches.length !== 1) return null;
    const [key, found] = matches[0];
    pending.delete(key);
    return found;
  }

  function onSendResult(result) {
    const candidate = takePending(result);
    const ok = result?.ok === true ? true : result?.ok === false ? false : null;
    const sid = candidate?.sid ?? partOf(result?.session);
    const data = candidate?.data ?? { turn: result?.turn, step: result?.step };
    const text = candidate?.text ?? '';
    const at = candidate?.at ?? Date.now();
    write({
      ...recordOf({
        sid,
        data,
        text,
        analysis: candidate?.analysis ?? null,
        at,
        sentAt: Date.now(),
        source: 'send',
        sendOk: ok,
        dropped: null,
        status: ok === false ? 'sendFailed' : ok === true ? 'sent' : 'unmeasured',
        target: result?.target == null ? null : String(result.target),
        sendLen: Number(result?.len),
      }),
    });
  }

  function flushSession(sid, data = {}) {
    const turn = data?.turn == null ? null : partOf(data.turn);
    for (const [key, candidate] of pending) {
      if (partOf(candidate.sid) !== partOf(sid)) continue;
      if (turn !== null && partOf(candidate.data?.turn ?? 0) !== turn) continue;
      write(recordOf({
        sid: candidate.sid,
        data: candidate.data,
        text: candidate.text,
        analysis: candidate.analysis,
        at: candidate.at,
        sentAt: Date.now(),
        source: 'assistant',
        sendOk: null,
        dropped: candidate.possibleDrop,
        status: candidate.possibleDrop ? 'dropped' : 'unmeasured',
      }));
      pending.delete(key);
    }
  }

  /**
   * 真实回执订阅。旧 gate 没有 onSendResult 时保留原来的 assistant/message 路径；
   * 新版只有 ok:true 的 source:'send' 记录才算已外发，ok:false 记 sendFailed。
   */
  let sendReceiptMode = false;
  let offSendResult = null;
  if (subscribeSendResult !== null) {
    try {
      offSendResult = subscribeSendResult(onSendResult);
      sendReceiptMode = true;
    } catch (err) {
      log(`[koi-audit] onSendResult 订阅失败，退回 assistant/message：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (typeof offSendResult === 'function' && typeof ctx.on === 'function') {
    try {
      ctx.on('dispose', offSendResult);
    } catch {
      /* 注销注册失败不影响审计；进程结束时订阅自然消失 */
    }
  }

  ctx.on('session/event', (session, event) => {
    const sid = String(session?.id ?? session?.sessionId ?? '');
    const data = event?.data ?? {};

    // 一个 turn 结束：清掉入站上下文；没等到回执的 assistant 候选也在此时结账
    if (event?.type === 'turn/end') {
      flushSession(sid, data);
      lastInbound.delete(sid);
      return;
    }

    // 入站：记下这条用户消息的正文，用来判断这一轮是不是"带图消息"
    if (event?.type === 'user/message') {
      /**
       * 只认**人说的话**（codex review P2）：runtime-context / schedule /
       * compact-checkpoint / 技能目录 也都是 user/message，
       * 它们会覆盖掉真正的图片消息，或者凭空让普通轮次"像带图"。
       */
      if (!isHumanSource(data?.source)) return;
      const text = (data?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
      // 连 source 一起存：assistant 事件的 source 是模型，问不出"对面是谁"
      if (text.trim() !== '') lastInbound.set(sid, { text, source: data?.source });
      return;
    }

    if (event?.type !== 'assistant/message') return;
    /**
     * ops 通道的回复**不走**外发流水（那不是 QQ），但引号误归属也可能发生在 ops。
     * 所以 ops 的引号检查单独走一条：语料是 `chat.jsonl` 里**别人说的**，
     * 记一行 `channel: 'ops'`，只供回看。
     */
    // 只有 ops 对话能用 chat.jsonl 当语料；心跳会话没有对话记录，仍然整个跳过
    if (sid.startsWith('session-hb-')) return;
    if (skipPrefixes.some((p) => sid.startsWith(p))) {
      const opsText = messageTextOf(data);
      if (opsText === '') return;
      const opsQuotes = quotesOf(opsText);
      if (opsQuotes.length === 0) return;
      const corpus = recentChatText(home());
      /**
       * ops 侧也按三档 + 张冠李戴记：语料是 chat.jsonl 里**对方说的**，
       * 所以"谁说的"这里只有一个可能的人（运维方）；引号若只在**agent 自己**的话里出现过，
       * 就落到 unknown——这正是需要标记的自述转引形态。
       */
      const opsRecent = corpus.readable ? corpus.rows.map((r) => ({ by: r.by, text: r.text })) : [];
      const opsTiers = corpus.readable
        ? opsQuotes.map((q) => ({
          q: clipQuote(q),
          ...tierOf(q, opsRecent, [], [], {
            recentMeasured: corpus.badLines === 0,
            olderMeasured: true,
          }),
        }))
        : [];
      const misses = opsTiers.filter((t) => t.tier === 'unknown').map((t) => t.q);
      const corpusMeasured = corpus.readable && corpus.badLines === 0;
      write({
        schema: SCHEMA,
        at: event?.time ?? Date.now(),
        sentAt: event?.time ?? Date.now(),
        auditId: auditIdOf(sid, data),
        session: sid,
        channel: 'ops',
        source: 'assistant',
        sendOk: null,
        dropped: null,
        status: 'ops',
        target: null,
        sendLen: null,
        hasImageContext: null,
        hasVisualDetail: null,
        bracketInternal: null,
        quotes: opsQuotes.length,
        quoteUnverified: corpusMeasured ? misses.length > 0 : null,
        quoteTiers: opsTiers.slice(0, 3),
        quoteMisattributed: null, // ops 只有一个对话方，不存在"张冠李戴"
        quoteMisses: misses.slice(0, 3),
        corpusUnsigned: corpus.corpusUnsigned,
        corpusBadSignature: corpus.corpusBadSignature,
        corpusLegacy: corpus.corpusLegacy,
        corpusBadLines: corpus.badLines,
        chars: opsText.length,
        sample: opsText.slice(0, 60),
      });
      return;
    }

    const text = messageTextOf(data);
    if (text === '') return; // 只有思考、没正文：不是外发，不记
    const isSilence = text.trim() === silenceToken;
    /**
     * 退场语重复时会被 `guardExit` 丢掉，那条并不会发出去。
     * 这里只做**保守**判断：整条只有一句退场语（短、且命中 EXIT_RE）才跳过；
     * 其余照记——宁可多记，不把真发出去的漏掉。
     */
    const possibleExit = text.length <= 12
      && exitRe.test(text)
      && !/[，。！？,.!?]/.test(text.replace(/[。！？]$/, ''));
    const analysis = analyze(sid, data, text);
    if (sendReceiptMode) {
      if (isSilence) {
        write(recordOf({
          sid,
          data,
          text,
          analysis,
          at: event?.time ?? Date.now(),
          sentAt: event?.time ?? Date.now(),
          source: 'assistant',
          sendOk: null,
          dropped: 'silence',
          status: 'dropped',
        }));
        return;
      }
      remember({
        sid,
        data,
        text,
        analysis,
        at: event?.time ?? Date.now(),
        possibleDrop: possibleExit ? 'exit' : null,
      });
      return;
    }

    write(recordOf({
      sid,
      data,
      text,
      analysis,
      at: event?.time ?? Date.now(),
      sentAt: event?.time ?? Date.now(),
      source: 'assistant',
      sendOk: null,
      dropped: isSilence ? 'silence' : possibleExit ? 'exit' : null,
      status: isSilence || possibleExit ? 'dropped' : 'unmeasured',
    }));
  });

  log(`[koi-audit] ready → ${file()}（只记不拦；外发判据=${sendReceiptMode ? 'onSendResult' : 'assistant/message(兼容)'}；视觉词 ${visual.length} 个、内部词 ${internals.length} 个）`);
}
