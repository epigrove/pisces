/**
 * dsh-pisces —— Host 侧（v2）
 *
 * 面板只留三块：
 *   ① API/模型：选择器（provider→model，同会话模型选择器）+「跟随最近活跃的会话」
 *   ② 提案会话：选「koi的提案/回复送到ashu哪个会话」（relay pin）+ 自动
 *   ③ 其它默认：唤醒间隔/注入条数（两个简单数字）
 * 删掉：曲线设置（参数归koi每次自选）、群聊门控（迭代太快，面板不绑它的 schema）。
 *
 * 关键约束：固定模型**只写 koi 的 override**，绝不写 shared/model.env（那会连ashu一起改）。
 *
 * 路由：GET state / GET models / GET sessions / POST override
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, readdirSync,
  copyFileSync, renameSync, unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';


export const name = 'pisces-config';
export const inject = [];

const readJson = (p, fb) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fb; } };

/** 配置里的插件 id 是字面量，不是正则源码。 */
function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function writeTextAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* 临时文件可能还没创建 */ }
    throw err;
  }
}

function readSharedModel(file) {
  const out = { provider: '', model: '' };
  // 2026-11-17 codex review P3：路径不再写死某个部署布局；
  // 没配就直接返回空，调用方用别的来源兜底。
  if (!file) return out;
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^(MODEL_PROVIDER|MODEL_NAME)=(.*)$/.exec(line.trim());
      if (m) out[m[1] === 'MODEL_PROVIDER' ? 'provider' : 'model'] = m[2].trim();
    }
  } catch { /* 没有就空 */ }
  return out;
}

/** 从运行中的 dsh 入口反推安装目录，借它的 js-yaml 读 profile（不写死路径） */
function loadYaml() {
  try {
    const bin = process.argv[1];
    const root = dirname(dirname(realpathSync(bin)));
    const req = createRequire(join(root, 'package.json'));
    return req('js-yaml');
  } catch { return null; }
}

// ── 模型查询（2026-11-16 从 dsh-pisces-session 合并）──
// 面板要展示"当前生效的模型"，得看会话实际在用哪个。
function eventsOf(a) {
  try {
    const s = a?.session;
    if (typeof s?.snapshotEvents === 'function') return s.snapshotEvents();
    if (typeof s?.ownEvents === 'function') return s.ownEvents();
  } catch { /* 拿不到就当没有 */ }
  return [];
}

export function lastModelOf(a) {
  const ev = eventsOf(a);
  if (!Array.isArray(ev)) return null;
  for (let i = ev.length - 1; i >= 0; i -= 1) {
    const e = ev[i], d = e?.data;
    if (e?.type !== 'model/selection' || d === undefined) continue;
    const provider = String(d.provider ?? '').trim();
    const model = String(d.model ?? '').trim();
    if (provider === '' || model === '') continue;
    return { provider, model };
  }
  return null;
}

export function pickModel(list, fallback = {}) {
  if (Array.isArray(list)) {
    const pool = list.filter((a) => a && typeof a.followup === 'function');
    const mains = pool.filter((a) => !isSubAgent(a));
    for (const group of [mains.length > 0 ? mains : pool]) {
      const withModel = group
        .map((a) => ({ a, m: lastModelOf(a), act: Number(a.lastActivity ?? 0) }))
        .filter((x) => x.m !== null)
        .sort((x, y) => y.act - x.act);
      if (withModel.length > 0) return withModel[0].m;
    }
  }
  return { provider: String(fallback.provider ?? ''), model: String(fallback.model ?? '') };
}

// 2026-11-16：原来 lastHumanAt 引用了 NON_HUMAN_KINDS / SELF_INJECTED，
// 但这两个常量本文件里**根本没定义**——每次调用抛 ReferenceError，
// 被 sessions() 的 try/catch 吞掉，于是"我的会话"下拉永远是空的。
// 定义照抄 lib/ai-config.mjs（同一个框架，别自己发明第三个版本）。
// 2026-11-16 实测（本机 session 全量扫描）：真实的 source.kind 有 12 种，
// 其中**只有 `user` 是人真的在说话**。用白名单而不是黑名单——框架以后新增 kind
// 时默认不会被误判成"人刚说了话"（黑名单今天已经漏过两次）。
const HUMAN_KINDS = new Set(['user']);
const SELF_INJECTED = ['koi-relay-', 'ashu-relay-', 'chat-', 'heartbeat-'];

export function isSubAgent(a) {
  return Number(a?.session?.header?.delegationDepth ?? 0) > 0;
}

export function idOf(a) {
  return String(a?.session?.id ?? a?.id ?? '');
}

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

export function apply(ctx, config = {}) {
  const KOI = String(config.koiHome || process.env.KOI_HOME || join(homedir(), 'koi'));
  const OVERRIDE = join(KOI, '.koi', 'ashu-config.json');
  const MY_PROFILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'web', 'cordis.patch.yml');
  const log = (m) => console.log(`[pisces] ${m}`);

  // provider / key / models 全部跟随本插件。
  // 数据源从 koi 的 profile 读（那是 llm-pi-ai 真正加载的地方），
  // 本插件负责**展示与修改**，profile 只做声明，不再手写一堆模型。
  const KOI_PROFILE = join(KOI, '.dsh-home', 'profiles', 'koi', 'cordis.patch.yml');

  // 直接读 llm-providers.yml（纯 YAML，无 !!js），不解析 profile——
  // profile 里混着 DSH 的自定义 tag，普通 js-yaml 解析不了。
  const KOI_PROVIDERS = join(KOI, '.dsh-home', 'profiles', 'koi', 'llm-providers.yml');

  function koiProviders() {
    const yaml = loadYaml();
    if (!yaml) return {};
    try {
      const doc = yaml.load(readFileSync(KOI_PROVIDERS, 'utf8'));
      const rows = Array.isArray(doc) ? doc : [doc];
      return rows.find((r) => r?.config?.providers)?.config?.providers ?? {};
    } catch (e) { log('解析 llm-providers.yml 失败：' + String(e)); return {}; }
  }

  function models() {
    const prov = koiProviders();
    const out = Object.entries(prov).map(([p, v]) => ({
      provider: p,
      // key 从哪来（env 名），以及本机有没有配（只看有无，不回显）
      apiKeyEnv: v?.apiKeyEnv ?? '',
      hasKey: !!(v?.apiKeyEnv && creds()[v.apiKeyEnv]),
      models: (v?.models ?? []).map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        input: m.input ?? ['text'],
      })),
    }));
    if (out.length === 0) log('koi profile 里没解析到 providers');
    return out;
  }

  // ── 凭据：只读写 koi 的 .credentials.yaml，不碰主人的其他凭据 ──
  const KOI_DSH_HOME = join(KOI, '.dsh-home');
  function credsFile() { return join(KOI_DSH_HOME, '.credentials.yaml'); }

  function credentialsService() {
    try {
      const service = ctx.get?.('credentials');
      if (service && typeof service.set === 'function') return service;
    } catch (err) {
      log(`credentials 服务不可用：${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }

  function quarantineCredentials(file, err) {
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      copyFileSync(file, backup);
    } catch (copyErr) {
      throw new Error(`凭据 YAML 解析失败，且备份失败（${copyErr instanceof Error ? copyErr.message : String(copyErr)}）：${err instanceof Error ? err.message : String(err)}`);
    }
    throw new Error(`凭据 YAML 解析失败，已备份到 ${backup}，拒绝写入：${err instanceof Error ? err.message : String(err)}`);
  }

  function creds() {
    const yaml = loadYaml();
    if (!yaml) return {};
    try {
      const d = yaml.load(readFileSync(credsFile(), 'utf8')) ?? {};
      return d.refs ?? {};
    } catch (e) { log('读凭据失败：' + String(e)); return {}; }
  }

  /** 换某个 provider 的 apiKey（优先走 credential seam；否则写 koi 的 .credentials.yaml）。 */
  async function setKey(envName, value) {
    const yaml = loadYaml();
    const f = credsFile();
    const ownHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
    const service = credentialsService();
    if (service && ownHome === resolve(KOI_DSH_HOME)) {
      await service.set(envName, String(value));
      log(`已通过 credentials 服务更新凭据 ${envName}（不回显）`);
      return true;
    }
    if (!yaml) throw new Error('读不到 js-yaml，无法写凭据');
    let doc = {};
    if (existsSync(f)) {
      let parsed;
      try {
        parsed = yaml.load(readFileSync(f, 'utf8'));
      } catch (err) {
        quarantineCredentials(f, err);
      }
      if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
        quarantineCredentials(f, new Error('顶层不是对象'));
      }
      doc = parsed ?? {};
    }
    if (doc.refs !== undefined && (doc.refs === null || typeof doc.refs !== 'object' || Array.isArray(doc.refs))) {
      quarantineCredentials(f, new Error('refs 不是对象'));
    }
    if (doc.records !== undefined && (doc.records === null || typeof doc.records !== 'object' || Array.isArray(doc.records))) {
      quarantineCredentials(f, new Error('records 不是对象'));
    }
    doc.version = doc.version ?? 1;
    doc.records = doc.records ?? {};
    doc.refs = doc.refs ?? {};
    doc.refs[envName] = String(value);
    mkdirSync(dirname(f), { recursive: true });
    writeTextAtomic(f, yaml.dump(doc));
    log(`已更新凭据 ${envName}（不回显）`);
    return true;
  }

  function sessions() {
    try {
      const list = ctx.get('agents')?.list?.() ?? [];
      const rows = list
        .filter((a) => a && typeof a.followup === 'function' && !isSubAgent(a))
        .map((a) => ({ id: idOf(a), lastHumanAt: lastHumanAt(a) }))
        .sort((x, y) => y.lastHumanAt - x.lastHumanAt);
      return { ok: true, rows };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`枚举会话失败：${message}`);
      return { ok: false, error: message };
    }
  }

  function state() {
    const shared = readSharedModel(String(config.sharedModelEnv || process.env.PISCES_SHARED_MODEL_ENV || ''));
    let live = shared;
    try { live = pickModel(ctx.get('agents')?.list?.() ?? [], shared); } catch { /* 用 shared */ }
    const ov = readJson(OVERRIDE, {});
    return {
      koiHome: KOI,
      api: {
        // 三种模式：follow（跟随活跃会话）/ fixed（面板指定）/ manual（会话里手动选）
        mode: ['fixed', 'manual'].includes(ov?.api?.mode) ? ov.api.mode : 'follow',
        // review P3：follow 模式下展示 live，而不是上次保存的固定值（否则误导）
        provider: ov?.api?.mode === 'fixed' ? (ov.api.provider ?? live.provider) : live.provider,
        model: ov?.api?.mode === 'fixed' ? (ov.api.model ?? live.model) : live.model,
        // manual 时，会话里选过的模型留在会话里；这里只如实回显是否有手动覆盖
        manual: ov?.api?.mode === 'manual',
        live,
      },
      // AI 类配置一律跟随这里，别处不再各自写死。
      // chat=主聊天；vision=识图；gate=门控判断；iterate=提需求。空值表示"跟随 chat"。
      // 身份锚点文件：面板只显示路径、不编辑（身份不该在面板里随手改）。
      // 三种平台的写法都给出——用户可能从 Windows/macOS 上连过来看这份配置。
      // 身份锚点文件：面板只显示路径，不编辑。
      // 路径按 **DSH 部署所在的系统** 生成（path.join 自动用对分隔符）——
      // 不是按浏览器的系统：面板管的是服务器上的配置。
      coreFile: join(KOI, '.koi', 'profile.core.md'),
      proposal: { sessionId: String(ov?.proposal?.sessionId ?? '') },
      defaults: {
        wakeMinutes: ov?.defaults?.wakeMinutes ?? 5,
        injectLimit: ov?.defaults?.injectLimit ?? 6,
      },
      // 命名自由：用户给自己的 agent 命名；env 兜底，共享配置优先。
      // 2026-11-17：默认值不能写死某个具体人设——开源仓库里没有「谁」，
      // 只有结构。留空即由使用方配置。
      naming: {
        agentName: ov?.naming?.agentName ?? process.env.KOI_AGENT_NAME ?? '',
        selfTitle: ov?.naming?.selfTitle ?? process.env.KOI_SELF_TITLE ?? '',
        aliases: ov?.naming?.aliases ?? process.env.QQBOT_ALIASES ?? '',
        masterName: ov?.naming?.masterName ?? process.env.KOI_MASTER_NAME ?? '',
        ownerOid: process.env.KOI_OWNER_OID8 ?? '',
        ownerQQ: process.env.KOI_OWNER_QQ ?? '',
      },
    };
  }

  const send = (res, code, obj) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
  };
  const sendFailure = (res, err) => {
    const code = Number(err?.statusCode) || 500;
    send(res, code, { error: err instanceof Error ? err.message : String(err) });
  };
  const readBody = (req) => new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      rejectBody(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > 1_000_000) {
        chunks.length = 0;
        fail(httpError(413, '请求体超过 1MB'));
        req.resume?.();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        settled = true;
        resolveBody(body);
      } catch (err) {
        fail(httpError(400, `请求体不是合法 JSON：${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on('error', (err) => fail(httpError(400, `读取请求体失败：${err instanceof Error ? err.message : String(err)}`)));
  });


  // ── agent 的插件开关 ─────────────────────
  //
  // 只列**在 bundle patch 里注册过**的插件：decay / rules / says 是库，
  // 没有独立入口，关不掉也不该出现在开关里。
  //
  // 写入方式：在她的 cordis.patch.yml 里给对应 `- id:` 加 `disabled: true`。
  // 只改这一行，不动别人的配置。
  const KOI_PATCH_FILE = () => join(KOI, '.dsh-home', 'profiles', 'koi', 'cordis.patch.yml');
  const revisionOf = (text) => createHash('sha256').update(text).digest('hex');
  function readPatchText() {
    const file = KOI_PATCH_FILE();
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  }

  // toggleable: false 的是**库**——没有独立入口，关不掉，但也要列出来，
  // 否则页面上看不见它，会让人以为这套东西没有衰减/门控。
  /**
   * 插件清单**从磁盘扫出来**，不写死；写死以后改了还要再更新。
   *
   * 数据来源全部在包自己身上：
   *   · 分类/标签   ← package.json 的 dsh.pisces（跟包走，加插件不用改面板）
   *   · 插件 id     ← 该包 cordis.patch.yml 里的第一个 `- id:`
   *                   没有 = 库（被别的插件 import，没有独立入口），toggleable=false
   *   · 依赖        ← package.json 的 dependencies 里同样是插件的那些
   */
  const PLUGIN_DIR = () => join(KOI, 'plugins');

  function readPkgMeta(dir) {
    try {
      const d = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      return { name: d.name, deps: Object.keys(d.dependencies ?? {}), pisces: d.dsh?.pisces ?? {} };
    } catch { return null; }
  }

  /** 从包的 bundle patch 里取插件 id；没有就是库。 */
  function readPluginId(dir) {
    try {
      const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
      const m = patch.match(/^\s*- id:\s*(\S+)\s*$/m);
      return m ? m[1] : '';
    } catch { return ''; }
  }

  /**
   * agent 真正用到的包：从 profile 的 bundles 出发，按依赖闭包展开。
   *
   * 2026-11-17 codex review P2：不能把 `$KOI/plugins` 下的所有目录都当 agent 的插件。
   * deploy 会把宿主插件也复制到这里，它们的 id 属于宿主 profile——
   * 给它们一个开关，写进她的 patch 既不会加载也不会禁用，纯属骗人。
   */
  function koiClosure() {
    const profile = join(KOI, '.dsh-home', 'profiles', 'koi', 'package.json');
    let roots = [];
    try {
      const d = JSON.parse(readFileSync(profile, 'utf8'));
      roots = [...(d?.dsh?.profile?.bundles ?? []), ...Object.keys(d?.dependencies ?? {})];
    } catch { return null; }   // 读不到就不限制（宁可多列）

    // 包名 → dependencies，按闭包展开
    const depsOf = new Map();
    try {
      for (const e of readdirSync(PLUGIN_DIR(), { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const meta = readPkgMeta(join(PLUGIN_DIR(), e.name));
        if (meta) depsOf.set(meta.name, meta.deps);
      }
    } catch { return null; }

    const seen = new Set();
    const queue = [...roots];
    while (queue.length > 0) {
      const n = queue.pop();
      if (seen.has(n)) continue;
      seen.add(n);
      for (const d of depsOf.get(n) ?? []) if (!seen.has(d)) queue.push(d);
    }
    return seen;
  }

  function pluginCatalog() {
    let dirs = [];
    try { dirs = readdirSync(PLUGIN_DIR(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
    catch { return []; }

    const closure = koiClosure();
    const rows = [];
    for (const name of dirs) {
      const dir = join(PLUGIN_DIR(), name);
      const meta = readPkgMeta(dir);
      if (!meta || !String(meta.name ?? '').startsWith('dsh-')) continue;
      // 不在她的依赖闭包里 = 不是她的东西，不列
      if (closure && !closure.has(meta.name)) continue;
      const id = readPluginId(dir);
      rows.push({
        id: id || meta.name,
        pkg: meta.name,
        label: meta.pisces.label ?? meta.name,
        desc: meta.pisces.desc ?? '',
        cat: meta.pisces.category ?? 'other',
        depPkgs: meta.deps.filter((d) => dirs.includes(d)),
        toggleable: id !== '',
        why: id === '' ? '库：被别的插件 import，没有独立入口' : '',
      });
    }

    // 2026-11-17 codex review P1：deps 存的是**包名**，而写盘判据用的是**插件 id**
    // (`dsh-koi-chat` vs `koi-chat`)。不映射这一层，联动永远判空 ——
    // 「依赖被关也能打开」，界面上还不显示。
    const idByPkg = new Map(rows.map((r) => [r.pkg, r.id]));
    for (const r of rows) r.deps = r.depPkgs.map((d) => idByPkg.get(d)).filter(Boolean);
    return rows;
  }

  /** 读 patch，判断某个 id 是不是 disabled。 */
  function readDisabled(text, id) {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => new RegExp(`^- id: ${escapeRegExp(id)}$`).test(l));
    if (start < 0) return false;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^- /.test(lines[i])) break;          // 下一个顶层条目
      if (/^  disabled:\s*true\s*$/.test(lines[i])) return true;
    }
    return false;
  }

  /**
   * 写开关。没有该条目就补一条；有就改 `disabled` 行。
   * @returns {{ok: boolean, error?: string}}
   */
  function writeDisabled(id, disabled, expectedRevision) {
    const file = KOI_PATCH_FILE();
    try {
      const text = readPatchText();
      const revision = revisionOf(text);
      if (expectedRevision === '' || expectedRevision !== revision) {
        return {
          ok: false,
          conflict: true,
          revision,
          error: '配置文件已被改动，请刷新后重试',
        };
      }
      const lines = text.split('\n');
      const start = lines.findIndex((l) => new RegExp(`^- id: ${escapeRegExp(id)}$`).test(l));
      if (start < 0) {
        // 没这个条目：追加到末尾（顶层）
        const add = disabled ? [`- id: ${id}`, '  disabled: true'] : [`- id: ${id}`, '  disabled: false'];
        const next = `${text.replace(/\s*$/, '')}\n\n${add.join('\n')}\n`;
        mkdirSync(dirname(file), { recursive: true });
        writeTextAtomic(file, next);
        return { ok: true, revision: revisionOf(next) };
      }
      // 有：在这个块里找 disabled 行
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i += 1) if (/^- /.test(lines[i])) { end = i; break; }
      const block = lines.slice(start, end);
      const di = block.findIndex((l) => /^  disabled:/.test(l));
      if (di >= 0) block[di] = `  disabled: ${disabled}`;
      else block.splice(1, 0, `  disabled: ${disabled}`);
      const next = [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n');
      writeTextAtomic(file, next);
      return { ok: true, revision: revisionOf(next) };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  function pluginList() {
    const text = readPatchText();
    const revision = revisionOf(text);
    return pluginCatalog().map((p) => ({
      ...p,
      revision,
      toggleable: p.toggleable !== false,
      enabled: p.toggleable === false ? true : !readDisabled(text, p.id),
      // 依赖里只要有一个是关的，这个也开不了
      blockedBy: p.deps.filter((d) => readDisabled(text, d)),
    }));
  }

  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.webServer;
    if (webServer === undefined || typeof webServer.register !== 'function') { log('webServer 不可用'); return; }
    const disposers = [
      webServer.register({ kind: 'exact', path: '/pisces/state', handler: (q, s) => send(s, 200, state()) }),
      webServer.register({ kind: 'exact', path: '/pisces/models', handler: (q, s) => send(s, 200, models()) }),
      webServer.register({
        kind: 'exact', path: '/pisces/key',
        handler: async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
          try {
            const body = await readBody(req);
            const envName = String(body?.env ?? '').trim();
            const value = String(body?.value ?? '').trim();
            if (!envName || !value) return send(res, 400, { error: 'env 和 value 都要给' });
            await setKey(envName, value);
            send(res, 200, { ok: true, env: envName });
          } catch (err) {
            sendFailure(res, err);
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: '/pisces/sessions',
        handler: (q, s) => {
          const result = sessions();
          if (!result.ok) return send(s, 500, { error: result.error });
          send(s, 200, result.rows);
        },
      }),
      webServer.register({ kind: 'exact', path: '/pisces/plugins', handler: (q, s) => send(s, 200, pluginList()) }),
      webServer.register({
        kind: 'exact', path: '/pisces/plugins/toggle',
        handler: async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
          try {
            const body = await readBody(req);
            const id = String(body?.id ?? '');
            const revision = String(body?.revision ?? '');
            const entry = pluginCatalog().find((p) => p.id === id);
            if (!entry) return send(res, 400, { error: `未知插件 id：${id}` });
            const currentText = readPatchText();
            // 联动：要打开时，依赖必须都开着；要关闭时，没被别的插件依赖
            if (body?.enabled) {
              const blocked = entry.deps.filter((d) => readDisabled(currentText, d));
              if (blocked.length > 0) return send(res, 409, { error: `先打开依赖：${blocked.join('、')}` });
            }
            const r = writeDisabled(id, body?.enabled === false, revision);
            if (r.conflict) return send(res, 409, r);
            if (!r.ok) return send(res, 500, r);
            send(res, 200, { ok: true, plugins: pluginList(), needRestart: true });
          } catch (err) {
            sendFailure(res, err);
          }
        },
      }),
      webServer.register({
        kind: 'exact', path: '/pisces/override',
        handler: async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
          try {
            const body = await readBody(req);
            let ov = {};
            if (existsSync(OVERRIDE)) {
              try {
                ov = JSON.parse(readFileSync(OVERRIDE, 'utf8'));
              } catch (err) {
                throw new Error(`现有 override 不是合法 JSON，拒绝覆盖：${err instanceof Error ? err.message : String(err)}`);
              }
            }
            let changed = false;
            for (const key of ['api', 'proposal', 'defaults', 'naming', 'ai']) {
              if (body?.[key] && typeof body[key] === 'object' && !Array.isArray(body[key])) {
                ov[key] = { ...ov[key], ...body[key] };
                changed = true;
              }
            }
            if (!changed) throw httpError(400, '请求里没有可写入的配置字段');
            mkdirSync(dirname(OVERRIDE), { recursive: true });
            const next = JSON.stringify(ov, null, 2) + '\n';
            writeTextAtomic(OVERRIDE, next);
            log('override 已更新');
            send(res, 200, { ok: true, override: ov });
          } catch (err) {
            sendFailure(res, err);
          }
        },
      }),
    ];
    log('v2 路由已挂：state/models/sessions/override');
    return () => { for (const d of disposers) { try { d(); } catch { /* 忽略 */ } } };
  });
}
