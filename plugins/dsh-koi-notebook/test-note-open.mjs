#!/usr/bin/env node
/**
 * notebook 回归：按小节读取也必须遵守 4000 字上限并明确标记截断。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from './lib/index.js';

const dir = mkdtempSync(join(tmpdir(), 'koi-notebook-open-'));
const tools = {};
const ctx = {
  tools: { register(tool) { tools[tool.name] = tool; } },
  logger: { info() {} },
};

let pass = 0;
let fail = 0;
const ok = (name, condition, extra = '') => {
  if (condition) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

try {
  apply(ctx, { dir });
  const saved = await tools.note_save.execute({
    title: '长节测试',
    kind: 'state',
    body: `## 长节\n${'甲'.repeat(4500)}\n尾标记\n\n## 短节\n短内容`,
  });
  const id = /记下了：(n-[^\s（]+)/.exec(saved)?.[1] ?? '';
  ok('笔记已创建', id !== '', saved);

  const opened = await tools.note_open.execute({ id, section: '长节' });
  ok('指定小节仍返回节标题', opened.includes('【长节测试 › 长节】'), opened.slice(0, 200));
  ok(
    '指定小节明确标记截断',
    opened.includes('已截断，可继续分段') && opened.includes('全文见'),
    opened.slice(0, 300),
  );
  ok('指定小节正文最多 4000 字', opened.split('甲').length - 1 === 4000, `实际 ${opened.split('甲').length - 1}`);
  ok('截断后不再返回节尾', !opened.includes('尾标记'));

  const short = await tools.note_open.execute({ id, section: '短节' });
  ok('普通短节不误报截断', short.includes('短内容') && !short.includes('已截断'), short);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 测试清理 */ }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
