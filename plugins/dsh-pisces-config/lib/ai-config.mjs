/**
 * ai-config.mjs —— 所有 AI（provider/model）配置的唯一读口。
 *
 * **AI 配置一律跟随 dsh-pisces-config 面板**。
 * 别处不再各自写死 provider、不再各自猜默认值——猜出来的默认值互相打架，
 * 换 key / 换模型要改 N 个地方，还容易漏。
 *
 * 读取顺序（高优先在前）：
 *   1. `<KOI_HOME>/.koi/ashu-config.json` 的 `ai.<用途>`
 *   2. `ai.chat`（主聊天配置）—— 用途没单独配就跟主聊天
 *   3. 环境变量 MODEL_PROVIDER / MODEL_NAME
 *   4. 显式报错，不猜
 *
 * 用途：'chat' | 'vision' | 'gate' | 'iterate'
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const PURPOSES = ['chat', 'vision', 'gate', 'iterate'];

/**
 * Koi 数据目录的唯一判定处。
 *
 * 优先级：显式 config.dir → $KOI_HOME/.koi → $HOME/.koi。
 * 返回值一定是绝对路径；末尾斜杠会被 path.resolve 归一化。
 *
 * @param {{dir?: string, koiHome?: string, home?: string}} [options]
 * @returns {string}
 */
export function resolveKoiDataDir({ dir, koiHome, home } = {}) {
  const configured = String(dir ?? '').trim();
  if (configured !== '') return resolve(configured);

  const koiBase = String(koiHome ?? process.env.KOI_HOME ?? '').trim();
  if (koiBase !== '') return resolve(koiBase, '.koi');

  const homeDir = String(home ?? process.env.HOME ?? '').trim() || homedir();
  return resolve(homeDir, '.koi');
}

function readOverride() {
  const p = join(resolveKoiDataDir(), 'ashu-config.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { console.log('[ai-config] 读配置失败：' + String(e)); return {}; }
}

/**
 * 取某个用途的 provider/model。
 * 返回 { provider, model, source }；provider/model 可能为空串（表示"用宿主默认"）。
 * source 说明值从哪来，方便排查。
 */
export function aiConfig(purpose = 'chat') {
  if (!PURPOSES.includes(purpose)) throw new Error(`aiConfig: 未知用途 ${purpose}`);
  const ov = readOverride();
  const ai = ov?.ai ?? {};

  const pick = (k) => {
    const own = ai?.[purpose]?.[k];
    if (typeof own === 'string' && own.trim() !== '') return { value: own.trim(), source: `ai.${purpose}` };
    const chat = ai?.chat?.[k];
    if (typeof chat === 'string' && chat.trim() !== '') return { value: chat.trim(), source: 'ai.chat' };
    const env = k === 'provider' ? process.env.MODEL_PROVIDER : process.env.MODEL_NAME;
    if (typeof env === 'string' && env.trim() !== '') return { value: env.trim(), source: 'env' };
    return { value: '', source: 'none' };
  };

  const p = pick('provider');
  const m = pick('model');
  return { provider: p.value, model: m.value, source: `${p.source}/${m.source}` };
}

// ── 模型选择（2026-11-16 从 dsh-pisces-session 合并进来）──────────────
// 为什么合并：这些都是"用哪个模型"的问题，归配置包统一回答。
// session 只留"选哪个会话"（pickAgent / lastHumanAt 等），职责不混。

function eventsOf(a) {
  try {
    const s = a?.session;
    if (typeof s?.snapshotEvents === 'function') return s.snapshotEvents();
    if (typeof s?.ownEvents === 'function') return s.ownEvents();
  } catch { /* 拿不到就当没有 */ }
  return [];
}

/** 某个 agent 最近一次显式选过的模型（读会话里的 model/selection 事件）。 */
export function lastModelOf(a) {
  const ev = eventsOf(a);
  if (!Array.isArray(ev)) return null;
  for (let i = ev.length - 1; i >= 0; i -= 1) {
    const e = ev[i];
    const d = e?.data;
    if (e?.type !== 'model/selection' || d === undefined) continue;
    const provider = String(d.provider ?? '').trim();
    const model = String(d.model ?? '').trim();
    if (provider === '' || model === '') continue;
    return { provider, model };
  }
  return null;
}

/**
 * 从活会话里挑一个模型（主会话优先，按活跃度）。
 * 用途：面板 mode=follow 时"跟随会话"——这是唯一能看见会话实况的途径。
 */
export function pickModel(list, fallback = {}) {
  if (Array.isArray(list)) {
    const pool = list.filter((a) => a && typeof a.followup === 'function');
    /**
     * 2026-11-26 review P1：原来用 `a.parentSessionId` / `a.subagent` / `a.lastActivity`
     * 判断子 agent 和活跃度 —— 这三个在 DSH 0.2.2-rc.5 的公共 Agent 上**都不存在**。
     * 结果是：子 agent 过滤形同虚设，活跃度全是 0（随机挑一个会话的模型）。
     *
     * 现在：子 agent 看 `session.header.delegationDepth`（宿主自己的判据），
     * 活跃度用会话事件里的**最后一条事件时间**。
     */
    const isSub = (a) => Number(a?.session?.header?.delegationDepth ?? 0) > 0;
    const activityOf = (a) => {
      const ev = eventsOf(a);
      if (!Array.isArray(ev) || ev.length === 0) return 0;
      const last = ev[ev.length - 1];
      const t = Number(last?.time ?? last?.at ?? 0);
      return Number.isFinite(t) ? t : 0;
    };
    const mains = pool.filter((a) => !isSub(a));
    for (const group of [mains.length > 0 ? mains : pool]) {
      const withModel = group
        .map((a) => ({ a, m: lastModelOf(a), act: activityOf(a) }))
        .filter((x) => x.m !== null)
        .sort((x, y) => y.act - x.act);
      if (withModel.length > 0) return withModel[0].m;
    }
  }
  return {
    provider: String(fallback.provider ?? ''),
    model: String(fallback.model ?? ''),
  };
}

/**
 * 面板语义：固定模型 > 跟随活会话 > 兜底。
 * @param {Array} list       agents.list()
 * @param {object} ov        ashu-config.json（看 ov.api.mode）
 * @param {object} fallback  { provider, model }
 */
export function koiModel(list, ov, fallback = {}) {
  if (ov?.api?.mode === 'fixed' && ov.api.provider && ov.api.model) {
    return { provider: String(ov.api.provider), model: String(ov.api.model) };
  }
  return pickModel(list, fallback);
}


// ── 会话查询（2026-11-16 整体从 dsh-pisces-session 合并）─────────────
// 为什么合并进"配置"包：投递到哪个会话、用哪个模型，都是**配置决定的事**。
// 面板上就是两处：投递目标（proposal.sessionId）+ API（api.mode）。
// 把它们和读取器放一起，配置只有这一个包负责回答。

/**
 * dsh-pisces-session —— 「用哪个会话」和「用哪个模型」的唯一判定处
 *
 * 为什么要有这个包
 * ----------------
 * 2026-11-12 参考 agent指出一类问题：
 *
 *   > 「最近活跃的会话」这种隐式选择，你系统里应该不只这一处——
 *   > 凡是「自动挑一个」的地方，早晚都会挑到没人看的那一个。
 *
 * 查下来确实是三处一模一样的拷贝（chat / heartbeat / relay），
 * 都是 `sort by lastActivity → 取第一个`。这个写法有两个必坏的场景：
 *
 *   ① **子代理会话**：我一派子代理，它就成了「最近活跃」，
 *      消息/唤醒全落到一个没人看的会话里
 *   ② **自己的注入**：我把她的回复塞进某个会话，那个会话的 lastActivity 被顶高，
 *      下一次就会「自动」选中它
 *
 * 所以判定统一收到这里：**只认真人打的字**。
 *
 * 同一份数据还解决第二个问题：**新建会话该用什么模型**。
 * chat / heartbeat 都写死过 `qwen-token-plan-cn` + `deepseek-v4.1-flash-1017`，
 * 而现网会话早就是 `deepseek-official` + `deepseek-flash` 了；
 * 配置过时就建不出会话。现在从**最近一次真实会话**里继承，配置不会漂。
 */

/**
 * 子代理会话（delegationDepth > 0）。它们的「活跃」不代表有人在看。
 * @param {object} a agent
 */
export function isSubAgent(a) {
  return Number(a?.session?.header?.delegationDepth ?? 0) > 0;
}

/** @param {object} a agent */
export function idOf(a) {
  return String(a?.session?.id ?? a?.id ?? '');
}

/** 事件流（不同宿主版本，API 名不一样，能拿到就给） */

/**
 * 我们自己塞进去的消息 id 前缀。
 *
 * 这些不是「人说话」，但 `source.kind` 都是 `user`，光看 source 分不出来。
 */
// 2026-11-16 实测（本机 session 全量扫描，12 种 source.kind）：
//   user 966 / time-context 582 / agent-instructions 66 / runtime-context 34 /
//   tool-jobs 29 / model-selection 25 / schedule 13 / skill-catalog 11 /
//   compact-checkpoint 9 / subagent-settled 9 / user-approval 6 / agent-message 4
//
// **只有 `user` 是人真的在说话**，其余全是系统/定时/子代理注入。
// 这里用白名单而不是黑名单：以后框架新增 kind 时，默认不会被误判成"人刚说了话"
// （黑名单会漏，今天已经漏过两次）。
const HUMAN_KINDS = new Set(['user']);

/**
 * 这条用户消息是不是**人真的在说话**。
 *
 * 2026-11-17 决定：三处判据合一，全部走这一个函数。
 *   - 原来散在 ai-config / ashu-relay / koi-memory / koi-lexicon 各一份
 *   - 判错过一次：压缩摘要被当成群友发言写进了短期记忆
 *
 * **fail-closed**：
 *   > 只有 source.kind === 'user' 才算人说的，其余一律不算——
 *   > 包括定时上下文、压缩摘要、指令更新。宁可漏一个人，别把系统话记成谁说的，
 *   > 那个方向是隐私，不是记性问题。
 *
 * 实测依据（2026-11-17，全部会话）：user/message 事件里
 *   kind=user 969 条、schedule 28、runtime-context 13、compact-checkpoint 5、
 *   **无 kind 的 0 条**。所以收紧成严格判定不会漏掉任何真人消息。
 */
export function isHumanSource(source) {
  return source?.kind === 'user';
}

/** 诊断用：这条消息为什么不算人说的（给日志用，判定本身不看它）。 */
export function humanKindOf(source) {
  const k = source?.kind;
  return k === undefined ? '(无 kind)' : String(k);
}
const SELF_INJECTED = ['koi-relay-', 'ashu-relay-', 'chat-', 'heartbeat-'];

/**
 * 系统注入的 source.kind —— 这些**都不是人说话**。
 *
 * 2026-11-13 补：原来只挡 `runtime-context`，而 `agent-instructions`（AGENTS.md 变更）
 * 和 `skill-catalog`（技能清单）也是 `user/message` 事件，会被当成「人刚说了话」，
 * 把会话判定带偏。现在按**结构化 kind** 挡，不靠文本、不靠 id 前缀。
 */

/**
 * 这个会话里**人**最后一次说话是什么时候。
 *
 * 跳过：
 *   - `runtime-context`（系统注入的上下文快照）
 *   - 我们自己的注入（`koi-relay-` / `chat-` / `heartbeat-` 前缀）
 *
 * @param {object} a agent
 * @returns {number} 毫秒时间戳；没说过话返回 0
 */
export function lastHumanAt(a) {
  const ev = eventsOf(a);
  if (!Array.isArray(ev)) return 0;
  for (let i = ev.length - 1; i >= 0; i -= 1) {
    const e = ev[i];
    if (e?.type !== 'user/message') continue;
    const kind = e.data?.source?.kind;
    if (kind !== undefined && !HUMAN_KINDS.has(kind)) continue;
    const id = String(e.data?.id ?? e.id ?? '');
    if (SELF_INJECTED.some((p) => id.startsWith(p))) continue;
    return Number(e.time ?? 0);
  }
  return 0;
}

/**
 * 这个会话最后一次真正用过的模型。
 *
 * 从 `model/selection` 事件读——**不在配置里猜**。
 * 这样「新建会话用什么模型」永远跟当前实际情况一致，不会因为
 * `.env` 或 profile 写了个过时的 provider 名而建不出会话。
 *
 * @param {object} a agent
 * @returns {{provider: string, model: string} | null}
 */

/**
 * 挑一个会话。
 *
 * 优先级：
 *   ① 显式钉住的 `sessionId`（想固定在一个窗口时用）
 *   ② **主会话**里，「人最后说话」最晚的那个（这才是你正在看的）
 *   ③ 都没有 → 最近活跃的主会话（兜底，别返回 null 把消息憋死）
 *
 * @param {Array<object>} list `agents.list()` 的结果
 * @param {{sessionId?: string, log?: (msg: string) => void}} [opts]
 * @returns {object | null}
 */
export function pickAgent(list, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  if (!Array.isArray(list) || list.length === 0) return null;

  const usable = list.filter((a) => a && typeof a.followup === 'function');
  if (usable.length === 0) return null;

  // ① 钉住的
  const pinned = String(opts.sessionId ?? '').trim();
  if (pinned !== '') {
    const hit = usable.find((a) => idOf(a) === pinned);
    if (hit) return hit;
    log(`⚠️ 钉住的会话 ${pinned} 不在活会话里，退回自动挑`);
  }

  // ② 主会话 + 人最后说话最晚的
  const mains = usable.filter((a) => !isSubAgent(a));
  const pool = mains.length > 0 ? mains : usable;
  const scored = pool.map((a) => ({
    a,
    human: lastHumanAt(a),
    act: Number(a.lastActivity ?? a.session?.header?.createdAt ?? 0),
  }));
  scored.sort((x, y) => y.human - x.human || y.act - x.act);

  const pick = scored[0];
  if (pick !== undefined && pick.human > 0) {
    log(`目标会话（跟随人最后说话）：${idOf(pick.a)}`);
    return pick.a;
  }
  // ③ 谁都没开过口
  return pick?.a ?? null;
}

/**
 * koi 的模型解析单一入口（2026-11-14 配置面板 v2）。
 *
 * 优先级：override.api.mode==='fixed' → 用固定 provider/model；
 *         否则 follow → pickModel（跟随最近活跃会话）；再退回 fallback。
 * 固定模型只来自 koi 自己的 override，**不读 shared/model.env 当固定值**
 * （shared 是两 agent 共用，不能当 koi 的固定配置）。
 */

/**
 * 新建会话/换会话时该用的 provider/model。
 *
 * 从**当前活会话**里继承（最近用过的那个），拿不到才用调用方给的回退值。
 * 不要在这里写死 provider 名——那正是「配置过时 → 建不出会话」的来源。
 *
 * @param {Array<object>} list `agents.list()` 的结果
 * @param {{provider?: string, model?: string}} [fallback] 实在没有活会话时用
 * @returns {{provider: string, model: string}}
 */
