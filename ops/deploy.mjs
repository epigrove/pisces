#!/usr/bin/env node
/**
 * deploy.mjs —— 把本仓库（上游）的插件代码部署到活 agent。
 *
 * 隔离底线：只更新**插件代码**（lib/package.json/patch/测试/README）与 ops 运行时模块；
 * **绝不碰** .koi（记忆）、.env（私有身份）、profiles（人设）。那些与仓库隔离。
 * 私有身份由活侧 .env 供（KOI_OWNER_* / KOI_AGENT_NAME / QQBOT_ALIASES）。
 *
 * 默认跳过 lexicon（参考 agent身上晚些再装；仓库可先改 v3）。--include-lexicon 才装。
 * 先备份活侧再覆盖，可回滚。
 *
 * 用法：node ops/deploy.mjs [--include-lexicon] [--dry]
 */
import { cpSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const KOI = process.env.KOI_HOME || join(homedir(), 'koi');
const DRY = process.argv.includes('--dry');
const WITH_LEX = process.argv.includes('--include-lexicon');
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const BAK = join(KOI, 'backups', `deploy-${TS}`);

const CODE_ENTRIES = ['lib', 'package.json', 'cordis.patch.yml', 'README.md'];

// 部署前先自查：未定义引用会让插件一加载就崩（用户看到「服务异常」），
// 而 node --check 验不出来。宁可拒绝部署，也不要把坏的推上去。
if (!DRY) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [join(REPO, 'ops', 'check-undefined-refs.mjs')], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stdout || '');
    console.error('❌ 有未定义引用，拒绝部署。');
    process.exit(1);
  }
}
// 这里只登记当前仓库里真实存在的运行时模块。历史上列过已经删除的
// selftalk-gate.js / outbound-filter.mjs / dedupe-status.mjs，循环却静默跳过，
// 最后仍然打印“完成”。现在空列表是合法的；以后登记了模块但源文件缺失，
// 部署会在写任何数据之前直接失败。
const OPS_RUNTIME = [];

function backup(rel) {
  const src = join(KOI, rel);
  if (!existsSync(src)) return;
  const dst = join(BAK, rel);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
}
function put(rel, from) {
  if (DRY) { console.log(`[dry] ${rel}`); return; }
  backup(rel);
  mkdirSync(dirname(join(KOI, rel)), { recursive: true });
  cpSync(from, join(KOI, rel), { recursive: true });
  console.log(`部署 ${rel}`);
}

for (const o of OPS_RUNTIME) {
  const from = join(REPO, 'ops', o);
  if (!existsSync(from)) {
    console.error(`❌ 运行时模块缺失：${from}`);
    process.exit(1);
  }
}

for (const d of readdirSync(join(REPO, 'plugins'))) {
  if (!d.startsWith('dsh-koi-') && !d.startsWith('dsh-pisces-')) continue;
  if (d === 'dsh-koi-lexicon' && !WITH_LEX) { console.log(`跳过 ${d}（--include-lexicon 才装）`); continue; }
  for (const e of CODE_ENTRIES) {
    const from = join(REPO, 'plugins', d, e);
    if (existsSync(from)) put(join('plugins', d, e), from);
  }
  for (const t of readdirSync(join(REPO, 'plugins', d))) {
    if (t.startsWith('test-') && t.endsWith('.mjs')) put(join('plugins', d, t), join(REPO, 'plugins', d, t));
  }
}
for (const o of OPS_RUNTIME) {
  const from = join(REPO, 'ops', o);
  put(join('ops', o), from);
}
console.log(DRY ? '[dry] 完成' : `完成。备份在 ${BAK}。重启 koi 生效：~/start-koi.sh --daemon`);
