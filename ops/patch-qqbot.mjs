#!/usr/bin/env node
/**
 * check-qqbot-patch.mjs —— 检查 qqbot 的四处改动是否在位
 *
 * **补丁本身不在这里打。**
 *
 * 历史：对 `@tencent-connect/dsh-qqbot` 的改动原来是**手改 node_modules**：
 *   1. gateway/bootstrap.js        注册 dsh-koi-gate 插件
 *   2. gateway/middleware-setup.js 并发策略 merge → queue（保住发送者）
 *   3. transport/outbound.js       出口过滤（防底稿外流）+ 状态行去重
 *   4. transport/inbound.js        历史消息里的 QQ 表情标签清理 + 入站带 source.person（2026-11-24）
 *
 * 手改的问题：`node_modules` 是装出来的，任何一次 `pnpm install` 都从 lockfile 重建，
 * 三处会**静默消失**且不报错。症状分别是：
 *   - 群聊退回「@ 才回」
 *   - 几个人连着说话，消息被合并记到第一个人头上
 *   - 「（凌晨，脑子木……）」这种底稿被当正文发到群里
 *
 * 现在（2026-11-12）改成 **pnpm patch**：
 *   pnpm-workspace.yaml 的 `patchedDependencies` 指向
 *   `.dsh-home/profiles/koi/patches/@tencent-connect__dsh-qqbot@0.5.5.patch`
 *   `pnpm install` 每次自动重新应用，补丁文件在 git 里。
 *   实测：删掉整个 node_modules 重装，三处自动回来。
 *
 * 这个脚本只剩一个用途：**体检**。检查它们是不是真的在位，
 * 顺便在 qqbot 升级、补丁版本对不上时明确报警。
 *
 * 用法：node ops/patch-qqbot.mjs [--check]   （--check 是默认行为，保留为了兼容旧调用）
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = process.env.QQBOT_PKG ?? join(
  ROOT,
  '.dsh-home/profiles/koi/node_modules/@tencent-connect/dsh-qqbot',
);

/** 每处改动一条独有判据 */
const CHECKS = [
  {
    what: '群聊两级判断（selftalk）已注册',
    file: 'lib/gateway/bootstrap.js',
    sign: (s) => s.includes('createGate(') && s.includes("from 'dsh-koi-gate'"),
    fix: '补丁没套上——看 .dsh-home/profiles/koi/pnpm-workspace.yaml 的 patchedDependencies',
  },
  {
    what: '并发策略是 queue（不合并消息，保住发送者）',
    file: 'lib/gateway/middleware-setup.js',
    sign: (s) => /strategy:\s*'queue'/.test(s),
    fix: '还是 merge——发送者会被合并记到第一个人头上',
  },
  {
    what: '入站带结构化身份（source.person，去 QQ 化的接口）',
    file: 'lib/transport/inbound.js',
    sign: (s) => s.includes("platform: 'qq'") && s.includes('person: {'),
    fix: '补丁没套上——插件又得从「[昵称 (openid)]」里抠 id 了',
  },
  {
    what: '出口过滤在位（判定在 dsh-koi-gate 插件，通道只留调用）',
    file: 'lib/transport/outbound.js',
    sign: (s) => s.includes("from 'dsh-koi-gate'") && s.includes('.drop'),
    fix: '括号旁白/静默词会当正文发出去（或插件没接上）',
  },
];

let bad = 0;
for (const c of CHECKS) {
  const p = join(PKG, c.file);
  if (!existsSync(p)) {
    console.log(`❌ ${c.what}：文件不存在 ${c.file}`);
    bad += 1;
    continue;
  }
  const ok = c.sign(readFileSync(p, 'utf8'));
  if (ok) {
    console.log(`✅ ${c.what}`);
  } else {
    console.log(`❌ ${c.what}：${c.fix}`);
    bad += 1;
  }
}

if (bad > 0) {
  console.log(`\n${bad} 处不在位。`);
  console.log('最常见原因：qqbot 升级了，补丁版本号对不上。');
  console.log('处理：改 pnpm-workspace.yaml 里的版本键 → pnpm install → 再跑这个脚本。');
  process.exit(1);
}
console.log('\n四处都在位。');
