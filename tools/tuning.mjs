#!/usr/bin/env node
/**
 * ashu的审核工具：看/批/驳 koi提交的曲线调整申请。
 *
 *   node ~/koi/tools/tuning.mjs list
 *   node ~/koi/tools/tuning.mjs approve <序号>
 *   node ~/koi/tools/tuning.mjs reject  <序号> "理由"
 *
 * 批准后会直接写进对应的状态文件（lexicon.json / affect.json），并记录审计。
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-11-26 CI 抓到的写死部署路径：默认值改成相对位置，部署方用 KOI_DATA 指定
const DATA = process.env.KOI_DATA ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.koi');
const QUEUE = join(DATA, 'pending-tuning.jsonl');
const LEXICON = join(DATA, 'lexicon.json');
const AFFECT = join(DATA, 'affect.json');
const AUDIT = join(DATA, 'tuning-audit.jsonl');

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {});
function writeTextAtomic(p, text) {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, p);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* 临时文件可能还没创建 */ }
    throw err;
  }
}
const writeJson = (p, o) => writeTextAtomic(p, JSON.stringify(o, null, 2));
const writeQueue = (items) => writeTextAtomic(
  QUEUE,
  items.map((x) => JSON.stringify(x)).join('\n') + (items.length ? '\n' : ''),
);
function readQueue() {
  if (!existsSync(QUEUE)) return [];
  return readFileSync(QUEUE, 'utf8').split('\n').flatMap((line, i) => {
    if (line.trim() === '') return [];
    try {
      return [JSON.parse(line)];
    } catch (err) {
      throw new Error(`待审队列第 ${i + 1} 行不是合法 JSON，拒绝修改：${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/** 把申请落到真实配置上 */
function apply(req) {
  if (req.kind === 'mood') {
    /**
     * 2026-11-24 M3：单值心情曲线已退休（不再存值、不再注入）。
     * 但 `request_mood_tuning` 还留着（koi 11-21 明确要保留），
     * 所以把它的效果**接到唯一活着的心情载体**上：多维情绪的衰减速度。
     *
     *   half → 半衰期（天）→ 换算成 alpha，写成 mood-dims 的默认曲线
     *
     * 这样批一条"心情衰减慢一点"的申请，真的会让她自己填的那些情绪淡得慢一点。
     * 别的字段（w0/shape）在多维模型里没有对应物，直接拒绝，不写假账。
     */
    // 不合法的申请**不走 apply 的退出**：退出去会把这条卡在队列里、也没有审计记录。
    // 直接抛错交给上面的 approve 分支处理（记 rejected + 清队列）。
    if (req.field !== 'half') {
      throw new Error(`多维情绪只支持 half（半衰期），收到 ${req.field}`);
    }
    const half = Number(req.value);
    if (!Number.isFinite(half) || half <= 0) {
      throw new Error(`half 要给正数，收到 ${req.value}`);
    }
    // 落回 affect.json 的 moodCurveDefaults（和原来同一处），
    // 由 affect 插件启动时读它、换算成多维情绪的默认 alpha。
    const a = readJson(AFFECT);
    a.moodCurveDefaults ??= { w0: 1.0, half: 18, shape: 1.3 };
    a.moodCurveDefaults.half = half;
    // 打戳：affect 插件只认"批过的" half，否则用文档里的 36 小时默认
    a.moodCurveDefaults.tunedAt = Date.now();
    writeJson(AFFECT, a);
  } else {
    const l = readJson(LEXICON);
    l.curves ??= {};
    l.curves[req.kind] ??= {};
    l.curves[req.kind][req.field] = req.value;
    writeJson(LEXICON, l);
  }
}

const [cmd, idx, reason] = process.argv.slice(2);
const queue = readQueue();

if (cmd === 'list' || cmd === undefined) {
  if (queue.length === 0) { console.log('没有待审申请。'); process.exit(0); }
  console.log(`待审 ${queue.length} 条：`);
  queue.forEach((q, i) => {
    const at = new Date(q.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    console.log(`${String(i + 1).padStart(2)}. [${at}] ${q.kind}.${q.field}: ${q.from ?? '?'} → ${q.value}（${q.why}）`);
  });
} else if (cmd === 'approve' || cmd === 'reject') {
  const i = Number(idx) - 1;
  const req = queue[i];
  if (!req) { console.error('序号不对'); process.exit(1); }
  if (cmd === 'approve') {
    try {
      apply(req);
    } catch (err) {
      // 批准失败也要记一笔并出队，别让一条错误申请永远卡在队列里
      appendFileSync(AUDIT, `${JSON.stringify({ ...req, decision: 'rejected', reason: `批准失败：${err instanceof Error ? err.message : String(err)}`, decidedAt: Date.now() })}\n`, 'utf8');
      const rest = queue.filter((_, k) => k !== i);
      writeQueue(rest);
      console.error(`批准失败（已记 rejected 并出队）：${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }
  appendFileSync(AUDIT, `${JSON.stringify({ ...req, decision: cmd === 'approve' ? 'approved' : 'rejected', reason: reason ?? '', decidedAt: Date.now() })}\n`, 'utf8');
  const rest = queue.filter((_, k) => k !== i);
  writeQueue(rest);
  console.log(cmd === 'approve' ? `已批准：${req.kind}.${req.field} = ${req.value}` : `已驳回（理由：${reason ?? '无'}）`);
}
