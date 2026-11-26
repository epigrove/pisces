#!/usr/bin/env node
/**
 * patch-nocommands.mjs — 清空参考 agent的斜杠命令表（/new /clear /model … 全部不注册）
 * 用法：node ops/patch-nocommands.mjs     （插件升级后需重跑，幂等）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(
  ROOT,
  '.dsh-home/profiles/koi/node_modules/@tencent-connect/dsh-qqbot/lib/commands/index.js',
);
const MARKER = '[patch] 参考 agent的命令表已清空';
const CONTENT = `/**
 * ${MARKER}：
 * 不再注册任何斜杠命令（/new /clear /reset /model /preset /compact /stop /bot-help …）。
 * 未注册的命令消息会原样进入普通对话流程。
 */
export function buildCommandList(_deps) {
    return [];
}
`;

if (!existsSync(TARGET)) {
  console.error('找不到目标文件:', TARGET);
  process.exit(1);
}
if (readFileSync(TARGET, 'utf8').includes(MARKER)) {
  console.log('命令表已清空，无需重复');
  process.exit(0);
}
writeFileSync(TARGET, CONTENT, 'utf8');
console.log('已清空命令表:', TARGET);
