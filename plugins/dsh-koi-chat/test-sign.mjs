import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadKey, sign, verify } from './lib/sign.js';

let p = 0, f = 0;
const ok = (n, c, extra = '') => { c ? p++ : f++; console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : ` — ${extra}`}`); };

const D = mkdtempSync(join(tmpdir(), 'chatsign-'));
const kf = join(D, 'chat.key');

const k1 = loadKey(kf);
ok('生成 64 位 hex 密钥', /^[0-9a-f]{64}$/.test(k1), k1.length);
ok('密钥文件 0600', (statSync(kf).mode & 0o777) === 0o600, (statSync(kf).mode & 0o777).toString(8));
ok('再读是同一把', loadKey(kf) === k1);

const m = { from: 'ashu', at: 1794200000000, kind: 'chat', text: '在吗' };
const sig = sign(m, k1);
ok('签名是 32 位 hex', /^[0-9a-f]{32}$/.test(sig));

ok('原样验过', verify({ ...m, sig }, k1) === 'ok');
ok('改文本就废', verify({ ...m, text: '在吗？', sig }, k1) === 'bad');
ok('改时间就废', verify({ ...m, at: m.at + 1, sig }, k1) === 'bad');
ok('改署名就废', verify({ ...m, from: 'koi', sig }, k1) === 'bad');
ok('没签名 = unsigned', verify(m, k1) === 'unsigned');
ok('签名是空串 = unsigned', verify({ ...m, sig: '' }, k1) === 'unsigned');
ok('换把钥匙就废', verify({ ...m, sig }, loadKey(join(D, 'other.key'))) === 'bad');

// 密钥文件被写坏：重新生成，不抛
writeFileSync(kf, 'not-a-key\n');
const k2 = loadKey(kf);
ok('坏密钥文件会重建', /^[0-9a-f]{64}$/.test(k2) && k2 !== k1);
ok('重建后旧签名作废', verify({ ...m, sig }, k2) === 'bad');

rmSync(D, { recursive: true, force: true });
console.log(`\n${p} 通过 / ${f} 失败`);
process.exit(f === 0 ? 0 : 1);
