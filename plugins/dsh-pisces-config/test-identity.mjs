#!/usr/bin/env node
/**
 * 身份抽象的单测（2026-11-24 去 QQ 化）：
 * 插件只认 `source.person` 这一种形状；平台 id 由通道翻译。
 */
import { personOf, personKeyOf, personNameOf, isOwnerPerson, legacyKeyFromText } from './lib/identity.mjs';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}

const qq = { kind: 'user', person: { platform: 'qq', id: "a".repeat(32), name: '主人', scope: 'c2c' } };
const web = { kind: 'user', person: { platform: 'web', id: "a".repeat(32), name: '主人' } };

eq('personOf 取到结构化身份', personOf(qq)?.platform, 'qq');
eq('没有 person 就返回 null', personOf({ kind: 'user' }), null);
eq('person 缺 id 也算没有', personOf({ person: { platform: 'qq' } }), null);
eq('key 带平台前缀', personKeyOf(qq), `qq:${"a".repeat(32)}`);
eq('同 id 不同平台不冲突', personKeyOf(web) !== personKeyOf(qq), true);
eq('没有身份时 key 是空串', personKeyOf({}), '');
eq('显示名优先用 name', personNameOf(qq), '主人');
eq('没有 name 时退回 id 前 8 位', personNameOf({ person: { platform: 'qq', id: '1234567890' } }), '12345678');
eq('主人由配置判定（命中）', isOwnerPerson(qq, [`qq:${"a".repeat(32)}`]), true);
eq('主人由配置判定（不命中）', isOwnerPerson(qq, ['qq:someoneelse']), false);

// 大小写：入站可能是大写，配置可能写小写（2026-11-24 review P2）
const upper = { kind: 'user', person: { platform: 'qq', id: 'ABCDEF0123456789ABCDEF0123456789' } };
eq('大写 id 归一成小写 key', personKeyOf(upper), 'qq:abcdef0123456789abcdef0123456789');
eq('大写入站能匹配小写 owner 配置', isOwnerPerson(upper, ['qq:abcdef0123456789abcdef0123456789']), true);
eq('大写 owner 配置也能匹配', isOwnerPerson(upper, ['qq:ABCDEF0123456789ABCDEF0123456789']), true);
eq('平台名大小写也归一', personKeyOf({ person: { platform: 'QQ', id: 'ABC' } }), 'qq:abc');
eq('legacy 抠出来的 id 也归一', legacyKeyFromText('[甲 (ABCDEF0123456789ABCDEF0123456789)] 你好')?.key, 'qq:abcdef0123456789abcdef0123456789');
eq('没有身份就不是主人', isOwnerPerson({ kind: 'user' }, ['qq:x']), false);

// legacy：老消息只有文本
const t = '[某个昵称 (a1b2c3d4e5f60718293a4b5c6d7e8f90)] 你好';
eq('legacy 能从正文抠出 id', legacyKeyFromText(t)?.key, 'qq:a1b2c3d4e5f60718293a4b5c6d7e8f90');
eq('legacy 带名字', legacyKeyFromText(t)?.name, '某个昵称');
eq('legacy 明确标了 transition', legacyKeyFromText(t)?.legacy, true);
eq('legacy 认不出就返回 null', legacyKeyFromText('今天天气不错'), null);

// 老消息是「历史 + [Current message] + 当前发送者」，不能取历史里第一个
const hist = [
  '[Chat history begins]',
  '[甲 (11111111111111111111111111111111)] 先说一句',
  '[乙 (22222222222222222222222222222222)] 又说一句',
  '[Current message]',
  '[丙 (33333333333333333333333333333333)] 这才是发这条的人',
].join('\n');
eq('legacy 只认当前段的发送者', legacyKeyFromText(hist)?.name, '丙');
eq('legacy 不把历史第一个人当发送者', legacyKeyFromText(hist)?.key.startsWith('qq:1111'), false);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
