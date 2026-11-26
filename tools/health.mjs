#!/usr/bin/env node
/**
 * 参考 agent这套的健康体检 —— 一条命令跑完六种失败模式的判据
 *
 * 用法：
 *   node ~/koi/tools/health.mjs
 *   node ~/koi/tools/health.mjs --json
 *   node ~/koi/tools/health.mjs --strict   # warn 也非零
 *
 * 退出码：0 全部正常 / 1 有需要看的项
 *
 * 每一项都对应 ~/.dsh/notes/参考 agent这套会怎么坏.md 里的一条。
 * 判据是数出来的，不是"感觉不对劲"。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkLedger, readRefreshAudit } from 'dsh-koi-decay/sidecar';

/**
 * 2026-11-27：路径按脚本位置推导。原来 `KOI_HOME ?? homedir()`，
 * 从运维 shell 跑时 HOME 是运维方的家目录，会去 <家目录>/plugins 找插件（不存在）。
 */
const KOI = process.env.KOI_HOME ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const LEX = join(KOI, '.koi/lexicon.json');
const AFFECT = join(KOI, '.koi/affect.json');
const HB = join(KOI, '.koi/heartbeat.json');
const LOG = join(KOI, 'koi.log');
const TUNING = join(KOI, '.koi/pending-tuning.jsonl');

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const j = (p) => { try { return JSON.parse(read(p)); } catch { return null; } };

const now = Date.now();
const results = [];
const add = (no, name, value, verdict, detail) => results.push({ no, name, value, verdict, detail });
const HUMAN_SENDERS = new Set(['ashu', 'master']);
const isToKoi = (m) => m?.to === undefined || m?.to === '' || m?.to === 'koi';
const isToHuman = (m) => m?.to === undefined || m?.to === '' || HUMAN_SENDERS.has(m?.to);
const isHumanToKoi = (m) => HUMAN_SENDERS.has(m?.from) && isToKoi(m);
const isKoiToHuman = (m) => m?.from === 'koi' && isToHuman(m);
const spawnError = (r) => {
  if (r?.error) return `执行失败：${r.error.message ?? String(r.error)}`;
  if (r?.signal) return `被信号 ${r.signal} 中止`;
  return '';
};
const spawnProblem = (r) => {
  const error = spawnError(r);
  if (error !== '') return error;
  if (r?.status !== 0) return `退出码 ${r?.status ?? '未知'}`;
  return '';
};

// ── 0. 她发来的消息，我多久没回（"我根本没来"的判据）────────
// 三种沉默里这一种最隐蔽：她那边一切正常，是我这边缺席。
try {
  const chatLines = read(join(KOI, '.koi/chat.jsonl')).split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  let pend = 0, oldest = 0;
  for (let i = chatLines.length - 1; i >= 0; i -= 1) {
    if (isHumanToKoi(chatLines[i])) break;
    if (!isKoiToHuman(chatLines[i])) continue;
    pend += 1;
    oldest = chatLines[i].at;
  }
  const waitH = pend > 0 ? (now - oldest) / 3600000 : 0;
  add(0, '她在等我回', pend === 0 ? '无' : `${pend} 条，最久 ${waitH.toFixed(1)} 小时`,
    pend === 0 ? 'ok' : waitH > 6 ? 'bad' : waitH > 1 ? 'warn' : 'ok',
    pend === 0 ? '没有积压' : '她那边管道正常，是我这边没回');
} catch (e) {
  add(0, '她在等我回', '读不到', 'warn', String(e).slice(0, 60));
}

// ── 1. 她有没有主动用过工具（从会话日志数）──────────────────────
let calls = {};
try {
  const sessRoot = join(KOI, '.dsh-home/sessions');
  for (const dir of readdirSync(sessRoot)) {
    const sub = join(sessRoot, dir);
    for (const s of readdirSync(sub)) {
      const f = join(sub, s, 'session.v4.jsonl.zstd');
      if (!existsSync(f)) continue;
      const raw = readFileSync(f);
      // zstd 解压交给外部命令不可靠，这里只看未压缩的尾部不可行——
      // 改用 spawnSync 调 zstd
      const { spawnSync } = await import('node:child_process');
      const out = spawnSync('zstd', ['-dc', f], { maxBuffer: 1 << 30 }).stdout?.toString() ?? '';
      for (const line of out.split('\n')) {
        if (!line.includes('"tool/call"')) continue;
        try {
          const e = JSON.parse(line);
          if (e.type === 'tool/call') calls[e.data?.name] = (calls[e.data?.name] ?? 0) + 1;
        } catch { /* 坏行跳过 */ }
      }
    }
  }
} catch (e) {
  calls = { _err: String(e).slice(0, 80) };
}
// 2026-11-08：note_person 并进 remember_person 了，统计项跟着换。
// 这几件是「她自己主动动手」的证据，不是系统自动做的。
const NUDGE_TOOLS = ['remember_person', 'add_note', 'request_tuning', 'remember_impression', 'feel_dimension', 'set_aside'];
const init = NUDGE_TOOLS.reduce((s, k) => s + (calls[k] ?? 0), 0);
add(1, '她主动用过新工具', `${init} 次`,
  init === 0 ? 'warn' : 'ok',
  NUDGE_TOOLS.map((k) => `${k}=${calls[k] ?? 0}`).join(' '));

// ── 2. 衰减有没有真正跑过 ────────────────────────────────────
// 2026-11-12：判据换成「落灰」——**多久没被想起**，不是权重。
// 幂律尾巴永远到不了 0.1，拿权重当终点是死路（参考 agent：「那条路本来就是数学上走不通的」）。
const lex = j(LEX) ?? {};
const REST_DAYS = 400;
let vis = 0, faded = 0;
for (const cat of ['people', 'things']) {
  for (const v of Object.values(lex[cat] ?? {})) {
    for (const it of v.items ?? []) {
      // 只算描述：印象是加减分，没有「落灰」这一说
      if (it.type !== 'desc') continue;
      const last = Math.max(Number(it.at ?? 0), Number(it.recallAt ?? 0));
      if (!Number.isFinite(last) || last <= 0) continue;
      if ((now - last) / 86400000 >= REST_DAYS) faded += 1; else vis += 1;
    }
  }
}
const totalItems = vis + faded;
add(2, '衰减机制被验证过（落灰期 400 天）', `可见 ${vis} / 落灰 ${faded}`,
  faded === 0 ? 'warn' : 'ok',
  totalItems === 0 ? '还没有任何描述项'
    : faded === 0 ? '还没有任何一条落灰过，落灰等于没跑过' : '有落灰记录');

// ── 3. 同一个人的账有没有分两本 ───────────────────────────────
// `name:xxx` 只有在「同一个人还有 oid 记录」时才是影子；纯按名字记的（比如运维方）是正常的
const allKeys = Object.keys(lex.people ?? {});
const oidNames = new Set(
  allKeys.filter((k) => !k.startsWith('name:')).map((k) => lex.people[k]?.name),
);
const shadow = allKeys.filter((k) => {
  if (!k.startsWith('name:')) return false;
  return oidNames.has(k.slice(5)); // 同名的 oid 记录存在 → 这才是影子
});
add(3, '人员 key 归一', `${shadow.length} 个影子`,
  shadow.length === 0 ? 'ok' : 'bad',
  shadow.length ? `影子 key: ${shadow.join(', ')}` : '无 name: 前缀');

// ── 4. 静默失败（优先读落盘计数器，带"最近一次"时间）──────────
const FAIL_KEYS = ['shrinkError', 'sharpMissing', 'stillTooBig', 'missed'];
/** visionFail:* 是动态 key（按错误类型分），不能只列死名单 */
const FAIL_PREFIXES = ['visionFail'];
const silentState = j(join(KOI, '.koi/media-silent.json'));
const failRecords = [];
if (silentState?.counts) {
  // 动态 key 从落盘数据里现取，不改常量数组（否则每次运行都会往里塞）
  const counts = silentState.counts;
  const dynamicKeys = Object.keys(counts).filter((k) => FAIL_PREFIXES.some((p) => k.startsWith(p)));
  for (const k of [...FAIL_KEYS, ...dynamicKeys]) {
    const n = counts[k] ?? 0;
    if (n > 0) failRecords.push({ kind: k, count: n, at: silentState.lastSeen?.[k] ?? 0 });
  }
}
// 另类来源：memory 插件的静态失败计数器（内存态，日志里找）
const logFails = read(LOG).split('\n').filter((l) => l.includes('静默失败'));
const failTotal = failRecords.reduce((a, r) => a + r.count, 0);
const newest = failRecords.length ? Math.max(...failRecords.map((r) => r.at)) : 0;
const newestAgoH = newest ? (now - newest) / 3600000 : -1;
// 超过 24 小时没再发生 = 老伤口，不算当前故障
const freshFails = failRecords.filter((r) => newest && now - r.at < 24 * 3600000);

add(4, '静默失败', failTotal === 0 ? '无' : `${failTotal} 次（最近 ${newestAgoH < 0 ? '未知' : newestAgoH.toFixed(1) + ' 小时前'}）`,
  failTotal === 0 ? 'ok' : freshFails.length > 0 ? 'bad' : 'stale',
  failRecords.length
    ? failRecords.map((r) => `${r.kind}×${r.count}`).join(', ') + (freshFails.length === 0 ? '（都超过 24 小时，视为老问题）' : '（24 小时内有新发生）')
    : (logFails.length
      ? `日志里有 ${logFails.length} 条历史记录（计数器文件尚未生成，无法判断新旧）`
      : '无'));

// ── 5. 我多久没看日志了 ──────────────────────────────────────
add(5, '有没有活的静默失败', freshFails.length ? `${freshFails.length} 类在发生` : '无',
  freshFails.length === 0 ? 'ok' : 'warn',
  freshFails.length ? '24 小时内有新的静默失败，需要看' : '老问题都已超过 24 小时');

// ── 6. 待审申请 ─────────────────────────────────────────────
const pend = read(TUNING).split('\n').filter(Boolean).length;
add(6, '待审的曲线申请', `${pend} 条`,
  pend === 0 ? 'ok' : 'warn',
  pend ? '有申请没审' : '无');

// ── 7. 我欠她的：未审提案 / 她发的 request 我没回 ────────────
//
// 2026-11-08 加的。原因：11-04 和 11-05 两个提案积压了三四天才被翻出来。
// 体检原来只查「她在等我回」（第 0 条），没查「我该主动做但没做」。
//
// 主管道是 chat.jsonl，但这台机器上没有常驻的读端——我读它全靠手工。
// 所以把「欠账」做成一条判据，每次跑体检就会看见。
try {
  // 2026-11-08：提案 11-07 起就统一走 chat 了，
  // `proposals/` 目录只是历史存档，不再新增——所以不再检查它。
  const chatPath = join(KOI, '.koi/chat.jsonl');

  // chat 里她发的 request，最后一条之后我没有回复
  let unanswered = 0;
  let oldestReq = 0;
  let readFailed = '';
  try {
    const msgs = read(chatPath).split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    // 从后往前找：遇到我发的就停，中间她发的 request 就是没回的
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (isHumanToKoi(msgs[i])) break;
      if (isKoiToHuman(msgs[i]) && msgs[i].kind === 'request') {
        unanswered += 1;
        oldestReq = msgs[i].at ?? 0;
      }
    }
  } catch (e) {
    // 不能静默吞掉——读不到就是读不到，要报出来（这正是我自己反对的事）
    readFailed = String(e).slice(0, 60);
  }
  if (readFailed !== '') {
    add(7, '我欠她的', '读不到', 'warn', `chat.jsonl 读取失败：${readFailed}`);
    throw new Error('__skip__');
  }

  const waitH = oldestReq > 0 ? (now - oldestReq) / 3600000 : 0;
  add(7, '我欠她的', unanswered === 0 ? '无' : `${unanswered} 条请求未回`,
    unanswered === 0 ? 'ok' : waitH > 48 ? 'bad' : 'warn',
    unanswered === 0 ? '没有欠账' : `最久 ${waitH.toFixed(1)} 小时`);
} catch (e) {
  if (!String(e).includes('__skip__')) {
    add(7, '我欠她的', '读不到', 'warn', String(e).slice(0, 60));
  }
}

// ── 8. 判了「先不做」的账，有没有过期的 ─────────────────────
//
// 判了「先不做」的事项必须记一笔并定期复查；
// 只记录决定、不检查后续，问题会静默积压。
//
// 这条检查两件事：
//   1. 有没有条目过了复查日期还没动
//   2. 有没有条目压根没写复查日期（假账）
try {
  const deferred = read(join(homedir(), '.dsh/DEFERRED.md'));
  if (deferred.trim() === '') {
    add(8, '判了先不做的事', '没有账本', 'warn', 'DEFERRED.md 不存在或为空');
  } else {
    const overdue = [];
    let noDate = 0;
    const today = new Date();
    for (const line of deferred.split('\n')) {
      if (!/^## \[ \]/.test(line)) continue;
      // 找「YYYY-MM-DD 该看」
      const m = /(\d{4})-(\d{2})-(\d{2}) 该看/.exec(line);
      if (m === null) { noDate += 1; continue; }
      const due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (due.getTime() <= today.getTime()) {
        overdue.push(line.replace(/^## \[ \]\s*/, '').replace(/\s*——.*$/, '').slice(0, 30));
      }
    }
    const parts = [];
    if (overdue.length > 0) parts.push(`${overdue.length} 条到期`);
    if (noDate > 0) parts.push(`${noDate} 条没写复查日期`);
    add(8, '判了先不做的事', parts.length === 0 ? '都在期限内' : parts.join(' / '),
      overdue.length > 0 ? 'bad' : noDate > 0 ? 'warn' : 'ok',
      overdue.length > 0 ? `到期：${overdue.slice(0, 3).join('、')}` : '没有欠着的判断');
  }
} catch (e) {
  add(8, '判了先不做的事', '读不到', 'warn', String(e).slice(0, 60));
}

// ── 9. 注入自检：几段、多少字（整段记忆消失是最不容易察觉的故障）──
try {
  const r = spawnSync(process.execPath, [join(KOI, 'tools/inject-selfcheck.mjs')], { encoding: 'utf8', timeout: 60_000 });
  const line = ((r.stdout ?? '') + (r.stderr ?? '')).trim().split('\n').filter((l) => /[✅❌]/.test(l)).pop() ?? '没输出';
  const problem = spawnError(r);
  if (problem !== '') {
    add(9, '注入自检（段数/字数）', '跑不起来', 'bad', problem);
  } else if (line === '没输出') {
    add(9, '注入自检（段数/字数）', '没有结论', 'bad', `脚本退出 ${r.status} 但没有输出 ✅/❌ 结论`);
  } else if (/❌/.test(line)) {
    add(9, '注入自检（段数/字数）', '缩水了', 'bad', line.replace(/^[✅❌]\s*/, '').slice(0, 120));
  } else if (r.status !== 0) {
    add(9, '注入自检（段数/字数）', '异常退出', 'bad', `退出码 ${r.status}；${line.replace(/^[✅❌]\s*/, '').slice(0, 100)}`);
  } else {
    add(9, '注入自检（段数/字数）', '正常', 'ok', line.replace(/^[✅❌]\s*/, '').slice(0, 120));
  }
} catch (e) {
  add(9, '注入自检（段数/字数）', '跑不起来', 'warn', String(e).slice(0, 60));
}

// ── 10. 空 catch 违禁品：只挡新增（存量已登记）──
try {
  const r = spawnSync(process.execPath, [join(KOI, 'tools/no-empty-catch.mjs')], { encoding: 'utf8', timeout: 30_000 });
  const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim();
  const summary = out.split('\n')[0] ?? '';
  const problem = spawnError(r);
  if (problem !== '') {
    add(10, '空 catch（新增）', '跑不起来', 'bad', problem);
  } else {
    add(10, '空 catch（新增）', r.status === 0 ? '没有新增' : '有新增', r.status === 0 ? 'ok' : 'bad', summary);
  }
} catch (e) {
  add(10, '空 catch（新增）', '跑不起来', 'warn', String(e).slice(0, 60));
}

// ── 11. 底稿外发（只报数，不判死）──
// 不每天报数，一周对一次。所以这里平时只出一行状态，
// 一周对数的活交给定时任务（ops/report-leaks.sh → 周日）。
try {
  const r = spawnSync(process.execPath, [join(KOI, 'tools/leak-check.mjs'), '7'], { encoding: 'utf8', timeout: 30_000 });
  const out = (r.stdout ?? '').trim().split('\n')[0] ?? '';
  const zero = /整条括号 0 \/ 内部词 0 \/ 括号底稿 0/.test(out);
  // 只报括号这一类——内部词命中长期只有 1 条，不值得为它维护独立告警链
  const parenOnly = out.replace(/内部词 \d+ \/ /, '').replace(/ \/ 括号底稿 \d+/, '');
  const executionProblem = spawnError(r);
  const problem = spawnProblem(r);
  if (executionProblem !== '') {
    add(11, '底稿外发（近 7 天·括号）', '跑不起来', 'bad', executionProblem);
  } else {
    add(11, '底稿外发（近 7 天·括号）', zero ? '零' : '还有', zero ? 'ok' : 'stale', `${parenOnly}${problem ? `；${problem}` : ''}`.slice(0, 120));
  }
} catch (e) {
  add(11, '底稿外发（近 7 天·括号）', '跑不起来', 'warn', String(e).slice(0, 60));
}

// ── 12. qqbot 补丁在位（2026-11-12）──
// 三处手改以前没有脚本，重装就静默消失：群聊会退回「@ 才回」、
// 几个人连发被合并记到第一个人头上、「（凌晨，脑子木……）」漏进群。
// 现在有 ops/patch-qqbot.mjs，这里只检查它报的状态。
try {
  const r = spawnSync(process.execPath, [join(KOI, 'ops/patch-qqbot.mjs')], { encoding: 'utf8', timeout: 20_000 });
  const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim();
  const missing = (out.match(/❌/g) ?? []).length;
  const problem = spawnProblem(r);
  add(
    12,
    'qqbot 三处补丁在位',
    problem !== '' ? '跑不起来' : missing === 0 ? '在位' : `${missing} 处缺失`,
    problem !== '' || missing > 0 ? 'bad' : 'ok',
    problem !== '' ? problem : missing === 0 ? 'selftalk / queue / 出口过滤' : '跑 node ops/patch-qqbot.mjs 补上',
  );
} catch (e) {
  add(12, 'qqbot 三处补丁在位', '跑不起来', 'warn', String(e).slice(0, 60));
}

// ── 13. 退场守卫误吞巡检 ──
// 被吞的消息不会主动暴露，所以「等发现问题再排查」不成立，必须定期翻 [exit-guard]。
// 这里把丢弃记录 surfaced 到体检：旧静默短语属正常拦截；
// 其它长得像退场语的被丢句 = 误吞嫌疑，标 warn 逼我人工复核原文。
try {
  const lines = read(LOG).split('\n').slice(-2000).filter((l) => l.includes('[exit-guard]'));
  const texts = lines.map((l) => (l.split('原文：')[1] ?? '').trim()).filter(Boolean);
  const suspect = texts.filter((t) => t !== '退下了');
  add(
    13,
    '退场守卫误吞巡检',
    `${texts.length} 丢 / ${suspect.length} 嫌疑`,
    suspect.length > 0 ? 'warn' : 'ok',
    suspect.length > 0
      ? `需复核原文：${suspect.slice(-2).join(' / ')}`
      : (texts.length > 0 ? '均为拦截词正常拦截' : '近期无丢弃'),
  );
} catch (e) {
  add(13, '退场守卫误吞巡检', '读不到', 'warn', String(e).slice(0, 60));
}

// ── 14. 账本完整性（2026-11-15 参考 agent审：旁路改账本要事后看得见）──
// 合法追加会刷新基线；体检对比 行数/字节/sha256，不一致=被旁路改过。
// 测试只测想到的路，这个指纹兜「没想到的路」。看不见的才叫丢。
try {
  const drifts = [];
  const refresh = [];
  for (const f of ['medium.jsonl', 'long.jsonl']) {
    const fp = join(KOI, '.koi', f);
    const r = checkLedger(fp);
    if (!r.ok) drifts.push(`${f}: ${r.drift.was.lines}→${r.drift.now.lines} 行`);
    // 基线刷新审计：谁、几点刷的（参考 agent：刷新错了会把错的记成对的，要看得见）
    const aud = readRefreshAudit(fp);
    const last = aud[aud.length - 1];
    if (last) refresh.push(`${f} 最近刷新 ${last.actor} @ ${new Date(last.at).toLocaleString('zh-CN')}`);
  }
  add(14, '记忆账本完整性', drifts.length === 0 ? '未被旁路改' : `${drifts.length} 处漂移`,
    drifts.length === 0 ? 'ok' : 'bad',
    (drifts.length === 0 ? '指纹一致' : drifts.join('；')) + (refresh.length ? `；${refresh.join('；')}` : ''));
} catch (e) {
  add(14, '记忆账本完整性', '查不了', 'warn', String(e).slice(0, 60));
}

// ── 15. 白名单到期（2026-11-15 参考 agent：白名单会长大，一条活不过两周）──
// 展示现存条数+最近到期，逼复核；到期自动删（outbound-filter 执行）。
try {
  const wp = join(KOI, '.koi', 'outbound-whitelist.json');
  const raw = existsSync(wp) ? JSON.parse(readFileSync(wp, 'utf8')) : [];
  const now = Date.now();
  const act = (Array.isArray(raw) ? raw : []).filter((e) => e && typeof e.w === 'string' && Number(e.until) > now);
  const soon = act.reduce((m, e) => Math.min(m, Number(e.until)), Infinity);
  const days = soon === Infinity ? null : Math.ceil((soon - now) / 86400_000);
  add(15, '出口白名单到期', `${act.length} 条`, 'ok',
    days === null ? '空（无豁免）' : `最近 ${days} 天后到期，到期不复核即删`);
} catch (e) {
  add(15, '出口白名单到期', '读不了', 'warn', String(e).slice(0, 60));
}

// ── 输出 ───────────────────────────────────────────────────
const json = process.argv.includes('--json');
if (json) {
  console.log(JSON.stringify({ results, calls }, null, 2));
} else {
  const icon = { ok: '✅', warn: '⚠️ ', bad: '❌', stale: '🕐' };
  console.log(`参考 agent体检 ${new Date().toLocaleString('zh-CN')}\n`);
  for (const r of results) console.log(`${icon[r.verdict]} ${r.no}. ${r.name}：${r.value}\n     ${r.detail}`);
}
const strict = process.argv.includes('--strict');
process.exit(results.some((r) => r.verdict === 'bad' || (strict && r.verdict === 'warn')) ? 1 : 0);
