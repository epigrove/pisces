#!/usr/bin/env node
/**
 * list-people.mjs —— 一眼看出账本里谁是谁、谁是空壳。
 *
 * ensurePerson 会给每个说话的人建记录，只是不再顶行。空记录会一直攒，
 * 所以查「认不认识这人」时必须能一眼区分空壳。
 *
 * 「空壳」的判据来自 dsh-koi-decay 的 isEmptyPerson()：
 *   没有 traits、没有 items、分数为 0。
 *   （turns 不算内容——那只是"说过几次话"，不是"我记住了什么"。）
 *
 * 用法：
 *   node $KOI_HOME/ops/list-people.mjs                 # 全部
 *   node $KOI_HOME/ops/list-people.mjs 人物甲            # 名字过滤
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEmptyPerson, isRested, isMentionedToday, personKeyOf } from 'dsh-koi-decay';

// 按脚本位置定位账本，不依赖 HOME——从运维 agent 的 shell 跑时 HOME 是别的目录，会指向错的地方。
const KOI = dirname(dirname(fileURLToPath(import.meta.url)));
const file = join(KOI, '.koi', 'lexicon.json');
const state = JSON.parse(readFileSync(file, 'utf8'));

/**
 * owner 是锚点，不是印象对象；对应栏位为空是预期状态。
 * 所以空壳分两种：**该空的**（锚点）和**没留住的**（该修）。
 * 锚点名单放 .koi/anchors.txt，一行一个 id，谁都能读、能改。
 */
const anchors = new Set();
try {
  const anchorText = readFileSync(join(KOI, '.koi', 'anchors.txt'), 'utf8');
  for (const line of anchorText.split('\n')) {
    const t = line.trim();
    if (t !== '' && !t.startsWith('#')) anchors.add(t.toLowerCase());
  }
} catch { /* 没有名单就不区分 */ }
const q = String(process.argv[2] ?? '').trim();

const now = Date.now();
const rows = [];
for (const [key, rec] of Object.entries(state.people ?? {})) {
  if (q !== '' && !String(rec.name ?? '').includes(q)) continue;
  const items = rec.items ?? [];
  const traits = rec.traits ?? [];
  const descs = items.filter((it) => it.type === 'desc');
  const aliveDesc = descs.filter((it) => !isRested(it, now)).length;
  const aliveTrait = traits.filter((t) => !t.superseded && !isRested(t, now)).length;
  rows.push({
    key,
    name: String(rec.name ?? ''),
    turns: Number(rec.turns ?? 0),
    score: Number(rec.score ?? 0),
    desc: `${aliveDesc}/${descs.length}`,
    trait: `${aliveTrait}/${traits.length}`,
    mentioned: isMentionedToday(rec, now) ? '今天' : '',
    empty: [
      // **不一定要靠 openid 记人**，别把只有名字的记录当成格式问题。
      // 键有两类，都是正经的人：
      //   有平台 id → 群里 @ 得到，通道能直接解析
      //   只有名字（name:xxx）→ @ 不到，但**照样认得、照样能被她提起**
      personKeyOf(key) === null ? '按名字记(无平台id)' : '',
      isEmptyPerson(rec) ? (anchors.has(key.toLowerCase()) ? '锚点(该空)' : '空壳') : '',
    ].filter(Boolean).join(' '),
  });
}

rows.sort((a, b) => Number(a.empty !== '') - Number(b.empty !== '') || b.turns - a.turns);

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('id', 9)}${pad('名字', 16)}${pad('说话', 6)}${pad('分', 8)}${pad('描述活/总', 11)}${pad('说法活/总', 11)}${pad('提到', 6)}备注`);
for (const r of rows) {
  console.log(
    `${pad(r.key, 9)}${pad(r.name, 16)}${pad(r.turns, 6)}${pad(r.score.toFixed(2), 8)}` +
      `${pad(r.desc, 11)}${pad(r.trait, 11)}${pad(r.mentioned, 6)}${r.empty}`,
  );
}
const lost = rows.filter((r) => r.empty === '空壳').length;
const anchorCount = rows.filter((r) => r.empty.startsWith('锚点')).length;
console.log(
  `\n共 ${rows.length} 人：没留住的空壳 ${lost} 个`
    + (anchorCount > 0 ? `；锚点（本来就该空）${anchorCount} 个` : ''),
);
if (lost > 0) console.log('「空壳」= 说过话但什么都没记住，该补的是这些；「锚点」不是漏记，别去填。');
