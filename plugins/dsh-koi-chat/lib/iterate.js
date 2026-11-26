/**
 * chat/iterate — 04:00 从「记忆 + 最近群聊」里提炼迭代需求
 *
 * 2026-11-08：**原来是独立插件 dsh-koi-iterate，现在并进 koi-chat。**
 * 理由：它写的就是 chat.jsonl，和 chat 插件操作同一份文件，同一个进程。
 * 分成两个插件只让 profile 多一个条目、代码多一份 JSONL 解析。
 *
 * 保留成单独文件（不塞进 index.js）：chat 主逻辑 354 行 + 这个 466 行
 * 合成一个 800 行的文件会难读。
 *
 * 职责边界没变：
 *   - 这个模块决定 **4:00 生成什么**
 *   - chat-store 负责 **怎么落盘**
 *
 * 原始设计说明：
 *
 * 每天 04:00（本地时间）：
 *   1. 读长期记忆、最近 3 天的群聊片段（memory 插件的短期缓冲）、她的人设
 *   2. 读以前提过的提案标题，避免重复提
 *   3. 让模型找出「做不到 / 做不好 / 该做到」的地方，提几条迭代需求
 *   4. 写入 <数据目录>/proposals/YYYY-MM-DD.md，由运维方 04:05 审核
 *
 * 关键：这个插件不写记忆、不改代码，只出需求。记忆的写入靠 memory_add 手动，
 * 自动提炼记忆已经关掉——目标是从记忆里看出缺什么，而不是记流水账。
 *
 * 按需提问：
 *   QQBOT_ASK="问题" 启动时，会用她的人设+记忆回答，结果写入 <数据目录>/answers/。
 *   QQBOT_ITERATE_NOW=1 启动时立即生成一次提案。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { readAllSafe, append as storeAppend } from './chat-store.js';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { normalizeRecord } from 'dsh-koi-decay';
import { pickModel } from 'dsh-pisces-config';

// 这个文件是 chat 的子模块，不单独注册插件（name/inject 由 chat 提供）

/** 读取记忆文件末尾若干行作为上下文 */
/**
 * 读她的记忆（2026-11-08 改）。
 *
 * 原来只读旧的 memory.md，但那边已经停写了——不读新分层的话，
 * 提案的输入永远是空的。
 *
 * 现在：medium.jsonl（会淡的）+ long.jsonl（不淡的）优先，
 * memory.md 只当历史兜底（文件可能还在）。
 *
 * @param {string} file memory.md 的路径（兜底）
 * @param {number} maxLines
 * @returns {string}
 */
function readMemory(file, maxLines = 60) {
  const dir = dirname(file);
  const out = [];

  for (const [name, label] of [['long.jsonl', '一直记得的'], ['medium.jsonl', '还记得的']]) {
    try {
      const p = join(dir, name);
      if (!existsSync(p)) continue;
      /**
       * 2026-11-18 codex review P2：她在 04:00 提案/问询里也会读 long.jsonl，
       * 而"废弃"标记只做在注入和 recall 两处——这里的 prompt 照样把废弃条目当活的。
       * 统一跳过：侧车索引里标过 obsolete 的，这里也不算。
       */
      const obFile = join(dir, 'medium.index.json');
      let ob = {};
      try { ob = JSON.parse(readFileSync(obFile, 'utf8'))?.obsolete ?? {}; } catch { /* 没侧车就当没标过 */ }
      const items = readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean)
        .filter((it) => !(name === 'long.jsonl' && it?.id && ob[it.id]));
      if (items.length > 0) {
        out.push(`【${label}】`);
        for (const it of items.slice(-maxLines)) out.push(`- ${normalizeRecord(it).text}`);
      }
    } catch { /* 单层读不到就跳过 */ }
  }

  // 旧 memory.md 兜底（已经停写，但历史文件可能还在）
  try {
    if (existsSync(file)) {
      const legacy = readFileSync(file, 'utf8').trim();
      if (legacy !== '') out.push(`【旧记忆】\n${legacy.split('\n').slice(-20).join('\n')}`);
    }
  } catch { /* 忽略 */ }

  return out.join('\n');
}

/** 从 profile 配置里读她的人设（directPrompt 块） */
function readPersona() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const profile = process.env.QQBOT_PROFILE ?? 'koi';
  const file = join(home, 'profiles', profile, 'cordis.patch.yml');
  try {
    const lines = readFileSync(file, 'utf8').split('\n');
    const out = [];
    let inBlock = false;
    for (const line of lines) {
      if (/^\s*directPrompt:\s*\|/.test(line)) {
        inBlock = true;
        continue;
      }
      if (!inBlock) continue;
      if (line.trim() === '') {
        out.push('');
        continue;
      }
      if (/^\s{0,4}\S/.test(line)) break; // 回到同级别配置项
      out.push(line.replace(/^ {6}/, ''));
    }
    return out.join('\n').trim();
  } catch {
    return '';
  }
}

/** 最近 N 天的群聊片段（memory 插件写的短期缓冲） */
function readChats(shortDir, { days = 3, limit = 60, maxChars = 80 } = {}) {
  const out = [];
  let names = [];
  try {
    names = readdirSync(shortDir).filter((n) => n.endsWith('.jsonl')).sort();
  } catch {
    return '';
  }
  const cutoff = Date.now() - days * 86400000;
  for (const name of names.slice(-days)) {
    let text = '';
    try {
      text = readFileSync(join(shortDir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const o = JSON.parse(line);
        if (typeof o?.t !== 'number' || typeof o?.x !== 'string') continue;
        if (o.t < cutoff) continue;
        const who = o.r === 'b' ? '参考 agent' : String(o.w ?? '群友');
        out.push({ t: o.t, line: `${who}：${o.x.replace(/\s+/g, ' ').slice(0, maxChars)}` });
      } catch {
        /* 坏行跳过 */
      }
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out
    .slice(-limit)
    .map((o) => o.line)
    .join('\n');
}

/**
 * 以前提过的提案标题，用于去重。
 *
 * 2026-11-08：**改成从 chat.jsonl 读**；统一走 chat，避免额外维护提案通道。
 *
 * 提案 11-07 起就统一走 chat 了（提交 5d04f46），但这里还在读旧的
 * `proposals/*.md` 目录——那目录自那以后就不再新增，等于去重表永远是旧的。
 *
 * 现在从 chat 里挑她发的、带【今日需求】的消息，取 `## 需求：xxx` 当标题。
 * 旧目录只在没有 chat 记录时兜底（它里面的两个提案是历史存档）。
 *
 * @param {string} chatFile chat.jsonl 的路径
 * @param {string} dir 旧 proposals 目录（兜底用）
 * @param {number} keep 最多取几条
 * @returns {string} 每行一个「- 标题」
 */
function readPastTitles(chatFile, dir, keep = 12) {
  const titles = [];

  // 1) 主：从 chat 里挑她发的提案
  try {
    const report = readAllSafe(chatFile);
    if (!report.readable) {
      console.log(`[koi-chat/iterate] ⚠️ 会话记录暂不可读，本轮不读取提案去重表：${report.error}`);
    }
    for (const m of report.messages) {
      if (m?.from !== 'koi') continue;
      const text = String(m.text ?? '');
      // 提案消息以【今日需求 或【回答 开头
      if (!/^【(今日需求|回答)/.test(text)) continue;
      const d = new Date(Number(m.at ?? 0));
      const day = `${d.getMonth() + 1}/${d.getDate()}`;
      for (const line of text.split('\n')) {
        const t = /^##\s*(?:提案|需求)[：:]\s*(.+)$/.exec(line.trim());
        if (t) titles.push(`- ${t[1].trim()}（${day}）`);
      }
    }
  } catch { /* 没有 chat 文件就跳过 */ }

  // 2) 兜底：旧 proposals 目录（历史存档，不再新增）
  if (titles.length === 0) {
    try {
      const files = [];
      for (const base of [dir, join(dir, 'done')]) {
        try {
          for (const n of readdirSync(base)) {
            if (n.endsWith('.md')) files.push(join(base, n));
          }
        } catch { /* 目录不存在就跳过 */ }
      }
      files.sort((a, b) => basename(a).localeCompare(basename(b)));
      for (const f of files.slice(-keep)) {
        const text = readFileSync(f, 'utf8');
        for (const line of text.split('\n')) {
          const m = /^##\s*(?:提案|需求)[：:]\s*(.+)$/.exec(line.trim());
          if (m) titles.push(`- ${m[1].trim()}（${basename(f, '.md')}）`);
        }
      }
    } catch { /* 忽略 */ }
  }

  return titles.slice(-keep).join('\n');
}

function dayName(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 标题近似判重：中文 bigram Dice */
function gramsOf(text) {
  const lower = String(text).toLowerCase();
  const out = new Map();
  const bump = (g) => out.set(g, (out.get(g) ?? 0) + 1);
  for (const w of lower.match(/[a-z0-9]+/g) ?? []) if (w.length >= 2) bump(w);
  for (const run of lower.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? []) {
    if (run.length === 1) {
      bump(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) bump(run.slice(i, i + 2));
  }
  return out;
}

function titleSimilar(a, b) {
  const A = gramsOf(a);
  const B = gramsOf(b);
  let na = 0;
  let nb = 0;
  for (const c of A.values()) na += c;
  for (const c of B.values()) nb += c;
  if (na === 0 || nb === 0) return 0;
  let hit = 0;
  for (const [g, c] of A) {
    const d = B.get(g);
    if (d) hit += Math.min(c, d);
  }
  return (2 * hit) / (na + nb);
}

/**
 * 去掉和以前重复的需求。
 * 模型经常换个说法再提一遍（昨天刚提「身份校验」今天又提），代码兜住。
 */
function dropRepeats(text, pastTitles) {
  const known = pastTitles
    .split('\n')
    .map((l) => l.replace(/^-\s*/, '').replace(/（[^）]*）\s*$/, '').trim())
    .filter((l) => l !== '');
  const blocks = text.split(/\n(?=##\s*(?:需求|提案)[：:])/);
  const kept = [];
  const skipped = [];
  for (const block of blocks) {
    const m = /^##\s*(?:需求|提案)[：:]\s*(.+)$/m.exec(block);
    if (!m) {
      // 没有标题的碎块（前言）直接丢
      continue;
    }
    const title = m[1].trim();
    // 生成被 maxTokens 截断时，最后一条会缺字段——宁可不要，也不留半条
    const complete = ['现象', '期望', '落地', '优先级', '成本'].every((k) => block.includes(k));
    if (!complete) {
      skipped.push(`${title}（生成被截断，丢弃）`);
      continue;
    }
    const dup = known.find((k) => titleSimilar(title, k) >= 0.6);
    if (dup) skipped.push(`${title} ≈ ${dup}`);
    else kept.push(block.trim());
  }
  return { text: kept.join('\n\n'), skipped };
}

function stamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${dayName(date)}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * 2026-11-26 停用的旧措辞（**留档，不注入**，旧文本另存 `.koi/prompts.old.md`）：
 *   「想到几条说几条……3 条以上基本说明没分清主次，回去删」
 * 停用理由：把数量阈值解释成"没分清主次"，会让模型为了显得节制而合并互不相关的问题。
 * 现在改为「三件互不相干就提三条，不为了显得节制而少提」。
 */
function buildProposalPrompt({ persona, memory, chats, past, capabilities }) {
  return `${persona}

【我的记忆】
${memory || '（无）'}

【最近的群聊】（真实发生过的；引用它来说明问题，别复述它）
${chats || '（无）'}

【我目前的能力】
${capabilities || '（未知）'}

【以前提过的提案】（别重复；这些已经提过了，除非情况明显更严重）
${past || '（无）'}

现在是每日复盘。

**第一步：先判有没有货。**
从下面的材料里找「我今天明确做不到 / 做得不好」的**证据**——
证据 = 聊天里的**原话片段**，而且**要能贴回去**：
说得出这话是谁、在哪个场景说的。说不出来，那就是你印象里的一句，不是素材。
找不到能贴回去的片段，就只输出 NONE，结束。

> 提不提、提几条都可以。**没有真问题的那天什么都不提是正常的**，不用凑数，
> 也不用为了让复盘看起来有产出而发明问题。连续几天 NONE 完全没问题。

**第二步：有货才提，而且别贪多。**
- 通常 **1 条**
- 两件互不相干的事，提 2 条，说清为什么不能合成一条
- **三件互不相干就提三条，别为了显得节制而少提**

判据（按重要性）：
1. 聊天里暴露的明确失败：答不上、记不住、认错人、说漏自己是 AI、回得太长/太油/重复
2. 群友反复要求、但我没有的能力
3. 我有但没用对的能力（工具不会调、记忆召不回、该查的时候没查）

每条格式（中文，说清楚就行，别写成需求文档）：
## 需求：<标题>
- 现象：哪句话、哪个场景暴露的（**原话片段**，别编；现象要直接对应问题，别硬凑因果）
- 期望：改完之后什么表现算好（要能验收）
- 落地：dsh 插件体系里怎么做（工具 / 中间件 / 提示词 / 定时任务）
- 优先级：高 / 中 / 低
- 成本：大概多少 token、多大复杂度

只输出需求（或 NONE），不要寒暄、不要总结、不要复述聊天。`;
}

function buildAnswerPrompt(question, persona, memory) {
  return `${persona}

【记忆】
${memory || '（无）'}

主人问你：${question}

用你自己的口吻直接回答，讲明白就收。
如果问的是插件/能力：想要什么就一次说完，按重要性排序，说清楚为什么、希望它怎么工作；没有想要的就直接说没有，不要每次只挤一条凑数。
不要客套，不要复述问题。`;
}

/**
 * 提案/问答的模型路由。显式插件配置优先；之后严格按
 * 面板固定配置 → 活会话 → 环境变量解析。空 provider/model 不是一个合法路由。
 */
export function resolveIterateRoute({
  override = {},
  live = [],
  env = process.env,
  configured = {},
} = {}) {
  const configuredProvider = String(configured.provider ?? '').trim();
  const configuredModel = String(configured.model ?? '').trim();
  if (configuredProvider !== '' && configuredModel !== '') {
    return { route: { provider: configuredProvider, model: configuredModel }, source: 'config' };
  }

  const fixedProvider = String(override?.api?.provider ?? '').trim();
  const fixedModel = String(override?.api?.model ?? '').trim();
  if (override?.api?.mode === 'fixed' && fixedProvider !== '' && fixedModel !== '') {
    return { route: { provider: fixedProvider, model: fixedModel }, source: 'panel-fixed' };
  }

  let inherited = { provider: '', model: '' };
  try {
    inherited = pickModel(live);
  } catch {
    // 活会话列表不可用不阻断后面的环境变量兜底。
  }
  const inheritedProvider = String(inherited?.provider ?? '').trim();
  const inheritedModel = String(inherited?.model ?? '').trim();
  if (inheritedProvider !== '' && inheritedModel !== '') {
    return { route: { provider: inheritedProvider, model: inheritedModel }, source: 'live-session' };
  }

  const envProvider = String(env?.MODEL_PROVIDER ?? '').trim();
  const envModel = String(env?.MODEL_NAME ?? '').trim();
  if (envProvider !== '' && envModel !== '') {
    return { route: { provider: envProvider, model: envModel }, source: 'environment' };
  }
  return { route: null, source: 'none' };
}

export function setup(ctx, config) {
  const hour = Number(config?.hour ?? 4);
  const minute = Number(config?.minute ?? 0);
  const dir = String(config?.dir || join(homedir(), '.koi', 'proposals'));
  const memoryFile = String(config?.memoryFile || join(homedir(), '.koi', 'memory.md'));
  const shortDir = String(config?.shortDir || join(homedir(), '.koi', 'short'));
  const chatDays = Number(config?.chatDays ?? 3);
  const chatLimit = Number(config?.chatLimit ?? 60);
  // 提案「会话」另由 override.proposal.sessionId 控制（relay 送达），这里只管模型。
  // 模型必须到每次调用时再解析：面板 fixed、活会话和环境变量都可能在运行中变化。
  const configuredRoute = {
    provider: String(config?.provider ?? '').trim(),
    model: String(config?.model ?? '').trim(),
  };
  // 不限制输出长度：一天一次，让它把话说完；截断比多花几个 token 更糟
  const maxTokens = config?.maxTokens == null ? undefined : Number(config.maxTokens);
  const capabilities = String(config?.capabilities ?? '');
  // 2026-11-08 codex review P3：优先用调用方传进来的路径
  const chatFile = String(
    config?.chatFile || join(homedir(), '.koi', 'chat.jsonl'),
  );
  // 2026-11-08 codex review P2：capabilities 缺失时提案模型看到「（未知）」，
  // 会提一些她根本不具备的能力。启动时把长度打出来，缺了一眼能看见。
  if (capabilities.trim() === '') {
    console.log('[koi-chat/iterate] ⚠️ capabilities 是空的——提案模型会以为你什么都不会');
  }
  let timer;

  function resolveRouteNow() {
    let override = {};
    try {
      override = JSON.parse(readFileSync(join(dirname(chatFile), 'ashu-config.json'), 'utf8'));
    } catch {
      // 没有或读不了面板配置时继续尝试活会话和环境变量。
    }
    let live = [];
    try {
      live = ctx.get?.('agents')?.list?.() ?? [];
    } catch {
      // 取不到活会话列表只影响"跟随面板模型"这一档，下一档还有环境变量兜底；
      // 所以这里不抛，但也不假装成功——空列表会让 C 段走"未配置"分支并记日志
      live = [];
    }
    return resolveIterateRoute({
      override,
      live,
      env: process.env,
      configured: configuredRoute,
    });
  }

  /** 调模型，返回文本 */
  async function call(prompt) {
    const { route, source } = resolveRouteNow();
    if (!route) {
      console.log('[koi-chat/iterate] 跳过：模型未配置（面板 fixed、活会话和环境变量都没有完整 provider/model）');
      return '';
    }
    let text = '';
    try {
      const request = {
        provider: route.provider,
        model: route.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      };
      if (maxTokens !== undefined) request.maxTokens = maxTokens;
      console.log(`[koi-chat/iterate] 模型路由：${source} → ${route.provider}/${route.model}`);
      // 2026-11-08 codex review P2：llm 不在 inject 里了（不然缺 llm 整个 chat 挂）。
      // 这里运行时取，取不到就让这一轮提案失败，不影响通道。
      const llm = ctx.get?.('llm') ?? ctx.llm;
      if (!llm || typeof llm.stream !== 'function') {
        throw new Error('llm 服务不可用，这轮提案跳过（通道不受影响）');
      }
      const stream = llm.stream(request);
      let failure = '';
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
        if (chunk?.type === 'finish' && ['error', 'aborted'].includes(chunk.reason?.kind)) {
          const f = chunk.reason?.failure ?? {};
          failure = `${chunk.reason.kind}${f.code ? `:${f.code}` : ''}${f.message ? ` ${f.message}` : ''}`;
        }
      }
      if (failure !== '') throw new Error(`模型调用失败：${failure}`);
    } catch (err) {
      console.log(`[koi-chat/iterate] 生成失败: ${err instanceof Error ? err.message : String(err)}`);
      return '';
    }
    return text.trim();
  }

  /**
   * 统一写进 chat：她就是通过这条通道跟运维方说话的。
   *
   * 2026-11-08 修两处：
   *  1. **上限 1200 → 4000**，和 dsh-koi-chat 的 append() 对齐。
   *     两处曾分头修改：chat 插件已是 4000，这里仍是 1200，长提案照样被截。
   *  2. **补 kind: 'request'**。不补的话 chat 插件读到的 kind 是 undefined，
   *     注入时不会标「（要回）」——提案是需要人回的，不该当闲聊。
   *
   * 为什么不直接调 chat 插件的 append()：两个插件各自独立加载，
   * 跨插件拿运行时对象要额外依赖，写文件更稳（格式对齐就行）。
   */
  function sendToSister(text, kind = 'request') {
    try {
      // 2026-11-08 codex review P3：**用传进来的 chatFile**，别再自己推导。
      // 原来从 `dir`（proposals 目录）推 `../chat.jsonl`，
      // 万一 proposals 和 chat.jsonl 不在同一层就会写到别处去。
      // 调用方（chat/index.js）已经把真实路径传进来了。
      const dataDir = dirname(chatFile);
      mkdirSync(dataDir, { recursive: true });
      // 2026-11-08（codex 审计）：不要在发送时默默切。
      // 提案在一行字中间被切断，模型会误以为已经写完。
      // 超长就明确标出来，说明还有下半段。
      const full = String(text);
      const MAX = 4000;
      const body = full.length > MAX
        ? `${full.slice(0, MAX - 60)}\n\n（太长，后面 ${full.length - MAX + 60} 字被截断）`
        : full;
      const r = storeAppend(chatFile, { from: 'koi', text: body, kind });
      if (!r.ok) throw new Error(r.error);
      console.log('[koi-chat/iterate] 已发到 chat');
    } catch (err) {
      console.log(`[koi-chat/iterate] 发送失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 生成一次需求提案 */
  async function generate(now = new Date()) {
    const memory = readMemory(memoryFile);
    const chats = readChats(shortDir, { days: chatDays, limit: chatLimit });
    const past = readPastTitles(chatFile, dir); // 2026-11-08 codex P3：用配置的路径
    console.log(
      `[koi-chat/iterate] 输入：记忆 ${memory.split('\n').length} 行 / 聊天 ${chats.split('\n').length} 行 / 旧提案 ${past.split('\n').length} 条`,
    );
    if (chats === '' && memory === '') {
      console.log('[koi-chat/iterate] 没有材料，今天不提');
      return;
    }
    const text = await call(buildProposalPrompt({ persona: readPersona(), memory, chats, past, capabilities }));
    if (text === '') return;
    /**
     * **记一笔"今天没提"**。
     * 光看提案数量分不清"真的发现问题"还是"被要求交作业"，
     * 有了这份账才能看比例（提案 vs NONE）。
     */
    const logRun = (kind, n) => {
      try {
        const f = join(dir, 'iterate-log.jsonl');
        appendFileSync(f, `${JSON.stringify({ at: now.getTime(), kind, n, day: dayName(now) })}\n`, 'utf8');
      } catch (err) {
        console.log(`[koi-chat/iterate] 记录失败（不影响提案）：${err instanceof Error ? err.message : String(err)}`);
      }
    };
    if (/^NONE$/i.test(text)) {
      console.log('[koi-chat/iterate] 模型判断没有真问题，今天不提');
      logRun('none', 0);
      return;
    }
    const { text: fresh, skipped } = dropRepeats(text, past);
    if (skipped.length > 0) console.log(`[koi-chat/iterate] 跳过重复需求：${skipped.join('；')}`);
    if (fresh === '') {
      console.log('[koi-chat/iterate] 今天提的全是旧需求，未写入');
      return;
    }
    const nProposals = (fresh.match(/^##\s*(?:需求|提案)[：:]/gm) ?? []).length;
    logRun('proposal', nProposals);
    sendToSister(`【今日需求 ${dayName(now)}】\n${fresh}`);
  }

  /** 回答一个问题（按需提问） */
  async function ask(question, now = new Date()) {
    const text = await call(buildAnswerPrompt(question, readPersona(), readMemory(memoryFile)));
    if (text === '') return;
    // 回答不是新请求，别占「要回」的额度（2026-11-08 codex review P3）
    sendToSister(`【回答】${question}\n${text}`, 'chat');
  }

  /** 排下一次 04:00 */
  function scheduleNext() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    console.log(`[koi-chat/iterate] 下次提案 ${next.toLocaleString('zh-CN', { hour12: false })}`);
    timer = setTimeout(() => {
      void generate().finally(() => scheduleNext());
    }, next.getTime() - now.getTime());
    if (typeof timer.unref === 'function') timer.unref();
  }

  ctx.effect(() => {
    if (process.env.QQBOT_ITERATE_NOW === '1') {
      const t = setTimeout(() => {
        void generate();
      }, 4000);
      if (typeof t.unref === 'function') t.unref();
    }
    if (process.env.QQBOT_ASK) {
      const question = process.env.QQBOT_ASK;
      const t = setTimeout(() => {
        void ask(question);
      }, 4000);
      if (typeof t.unref === 'function') t.unref();
    }
    scheduleNext();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, 'koi-chat.iterate.timer');
}
