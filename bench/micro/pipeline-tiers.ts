// Fused pipelines in tiers (codegen.ts `Tier`): planning cost when every statement has new literals, and full-scan speed
// once a statement is specialized. Each hot query is timed after 5 warm-up runs (median and minimum of 21).
// The first runs of each hot query are listed too: below the threshold they run the shared tier.
// Run (ROWS, default 400000): npx esbuild bench/micro/pipeline-tiers.ts --bundle --platform=node --format=esm --outfile=.cache/pipeline-tiers.mjs && node .cache/pipeline-tiers.mjs [ROWS]
import { Database } from '../../src/engine/database.js';
import { MemoryVfs } from '../../src/engine/vfs/memory.js';
const vfs = new MemoryVfs();
const db = Database.openFile(vfs.openSync('k.db'), {}, vfs.openSync('k.db-wal'));
db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, x INT, y REAL, s TEXT)');
db.exec('CREATE TABLE c(g INT, v INT, w REAL) WITH (storage = \'columnar\')');
const N = Number(process.argv[2] ?? 400_000);
db.exec('BEGIN');
const ins = db.prepare('INSERT INTO t VALUES (?, ?, ?, ?)');
const insc = db.prepare('INSERT INTO c VALUES (?, ?, ?)');
for (let i = 1; i <= N; i++) { ins.run([i, i % 1000, (i % 777) / 3, 's' + (i % 50)]); insc.run([i % 16, i % 1000, (i % 777) / 3]); }
db.exec('COMMIT');
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
let lastMin = 0;
function time(f: () => void, reps: number): number {
  for (let w = 0; w < 5; w++) f();
  const ms: number[] = [];
  for (let r = 0; r < reps; r++) { const t0 = performance.now(); f(); ms.push(performance.now() - t0); }
  lastMin = Math.min(...ms);
  return median(ms);
}
// Planning: new literals every statement (no statement-cache hit), small result.
const plan: [string, (i: number) => string][] = [
  ['scan filter LIMIT', (i) => `SELECT id FROM t WHERE x > ${i % 900} AND y < ${(i % 200) + 1.5} LIMIT 3`],
  ['fused count', (i) => `SELECT count(*) FROM t WHERE x = ${i % 1000} AND id < 2000`],
  ['group by', (i) => `SELECT s, count(*) FROM t WHERE id < ${1000 + (i % 500)} GROUP BY s`],
];
let n = 0;
for (const [name, sql] of plan) {
  const ms = time(() => { for (let i = 0; i < 300; i++) db.prepare(sql(n++)).all(); }, 9);
  console.log(`plan  | ${name} | ${(ms * 1000 / 300).toFixed(1)} µs/stmt`);
}
// Hot loop: same statement (cached), full scans.
const hot: [string, string][] = [
  ['row scan filter', 'SELECT count(*) FROM t WHERE x > 100 AND y < 200.5'],
  ['row arithmetic', 'SELECT sum(x * 3 + 7) FROM t WHERE x % 7 = 3'],
  ['row group by', 'SELECT x % 10, sum(y * 2.5) FROM t WHERE x > 50 GROUP BY 1'],
  ['columnar filter agg', 'SELECT sum(v * 2), count(*) FROM c WHERE v > 250 AND w < 100.5'],
  ['columnar group by', 'SELECT g, sum(v + 3), avg(w) FROM c WHERE v < 900 GROUP BY g'],
];
for (const [name, sql] of hot) {
  const st = db.prepare(sql);
  const first: string[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    st.all();
    first.push((performance.now() - t0).toFixed(1));
  }
  const ms = time(() => st.all(), 21);
  console.log(`hot   | ${name} | runs 1-3 ${first.join(' / ')} ms | then median ${ms.toFixed(1)} ms, min ${lastMin.toFixed(1)} ms`);
}
