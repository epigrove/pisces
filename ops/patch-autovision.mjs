#!/usr/bin/env node
/**
 * patch-autovision.mjs — 带图消息自动先识图
 *
 * 为什么必须做在中间件：
 *   只在提示词里写「收到图先 describe」并不可靠——提示词是建议，模型仍可能先接话。
 *   因此改成消息一进来就先识图，把客观描述拼进上下文，
 *   「没看图」这个选项直接不存在。
 *
 * 成本：只处理已经通过发言门控的消息；单条最多 2 张图，每张描述截断 300 字。
 *
 * 注意（2026-11-13 修正）：handleInbound 的第一个参数是 SDK 的中间件上下文，
 * 不是 DSH 插件上下文，`ctx.get('tools')` 在那里取不到。所以必须由 bootstrap
 * 把 DSH 上下文当第 5 个参数传进来，否则这个补丁会静默失效。
 *
 * 用法：node ops/patch-autovision.mjs     插件升级后重跑（幂等）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, '.dsh-home/profiles/koi/node_modules/@tencent-connect/dsh-qqbot/lib');
const INBOUND = join(PKG, 'transport/inbound.js');
const BOOTSTRAP = join(PKG, 'gateway/bootstrap.js');
const MARK = '// [patch] auto-vision';

const HELPER = `${MARK}: 带图消息先自动识图，把描述拼进上下文（2026-11-13）
async function autoDescribeImages(pluginCtx, msg, state, config, logger) {
    const vision = config?.vision ?? {};
    if (vision.enabled !== true) return '';
    const images = (msg.attachments ?? [])
        .filter((a) => /^image\\//i.test(a.content_type ?? ''))
        .slice(0, 2);
    if (images.length === 0) return '';   // 纯文本消息直接走，不取工具、不刷日志
    let tool;
    try {
        const tools = pluginCtx?.get?.('tools');
        tool = tools?.get?.('qqbot_describe_image');
    } catch { /* 取不到就当没有 */ }
    if (!tool?.execute) {
        logger?.warn?.('auto-vision: qqbot_describe_image 不可用，带图消息没法自动识图');
        return '';
    }
    const byName = new Map((state.downloadedFiles ?? []).map((d) => [d.filename, d]));
    const lines = [];
    for (const att of images) {
        const got = byName.get(att.filename);
        if (!got?.localPath) {
            lines.push(\`- 图（\${att.filename}）：没下下来，图打不开\`);
            continue;
        }
        try {
            const res = await tool.execute(
                {
                    image: got.localPath,
                    prompt: '客观描述这张图：画的是什么人/物、什么动作、什么表情、有没有文字。不要推测发图人的意图。',
                },
                {},
            );
            const text = typeof res === 'string' ? res : (res?.text ?? res?.value?.text ?? '');
            lines.push(text
                ? \`- 图（\${att.filename}）：\${String(text).slice(0, 300)}\`
                : \`- 图（\${att.filename}）：识图没返回内容\`);
        } catch (err) {
            const why = String(err?.message ?? err).slice(0, 120);
            logger?.warn?.('auto-vision failed: ' + why);
            lines.push(\`- 图（\${att.filename}）：图打不开（\${why}）\`);
        }
    }
    if (lines.length === 0) return '';
    return [
        '【系统注 · 不是群友发言】以下是识图工具对这条消息里图片的客观描述（系统替你看了，不是谁说的话）：',
        ...lines,
        '回话时用里面的客观描述，别再说「没看图」，也不用再调识图工具。描述失败的那张，就直说图打不开。',
    ].join('\\n');
}
`;

function patchInbound() {
  let s = readFileSync(INBOUND, 'utf8');
  if (s.includes(MARK)) {
    console.log('inbound: 已打过 auto-vision');
    return;
  }
  const sig = 'export async function handleInbound(ctx, manager, config, logger) {';
  const at = s.indexOf(sig);
  if (at < 0) throw new Error('找不到 handleInbound');
  s = s.slice(0, at) + HELPER.trimStart() + '\n' + s.slice(at);
  s = s.replace(sig, 'export async function handleInbound(ctx, manager, config, logger, pluginCtx) {');

  const oldBody = `    const agentBody = assembleAgentBody(msg, mwState, scope, logger);
    if (!agentBody)
        return;`;
  const newBody = `    let agentBody = assembleAgentBody(msg, mwState, scope, logger);
    // ${MARK}: 带图的先补一段客观描述，模型没机会「装没看见」
    try {
        const visionNote = await autoDescribeImages(pluginCtx, msg, mwState, config, logger);
        if (visionNote !== '') {
            agentBody = agentBody === null || agentBody === undefined
                ? visionNote
                : \`\${visionNote}\\n\\n\${agentBody}\`;
        }
    } catch (err) {
        logger?.warn?.(\`auto-vision: \${err instanceof Error ? err.message : String(err)}\`);
    }
    if (!agentBody)
        return;`;
  if (!s.includes(oldBody)) throw new Error('找不到组装锚点');
  s = s.replace(oldBody, newBody);
  writeFileSync(INBOUND, s, 'utf8');
  console.log('inbound: auto-vision 已写入');
}

function patchBootstrap() {
  let s = readFileSync(BOOTSTRAP, 'utf8');
  if (s.includes('[patch] auto-vision')) {
    console.log('bootstrap: 已传 DSH 上下文');
    return;
  }
  const old = 'await handleInbound(mCtx, manager, config, logger);';
  if (!s.includes(old)) throw new Error('找不到 handleInbound 调用');
  s = s.replace(old, 'await handleInbound(mCtx, manager, config, logger, ctx); // [patch] auto-vision: 传 DSH 上下文');
  writeFileSync(BOOTSTRAP, s, 'utf8');
  console.log('bootstrap: 已传 DSH 上下文');
}

for (const f of [INBOUND, BOOTSTRAP]) {
  if (!existsSync(f)) {
    console.error('找不到:', f);
    process.exit(1);
  }
}
patchInbound();
patchBootstrap();
