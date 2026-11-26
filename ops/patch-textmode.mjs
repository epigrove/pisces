#!/usr/bin/env node
/**
 * patch-textmode.mjs — 把 dsh-qqbot 的 markdown 出站降级为纯文本 (msg_type=0)
 *
 * 背景：QQ 在推送 markdown 消息时，接收端会同时拿到 markdown 本体和纯文本
 * content，导致其他机器人/客户端把同一条消息读两遍。这里统一改发纯文本。
 *
 * 用法：node patch-textmode.mjs           打补丁（幂等）
 *       node patch-textmode.mjs --check   只检查是否已打
 *
 * 注意：`dsh plugin add @tencent-connect/dsh-qqbot` 升级插件后 node_modules 会被
 * 重建，补丁丢失，重新执行本脚本即可。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(
  ROOT,
  '.dsh-home/profiles/koi/node_modules/@tencent-connect/dsh-qqbot/lib/gateway/bootstrap.js',
);

const MARKER = '// [patch] textmode:';
const ANCHOR = '    logger.info(`QQBot SDK initialized';

const PATCH = `    // [patch] textmode: 出站统一降级为纯文本 msg_type=0（避免接收端同时拿到 markdown+text）
    {
        const __originalSend = bot.send.bind(bot);
        bot.send = (opts) => {
            // 带按钮的消息（审批/提问）必须保持 markdown，纯文本不渲染内嵌键盘
            if (opts !== undefined && opts.keyboard !== undefined) return __originalSend(opts);
            if (opts !== undefined && opts.markdown !== undefined) {
                const { markdown, msgType: __t, ...rest } = opts;
                return __originalSend({ ...rest, msgType: 0, content: typeof markdown?.content === 'string' ? markdown.content : '' });
            }
            if (opts !== undefined && opts.msgType === 2) {
                const { msgType: __t2, ...rest } = opts;
                return __originalSend({ ...rest, msgType: 0, content: typeof opts.content === 'string' ? opts.content : '' });
            }
            return __originalSend(opts);
        };
    }
`;

if (!existsSync(TARGET)) {
  console.error(`找不到目标文件: ${TARGET}`);
  process.exit(1);
}

const source = readFileSync(TARGET, 'utf8');

if (source.includes(MARKER)) {
  console.log('已打过补丁，无需重复');
  process.exit(0);
}

if (process.argv.includes('--check')) {
  console.log('未打补丁');
  process.exit(1);
}

const index = source.indexOf(ANCHOR);
if (index < 0) {
  console.error('找不到插入锚点（插件结构可能已变），请人工检查');
  process.exit(1);
}

const patched = source.slice(0, index) + PATCH + source.slice(index);
writeFileSync(TARGET, patched, 'utf8');
console.log('补丁已写入:', TARGET);
