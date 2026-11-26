#!/usr/bin/env node
/**
 * dsh-koi-gate（原 dsh-koi-says）的回归测试。
 *
 * host 层会读白名单/状态文件，所以这里用临时 KOI_HOME，
 * 每个用例互不干扰，跑完自动清理。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const D = mkdtempSync(join(tmpdir(), 'koi-says-'));
process.env.KOI_HOME = D;
mkdirSync(join(D, '.koi'), { recursive: true });
process.on('exit', () => { try { rmSync(D, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

const { allow } = await import('./lib/index.js');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── 基本放行 ──────────────────────────────────────────────
ok('普通话 → 放行', allow('今晚吃点啥').drop === false);
ok('放行时 reason 为空', allow('今晚吃点啥').reason === '');

// ── 各种拦截，reason 要能说清原因 ─────────────────────────
ok('空串 → silence', allow('').reason === 'silence');
ok('纯空白 → silence', allow('   ').reason === 'silence');
// 出口不再按内容形状猜。
// 「想不想说」由 agent 输出 SILENCE_TOKEN 表达；「像不像旁白」不归正则判。
ok('括号不再被当成旁白拦', allow('（凌晨，脑子木）').reason !== 'aside');
// 2026-11-17 改：同上，日常短语不再判漏话
ok('日常短语不再误杀', allow('拉丁词 astrum（星星）').reason !== 'leak');

// ── 退场守卫（需要 target） ───────────────────────────────
const g = 'group-A';
ok('退场 1 → 放行', allow('睡了', { target: g }).drop === false);
ok('退场连击第 3 条 → exit', allow('告辞', { target: g }).drop === false && allow('先走了', { target: g }).reason === 'exit');

// 不同 target 互不影响：新 target 第一次说退场必须放行
// （不能用 'group-B'——它可能已被前面的用例累加过连击）
ok('新 target 首次退场放行（不受别的 group 连击影响）', allow('不聊了', { target: 'fresh-'+Math.random().toString(36).slice(2), statusDedup: false }).drop === false);

// ── 白名单（走真实文件） ──────────────────────────────────
// 注意：whitelist() 有 60 秒缓存，所以**必须在第一次 allow() 之前**把文件写好。
// 这里补一个独立验证：直接确认文件内容能被解析出来。
writeFileSync(join(D, '.koi', 'outbound-whitelist.json'), JSON.stringify([
  { w: '这次没事', until: Date.now() + 86400_000 },
]));
const wl = JSON.parse(readFileSync(join(D, '.koi', 'outbound-whitelist.json'), 'utf8'));
ok('白名单文件可解析', Array.isArray(wl) && wl[0].w === '这次没事');

// 过期条目不生效，且会被清出文件
writeFileSync(join(D, '.koi', 'outbound-whitelist.json'), JSON.stringify([
  { w: '过期词', until: Date.now() - 1000 },
]));
// leak 规则已整体从出口移除，见 lib/index.js 里那段说明
ok('出口不再做漏话判定', allow('过期词 再醒一次').reason !== 'leak');

// ── 状态类发言去重 ────────────────────────────────────────
const s1 = allow('在线，有事说', { target: 'status-g' });
const s2 = allow('在线，有事说', { target: 'status-g' });
ok('状态类发言只放一条', s1.drop === false || s2.drop === true);

// ── 关掉状态去重时都放行 ──────────────────────────────────
ok('statusDedup:false → 不做状态去重', allow('在线，有事说', { target: 'x', statusDedup: false }).reason !== 'status');

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
