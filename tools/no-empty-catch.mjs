#!/usr/bin/env node
/**
 * 空 catch 违禁品检查（2026-11-10 参考 agent定的）
 *
 *   > 空 catch 该当违禁品处理，不许存在。
 *
 * 今天两次：一次把「我是谁·不可改」整段吞掉，一次把整段记忆注入吞掉。
 * 两次都是 `catch { return base; }` —— 注入消失，看着却一切正常。
 *
 * 判据：`catch` 块里**既不 throw、也不打日志、也不计数**，就算违禁。
 * 允许的写法：
 *   catch { /* 说明为什么可以忽略 *\/ }      ← 带注释说明
 *   catch (err) { console.log(...) }          ← 有日志
 *   catch { bump('kind', ...) }               ← 有计数
 *
 * 用法：node tools/no-empty-catch.mjs [--update]   退出码 1 = 有新的违禁品
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(REPO_ROOT, 'plugins');
const BASELINE = join(REPO_ROOT, 'tools', 'no-empty-catch.baseline.json');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

/** 找出所有 catch 块，判断块内是否有"有意义的动作" */
function scan(file) {
  const src = readFileSync(file, 'utf8');
  const hits = [];
  const re = /catch\s*(?:\([^)]*\))?\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    // 括号配对（忽略字符串内的括号，粗略但够用）
    let depth = 0;
    let i = open;
    let inStr = null;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (inStr !== null) {
        if (c === '\\') { i += 1; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = src.slice(open + 1, i);
    const meaningful =
      /\b(throw|console\.|warn|log|error|bump|record|报告|记一笔)\b/.test(body) ||
      // 把错误转换成返回值 / 交给上层，也算处理过：
      //   catch (err) { return { ok: false, message: err.message } }
      //   catch (err) { return `写不进去：${err.message}` }
      /\breturn\b[^;]*\b(err|e|error)\b/.test(body) ||
      // 主动交给 Promise 链也算已传递：catch (e) { reject(e); }
      /\b(?:Promise\.)?reject\s*\(\s*(err|e|error)\b/.test(body) ||
      // 调用统一错误处理函数，或累加坏行/失败计数，也不是吞掉。
      /\b[A-Za-z_$][\w$]*\s*\(/.test(body) ||
      /\b[A-Za-z_$][\w$]*(?:\+\+|\+=|-=)/.test(body) ||
      // 单行兜底也算：`.map(l => { try { return JSON.parse(l); } catch { return null; } })`
      // ——这是「解析不了就当没有」，不是吞错后继续假装正常
      /^\s*return\b[^;]*;\s*$/.test(body) ||
      /\/\*[\s\S]*?\*\/|\/\/.+/.test(body);   // 带注释说明 = 允许
    if (!meaningful) {
      const line = src.slice(0, m.index).split('\n').length;
      hits.push({ file, line, snippet: src.slice(m.index, Math.min(i + 1, m.index + 80)).replace(/\s+/g, ' ') });
    }
  }
  return hits;
}

const files = walk(ROOT);
const all = files.flatMap(scan).map((h) => ({ ...h, file: relative(REPO_ROOT, h.file) }));

/**
 * 基线键：**文件 + 规范化后的代码片段**，不带行号（2026-11-12 改）。
 *
 * 原来用 `文件:行号`——在文件里插一行注释，后面所有存量都会「漂移成新增」，
 * 于是每次改代码都要重跑 --update，而重跑就等于把真新增也一起登记了，检查形同虚设。
 * 我今天改 chat/index.js 加了 3 行注释，就凭空冒出 3 条「新增」。
 *
 * 现在用「文件 + 把空白压平后的片段」：行号怎么动都不影响，同一个空 catch 稳定认出。
 */
const keyOf = (h) => `${h.file}|${String(h.snippet ?? '').replace(/\s+/g, ' ').trim()}`;
const keys = all.map(keyOf);

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE, JSON.stringify(keys.sort(), null, 1));
  console.log(`已登记 ${keys.length} 处存量（只挡新增）`);
  process.exit(0);
}

const base = existsSync(BASELINE) ? new Set(JSON.parse(readFileSync(BASELINE, 'utf8'))) : new Set();
const fresh = all.filter((h) => !base.has(keyOf(h)));
console.log(`扫描 ${files.length} 个文件：空 catch ${all.length} 处（存量 ${all.length - fresh.length} / 新增 ${fresh.length}）`);
for (const h of fresh.slice(0, 20)) console.log(`❌ ${h.file}:${h.line}  ${h.snippet}`);
process.exit(fresh.length === 0 ? 0 : 1);
