/**
 * dsh-ashu-relay — ashu这边读koi消息的那一端（2026-11-08）
 *
 * 为什么要有这个东西
 * ------------------
 * `dsh-koi-chat` 装在koi的 profile 里，它只轮询**一个方向**：
 *
 *     from === 'ashu'   →  提醒koi「ashu找你说话了」
 *
 * 反方向（对端发给本端）**没有任何机制**。本端甚至不知道对端已经说过话；
 * 实测曾因此积压数小时，原因都是这边没有轮询。
 *
 * 体检中的未回请求检查能发现积压，但只有**主动跑体检**时才看得见。
 *
 * 这个插件补的就是这一端：定期看 chat.jsonl，发现对端的未读消息就
 * 往本端会话里塞一条 followup —— 和 chat 插件反方向投递，机制相同。
 *
 * 设计约束
 * --------
 * 1. **只在真有消息时才叫**，没消息什么都不做（不烧 token）
 * 2. 游标存在本地，重启不会重复提醒
 * 3. 叫不醒（没有活会话）就等到下一轮，不硬造会话——我这边没有
 *    「自建会话」的语义，硬开一个会变成没人看的孤儿会话
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
// 2026-11-08：读 chat.jsonl 统一走koi那边的 chat-store。
// 跨 profile 但同一台机器，直接 import 文件就行——**代码复用不等于进程合并**，
// 这个插件必须留在ashu的进程里，因为它要 followup 到ashu的会话。
/**
 * 2026-11-13 **review 抓到的**：这两行原来是写死的绝对路径
 * `../../plugins/...`——违反我自己定的两条：
 *   ① 不写死绝对路径（换机器就废）
 *   ② 跨包只走包名（不写 ../../ 或 /home/...）
 *
 * 改成包名，由 profile 的 node_modules 解析（web profile 里 link: 到 koi 的源码）。
 * 副作用是个好处：`KOI_HOME` 现在真正统一了——不再「chatFile 跟着 KOI_HOME、import 不跟」。
 */
import { readAllSafe as storeReadAllSafe } from 'dsh-koi-chat/lib/chat-store.js';

/**
 * 挑一个活着的会话（2026-11-16 改为自包含）。
 *
 * 原来 import 外部包，先是 dsh-pisces-session（已删除），改成 dsh-pisces-config（另一个包）
 * 后又从插件真实路径解析不到——插件是 link 进来的，bare import 按真实路径找。
 * 而现在宿主侧的面板已改名 dsh-pisces-panel，共享库仍叫 dsh-pisces-config；
 * relay 从插件真实路径解析时仍拿不到它，所以这里不再依赖外部包。
 *
 * 所以这里只留最小实现：跳过子 agent，钉住的优先，否则取最后有人说话的。
 */
function pickAgentFor(list, { sessionId = '', log = () => {} } = {}) {
  const all = (Array.isArray(list) ? list : []).filter(
    (a) => a && typeof a.followup === 'function' && Number(a?.session?.header?.delegationDepth ?? 0) === 0,
  );
  if (all.length === 0) { log('没有可用会话'); return null; }
  const idOf = (a) => String(a?.session?.id ?? a?.id ?? '');
  if (sessionId) {
    const pinned = all.find((a) => idOf(a) === sessionId);
    if (pinned) return pinned;
    log(`钉住的会话 ${sessionId} 不在活列表里，退回自动挑`);
  }
  // 最后有人说话的优先。
  // 2026-11-16 codex review P1：上一版读 `session.events` 和 `e.at`，两样都不存在
  // （事件要走 snapshotEvents()/ownEvents()，时间字段是 time），于是所有人的得分都是 0，
  // sort 稳定 —— 实际永远取列表第一个（最老那个），留言会投进没人看的会话。
  // 只有 user 是人真的在说话（2026-11-16 本机实测 12 种 kind）；白名单，避免框架新增时漏判
  const HUMAN = new Set(['user']);
  const SELF = ['koi-relay-', 'ashu-relay-', 'chat-', 'heartbeat-'];
  const eventsOf = (a) => {
    try {
      const sess = a?.session;
      if (typeof sess?.snapshotEvents === 'function') return sess.snapshotEvents();
      if (typeof sess?.ownEvents === 'function') return sess.ownEvents();
    } catch { /* 拿不到就当没有 */ }
    return [];
  };
  const lastHuman = (a) => {
    const ev = eventsOf(a);
    if (!Array.isArray(ev)) return 0;
    for (let i = ev.length - 1; i >= 0; i -= 1) {
      const e = ev[i];
      if (e?.type !== 'user/message') continue;
      const kind = e.data?.source?.kind;
      if (kind !== undefined && !HUMAN.has(kind)) continue;
      const id = String(e.data?.id ?? e.id ?? '');
      if (SELF.some((p) => id.startsWith(p))) continue;
      return Number(e.time ?? 0);
    }
    return 0;
  };
  return all.slice().sort((x, y) => lastHuman(y) - lastHuman(x))[0] ?? null;
}

import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const name = 'ashu-relay';
/** 要 agents 才能往会话里塞消息 */
export const inject = ['agents'];

const KOI_HOME = process.env.KOI_HOME ?? join(homedir(), 'koi');
/** 对面那个 agent 的名字：部署方配，没配就用包名里的中性词 */
function peerName() {
  return String(process.env.KOI_PEER_NAME ?? '') || 'koi';
}

const DEFAULTS = {
  chatFile: join(KOI_HOME, '.koi', 'chat.jsonl'),
  // 2026-11-12 改名：koi-relay → ashu-relay。状态文件跟着改，
  // 但老文件名里存着「已经提醒过哪些」的游标——丢了会把历史消息重放一遍（11-08 刷屏那次）。
  // 所以启动时做一次性搬运，见 migrateLegacyState()。
  stateFile: join(homedir(), '.dsh', '.ashu-relay-state.json'),
  legacyStateFile: join(homedir(), '.dsh', '.koi-relay-state.json'),
  minutes: 3,
};

function log(msg) {
  console.log(`[ashu-relay] ${msg}`);
}

export function apply(ctx, config = {}) {
  const chatFile = String(config?.chatFile ?? DEFAULTS.chatFile);
  const stateFile = String(config?.stateFile ?? DEFAULTS.stateFile);
  const minutes = Math.min(Math.max(Number(config?.minutes ?? DEFAULTS.minutes) || 3, 1), 60);
  /**
   * 回复固定送到哪个会话（2026-11-12 主人要求）。
   *
   * 原来 `findAgent()` 取「最近活跃的会话」——这有两个坑：
   *   1. 你一开新窗口，她的回复就跟着跑到新窗口去了
   *   2. 我派子代理干活时，子代理会话会变成「最近活跃」，
   *      她的回复直接落进一个你根本没在看的会话里（今天真发生了）
   *
   * 配了 sessionId 就固定送那里；没配/找不到就退回原来的「最近活跃」。
   */
  // 2026-11-14 v2：提案会话 pin 也可来自koi配置面板（koi/.koi/ashu-config.json 的 proposal.sessionId）。
  // 显式 config.sessionId 优先；面板 pin 次之；都没有则跟随「人最后说话」。
  const pinnedSessionId = String(config?.sessionId ?? '').trim();
  // review P1：pin 必须**每次投递时**重读，不能在加载时读一次——否则面板保存后不生效。
  function readOvPin() {
    try {
      return String(JSON.parse(readFileSync(join(KOI_HOME, '.koi', 'ashu-config.json'), 'utf8'))?.proposal?.sessionId ?? '').trim();
    } catch { return ''; }
  }
  const currentPin = () => pinnedSessionId || readOvPin();

  /**
   * 一次性把旧状态文件搬过来（2026-11-12 插件改名 koi-relay → ashu-relay）。
   *
   * 不搬的后果不是「少一个文件」，是**把历史消息全部重放一遍**：
   * 状态里存的是「已经提醒过哪些 id」，空了就当全是未读。
   * 2026-11-08 已经踩过一次（31 条老消息一次性灌进会话），所以这里宁可多写几行。
   */
  (function migrateLegacyState() {
    try {
      const legacy = String(config?.legacyStateFile ?? DEFAULTS.legacyStateFile);
      if (!existsSync(legacy)) return;

      /**
       * 2026-11-13 **第二次 review 抓到**：上面这段只在「新状态不存在」时才搬。
       * 可本机 23:04 那次是用**旧代码**迁的（只 copy、没改名），新状态已经存在，
       * 所以旧文件 forever 留在这儿 —— 哪天删了新状态想重置，它又会把旧状态复活。
       *
       * 现在分两种情况：
       *   新状态不存在  → 搬过去（真的迁移）
       *   新状态已存在  → 只把旧文件改名归档（本机的历史遗留，清掉复活隐患）
       */
      if (existsSync(stateFile)) {
        renameSync(legacy, legacy + '.migrated');
        console.log('[ashu-relay] 旧状态文件归档为 .migrated（新状态已存在，不覆盖）');
        return;
      }
      copyFileSync(legacy, stateFile);
      /**
       * 2026-11-13 **review 抓到的坑**：只 copy 不删，等于迁移「不是一次性的」。
       * 哪天你手动删掉 .ashu-relay-state.json 想重置（README 里就写了可以删），
       * 下次启动又会把旧状态搬回来 —— 于是已提醒过的消息重新变成未读，重放一遍。
       * 所以搬完就把源文件改名成 .migrated，世界就干净了。
       */
      try {
        renameSync(legacy, legacy + '.migrated');
        console.log('[ashu-relay] 已把旧状态迁到 ' + stateFile + '（源文件改名 .migrated）');
      } catch (err) {
        console.log('[ashu-relay] 已迁状态，但旧文件没删掉（下次可能复活）：' + (err instanceof Error ? err.message : String(err)));
      }
    } catch (err) {
      console.log('[ashu-relay] ⚠️ 旧状态迁移失败（会重放历史）：' + (err instanceof Error ? err.message : String(err)));
    }
  })();

  /**
   * v2 状态是单调行水位：chat.jsonl 只追加，处理到哪一行就记到哪里。
   * 不再保存最近 500 个 id —— 旧实现超过 500 条后会从窗口外重放。
   */
  let lastLine = -1;
  let lastId = '';
  let legacySeen = new Set();
  let stateStatus = 'missing';
  let skipFirstCheck = false;
  let needsBaseline = false;
  let corruptRaw = '';
  let retryAt = 0;
  let retryDelayMs = 0;

  function scheduleSaveRetry(fromLine, toLine) {
    const base = Math.max(30_000, minutes * 60_000);
    retryDelayMs = retryDelayMs === 0 ? base : Math.min(base * 8, retryDelayMs * 2);
    retryAt = Date.now() + retryDelayMs;
    log(
      `未提交水位 ${fromLine} → ${toLine}：状态保存失败；`
      + `${Math.ceil(retryDelayMs / 60_000)} 分钟后仍从 ${fromLine} 重试（宁可重复，不丢积压）`,
    );
  }

  function resetSaveRetry() {
    retryAt = 0;
    retryDelayMs = 0;
  }

  function load() {
    if (!existsSync(stateFile)) {
      stateStatus = 'missing';
      return;
    }
    let rawText = '';
    try {
      rawText = readFileSync(stateFile, 'utf8');
      const raw = JSON.parse(rawText);
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('顶层不是对象');
      if (Number.isInteger(raw.lastLine) && raw.lastLine >= -1) {
        lastLine = raw.lastLine;
        lastId = String(raw.lastId ?? '');
        stateStatus = 'ok';
        return;
      }
      const seen = Array.isArray(raw.seen) ? raw.seen.map(String) : [];
      lastId = String(raw?.lastId ?? '');
      if (lastId === '' && seen.length === 0) throw new Error('没有 lastLine/lastId/seen 可用');
      legacySeen = new Set(seen);
      stateStatus = 'legacy';
    } catch (err) {
      stateStatus = 'corrupt';
      corruptRaw = rawText;
      lastId = '';
      log(`状态文件坏了：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function save(nextLine = lastLine, nextId = lastId) {
    const tmp = `${stateFile}.tmp-${process.pid}-${randomUUID()}`;
    let fd;
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      fd = openSync(tmp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ version: 2, lastLine: nextLine, lastId: nextId }, null, 2), 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, stateFile);
      return true;
    } catch (err) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* 已关闭或打开失败 */ }
      }
      try { unlinkSync(tmp); } catch { /* 临时文件可能还没创建 */ }
      log(`状态保存失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  function commitWaterline(nextLine, nextId) {
    if (save(nextLine, nextId)) {
      lastLine = nextLine;
      lastId = nextId;
      resetSaveRetry();
      return true;
    }
    scheduleSaveRetry(lastLine, nextLine);
    return false;
  }

  function readMessages() {
    return storeReadAllSafe(chatFile);
  }

  function tailLineOf(all) {
    const last = all[all.length - 1];
    return last && Number.isInteger(last._line) ? last._line : -1;
  }

  function setBaseline(all, sideEffect) {
    const nextLine = tailLineOf(all);
    const nextId = String(all[all.length - 1]?._id ?? '');
    if (sideEffect) return commitWaterline(nextLine, nextId);
    lastLine = nextLine;
    lastId = nextId;
    return true;
  }

  function backupCorruptState() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${stateFile}.corrupt-${stamp}-${randomUUID()}`;
    try {
      copyFileSync(stateFile, backup);
      log(`坏状态已备份：${backup}`);
      return backup;
    } catch (err) {
      log(`坏状态备份失败（原文件保留）：${err instanceof Error ? err.message : String(err)}`);
      return '';
    }
  }

  /**
   * 从坏文件里尽量捞出之前写过的水位。能找回 lastId/lastLine 就只重放它之后；
   * 完全找不回时从 -1 开始重放全部。**绝不拿当前尾部当基线**，那会把积压永久跳过。
   */
  function recoveryAnchor(all) {
    const ids = [];
    const idRe = /"lastId"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    for (const match of corruptRaw.matchAll(idRe)) {
      try {
        ids.push(JSON.parse(`"${match[1]}"`));
      } catch {
        // 坏转义就当这个候选无效。
      }
    }
    for (let i = ids.length - 1; i >= 0; i -= 1) {
      const id = String(ids[i]);
      if (id === '') continue;
      const hit = all.findLast((m) => m._id === id);
      if (hit) return { line: hit._line, id: hit._id, label: `消息 id ${id}（第 ${hit._line} 行）` };
    }

    const lineRe = /"lastLine"\s*:\s*(-?\d+)/g;
    const lines = [...corruptRaw.matchAll(lineRe)]
      .map((match) => Number(match[1]))
      .filter((line) => Number.isInteger(line) && line >= -1 && line <= tailLineOf(all));
    if (lines.length > 0) {
      const line = Math.max(...lines);
      const hit = all.find((m) => m._line === line);
      return {
        line,
        id: String(hit?._id ?? ''),
        label: `行水位 ${line}${hit ? `（${hit._id}）` : ''}`,
      };
    }
    return { line: -1, id: '', label: '从头重放（-1）' };
  }

  /**
   * 2026-11-12：**不再自己挑会话。**
   *
   * 这里原来有一份「最近活跃优先」的实现，和 koi 那边的 chat、heartbeat
   * 一模一样（三份拷贝）。共同约束是：
   *   凡是「自动挑一个」的地方，早晚都会挑到没人看的那一个。
   *
   * 判定已经收口到 `dsh-koi-session`：只认真人打的字、排除子代理、可钉住。
   * 这边只负责「读 chat.jsonl → 塞进那个会话」。
   */
  function findAgent() {
    try {
      const agents = ctx.get('agents');
      return pickAgentFor(agents?.list?.(), { sessionId: currentPin(), log });
    } catch (err) {
      // 2026-11-12：原来这里是空 catch 直接返回 null——
      // 「挑不到会话」和「挑的时候抛错了」看起来一模一样。
      log(`挑会话出错：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** 会话 id，只用于日志 */
  const idOf = (a) => String(a?.session?.id ?? a?.id ?? '');

  async function check() {
    if (Date.now() < retryAt) return;
    const report = readMessages();
    if (!report.readable) {
      log(`会话记录暂不可读，本轮跳过（游标保持 ${lastLine}）：${report.error}`);
      return;
    }
    const all = report.messages;
    const tailLine = tailLineOf(all);
    if (needsBaseline) {
      if (setBaseline(all, true)) {
        needsBaseline = false;
        log(`会话记录恢复可读，以当前尾部 ${lastLine} 初始化水位，不重放历史`);
      }
      return;
    }
    // 文件被截断/轮换后，旧水位已经不可能再出现。先重置到新尾部，
    // 本轮不告警，避免把新文件里的历史整段当成未读。
    if (tailLine < lastLine) {
      log(`检测到水位回退（${lastLine} → ${tailLine}），按当前尾部重置基线`);
      setBaseline(all, true);
      return;
    }

    // 她发的、我没看过的
    // 2026-11-16 **只收发给我的**。
    // 她回主人（to: 'master'）的消息原来也会被投到这里——主人跟她的对话
    // 全漏进我的会话，我还得替主人回。缺 to 的历史消息按「给我」处理。
    const unread = all.filter((m) => m.from === 'koi' && m._line > lastLine
      && (m.to === undefined || m.to === '' || m.to === 'ashu'));
    if (unread.length === 0) {
      if (tailLine > lastLine) {
        commitWaterline(tailLine, String(all[all.length - 1]?._id ?? ''));
      }
      return;
    }

    const agent = findAgent();
    if (!agent) {
      // 没有活会话：不硬造。等她下次在群里说话时会开新会话，那时候再看。
      log(`有 ${unread.length} 条未读，但没有活会话，等下一轮`);
      return;
    }

    const body = unread
      .map((m) => {
        const tag = m.kind === 'request' ? '（要回）' : '';
        return `【${peerName()}${tag}】${m.text}`;
      })
      .join('\n\n');

    try {
      agent.followup(
        Object.freeze({
          id: `ashu-relay-${Date.now()}`,
          role: 'user',
          content: [{ type: 'text', text: `${peerName()}在对话通道里给你留了话（${unread.length} 条）：\n\n${body}\n\n（回她：node ${join(KOI_HOME, 'ops', 'say-to-koi.mjs')} 加要发的话；要她回就加 --request。别手写 chat.jsonl——没签名的会被她标成「未署名」。她不是常驻的，靠心跳唤醒。）` }],
          source: Object.freeze({ kind: 'user' }),
        }),
      );
      // 只有同步 followup 确认入队、且水位真正落盘后才报“已提醒”。
      // 保存失败时 commitWaterline 保留旧水位并安排退避重试，宁可重复也不跳过。
      if (commitWaterline(tailLine, String(all[all.length - 1]?._id ?? ''))) {
        log(`已提醒 ${unread.length} 条`);
      }
    } catch (err) {
      log(`提醒失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load();

  // 首次运行：以当前文件尾部为基线，只提醒之后的新消息。
  if (stateStatus === 'missing') {
    const report = readMessages();
    if (!report.readable) {
      skipFirstCheck = true;
      needsBaseline = true;
      log(`初始化水位失败：会话记录暂不可读，不写入新基线（${report.error}）`);
    } else {
      const all = report.messages;
      const saved = setBaseline(all, true);
      skipFirstCheck = saved;
      log(saved
        ? `初始化水位 ${lastLine}：把现有 ${all.length} 条作为基线，本轮不告警`
        : '初始化水位保存失败；下一轮重试，期间不会把现有历史当成新消息');
    }
  } else if (stateStatus === 'corrupt') {
    backupCorruptState();
    const report = readMessages();
    if (!report.readable) {
      skipFirstCheck = true;
      needsBaseline = true;
      log(`坏状态恢复延后：会话记录暂不可读，不写新基线（${report.error}）`);
    } else {
      const anchor = recoveryAnchor(report.messages);
      const saved = commitWaterline(anchor.line, anchor.id);
      log(
        `坏状态恢复锚点：${anchor.label}`
        + (saved ? '；将从锚点之后重新检查' : '；锚点保存失败，仍保留旧水位并退避重试'),
      );
    }
  } else if (stateStatus === 'legacy') {
    const report = readMessages();
    if (!report.readable) {
      skipFirstCheck = true;
      needsBaseline = true;
      log(`旧状态迁移跳过：会话记录暂不可读，游标保持不变（${report.error}）`);
    } else {
      const all = report.messages;
      let anchor = lastId !== '' ? all.findLast((m) => m._id === lastId) : undefined;
      if (!anchor && legacySeen.size > 0) {
        anchor = all.findLast((m) => legacySeen.has(m._id));
      }
      if (anchor) {
        if (commitWaterline(anchor._line, anchor._id)) {
          log(`旧状态已迁移到行水位 ${lastLine}`);
        }
      } else {
        setBaseline(all, true);
        skipFirstCheck = true;
        log('旧状态找不到对应行，以当前尾部为新基线，本轮不告警');
      }
    }
  }

  ctx.effect(() => {
    // 启动先查一次（可能有一夜积压的）；但首次运行刚标记完全部已读，跳过
    if (!skipFirstCheck) check().catch((e) => log(`首次检查失败：${e?.message ?? e}`));
    else log(needsBaseline ? '会话记录尚不可读，本轮先不检查，等待恢复后初始化水位' : '首次运行已完成初始化，本轮不检查');
    const timer = setInterval(() => {
      check().catch((e) => log(`巡检失败：${e?.message ?? e}`));
    }, minutes * 60_000);
    timer.unref?.();
    log(
      `ready → ${chatFile}（每 ${minutes} 分钟查一次她发来的消息）`
      + (currentPin() !== '' ? `｜回复固定送到 ${currentPin()}（config 或面板 pin）` : '｜回复跟随「人最后说话的主会话」'),
    );
    // 启动时把**实际选中的**目标打出来，路由可以直接从日志核对，无需发测试消息。
    setTimeout(() => {
      const a = findAgent();
      log(a ? `当前目标会话：${idOf(a)}` : '当前没有活会话（她的回复先攒着）');
    }, 3000);
    return () => clearInterval(timer);
  }, 'ashu-relay.timer');
}
