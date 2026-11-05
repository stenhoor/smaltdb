// Math functions (sqrt, ln, pow, sin, exp, floor, …): cost per row in smaltdb (row and columnar tables) and in
// SQLite's WASM build on the same data and queries, next to plain arithmetic and abs() as baselines.
// Run (N rows, default 1,000,000):
//   npx esbuild bench/micro/math.ts --bundle --platform=node --format=esm --outfile=.cache/math-bench.mjs \
//     --external:@sqlite.org/sqlite-wasm && node .cache/math-bench.mjs 1000000
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { Database } from '../../src/engine/database.js';
import '../../src/engine/sql/register.js';
import { MemoryVfs } from '../../src/engine/vfs/memory.js';

const N = Number(process.argv[2] ?? 1_000_000);
const ROUNDS = Number(process.argv[3] ?? 7);

const QUERIES: [string, string][] = [
  ['baseline: sum(x * x)', 'SELECT sum(x * x) FROM t'],
  ['baseline: sum(abs(x))', 'SELECT sum(abs(x)) FROM t'],
  ['sum(sqrt(x))', 'SELECT sum(sqrt(x)) FROM t'],
  ['sum(sqrt(x) * 2 + 1)', 'SELECT sum(sqrt(x) * 2 + 1) FROM t'],
  ['sum(ln(x))', 'SELECT sum(ln(x)) FROM t'],
  ['sum(log10(x))', 'SELECT sum(log10(x)) FROM t'],
  ['sum(exp(x / 1000))', 'SELECT sum(exp(x / 1000)) FROM t'],
  ['sum(pow(x, 2))', 'SELECT sum(pow(x, 2)) FROM t'],
  ['sum(sin(x) * cos(x))', 'SELECT sum(sin(x) * cos(x)) FROM t'],
  ['sum(tanh(x / 500))', 'SELECT sum(tanh(x / 500)) FROM t'],
  ['sum(floor(x))', 'SELECT sum(floor(x)) FROM t'],
  ['sum(mod(i, 7))', 'SELECT sum(mod(i, 7)) FROM t'],
  ['count WHERE sqrt(x) > 20', 'SELECT count(*) FROM t WHERE sqrt(x) > 20'],
  ['group by k: avg(sqrt(x))', 'SELECT k, avg(sqrt(x)) FROM t GROUP BY k'],
];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function time(run: () => unknown): number {
  const ms: number[] = [];
  run(); // warm up (compile, JIT)
  for (let i = 0; i < ROUNDS; i++) {
    const t0 = performance.now();
    run();
    ms.push(performance.now() - t0);
  }
  return median(ms);
}

const rows: [number, number, number, number][] = [];
for (let id = 1; id <= N; id++) rows.push([id, ((id * 7919) % 100000) / 100 + 0.25, id % 1000, id % 16]);

const vfs = new MemoryVfs();
const db = Database.openFile(vfs.openSync('m.db'), { cacheSizeBytes: 1 << 30 }, vfs.openSync('m.db-wal'));
db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, x REAL, i INTEGER, k INTEGER)');
db.exec("CREATE TABLE c(id INTEGER PRIMARY KEY, x REAL, i INTEGER, k INTEGER) WITH (storage = 'columnar')");
for (const table of ['t', 'c']) {
  const ins = db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?)`);
  db.exec('BEGIN');
  for (const r of rows) ins.run(r);
  db.exec('COMMIT');
}

const s3 = (await (sqliteInit as unknown as (o: object) => Promise<{ oo1: { DB: new (n: string) => { exec(s: string | object): unknown; selectArrays(s: string): unknown[][]; prepare(s: string): { bind(v: unknown[]): unknown; stepReset(): unknown; finalize(): void } } } }>)({ print: () => {}, printErr: () => {} }));
const lite = new s3.oo1.DB(':memory:');
lite.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, x REAL, i INTEGER, k INTEGER)');
lite.exec('BEGIN');
const st = lite.prepare('INSERT INTO t VALUES (?, ?, ?, ?)');
for (const r of rows) {
  st.bind(r);
  st.stepReset();
}
st.finalize();
lite.exec('COMMIT');

console.log(`math functions, ${N.toLocaleString('en')} rows, median of ${ROUNDS} (ms; ns/row in brackets)`);
console.log('| Query | smaltdb row table | smaltdb columnar | SQLite WASM |');
console.log('|---|---|---|---|');
const fmt = (ms: number): string => `${ms.toFixed(1)} (${((ms * 1e6) / N).toFixed(1)})`;
for (const [name, sql] of QUERIES) {
  const a = db.query(sql).rows;
  const b = db.query(sql.replace(/FROM t\b/, 'FROM c')).rows;
  const l = lite.selectArrays(sql);
  if (JSON.stringify(a.length) !== JSON.stringify(l.length) || JSON.stringify(b.length) !== JSON.stringify(l.length)) throw new Error(`row counts differ: ${name}`);
  const rowMs = time(() => db.query(sql));
  const colMs = time(() => db.query(sql.replace(/FROM t\b/, 'FROM c')));
  const liteMs = time(() => lite.selectArrays(sql));
  console.log(`| ${name} | ${fmt(rowMs)} | ${fmt(colMs)} | ${fmt(liteMs)} |`);
}
