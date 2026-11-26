#!/usr/bin/env node
/**
 * check-undefined-refs.mjs —— 查「用了但没导入」的 Node 内建。
 *
 * 为什么要有（2026-11-16 事故）：
 *   清理写死路径时把 `join(...)` 塞进 selftalk-gate.js，却漏了 `import { join }`。
 *   `node --check` 只验语法，验不出未定义标识符 —— 语法全过，一加载就
 *   ReferenceError，QQ 网关起不来，用户看到的是「机器人服务异常」。
 *
 * 判据：出现在调用位置的常见 Node 内建名，必须在文件里有 import/const/function 声明。
 * 动态导入（`const { x } = await import(...)`）能识别；识别不了的一律报出来人工确认，
 * 宁可误报也不放过。
 *
 * 用法：node ops/check-undefined-refs.mjs [目录...]
 * 退出码 0 = 通过；1 = 有可疑未定义引用。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join as pjoin, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const roots = process.argv.slice(2).length ? process.argv.slice(2) : [pjoin(ROOT, 'plugins'), pjoin(ROOT, 'ops'), pjoin(ROOT, 'tools')];

const NAMES = [
  'existsSync', 'readFileSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'readdirSync',
  'statSync', 'rmSync', 'copyFileSync', 'mkdtempSync', 'unlinkSync',
  'join', 'resolve', 'dirname', 'basename', 'extname',
  'homedir', 'tmpdir', 'spawnSync', 'execSync', 'createHash', 'createRequire',
];

function walk(dir, out = []) {
  let ents;
  try { ents = readdirSync(dir); } catch { return out; }
  for (const e of ents) {
    if (e === 'node_modules' || e === '.git') continue;
    const p = pjoin(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (/\.(mjs|js)$/.test(p)) out.push(p);
  }
  return out;
}

let bad = 0;
let scanned = 0;
for (const file of roots.flatMap((r) => walk(r))) {
  // 去掉注释再判断——注释里提到函数名不算调用。
  const src = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(?<![:\w])\/\/[^\n]*/g, '');
  scanned += 1;
  for (const n of NAMES) {
    if (!new RegExp(`(?<![\\w.$])${n}\\s*\\(`).test(src)) continue;
    // 声明形式：import、const/let/var、function、解构取值（含动态 import 解构）
    const declared =
      new RegExp(`import[^;]*\\b${n}\\b[^;]*from`, 's').test(src) ||
      new RegExp(`(?:const|let|var)\\s+${n}\\b`).test(src) ||
      new RegExp(`function\\s+${n}\\b`).test(src) ||
      new RegExp(`[{,]\\s*${n}\\s*[,}]`).test(src) ||          // 解构
      new RegExp(`[{,]\\s*${n}\\s*:\\s*\\w+\\s*[,}]`).test(src) || // 解构重命名
      // 2026-11-17：**回调参数**也是本地绑定。
      // `new Promise((resolve) => ...)` 里的 resolve 被当成"用了没声明"，
      // 一次扫出 3 处误报，噪音会让人干脆不跑这个检查。
      new RegExp(`[(,]\\s*${n}\\s*[,)=]`).test(src) ||
      new RegExp(`function\\s*\\([^)]*\\b${n}\\b`).test(src);
    if (!declared) {
      console.log(`❌ ${relative(ROOT, file)}: 用了 ${n}() 但文件里没有声明`);
      bad += 1;
    }
  }
}

console.log(`\n扫描 ${scanned} 个文件：${bad === 0 ? '无未定义引用 ✅' : `${bad} 处可疑 ❌`}`);
process.exit(bad === 0 ? 0 : 1);
