#!/usr/bin/env node
/** 侧车索引：解析失败备份 + 临时文件 rename 原子写。 */
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIndex, readIndexResult, touch, writeIndex } from './lib/sidecar.js';

const D = mkdtempSync(join(tmpdir(), 'koi-sidecar-'));
process.on('exit', () => { try { rmSync(D, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

fileTest: {
  const file = join(D, 'index.json');
  writeIndex(file, { stale: {}, touch: {}, custom: { keep: true } });
  const beforeIno = statSync(file).ino;
  touch(file, 'abc', 123);
  const idx = readIndex(file);
  ok('写入后仍可读取', idx.touch.abc === 123);
  ok('未知桶不被抹掉', idx.custom?.keep === true);
  ok('写入使用 rename 替换文件', statSync(file).ino !== beforeIno);
  ok('不残留临时文件', readdirSync(D).every((f) => !f.includes('.tmp-')));
}

corruptTest: {
  const dir = join(D, 'corrupt');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'index.json');
  writeFileSync(file, '{"stale":');
  const logs = [];
  const oldLog = console.log;
  console.log = (line) => { logs.push(String(line)); };
  const idx = readIndex(file);
  console.log = oldLog;
  const backups = readdirSync(dir).filter((f) => f.startsWith('index.json.corrupt-'));
  ok('坏索引读成空桶', Object.keys(idx.stale).length === 0 && Object.keys(idx.touch).length === 0);
  ok('坏索引备份为 .corrupt-*', backups.length === 1);
  ok('坏索引备份有日志', logs.some((line) => line.includes('[sidecar]') && line.includes('已备份')));
}

backupFailureTest: {
  const dir = join(D, 'backup-failure');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'index.json');
  const badText = '{"stale":';
  writeFileSync(file, badText);
  chmodSync(dir, 0o500);
  const logs = [];
  const oldLog = console.log;
  console.log = (line) => { logs.push(String(line)); };
  let result;
  let touchError = null;
  try {
    result = readIndexResult(file);
    try {
      touch(file, 'abc', 123);
    } catch (err) {
      // 写失败本身是断言输入：留下错误对象，后面断言它确实失败过
      touchError = err;
    }
  } finally {
    console.log = oldLog;
    chmodSync(dir, 0o700);
  }
  ok('备份失败时读取不报告可用', result?.ok === false && result?.backupFailed === true);
  ok('备份失败时拒绝 touch 覆盖', touchError instanceof Error);
  ok('备份失败后原坏文件保持不变', readFileSync(file, 'utf8') === badText);
  ok('备份失败有明确日志', logs.some((line) => line.includes('[sidecar]') && line.includes('拒绝覆盖原文件')));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
