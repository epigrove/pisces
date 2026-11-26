#!/usr/bin/env node
/**
 * contract-audit 回归守卫：
 * - 没有会话快照时，顶层 ok 不能是真；
 * - --json 必须输出 unverified；
 * - unverified>0 使用退出码 2。
 *
 * 这里不 spawn 子进程（受限沙箱会拒绝），实际命令在发布验证里直接执行。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(HERE, '../../tools/contract-audit.mjs'), 'utf8');

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

ok('零快照被识别为宿主布局变化', source.includes('const layoutChanged = snapshotFiles.length === 0'));
ok('零快照时顶层 ok 强制为 null', /ok:\s*layoutChanged\s*\?\s*null/.test(source));
ok('--json 输出 unverified 计数', /unverified,/.test(source));
ok('unverified>0 时退出码为 2', /failed\.length > 0 \? 1 : unverified > 0 \? 2 : 0/.test(source));
ok('输出说明宿主布局可能变了', source.includes('宿主布局可能变了'));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
