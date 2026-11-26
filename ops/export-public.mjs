#!/usr/bin/env node
/**
 * export-public.mjs —— 生成「通用公开副本」（Pisces 开源 A 步）。
 *
 * 底线：**不碰源仓库里的记忆**。本脚本只读源码/身份卡，
 * 产出一个独立的 sanitize 副本；活仓库一个字节不改。
 * 数据结构优化（v2/v3）不在此做——那需要参考 agent 配合，另行安排。
 *
 * 做法：
 *   1 拷贝 plugins/tools/ops运行时/docs 到 DEST（排除 node_modules/.koi/backups/.bak）
 *   2 用「真人→占位」替换表清洗副本里的私人标识（owner+群友，来自身份卡，只读）
 *   3 生成通用模板数据 + 中性 persona + LICENSE + README（示例用假名，不含真实记忆）
 *   4 扫描副本，任何私人标识残留即报错退出
 *
 * 用法：node ops/export-public.mjs [DEST]   默认 <home>/pisces-public
 */
import { cpSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = process.argv[2] || process.env.PUBLIC_DIR || join(homedir(), 'pisces-public');
/**
 * 身份卡从哪读：
 *   ① `KOI_HOME`（显式）
 *   ② 同级的 `../koi`（本机布局：agent 的活仓库）
 * 读不到就**直接失败**——空替换表会生成一份"看起来通过了"的泄漏副本，
 * 比报错糟糕得多（2026-11-26 实测：表为空，脚本还打印"零私人标识残留"）。
 */
const KOI = process.env.KOI_HOME || join(ROOT, '..', 'koi');
if (existsSync(DEST)) {
  if (!statSync(DEST).isDirectory() || readdirSync(DEST).length > 0) {
    console.error(
      `❌ 目标目录必须不存在或为空：${DEST}\n`
      + '   避免覆盖已有文件，或把目标里的 node_modules 当作源码递归清洗。',
    );
    process.exit(2);
  }
}

// ── 1. 替换表：真人 → 占位（只读身份卡，不写）─────────────────
const CN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
/**
 * 2026-11-26 修：原来把 `['agent','agent']`、`['主人','主人']` 这种**自我映射**
 * 也塞进 `subs`，然后扫残留时又拿 `subs` 当"私人词"清单——
 * 结果副本里出现 "agent" 这种通用词就被判成泄漏，导出**永远失败**。
 *
 * 现在分成两份：
 *   subs      真正要替换的（真人名 / id）
 *   NEUTRAL   本来就不含隐私、不需要替换的通用词（不参与残留扫描）
 */
const NEUTRAL = ['agent', '主人', 'owner000', '0000000000'];
const subs = [];
const SHORT_FORM_BOUNDARY = /(?<![A-Za-z0-9_])%TERM%(?![A-Za-z0-9_\p{Script=Han}])/gu;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addSub(real, placeholder, shortForm = false) {
  if (!real || real === placeholder || subs.some(([term]) => term === real)) return;
  subs.push([real, placeholder, shortForm]);
}

/**
 * 从 agent 全名派生常见短形态。
 * `阿X` -> `小X`、`X退下了`、独立的 `X`。
 * 前两个是完整词，直接替换；单字短名允许出现在中文句子中，
 * 但前面不能紧贴 ASCII 标识符、后面不能继续接汉字，
 * 避免把含相同字形的普通词或标识符误伤。
 */
function addAgentName(real, placeholder) {
  addSub(real, placeholder);
  if (!/^阿./u.test(real)) return;
  const short = [...real].slice(1).join('');
  if (!short) return;
  addSub(`小${short}`, placeholder);
  addSub(`${short}退下了`, `${placeholder}退下了`);
  addSub(short, placeholder, true);
}

let lexiconLoaded = false;
let lexiconPeople = 0;
try {
  const lex = JSON.parse(readFileSync(join(KOI, '.koi', 'lexicon.json'), 'utf8'));
  const people = lex.people ?? lex.v3?.people ?? {};
  lexiconPeople = Object.keys(people).length;
  lexiconLoaded = true;
  let i = 0;
  for (const [oid, v] of Object.entries(people)) {
    const name = typeof v === 'string' ? v : (v?.name ?? '');
    if (!name || name === '主人') continue;
    const ph = `人物${CN[i % CN.length]}${i >= CN.length ? i : ''}`;
    addSub(name, ph);
    if (/^[0-9a-f]{8}$/i.test(oid)) addSub(oid, String(i + 1).padStart(8, '0'));
    i += 1;
  }
} catch { /* 身份卡读不到就用基础表 */ }

/**
 * agent 自己的名字和口音**不在 lexicon 里**（lexicon 记的是别人）。
 * 从核心设定读：`koi：…` / `owner：…` / `ashu：…` 这种行首。
 * 实测漏过：`ops/start.sh` 里的启动器注释原样进了公开副本。
 */
try {
  const core = readFileSync(join(KOI, '.koi', 'profile.core.md'), 'utf8');
  for (const line of core.split('\n')) {
    const m = /^([^\s：:]{1,8})\s*[：:]/.exec(line.trim());
    if (m === null) continue;
    const name = m[1];
    if (NEUTRAL.includes(name)) continue;
    addAgentName(name, 'agent');
  }
} catch {
  console.error(
    `❌ 核心设定读不到（${join(KOI, '.koi', 'profile.core.md')}）。\n`
    + '   没有核心设定就可能漏掉 agent 自己的名字，不能生成公开副本。\n'
    + '   指定来源：KOI_HOME=/path/to/agent node ops/export-public.mjs',
  );
  process.exit(2);
}
subs.sort((a, b) => b[0].length - a[0].length); // 长的先替换
if (!lexiconLoaded) {
  console.error(
    `❌ 身份卡读不到（${join(KOI, '.koi', 'lexicon.json')}）。\n`
    + '   没有身份表就不知道要替换谁，副本会是「扫描通过但没清洗」的假货。\n'
    + '   指定来源：KOI_HOME=/path/to/agent node ops/export-public.mjs',
  );
  process.exit(2);
}
if (subs.length === 0) {
  console.error(
    `❌ 取不到身份卡（${join(KOI, '.koi', 'lexicon.json')}），替换表为空。\n`
    + '   空表 = 副本里真人名一个都不会被替换，但脚本会"扫描通过"——必须停下来。\n'
    + '   指定来源：KOI_HOME=/path/to/agent node ops/export-public.mjs',
  );
  process.exit(2);
}
/** 扫描只认「真的被替换过的」+ 硬性格式（openid / QQ 号 / 路径 / token 等） */
const privateTokens = subs.map(([real]) => real).filter((t) => t !== '' && !NEUTRAL.includes(t));

const TEXT_EXT = new Set(['.js', '.mjs', '.md', '.yml', '.yaml', '.json', '.ts', '.sh', '.txt']);

/**
 * 2026-11-26 review P1：**不能对代码做全局字符串替换**。
 * 身份表里只要出现一个和包名/import/依赖同形的词（比如 agent 名恰好是 `koi`），
 * 全局替换会把 `dsh-koi-memory` 改成别的东西，副本直接装不起来、语义也坏了。
 *
 * 折中：
 *   - 代码文件：只替换**注释与字符串里**出现的真人名（按行判断，不碰标识符行）
 *   - 文档/文本：正常替换
 *   - 任何情况下都不替换 package.json 的 name/exports、lockfile、import 语句
 */
const CODE_EXT = new Set(['.js', '.mjs', '.ts']);
const NEVER_TOUCH = /^\s*(import|export|require)\b/;

function replaceSubs(text) {
  for (const [real, ph, shortForm] of subs) {
    if (!shortForm) {
      text = text.split(real).join(ph);
      continue;
    }
    const pattern = SHORT_FORM_BOUNDARY.source.replace('%TERM%', escapeRegExp(real));
    text = text.replace(new RegExp(pattern, 'gu'), ph);
  }
  return text;
}

function sanitizeLine(line, isCode) {
  if (!isCode) return replaceSubs(line);
  // 代码：跳过 import/export/require 行，跳过含包名的行
  if (NEVER_TOUCH.test(line) || /dsh-(koi|ashu|pisces)-/.test(line) && /from ['"]/.test(line)) return line;
  return replaceSubs(line);
}

/**
 * 2026-11-27：**代码文件不做人名替换**。
 *
 * 原来替换表全局作用到 .js/.mjs，结果把 exit 正则里的名字也换成了导出占位词
 * （退场正则里被塞进了导出占位词），公开副本里出现一串只有导出器才认识的怪词，
 * 而且改动了可执行逻辑。现在：
 *   - 代码：**原样保留**（源码本身已经不含真实人名，这是前置条件）
 *   - 文档/配置（.md/.txt/.yml/.json/.sh）：正常替换
 * 前面已经断言"源码不含真实人名"，这里不再重复兜底。
 */
function sanitize(content, file) {
  if (CODE_EXT.has(extname(file))) return content;
  return content.split('\n').map((line) => sanitizeLine(line, false)).join('\n');
}

/**
 * package.json 的包名、入口、依赖和脚本是结构字段，替换会直接破坏安装。
 * 只清洗显示给用户看的文本字段。
 */
const PACKAGE_STRUCTURAL_FIELDS = new Set([
  'name', 'version', 'exports', 'main', 'dependencies', 'devDependencies',
  'scripts', 'files', 'private', 'license', 'type', 'engines', 'packageManager',
]);
const HUMAN_TEXT_FIELDS = new Set([
  'description', 'label', 'desc', 'title', 'summary', 'displayName', 'display_name', 'tagline',
  'author', 'contributors', 'maintainers', 'keywords',
]);

function sanitizePackageValue(value, key, humanContext = false) {
  const inHumanField = humanContext || HUMAN_TEXT_FIELDS.has(key);
  if (typeof value === 'string') {
    return inHumanField ? replaceSubs(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePackageValue(item, key, inHumanField));
  }
  if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      value[childKey] = sanitizePackageValue(childValue, childKey, inHumanField);
    }
  }
  return value;
}

function sanitizePackageJson(content, file) {
  let pkg;
  try {
    pkg = JSON.parse(content);
  } catch (error) {
    console.error(`❌ package.json 无法解析：${file}\n   ${error.message}`);
    process.exit(2);
  }
  for (const [key, value] of Object.entries(pkg)) {
    if (!PACKAGE_STRUCTURAL_FIELDS.has(key)) pkg[key] = sanitizePackageValue(value, key);
  }
  return JSON.stringify(pkg, null, 2) + '\n';
}

// ── 2. 拷贝（排除私有/产物）─────────────────────────────────
const EXCLUDE = /node_modules|dist|\.koi|backups|\.bak|\.old|\.git|sessions|storages|attachments|guard-ledger|开源准备审计|HARVEST|MEMORY|\.log|(^|[\\/])archive([\\/]|$)/;
const WALK_SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
mkdirSync(DEST, { recursive: true });
/** 这些是一个能安装的仓库必需的（2026-11-26：之前只拷了 4 个目录，副本 pnpm install 都跑不了） */
/**
 * 顶层白名单。**本地化 README 要一起带**：只拷 README.md 会让公开副本丢掉中文版
 * （2026-11-27 实测：副本里只剩 README.md，`README.zh-CN.md` 没进发布包）。
 */
const LOCALE_READMES = readdirSync(ROOT).filter((f) => /^README\.[A-Za-z-]+\.md$/.test(f));
for (const f of [
  'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'install.sh', 'LICENSE', 'README.md',
  '.gitignore', '.editorconfig', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md',
  ...LOCALE_READMES,
]) {
  const src = join(ROOT, f);
  if (existsSync(src)) cpSync(src, join(DEST, f));
}
for (const top of ['plugins', 'tools', 'ops', 'docs', 'examples', 'prompts', '.github']) {
  const src = join(ROOT, top);
  if (!existsSync(src)) continue;
  cpSync(src, join(DEST, top), {
    recursive: true,
    filter: (s) => !EXCLUDE.test(s.replace(src, '')),
  });
}
// 清洗所有文本文件
function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) {
      if (!WALK_SKIP_DIRS.has(e.name)) walk(p);
      continue;
    }
    if (!e.isFile()) continue;
    if (!TEXT_EXT.has(extname(p))) continue;
    if (basename(p) === 'pnpm-lock.yaml') continue;
    const content = readFileSync(p, 'utf8');
    // package.json 只清洗人类文本字段；包名、入口和依赖图必须保持原样。
    if (basename(p) === 'package.json') writeFileSync(p, sanitizePackageJson(content, p), 'utf8');
    else writeFileSync(p, sanitize(content, p), 'utf8');
  }
}
walk(DEST);

// ── 3. 通用模板（假名，不含真实记忆）─────────────────────────
mkdirSync(join(DEST, 'examples', 'data'), { recursive: true });
writeFileSync(join(DEST, 'examples', 'data', 'lexicon.json'), JSON.stringify({
  version: 3, people: { '00000001': { name: '人物甲', items: [] }, '00000002': { name: '人物乙', items: [] } },
  things: {}, self: [], curves: {}, archive: [],
}, null, 2) + '\n');
writeFileSync(join(DEST, 'examples', 'data', 'medium.jsonl'),
  JSON.stringify({ id: 'ex000001', at: Date.now(), scope: 'medium', curve: { alpha: 0.26 }, tier: 'normal', source: 'seen', verified: true, who: '人物甲', body: { text: '示例：人物甲喜欢深烘咖啡。' } }) + '\n');
writeFileSync(join(DEST, 'examples', 'data', 'long.jsonl'),
  JSON.stringify({ id: 'ex000002', at: Date.now(), scope: 'long', source: 'seen', verified: true, body: { text: '示例：长期记忆不衰减。' } }) + '\n');
writeFileSync(join(DEST, 'examples', 'persona.template.md'),
  '# 人设模板（中性）\n\n你是一个聊天 agent。沉默=什么都不输出；括号=底稿不发；@ 对不上自己不接。\n（把这里换成你自己的角色设定；不要放真人隐私。）\n');
// 2026-11-26 review P1：以前这里用脚本里写死的**截断版** MIT 覆盖了仓库里完整的 LICENSE。
// 现在只在副本缺 LICENSE 时才写，且与仓库根的那份保持一致。
if (!existsSync(join(DEST, 'LICENSE')) || readFileSync(join(DEST, 'LICENSE'), 'utf8').length < 500) {
  writeFileSync(join(DEST, 'LICENSE'), readFileSync(join(ROOT, 'LICENSE')));
}
// 2026-11-26 review P1：也不再用脚本里的简版 README 覆盖仓库真实 README
// （那会把快速上手、包清单、文档链接全删掉）。README 已在上面按文件拷贝过。

// ── 4. 用与 CI 相同的扫描器断言副本真的干净 ─────────────────
const scanDenylist = [
  ...privateTokens,
  ...(process.env.PRIVACY_DENYLIST ?? '').split(',').map((term) => term.trim()).filter(Boolean),
];
const scan = spawnSync(
  process.execPath,
  [join(ROOT, 'tools', 'privacy-scan.mjs'), '--root', DEST, '--denylist', [...new Set(scanDenylist)].join(',')],
  { stdio: 'inherit' },
);
if (scan.error) {
  console.error(`❌ 无法启动隐私扫描器：${scan.error.message}`);
  process.exit(2);
}
if (scan.status === 1) {
  console.error(`❌ 公开副本仍有私人标识残留：${DEST}`);
  process.exit(1);
}
if (scan.status !== 0) {
  console.error(`❌ 公开副本隐私扫描无法执行（退出码 ${scan.status ?? 'unknown'}）：${DEST}`);
  process.exit(2);
}
console.log(`✅ 公开副本已生成并通过隐私扫描：${DEST}（替换 ${subs.length} 项）`);
