/**
 * dsh-ashu-chat —— 「Pisces 聊天」：ashu 侧与参考 agent 的对话面板。
 *
 * 做什么：
 *   · 左栏一个入口，和「Pisces 配置」并列
 *   · **新建并固定一个会话**（不是管理多个会话，也不删除任何东西）
 *   · 直接在这里收发消息
 *
 * 怎么打通：走既有的文件通道 `koi/.koi/chat.jsonl`。
 *   - 宿主侧：追加一行签名消息（和 ops/say-to-koi.mjs 同一套签名）
 *   - agent 侧：chat 插件追加一行，这里读出来显示
 *
 * 为什么不用它自己的会话管理：
 *   会话由 qqbot 按 QQ peer 自动分，硬造/硬删会破坏运行数据。所以这里只做
 *   「在**宿主侧**新建一个会话并固定为投递目标」——agent 的消息会进这个会话，
 *   面板显示的是同一条通道的内容。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadKey, sign } from 'dsh-koi-chat/lib/sign.js';
import { append, readAllSafe } from 'dsh-koi-chat/lib/chat-store.js';

export const name = 'ashu-chat';
export const inject = ['webServer'];

/** 只取最近这么多条，别把整个历史塞进面板。 */
const TAIL = 80;
const MAX_BODY = 1024 * 1024;

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

export function apply(ctx, config = {}) {
  // 部署位置走配置 / KOI_HOME；都没有时按「同一台机器上 koi 的家目录」推
  const KOI = String(config.koiHome || process.env.KOI_HOME || join(homedir(), 'koi'));
  const DATA = join(KOI, '.koi');
  const CHAT = join(DATA, 'chat.jsonl');
  // 她读白名单里有 workspace，所以文件放这里她就能 read 到
  const UPLOAD_DIR = join(DATA, 'workspace', 'uploads');
  const MAX_FILE = 20 * 1024 * 1024; // 20MB
  const MAX_UPLOAD_BODY = Math.ceil(MAX_FILE * 4 / 3) + 64 * 1024;
  const KEY = join(DATA, 'chat.key');
  const OVERRIDE = join(DATA, 'ashu-config.json');

  const log = (m) => console.log(`[ashu-chat] ${m}`);
  const webServer = ctx.webServer ?? ctx.get?.('webServer');
  if (!webServer?.register) {
    log('没有 webServer 服务，面板路由不会挂载');
    return () => {};
  }

  // ── 小工具 ──────────────────────────────────────────────
  function readBody(req, maxBytes = MAX_BODY) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      req.on('data', (c) => {
        if (settled) return;
        const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
        size += chunk.length;
        if (size > maxBytes) {
          chunks.length = 0;
          fail(httpError(413, `请求体超过上限（${(maxBytes / 1048576).toFixed(1)}MB）`));
          req.resume?.();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (settled) return;
        try {
          const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
          settled = true;
          resolve(body);
        } catch (e) {
          fail(httpError(400, `请求体不是合法 JSON：${e instanceof Error ? e.message : String(e)}`));
        }
      });
      req.on('error', (e) => fail(httpError(400, `读取请求体失败：${e instanceof Error ? e.message : String(e)}`)));
    });
  }

  const send = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  function readJson(file, fallback) {
    try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; }
    catch (e) { log(`读 ${file} 失败：${String(e)}`); return fallback; }
  }

  /** chat.jsonl 全量读成数组；坏行跳过，但必须计数并在响应里标出来。 */
  function readMessages() {
    const report = readAllSafe(CHAT);
    if (!report.readable) {
      log(`读 chat.jsonl 失败：${report.error}`);
      return { messages: [], badLines: report.badLines, readError: report.error };
    }
    const messages = report.messages
      .filter((x) => x && typeof x.text === 'string')
      // 只要 master ↔ koi 这一段。ashu ↔ koi 是另一条线，不在这里显示。
      // 必须**双向都有明确收件人**才显示。
      // 原来 master 那条允许 to 缺失，于是有人直接写 from:'master' 不标 to，
      // 也会混进面板，冒出一条「主人说的话」。
      .filter((x) => (x.from === 'master' && x.to === 'koi')
        || (x.from === 'koi' && x.to === 'master'))
      .slice(-TAIL);
    if (report.badLines > 0) {
      log(`chat.jsonl 有 ${report.badLines} 行不是合法 JSON，已跳过并在响应中标记`);
    }
    return { messages, badLines: report.badLines, readError: '' };
  }

  /** 发一条签名消息给 agent（与 ops/say-to-koi.mjs 同一套签名）。 */
  function post(text, kind, file) {
    const body = String(text ?? '').trim();
    if (body === '' && !file) throw new Error('空消息不发');
    // 这个面板是「owner ↔ agent」，不是 ashu 的通道。
    // from/to 必须写清，否则两条线会混。
    const entry = { from: 'master', to: 'koi', at: Date.now(), text: body };
    // 标清来源。签名只能证明「来自 ashu 这台机器」，
    // **分不出是 owner 敲的还是 ashu 写的**——两边用的是同一把 key。
    // 真正的人是谁，靠的是 Web 登录；这个字段至少让来源可见。
    entry.via = 'panel';
    if (kind === 'request') entry.kind = 'request';
    if (file) entry.file = file;
    try {
      const key = loadKey(KEY);
      if (key) entry.sig = sign(entry, key);
    } catch (e) {
      log(`签名失败（仍按未署名发送）：${String(e)}`);
    }
    const result = append(CHAT, entry);
    if (!result.ok) throw new Error(`写不进 chat.jsonl：${result.error}`);
    return entry;
  }

  /** 文件名消毒：只留基名，去掉路径分隔符和控制字符。 */
  function safeName(raw) {
    const base = String(raw ?? '').split(/[\\/]/).pop() ?? '';
    const cleaned = base.replace(/[\x00-\x1f<>:"|?*]/g, '').trim();
    return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned.slice(0, 120);
  }

  /** 保存上传内容到 agent 的 workspace/uploads，返回相对路径与元信息。 */
  function saveUpload(name, base64) {
    const buf = Buffer.from(String(base64 ?? ''), 'base64');
    if (buf.length === 0) throw new Error('空文件');
    if (buf.length > MAX_FILE) throw httpError(413, `文件太大（${(buf.length / 1048576).toFixed(1)}MB > ${MAX_FILE / 1048576}MB）`);
    const clean = safeName(name);
    // 加时间戳前缀：同名不覆盖，按名字也能看出先后
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const finalName = `${stamp}-${clean}`;
    mkdirSync(UPLOAD_DIR, { recursive: true });
    const abs = join(UPLOAD_DIR, finalName);
    writeFileSync(abs, buf);
    return {
      name: clean,
      path: abs,
      rel: join('workspace', 'uploads', finalName),
      size: buf.length,
    };
  }

  // 2026-11-16：这个面板不再碰会话。
  // 「owner ↔ agent」的会话由 chat 插件自己按来源建（session-chat-master-…），
  // 「ashu ↔ koi」的投递目标在 Pisces 配置面板里选。混在一处分不清谁跟谁。
  // ── 路由 ────────────────────────────────────────────────
  const routes = [
    {
      path: '/pisces-chat/state',
      handler: async (q, s) => {
        const report = readMessages();
        send(s, 200, {
          messages: report.messages,
          chatFile: CHAT,
          badLines: report.badLines,
          degraded: report.badLines > 0 || report.readError !== '',
          readError: report.readError,
        });
      },
    },
    {
      // 文件上传：{ name, data(base64), text? }
      // 存进 agent 的 workspace/uploads（在读白名单里），再发一条带 file 的消息。
      path: '/pisces-chat/upload',
      handler: async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
        try {
          const body = await readBody(req, MAX_UPLOAD_BODY);
          const info = saveUpload(body?.name, body?.data);
          const hint = String(body?.text ?? '').trim();
          const text = hint || `发了文件：${info.name}（${(info.size / 1024).toFixed(0)}KB），用 read 打开。`;
          const entry = post(text, undefined, { name: info.name, path: info.path, rel: info.rel, size: info.size });
          log(`已收文件 ${info.name}（${info.size}B）→ ${info.rel}`);
          send(res, 200, { ok: true, entry, file: info });
        } catch (e) { send(res, Number(e?.statusCode) || 500, { error: String(e) }); }
      },
    },
    {
      // 下载/预览：只允许 uploads 目录内的文件，防目录穿越
      path: '/pisces-chat/file',
      handler: (q, s) => {
        try {
          const url = new URL(q.url, 'http://localhost');
          const rel = String(url.searchParams.get('rel') ?? '');
          const abs = join(DATA, rel);
          const root = join(DATA, 'workspace');
          if (!abs.startsWith(root + '/')) return send(s, 403, { error: 'out of scope' });
          if (!existsSync(abs)) return send(s, 404, { error: 'not found' });
          const buf = readFileSync(abs);
          s.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(abs.split('/').pop())}"`,
            'Cache-Control': 'no-store',
          });
          s.end(buf);
        } catch (e) { send(s, 500, { error: String(e) }); }
      },
    },
    {
      path: '/pisces-chat/send',
      handler: async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
        try {
          const body = await readBody(req);
          const entry = post(body?.text, body?.kind);
          send(res, 200, { ok: true, entry });
        } catch (e) { send(res, Number(e?.statusCode) || 500, { error: String(e) }); }
      },
    },
  ];

  for (const r of routes) {
    webServer.register({ kind: 'exact', path: r.path, handler: r.handler });
  }

  log(`已挂载：${routes.map((r) => r.path).join('、')}｜通道 ${CHAT}`);
  return () => {};
}
