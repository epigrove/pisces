#!/usr/bin/env node
/**
 * patch-chattiness.mjs — 群聊发言门控（降频，省 token）
 *
 * 在中间件链末尾插入一个门控：
 *   私聊（c2c）        → 必回
 *   群聊 @ 或关键词    → 必回（<昵称1>/<昵称2>/agent）
 *   群聊主人发言       → 50%
 *   群聊其他机器人     → 35%
 *   群聊普通消息       → 12%
 *   每群每分钟最多 6 次（硬上限，防止刷屏）
 *
 * 环境变量可调（start.sh 里 export 即可）：
 *   QQBOT_GROUP_CHANCE         普通群消息回复概率，默认 0.12
 *   QQBOT_GROUP_MAX_PER_MIN    同群每分钟最多回复次数，默认 6
 *
 * 用法：node patch-chattiness.mjs
 * 插件升级后需重新执行（幂等）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(
  ROOT,
  '.dsh-home/profiles/koi/node_modules/@tencent-connect/dsh-qqbot/lib/gateway/bootstrap.js',
);

const MARKER = '// [patch] chattiness:';
const ANCHOR = '    setupMiddlewares(bot, config, manager, logger);';

const PATCH = `    // [patch] chattiness: 群聊发言门控（降频省 token；私聊必回）
    {
        const chance = Number(process.env.QQBOT_GROUP_CHANCE ?? '0.12');
        const maxPerMin = Number(process.env.QQBOT_GROUP_MAX_PER_MIN ?? '6');
        // 别名里只放 agent 已确认的名字，避免把未确认称呼当作自身标识。
        // 这个脚本现在没在用，但只要它还能跑一次就把旧别名写回去，所以一起改。
        const ALIAS = process.env.QQBOT_ALIASES ?? '参考 agent|agent';
        const KEYWORD = new RegExp(ALIAS, 'i');
        const MASTER = '主人';
        const gateLog = process.env.QQBOT_GATE_LOG === '1';
        const minuteBuckets = new Map();
        bot.use(async (c, next) => {
            const m = c.message;
            if (m.kind !== 'group') return next();
            const gid = m.groupOpenid ?? m.senderId ?? '';
            const now = Date.now();
            const text = typeof m.content === 'string' ? m.content : '';
            const isAt = m.rawEventType === 'GROUP_AT_MESSAGE_CREATE';
            const atMarker = /<@!?\d+>/.test(text);
            const aliasHit = KEYWORD.test(text);
            const mentionHit = Array.isArray(m.mentions) && m.mentions.some((u) => (u?.username && KEYWORD.test(u.username)) || u?.bot === true);
            if (isAt || atMarker || aliasHit || mentionHit) {
                if (gateLog) console.log(\`[chattiness] pass sender=\${m.senderName ?? '?'} by=\${isAt ? 'at-event' : atMarker ? 'at-marker' : aliasHit ? 'alias' : 'mention'} text=\${text.slice(0, 40)}\`);
                return next();
            }
            const isMaster = typeof m.senderName === 'string' && m.senderName.includes(MASTER);
            const isBot = m.senderIsBot === true;
            const bucket = (minuteBuckets.get(gid) ?? []).filter((ts) => now - ts < 60000);
            minuteBuckets.set(gid, bucket);
            if (bucket.length >= maxPerMin) {
                if (gateLog) console.log(\`[chattiness] skip reason=cap sender=\${m.senderName ?? '?'}\`);
                c.stop('chattiness-cap');
                return;
            }
            const p = isMaster ? 0.5 : isBot ? 0.35 : chance;
            if (Math.random() > p) {
                if (gateLog) console.log(\`[chattiness] skip reason=random sender=\${m.senderName ?? '?'} text=\${text.slice(0, 40)}\`);
                c.stop('chattiness-skip');
                return;
            }
            bucket.push(now);
            return next();
        });
        console.log(\`[chattiness] chance=\${chance} cap=\${maxPerMin}/min aliases=\${ALIAS}\`);
    }
`;

if (!existsSync(TARGET)) {
  console.error(`找不到目标文件: ${TARGET}`);
  process.exit(1);
}

const source = readFileSync(TARGET, 'utf8');

if (source.includes(MARKER)) {
  console.log('已打过门控补丁，无需重复');
  process.exit(0);
}

const index = source.indexOf(ANCHOR);
if (index < 0) {
  console.error('找不到插入锚点（插件结构可能已变），请人工检查');
  process.exit(1);
}

const insertAt = index + ANCHOR.length;
const patched = source.slice(0, insertAt) + '\n' + PATCH + source.slice(insertAt);
writeFileSync(TARGET, patched, 'utf8');
console.log('门控补丁已写入:', TARGET);
