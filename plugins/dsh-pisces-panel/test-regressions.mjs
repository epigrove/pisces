#!/usr/bin/env node
/**
 * Pisces panel 回归：插件 id 按字面量匹配，不能被 . / + 当成正则元字符。
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from './index.js';

const dir = mkdtempSync(join(tmpdir(), 'pisces-panel-regexp-'));
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理 */ } });

const patchFile = join(dir, '.dsh-home', 'profiles', 'koi', 'cordis.patch.yml');
mkdirSync(join(dir, '.dsh-home', 'profiles', 'koi'), { recursive: true });
writeFileSync(patchFile, [
  '- id: koiAchatt',
  '  disabled: true',
  '',
  '- id: koi.chat+',
  '',
].join('\n'), 'utf8');

for (const [name, pkg, id] of [
  ['decoy', 'dsh-decoy', 'koiAchatt'],
  ['target', 'dsh-target', 'koi.chat+'],
]) {
  const pluginDir = join(dir, 'plugins', name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
    name: pkg,
    dsh: { pisces: { label: name, category: 'test' } },
  }), 'utf8');
  writeFileSync(join(pluginDir, 'cordis.patch.yml'), `- id: ${id}\n`, 'utf8');
}

const routes = new Map();
const ctx = {
  get: () => undefined,
  inject(_deps, fn) {
    fn({
      webServer: {
        register(route) {
          routes.set(route.path, route);
          return () => {};
        },
      },
    });
  },
};

apply(ctx, { koiHome: dir });

async function responseOf(handler, req = {}) {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(code, headers) { this.statusCode = code; this.headers = headers ?? {}; },
    end(body = '') { this.body = String(body); },
  };
  await handler(req, res);
  return { ...res, json: res.body ? JSON.parse(res.body) : null };
}

function postReq(body) {
  const req = new EventEmitter();
  req.method = 'POST';
  queueMicrotask(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const listed = await responseOf(routes.get('/pisces/plugins').handler);
const target = listed.json.find((p) => p.id === 'koi.chat+');
const decoy = listed.json.find((p) => p.id === 'koiAchatt');
ok('读取 disabled 时 id 按字面量匹配', target?.enabled === true && decoy?.enabled === false,
  JSON.stringify(listed.json));

const toggled = await responseOf(
  routes.get('/pisces/plugins/toggle').handler,
  postReq({ id: 'koi.chat+', enabled: false, revision: target.revision }),
);
const after = readFileSync(patchFile, 'utf8');
const targetBlock = /- id: koi\.chat\+\n(?:  .*\n?)*/.exec(after)?.[0] ?? '';
const decoyBlock = /- id: koiAchatt\n(?:  .*\n?)*/.exec(after)?.[0] ?? '';
ok('写 disabled 时只改目标 id 条目',
  toggled.statusCode === 200
    && targetBlock.includes('disabled: true')
    && decoyBlock.includes('disabled: true')
    && !decoyBlock.includes('disabled: false'),
  after);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
