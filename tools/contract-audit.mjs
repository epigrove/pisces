#!/usr/bin/env node
/**
 * 契约核对（B7，2026-11-24）
 *
 * 为什么有它
 * ----------
 * 三类反复出现的接缝故障：
 *   - 写了，没接上（says.apply 在但没进 bundles）
 *   - 存了，没送到（self 上限 20，最早那条被挤掉）
 *   - 有接口，没通知调用方（静默词是哪个，提示词里从没写过）
 *
 * 三类故障都不报错，最终表现为"机制没有生效"。
 *
 * 所以：**每条对外承诺的机制，必须找得到一条「生效证据」**。
 * 找不到证据的，就是没接上——不管代码写得多完整。
 *
 * 证据只从**运行路径**取，不从源码取：
 *   - 提示词：会话里最后一条 `system/message` 的正文（真的是模型看到的那份）
 *   - 工具：`developer/message` 的 tool-addition + `request/header` 的工具清单
 *   - 插件：启动日志里的 ready 行
 *
 * 用法：
 *   KOI_HOME=/path/to/agent node tools/contract-audit.mjs
 *   ... --json
 *   ... --prompt-file <文件>   # 用指定文本代替运行路径（调试用，不算数）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KOI = process.env.KOI_HOME ?? REPO;
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const promptFileArg = args.indexOf('--prompt-file');
const promptFile = promptFileArg === -1 ? '' : String(args[promptFileArg + 1] ?? '');

// ── 契约表 ───────────────────────────────────────────────
// 每条都要有：id / 承诺了什么 / 证据在哪里 / 期望看到什么
const CONTRACTS = [
  // 提示词里必须真的出现的东西
  { id: 'silence-token', kind: 'prompt', expect: '#静默#', why: '她得知道自己能这样沉默；2026-11-17 那次就是"有接口没告诉她"' },
  { id: 'aside-rule', kind: 'prompt', expect: '括号里的东西', why: '底稿不外流（她 11-21 定的底线）' },
  { id: 'image-three-branch', kind: 'prompt', expect: '有没有一件只有我看了这张图', why: '带图三支（她 11-23 改的版本）' },
  { id: 'no-fake-visual', kind: 'prompt', expect: '编一个假的画面', why: '不许为了过审编画面（她 11-23 补的）' },
  /**
   * 2026-11-24 codex review P2：这条规则**两份提示词都要有**。
   * 第一版只查整段文字里出现过，结果群聊那份还是旧判据（按字数）也算通过——
   * 一侧改了、另一侧没改，正是这个脚本该抓的。
   */
  { id: 'quote-rule', kind: 'prompt', scope: 'both', expect: '核的是字，不是印象', why: '引号里的话必须核字，不是核印象（她 11-25 定的）' },
  { id: 'pending-review', kind: 'prompt', expect: '救回来的成本低的', why: '待重判按"代价"判，不按时间（她 11-24 定的）' },
  { id: 'short-reply', kind: 'prompt', scope: 'both', expect: '有没有把话交回来', why: '接短话按意图不按字数（她 11-24 纠正）；两份提示词都要有' },
  { id: 'exit-rule', kind: 'prompt', expect: '别老用同一句收尾', why: '退场语重复会被丢掉' },
  /**
   * 记忆段**不在**这里判"注入内容"：--dump-config 只 dump 配置值，
   * 注入段是运行时拼的。2026-11-24 第一版拿「记忆」两个字去匹配，
   * 结果匹配到的是人设里那句"把口径写进记忆"——假通过，比不查更糟。
   * 所以这里只查"段注册了没有"，注入是否真的发生交给体检第 9 项（注入自检）。
   */
  { id: 'memory-section-registered', kind: 'log', expect: '注入段：koi:memory', why: '记忆段注册了（是否真注入由体检第 9 项管）' },

  // 工具：应该在的 / 应该没了的
  { id: 'tool:note_save', kind: 'tool', expect: 'note_save', present: true, why: '笔记本' },
  { id: 'tool:remember_person', kind: 'tool', expect: 'remember_person', present: true, why: '记人' },
  { id: 'tool:memory_add', kind: 'tool', expect: 'memory_add', present: true, why: '记自己' },
  { id: 'tool:keep_image', kind: 'tool', expect: 'keep_image', present: true, why: '收图' },
  { id: 'no:ask_to_change_core', kind: 'tool', expect: 'ask_to_change_core', present: false, why: '2026-11-21 删掉（零调用且无读者）' },
  { id: 'no:request_tuning', kind: 'tool', expect: 'request_tuning', present: false, why: '2026-11-21 删掉' },

  // 插件必须在启动日志里报过到
  { id: 'plugin:media', kind: 'log', expect: 'koi-media ready', why: '图片/视频/识图转述' },
  { id: 'plugin:vision-feed', kind: 'log', expect: '识图转述已启用', why: '带图消息自动识图' },
  { id: 'plugin:memory', kind: 'log', expect: 'koi-memory] v', why: '记忆' },
  { id: 'plugin:lexicon', kind: 'log', expect: 'koi-lexicon] ready', why: '语料/人' },
  { id: 'plugin:audit', kind: 'log', expect: 'koi-audit] ready', why: '外发审计' },
  { id: 'plugin:gate', kind: 'log', expect: 'koi-gate] 已启用', why: '出入口判定（2026-11-24 三包合并后的唯一入口）' },
  { id: 'gate:deps', kind: 'log', expect: '[selftalk] 已启用', why: 'gate 的入口门控被通道真的调到了（不只是装上了）' },
  { id: 'gate:send-log', kind: 'log', expect: '出站投递日志已装上', why: 'B3：出站结果留痕（真的发没发得出去，得看 [send] 行）' },
];

// ── 从运行路径取证据 ──────────────────────────────────────
function latestSessionFiles(limit = 3) {
  const root = join(KOI, '.dsh-home', 'sessions');
  if (!existsSync(root)) return [];
  const out = [];
  for (const dir of readdirSync(root)) {
    const p = join(root, dir);
    if (!statSync(p).isDirectory()) continue;
    for (const sub of readdirSync(p)) {
      const f = join(p, sub, 'session.v4.jsonl.zstd');
      if (existsSync(f)) out.push({ f, mtime: statSync(f).mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((x) => x.f);
}

function readLines(file) {
  try {
    return zstdDecompressSync(readFileSync(file)).toString('utf8').trim().split('\n');
  } catch {
    return [];
  }
}

/**
 * 她那一侧真正会被注入的提示词。
 *
 * 2026-11-24 第一版写错过：直接取"最新会话的 system/message"，
 * 取到的是**对话通道那个参考 agent 的提示词**（5044 字），不是她的人设（7564 字）——
 * 于是五条规则全报"没接上"，全是假警报。
 *
 * 现在用 `dsh --dump-config` 合出来的文本：那是 DSH 加载时真正会注入的那一份
 * （不是源码字符串）。ops 会话只用来做交叉参考。
 */
function composedConfigText() {
  try {
    return execFileSync('dsh', ['--dump-config', '--profile', 'koi'], {
      env: { ...process.env, HOME: KOI, DSH_HOME: join(KOI, '.dsh-home') },
      encoding: 'utf8',
      timeout: 60000,
    });
  } catch (err) {
    return `（dump-config 失败：${err instanceof Error ? err.message : String(err)}）`;
  }
}

/** 从 dump-config 输出里切出一段 prompt 块（`directPrompt: >` / `groupPrompt: >` 起，到同级键止） */
function promptBlock(text, key) {
  const start = text.indexOf(`${key}:`);
  if (start === -1) return '';
  const rest = text.slice(start);
  const nextKey = rest.slice(key.length + 1).search(/\n\s{0,6}[a-zA-Z]+:/);
  return nextKey === -1 ? rest : rest.slice(0, key.length + 1 + nextKey);
}

function lastPromptText() {
  if (promptFile !== '') return readFileSync(promptFile, 'utf8');
  return composedConfigText();
}

/**
 * 她那一侧真实可见的工具名——**只取最近一次快照**。
 *
 * 2026-11-24 第一版把所有会话的 tool 记录求并集，结果 11-20 的旧快照里
 * 还带着已删的 `ask_to_change_core`，于是"应该没有它"这条永远失败。
 * 旧快照不是证据，是历史。
 */
function observedTools(files = latestSessionFiles(8)) {
  let best = { at: 0, names: new Set() };
  for (const file of files) {
    for (const line of readLines(file)) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e?.type !== 'request/header') continue;
      const at = Number(e.time ?? 0);
      if (at <= best.at) continue;
      const names = new Set();
      for (const t of e.data?.header?.tools ?? []) if (t?.name) names.add(String(t.name));
      // 空快照也要采纳：工具全挂时，退回旧快照会假装通过
      best = { at, names };
    }
  }
  return best;
}

/**
 * 启动日志——**只取最后一次启动那一段**。
 *
 * 2026-11-24 codex review P2：koi.log 是追加写的（`>>`），
 * 插件在**任何一次**历史启动里报过 ready 就永远算通过；
 * 后来插件被禁用/加载失败，这里还会假绿。老日志不是证据，是历史。
 *
 * 分段标记是 `Bot ready`（每次启动一行，在插件 ready 之后）。
 */
/** 进程在不在跑——崩溃/没起来时，日志里的 ready 都是上一次的，不能算证据 */
function processAlive() {
  try {
    execFileSync('pgrep', ['-f', 'dsh.*koi'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function logText() {
  const f = join(KOI, 'koi.log');
  if (!existsSync(f)) return '';
  const all = readFileSync(f, 'utf8');
  const marks = [];
  let i = all.indexOf('Bot ready');
  while (i !== -1) {
    marks.push(i);
    i = all.indexOf('Bot ready', i + 1);
  }
  if (marks.length === 0) return '';
  const start = marks.length >= 2 ? marks[marks.length - 2] : 0;
  return all.slice(start);
}

// ── 核对 ─────────────────────────────────────────────────
const prompt = lastPromptText();
const snapshotFiles = latestSessionFiles(8);
const layoutChanged = snapshotFiles.length === 0;
const snapshot = observedTools(snapshotFiles);
const tools = snapshot.names;
const snapshotAgeH = snapshot.at ? (Date.now() - snapshot.at) / 3600000 : -1;
/** 快照超过 24 小时 = 过期，工具这类判断只能标"未测"，不能算通过也不能算失败 */
const snapshotStale = snapshotAgeH < 0 || snapshotAgeH > 24;
const logs = logText();
const alive = processAlive();

if (prompt === '') {
  const msg = '取不到运行路径上的系统提示词（没有可读会话）——这项核对不算通过';
  if (asJson) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error(msg);
  process.exit(2);
}

const results = CONTRACTS.map((c) => {
  let hit = false;
  let detail = '';
  if (c.kind === 'prompt') {
    if (c.scope === 'both') {
      const d = promptBlock(prompt, 'directPrompt');
      const g = promptBlock(prompt, 'groupPrompt');
      const inD = d.includes(c.expect);
      const inG = g.includes(c.expect);
      hit = inD && inG;
      detail = `私聊${inD ? '有' : '没有'} / 群聊${inG ? '有' : '没有'}`;
    } else {
      hit = prompt.includes(c.expect);
      detail = hit ? '提示词里有' : '提示词里没有';
    }
  } else if (c.kind === 'tool') {
    if (snapshotStale) return { ...c, ok: null, detail: `工具快照过期（${snapshotAgeH < 0 ? '没有快照' : `${snapshotAgeH.toFixed(1)} 小时前`}），未测` };
    const has = tools.has(c.expect);
    hit = c.present === true ? has : !has;
    detail = has ? '工具清单里有' : '工具清单里没有';
  } else {
    if (!alive) return { ...c, ok: null, detail: '进程没在跑，日志里的 ready 是上一次的' };
    hit = logs.includes(c.expect);
    detail = hit ? '启动日志里报过到' : '启动日志里没找到';
  }
  return { ...c, ok: hit, detail };
});

const failed = results.filter((r) => r.ok === false);
const unknown = results.filter((r) => r.ok === null);
const unverified = Math.max(unknown.length, layoutChanged ? 1 : 0);
const layoutDetail = '找不到会话快照（sessions/*/*/session.v4.jsonl.zstd）；宿主布局可能变了，工具类证据未测';

if (asJson) {
  console.log(JSON.stringify({
    ok: layoutChanged ? null : failed.length > 0 ? false : unverified > 0 ? null : true,
    failed: failed.map((r) => r.id),
    unknown: unknown.map((r) => r.id),
    unverified,
    layoutChanged,
    layoutDetail: layoutChanged ? layoutDetail : '',
    promptChars: prompt.length,
    observedTools: [...tools].sort(),
    results,
  }, null, 2));
  // --json 的 stdout 必须是**干净的一个 JSON 文档**：提示走 stderr
  if (unknown.length > 0) console.error(`${unknown.length} 条证据过期，未测（不算通过）。`);
  if (layoutChanged) console.error(layoutDetail);
  process.exit(failed.length > 0 ? 1 : unverified > 0 ? 2 : 0);
}

console.log(`契约核对（证据取自运行路径：提示词 ${prompt.length} 字 / 工具 ${tools.size} 个 / 启动日志）`);
console.log('');
for (const r of results) {
  console.log(`${r.ok === true ? '✅' : r.ok === null ? '❔' : '❌'} ${r.id.padEnd(22)} ${r.detail}　— ${r.why}`);
}
console.log('');
if (failed.length === 0 && unknown.length === 0) {
  console.log('全部有生效证据。');
} else {
  console.log(`${failed.length} 条**找不到生效证据** = 没接上（不是代码没写，是没到她那一侧）：`);
  for (const r of failed) console.log(`  - ${r.id}：期望「${r.expect}」，${r.detail}`);
}
if (unknown.length > 0) console.log(`${unknown.length} 条证据过期，**未测**（不算通过）。`);
if (layoutChanged) console.log(layoutDetail);
process.exit(failed.length > 0 ? 1 : unverified > 0 ? 2 : 0);
