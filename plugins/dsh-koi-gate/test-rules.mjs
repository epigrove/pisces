#!/usr/bin/env node
/**
 * dsh-koi-gate（原 dsh-koi-rules）的回归测试。
 *
 * 这个包是纯函数，所以测试**不碰文件系统、不读环境变量**：
 * 白名单用注入的假函数，状态是模块内 Map，每个用例自己清理。
 */
import { isPureAside, SILENCE_TOKEN, isSilenceToken, shouldDropLeak, setWhitelistLoader, guardExit, markImage, markNamed, clearTurnFlags } from './lib/index.js';

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── 括号旁白 ──────────────────────────────────────────────
ok('全角括号整条 → 旁白', isPureAside('（凌晨，脑子木）') === true);
ok('半角括号整条 → 旁白', isPureAside('(no reply)') === true);
ok('以括号开头 → 旁白', isPureAside('（这条不回）下次再说') === true);
ok('正文中间有括号 → 不是旁白', isPureAside('他说（笑）了一下') === false);
ok('空串 → 不是旁白', isPureAside('') === false);
ok('普通话 → 不是旁白', isPureAside('今天天气不错') === false);

// ── 静默词 ────────────────────────────────────────────────
ok('静默词命中', isSilenceToken(SILENCE_TOKEN).silent === true);
ok('前后空格也算', isSilenceToken(`  ${SILENCE_TOKEN}  `).silent === true);
ok('正常话不命中', isSilenceToken('我在呢').silent === false);
ok('空串不命中', isSilenceToken('').silent === false);

// ── 漏话（行为型） ────────────────────────────────────────
ok('调度自述 → 拦', shouldDropLeak('等ashu看到再醒一次') === true);
// 2026-11-17 改：「这次没事」「没动静」是正常中文，曾误杀正常回复
ok('日常短语不再误杀', shouldDropLeak('拉丁词 astrum（星星）') === false);
ok('「已排到」→ 拦', shouldDropLeak('已经排到下轮了') === true);
ok('普通话 → 放行', shouldDropLeak('今晚吃点啥') === false);
// 关键：词表已撤，专名不该被拦——宁可漏，也不吞正常的话
ok('专名 v2 → 放行（词表已撤）', shouldDropLeak('这次 v2 那些分数我先记着') === false);
ok('「给你打八分」→ 放行', shouldDropLeak('给你打八分') === false);

// ── 白名单（注入式） ──────────────────────────────────────
setWhitelistLoader(() => [{ w: '这次没事', until: Date.now() + 86400_000 }]);
ok('白名单命中 → 放行', shouldDropLeak('这次没事') === false);
setWhitelistLoader(() => [{ w: '过期词', until: Date.now() - 1000 }]);
// 2026-11-17：「这次没事」不再是漏话，换成确实会命中的调度话术来测过期
ok('过期白名单 → 不生效', shouldDropLeak('过期词 再醒一次') === true);
setWhitelistLoader(() => []);

// ── 退场守卫 ──────────────────────────────────────────────
clearTurnFlags('g1');
ok('普通话 → 放行', guardExit('今天聊点别的', 'g1') === false);
ok('退场 1 → 放行', guardExit('睡了', 'g1') === false);
ok('退场连击第 3 条 → 拦', guardExit('告辞', 'g1') === false && guardExit('先走了', 'g1') === true);

// 带图时不许用退场语敷衍
clearTurnFlags('g2');
markImage('g2', true);
ok('带图后退场 → 拦', guardExit('退下了', 'g2') === true);
clearTurnFlags('g2');
markImage('g2', true);
ok('带图后说实在话 → 放行', guardExit('图里是只猫，眯着眼', 'g2') === false);
clearTurnFlags('g2');

// 点名时同理
clearTurnFlags('g3');
markNamed('g3', true);
ok('点名后退场 → 拦', guardExit('睡了', 'g3') === true);
clearTurnFlags('g3');

// 锚定：不能见「睡」就吞
ok('「没睡，在呢」→ 放行（不是退场）', guardExit('没睡，在呢', 'g4') === false);
ok('「睡不着」→ 放行（不是退场）', guardExit('睡不着', 'g4') === false);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
