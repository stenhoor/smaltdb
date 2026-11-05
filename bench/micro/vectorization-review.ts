// Vectorization review prototype (docs/research/vectorization-review.md).
// Run: npx esbuild bench/micro/vectorization-review.ts --bundle --platform=node --format=esm --outfile=.cache/vr.mjs --external:@sqlite.org/sqlite-wasm && node .cache/vr.mjs 1000000
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { Database } from '../../src/engine/database.js';
import '../../src/engine/sql/register.js';
import { MemoryVfs } from '../../src/engine/vfs/memory.js';
import { BTree } from '../../src/engine/storage/btree.js';
const N = Number(process.argv[2] ?? 1_000_000);
const vfs = new MemoryVfs();
const db = Database.openFile(vfs.openSync('a.db'), { cacheSizeBytes: 512 << 20 }, vfs.openSync('a.db-wal'));
db.exec('CREATE TABLE a(id INTEGER PRIMARY KEY, b INT, c REAL, d INT, e TEXT)');
const ins = db.prepare('INSERT INTO a VALUES (?, ?, ?, ?, ?)');
db.exec('BEGIN'); for (let i = 1; i <= N; i++) ins.run([i, i % 1000, ((i * 7919) % 1000) + 0.5, i % 100, 'x' + (i % 50)]); db.exec('COMMIT');
const SQL = 'SELECT count(*), sum(b * 2 + d), sum(c * 1.1) FROM a WHERE b % 7 = 3 AND c < 900';
const table = db.getTable('a')!; const L = table.layout.full; // b=1, c=2, d=3 ; all non-null here
const tree = new BTree(db.pager, table.rootPage);
const bitmap = (L.n + 7) >>> 3; const sB = L.slot[1], sC = L.slot[2], sD = L.slot[3];
function leaves(cb: (b: Uint8Array, dv: DataView) => void) {
  let f = tree.descendForCursor(null, false);
  for (;;) { cb(f.bytes, f.view); const nx = f.view.getUint32(8, true); db.pager.release(f); if (!nx) break; f = db.pager.get(nx); }
}
const i32 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
// V1: ideal row-at-a-time: values in locals, no register array, no null checks needed (data has none, checked bitmap anyway)
function v1() {
  let cnt = 0, s1 = 0, s2 = 0;
  leaves((b, dv) => { const n = b[2] | (b[3] << 8);
    for (let i = 0; i < n; i++) { const off = b[24 + 2 * i] | (b[25 + 2 * i] << 8); const vo = off + 7 + (b[off] | (b[off + 1] << 8)); const fx = vo + 3 + bitmap;
      if (b[vo + 3] & 0b1110) continue; // nulls in b,c,d -> skip (none in this data)
      const bv = i32(b, fx + sB), cv = dv.getFloat64(fx + sC, true), dvv = i32(b, fx + sD);
      if (bv % 7 !== 3 || !(cv < 900)) continue; cnt++; s1 += bv * 2 + dvv; s2 += cv * 1.1; } });
  return [cnt, s1, s2];
}
// V2: vectorized over row store: per page decode into typed arrays, selection vector, column loops
const B = 512; const vb = new Int32Array(B), vd = new Int32Array(B), vc = new Float64Array(B), sel = new Uint16Array(B);
function v2() {
  let cnt = 0, s1 = 0, s2 = 0;
  leaves((b, dv) => { const n = b[2] | (b[3] << 8);
    for (let i = 0; i < n; i++) { const off = b[24 + 2 * i] | (b[25 + 2 * i] << 8); const vo = off + 7 + (b[off] | (b[off + 1] << 8)); const fx = vo + 3 + bitmap;
      vb[i] = i32(b, fx + sB); vc[i] = dv.getFloat64(fx + sC, true); vd[i] = i32(b, fx + sD); }
    let m = 0; for (let i = 0; i < n; i++) { sel[m] = i; m += (vb[i] % 7 === 3 && vc[i] < 900) ? 1 : 0; }
    for (let j = 0; j < m; j++) { const i = sel[j]; s1 += vb[i] * 2 + vd[i]; s2 += vc[i] * 1.1; } cnt += m; });
  return [cnt, s1, s2];
}
// V3/V4: columnar storage (ideal): typed arrays per column
const cb = new Int32Array(N), cc = new Float64Array(N), cd = new Int32Array(N);
for (let i = 1; i <= N; i++) { cb[i - 1] = i % 1000; cc[i - 1] = ((i * 7919) % 1000) + 0.5; cd[i - 1] = i % 100; }
function v3() { // fused vectorized loops over columns, batch of 1024 with selection vector
  let cnt = 0, s1 = 0, s2 = 0; const sv = new Uint16Array(1024);
  for (let base = 0; base < N; base += 1024) { const end = Math.min(N, base + 1024); let m = 0;
    for (let i = base; i < end; i++) { sv[m] = i - base; m += (cb[i] % 7 === 3 && cc[i] < 900) ? 1 : 0; }
    for (let j = 0; j < m; j++) { const i = base + sv[j]; s1 += cb[i] * 2 + cd[i]; s2 += cc[i] * 1.1; } cnt += m; }
  return [cnt, s1, s2];
}
const t1 = new Float64Array(1024), t2 = new Float64Array(1024), mk = new Uint8Array(1024);
function v4() { // "classic" vectorized engine: one primitive per operator, materialized intermediate vectors
  let cnt = 0, s1 = 0, s2 = 0;
  for (let base = 0; base < N; base += 1024) { const len = Math.min(1024, N - base);
    for (let i = 0; i < len; i++) t1[i] = cb[base + i] % 7;          // b % 7
    for (let i = 0; i < len; i++) mk[i] = t1[i] === 3 ? 1 : 0;        // = 3
    for (let i = 0; i < len; i++) mk[i] &= cc[base + i] < 900 ? 1 : 0; // AND c < 900
    for (let i = 0; i < len; i++) t1[i] = cb[base + i] * 2;           // b * 2
    for (let i = 0; i < len; i++) t1[i] += cd[base + i];              // + d
    for (let i = 0; i < len; i++) t2[i] = cc[base + i] * 1.1;         // c * 1.1
    for (let i = 0; i < len; i++) if (mk[i]) { cnt++; s1 += t1[i]; s2 += t2[i]; } }
  return [cnt, s1, s2];
}
const lite: any = await (sqliteInit as any)({ print() {}, printErr() {} });
const s = new lite.oo1.DB(':memory:');
s.exec('PRAGMA cache_size=-524288; CREATE TABLE a(id INTEGER PRIMARY KEY, b INT, c REAL, d INT, e TEXT) STRICT; BEGIN');
const st = s.prepare('INSERT INTO a VALUES (?,?,?,?,?)');
for (let i = 1; i <= N; i++) st.bind([i, i % 1000, ((i * 7919) % 1000) + 0.5, i % 100, 'x' + (i % 50)]).stepReset();
st.finalize(); s.exec('COMMIT');
const p = db.prepare(SQL);
const time = (f: () => unknown) => { for (let i = 0; i < 3; i++) f(); const t: number[] = []; for (let i = 0; i < 11; i++) { const t0 = performance.now(); f(); t.push(performance.now() - t0); } return t.sort((a, b) => a - b)[5]; };
const ref = JSON.stringify(p.all()[0].map((x) => Math.round(Number(x))));
const rows: [string, () => unknown][] = [
  ['SQLite WASM (reference)', () => s.selectArrays(SQL)],
  ['V0 smaltdb now: fused, row-at-a-time, register array', () => p.all()],
  ['V1 ideal row-at-a-time: values in locals', v1],
  ['V2 vectorized over row store (page -> typed arrays)', v2],
  ['V3 columnar storage + fused vector loops', v3],
  ['V4 columnar + one-primitive-per-op vectors', v4],
];
console.log(`N=${N}  result check ${ref}`);
const base = time(rows[1][1]);
for (const [name, f] of rows) {
  const r = f() as unknown;
  const vals = Array.isArray(r) ? (Array.isArray((r as unknown[])[0]) ? (r as unknown[][])[0] : r) : r;
  const ok = JSON.stringify((vals as unknown[]).map((x) => Math.round(Number(x)))) === ref ? 'ok' : 'MISMATCH ' + JSON.stringify(vals);
  const t = time(f);
  console.log(`${name.padEnd(56)} ${t.toFixed(2).padStart(7)} ms  ${(t * 1e6 / N).toFixed(1).padStart(5)} ns/row  ${(base / t).toFixed(2)}x vs V0  ${ok}`);
}
