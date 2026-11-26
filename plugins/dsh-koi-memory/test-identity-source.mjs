#!/usr/bin/env node
/**
 * 去 QQ 化：短期记忆优先用**通道给的**身份（2026-11-25）
 *
 * 判据：有 `source.person` 时，who/oid 从通道来；
 * 没有时退回正文解析（老会话、别的通道还得能跑）。
 */
process.env.KOI_HOME = process.env.KOI_HOME ?? '/tmp/koi-memory-identity-test';

const { parseIncoming } = await import('./lib/index.js');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}

const person = { platform: 'qq', id: 'ABCDEF0123456789ABCDEF0123456789', name: '某人' };

// ① 有结构化身份：正文带 QQ 标记也以通道为准
eq('有 person 时 who 来自通道', parseIncoming('[旧名字 (11112222333344441111222233334444)] 你好', person)?.who, '某人');
eq('有 person 时 oid 来自通道', parseIncoming('[旧名字 (11112222333344441111222233334444)] 你好', person)?.oid, 'abcdef01');

// ② 没有结构化身份：退回正文解析（兼容）
eq('无 person 时按正文认人', parseIncoming('[旧名字 (11112222333344441111222233334444)] 你好')?.who, '旧名字');
eq('无 person 时 oid 来自正文', parseIncoming('[旧名字 (11112222333344441111222233334444)] 你好')?.oid, '11112222');

// ③ 通道不带发送者标记时，有 person 也能记
eq('无标记但有 person：who 可用', parseIncoming('随便说一句', person)?.who, '某人');
eq('无标记但有 person：oid 可用', parseIncoming('随便说一句', person)?.oid, 'abcdef01');

// ④ 都没有：退回「群友」，不瞎认人
eq('既无标记也无 person：退回群友', parseIncoming('随便说一句')?.who, '群友');

// ⑤ 历史段里的人是别人，不能记成发送者
// 注意：整段以 '[Chat history begins]' 开头的，本来就按噪声丢掉（那是注入的上下文，不是人话）
const hist = [
  '[甲 (11111111111111111111111111111111)] 先说一句',
  '[Current message]',
  '[乙 (22222222222222222222222222222222)] 这才是发这条的人',
].join('\n');
eq('历史第一个人不会被当成发送者', parseIncoming(hist)?.who, '乙');

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
