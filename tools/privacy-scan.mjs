#!/usr/bin/env node
/**
 * Repository privacy scanner shared by CI and public-copy export.
 *
 * Usage:
 *   node tools/privacy-scan.mjs [--root DIR] [--denylist "term-a,term-b"] [--json]
 *
 * Exit codes:
 *   0  clean
 *   1  one or more findings
 *   2  invalid arguments or an unreadable input
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');
const SKIP_DIRS = new Set(['.git', 'dist', 'node_modules']);
const PRIVATE_PATH_EXTENSIONS = new Set([
  '.js', '.mjs', '.md', '.yml', '.yaml', '.json', '.sh', '.txt', '.toml',
]);
const HEX_8_EXTENSIONS = new Set(['.js', '.mjs', '.md', '.json', '.yml']);
const HEX_8 = /(?<![0-9A-Za-z_])[0-9a-f]{8}(?![0-9A-Za-z_])/gi;
const HEX_32 = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi;
const DIGITS_9_12 = /(?<![0-9A-Za-z_])\d{9,12}(?![0-9A-Za-z_])/g;
const EMAIL = /(?<![A-Za-z0-9._%+@-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const OPENAI_TOKEN = /\bsk-[A-Za-z0-9_-]{12,}\b/;
const GITHUB_TOKEN = /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/;
const AWS_KEY = /\bAKIA[A-Z0-9]{16}\b/;
const TEST_FILE = /^test-.*\.[cm]?js$/i;
const TEST_PLACEHOLDER_CONTEXT = /placeholder|fixture|dummy|mock|example|sample|fake|占位|夹具|示例|某个昵称|某人|路人|陌生人|旧名字/i;
const KNOWN_NUMERIC_PLACEHOLDERS = new Set([
  '000000000', '0000000000', '012345678', '0123456789',
  '111111111', '1111111111', '123456789', '1234567890',
  '12345678901', '123456789012', '604800000',
]);
const KNOWN_HEX_PLACEHOLDERS = new Set([
  '00000000', '00000001', '00000002', '00000004',
  '11111111', '12345678', '86400000', '87654321',
  'abcdef12', 'deadbeef', 'feedface', 'abcdef01',
]);
const PRIVATE_PATTERNS = [
  {
    kind: 'home-admin-path',
    pattern: /[/\\]home[/\\]admin(?=\b|[/\\])/i,
  },
  {
    kind: 'home-user-path',
    pattern: /[/\\]home[/\\](?!(?:admin|user|username|you|name|example|sample)(?:\b|[/\\]))[A-Za-z0-9._-]+[/\\]/i,
  },
  {
    kind: 'macos-user-path',
    pattern: /[/\\]Users[/\\][^/\\\s"'`]+[/\\]/i,
  },
  {
    kind: 'root-user-path',
    pattern: /(?:^|[\s"'`(=])[/\\]root(?:[/\\]|$)/i,
  },
  {
    kind: 'private-host',
    pattern: /\biZ[0-9a-z]{6,12}\b/i,
  },
];

class UsageError extends Error {}

function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  let denylistArg;
  let denylistProvided = false;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      if (i + 1 >= argv.length) throw new UsageError('--root requires a directory');
      root = argv[(i += 1)];
    } else if (arg === '--denylist') {
      if (i + 1 >= argv.length) throw new UsageError('--denylist requires a comma-separated value');
      denylistArg = argv[(i += 1)];
      denylistProvided = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node tools/privacy-scan.mjs [--root DIR] [--denylist "term-a,term-b"] [--json]\n'
        + 'The denylist may also be supplied through PRIVACY_DENYLIST.\n',
      );
      process.exit(0);
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }

  const rawDenylist = denylistProvided ? denylistArg : (process.env.PRIVACY_DENYLIST ?? '');
  const denylist = rawDenylist
    .split(',')
    .map((term) => term.trim())
    .filter(Boolean);
  return { root: resolve(root), denylist, json };
}

function collectFiles(root) {
  const files = [];

  function visit(dir) {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(join(dir, entry.name));
      } else if (entry.isFile()) {
        files.push(join(dir, entry.name));
      }
    }
  }

  visit(root);
  return files;
}

function displayPath(root, file) {
  return relative(root, file).split('\\').join('/') || '.';
}

function isText(buffer) {
  return !buffer.includes(0);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isKnownHexPlaceholder(token) {
  return KNOWN_HEX_PLACEHOLDERS.has(token) || /^0{6}\d{2}$/.test(token);
}

function denylistMatches(line, term) {
  if ([...term].length > 2) return line.includes(term);
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_])${escapeRegExp(term)}(?![A-Za-z0-9_\\p{Script=Han}])`,
    'u',
  );
  return pattern.test(line);
}

function isFixtureHex(value, line, file, fixtureTokens) {
  const token = value.toLowerCase();
  if ([...token].every((char) => char === token[0])) return true;

  const even = token.split('').filter((_, index) => index % 2 === 0).join('');
  const odd = token.split('').filter((_, index) => index % 2 === 1).join('');
  if (even.length === 16 && odd.length === 16
      && [...even].every((char) => char === even[0])
      && [...odd].every((char) => char === odd[0])) return true;

  for (let size = 2; size <= 16; size += 1) {
    if (32 % size !== 0) continue;
    if (token.slice(0, size).repeat(32 / size) === token) return true;
  }

  // 1111 2222 3333 ... is a common hand-written test fixture.
  if (/^(.)\1{3}(.)\2{3}(.)\3{3}(.)\4{3}(.)\5{3}(.)\6{3}(.)\7{3}(.)\8{3}$/.test(token)) {
    return true;
  }

  return fixtureTokens.has(token);
}

function scanFile(root, file, denylist, addHit) {
  const buffer = readFileSync(file);
  const shown = displayPath(root, file);
  if (!isText(buffer)) {
    for (const term of denylist) {
      const needle = Buffer.from(term);
      let offset = buffer.indexOf(needle);
      while (offset !== -1) {
        let line = 1;
        for (let index = 0; index < offset; index += 1) {
          if (buffer[index] === 0x0a) line += 1;
        }
        addHit(shown, line, 'denylist');
        offset = buffer.indexOf(needle, offset + needle.length);
      }
    }
    return;
  }

  const content = buffer.toString('utf8');
  const lines = content.split(/\r?\n/);
  const extension = extname(file).toLowerCase();
  const isTestFile = TEST_FILE.test(basename(file));
  const fixtureTokens = new Set();

  if (isTestFile) {
    for (const line of lines) {
      if (!TEST_PLACEHOLDER_CONTEXT.test(line)) continue;
      for (const match of line.matchAll(HEX_32)) fixtureTokens.add(match[0].toLowerCase());
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;

    for (const match of line.matchAll(HEX_32)) {
      if (!isFixtureHex(match[0], line, file, fixtureTokens)) {
        addHit(shown, lineNumber, 'hex-32');
      }
    }

    if (PRIVATE_PATH_EXTENSIONS.has(extension)) {
      for (const { kind, pattern } of PRIVATE_PATTERNS) {
        if (pattern.test(line)) addHit(shown, lineNumber, kind);
      }
    }

    if (HEX_8_EXTENSIONS.has(extension) && !isTestFile) {
      for (const match of line.matchAll(HEX_8)) {
        const token = match[0].toLowerCase();
        const after = line.slice(match.index + match[0].length);
        const ellipsisPlaceholder = /^(?:…|\.{3})/.test(after);
        if (!isKnownHexPlaceholder(token) && !ellipsisPlaceholder) {
          addHit(shown, lineNumber, 'hex-8');
        }
      }
    }

    for (const match of line.matchAll(DIGITS_9_12)) {
      if (!KNOWN_NUMERIC_PLACEHOLDERS.has(match[0])) addHit(shown, lineNumber, 'digits-9-12');
    }

    if (PRIVATE_PATH_EXTENSIONS.has(extension)) {
      if (EMAIL.test(line)) addHit(shown, lineNumber, 'email');
      if (OPENAI_TOKEN.test(line)) addHit(shown, lineNumber, 'openai-token');
      if (GITHUB_TOKEN.test(line)) addHit(shown, lineNumber, 'github-token');
      if (AWS_KEY.test(line)) addHit(shown, lineNumber, 'aws-key');
    }

    if (denylist.some((term) => denylistMatches(line, term))) {
      addHit(shown, lineNumber, 'denylist');
    }
  }
}

function main() {
  const { root, denylist, json } = parseArgs(process.argv.slice(2));
  const hits = [];
  const seen = new Set();
  const warnings = denylist
    .filter((term) => [...term].length <= 2)
    .map((term) => `denylist 词“${term}”太短会大量误伤；仍会按词边界执行检查。`);

  const addHit = (file, line, kind) => {
    const key = `${file}\0${line}\0${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ file, line, kind });
  };

  const files = collectFiles(root);
  for (const file of files) scanFile(root, file, denylist, addHit);

  if (hits.length > 0) {
    if (json) {
      process.stdout.write(JSON.stringify({
        clean: false,
        root,
        denylistConfigured: denylist.length > 0,
        hits,
        warnings,
      }, null, 2) + '\n');
    } else {
      for (const warning of warnings) process.stdout.write(`⚠️ ${warning}\n`);
      for (const hit of hits) {
        process.stdout.write(`${hit.file}:${hit.line}: ${hit.kind}\n`);
      }
    }
    process.stderr.write(`❌ 隐私扫描命中 ${hits.length} 处。\n`);
    process.exitCode = 1;
    return;
  }

  if (json) {
    process.stdout.write(JSON.stringify({
      clean: true,
      root,
      denylistConfigured: denylist.length > 0,
      denylistTerms: denylist.length,
      hits,
      warnings,
    }, null, 2) + '\n');
    process.exitCode = 0;
    return;
  }

  for (const warning of warnings) process.stdout.write(`⚠️ ${warning}\n`);
  if (denylist.length === 0) {
    process.stdout.write('⚠️ 仅格式检查（未配置 denylist，身份词表检查已跳过）\n');
  } else {
    process.stdout.write(`✅ 格式与 denylist 检查通过（${denylist.length} 项）\n`);
  }
  process.exitCode = 0;
}

try {
  main();
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`❌ 参数错误：${error.message}\n`);
  } else {
    process.stderr.write(`❌ 无法完成隐私扫描：${error.message}\n`);
  }
  process.exitCode = 2;
}
