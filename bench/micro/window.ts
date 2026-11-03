// Window functions: cost per row in smaltdb and in SQLite's WASM build, for ranking, navigation and aggregates over
// growing, sliding and RANGE frames. Each query sums the window results, so the result set is one row.
// Run (N rows, default 100,000):
//   npx esbuild bench/micro/window.ts --bundle --platform=node --format=esm --outfile=.cache/window-bench.mjs \
//     --external:@sqlite.org/sqlite-wasm && node .cache/window-bench.mjs 100000
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { Database } from '../../src/engine/database.js';
import { MemoryVfs } from '../../src/engine/vfs/memory.js';

const N = Number(process.argv[2] ?? 100_000);
const ROUNDS = Number(process.argv[3] ?? 5);

const W = (expr: string): string => `SELECT sum(w) FROM (SELECT ${expr} AS w FROM t)`;
const QUERIES: [string, string][] = [
  ['baseline: SELECT sum(x)', 'SELECT sum(x) FROM t'],
  ['row_number() OVER (ORDER BY id)', W('row_number() OVER (ORDER BY id)')],
  ['rank() OVER (PARTITION BY k ORDER BY x)', W('rank() OVER (PARTITION BY k ORDER BY x)')],
  ['lag(x) OVER (ORDER BY id)', W('lag(x) OVER (ORDER BY id)')],
  ['sum(x) OVER (ORDER BY id) (running)', W('sum(x) OVER (ORDER BY id)')],
  ['count(*) OVER (PARTITION BY k)', W('count(*) OVER (PARTITION BY k)')],
  ['avg(x) OVER (ROWS 50 PRECEDING)', W('avg(x) OVER (ORDER BY id ROWS 50 PRECEDING)')],
  ['sum(x) OVER (ROWS 50 PRECEDING)', W('sum(x) OVER (ORDER BY id ROWS 50 PRECEDING)')],
  ['max(x) OVER (ROWS 50 PRECEDING)', W('max(x) OVER (ORDER BY id ROWS 50 PRECEDING)')],
  ['first_value(x) OVER (ROWS 50 PRECEDING)', W('first_value(x) OVER (ORDER BY id ROWS 50 PRECEDING)')],
  ['last_value(x) OVER (ORDER BY id)', W('last_value(x) OVER (ORDER BY id)')],
  ['var_samp(x) OVER (ROWS 50 PRECEDING)', W('var_samp(x) OVER (ORDER BY id ROWS 50 PRECEDING)')],
  ['median(x) OVER (ROWS 50 PRECEDING)', W('median(x) OVER (ORDER BY id ROWS 50 PRECEDING)')],
  ['sum(x) OVER (ORDER BY i RANGE 5 PRECEDING)', W('sum(x) OVER (ORDER BY i RANGE BETWEEN 5 PRECEDING AND 5 FOLLOWING)')],
];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function time(run: () => unknown): number {
  const ms: number[] = [];
  run(); // warm up
  for (let i = 0; i < ROUNDS; i++) {
    const t0 = performance.now();
    run();
    ms.push(performance.now() - t0);
  }
  return median(ms);
}

const rows: [number, number, number, number][] = [];
for (let id = 1; id <= N; id++) rows.push([id, ((id * 7919) % 100000) / 100 + 0.25, (id * 37) % 1000, id % 16]);

const vfs = new MemoryVfs();
const db = Database.openFile(vfs.openSync('w.db'), { cacheSizeBytes: 1 << 30 }, vfs.openSync('w.db-wal'));
db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, x REAL, i INTEGER, k INTEGER)');
const ins = db.prepare('INSERT INTO t VALUES (?, ?, ?, ?)');
db.exec('BEGIN');
for (const r of rows) ins.run(r);
db.exec('COMMIT');

const s3 = await (sqliteInit as unknown as (o: object) => Promise<{ oo1: { DB: new (n: string) => { exec(s: string): unknown; selectArrays(s: string): unknown[][]; prepare(s: string): { bind(v: unknown[]): unknown; stepReset(): unknown; finalize(): void } } } }>)({ print: () => {}, printErr: () => {} });
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

console.log(`window functions, ${N.toLocaleString('en')} rows, median of ${ROUNDS} (ms; ns/row in brackets)`);
console.log('| Query | smaltdb | SQLite WASM |');
console.log('|---|---|---|');
const fmt = (ms: number): string => `${ms.toFixed(1)} (${((ms * 1e6) / N).toFixed(0)})`;
for (const [name, sql] of QUERIES) {
  const a = db.query(sql).rows[0][0] as number;
  let liteCell = 'no such function';
  try {
    const b = lite.selectArrays(sql)[0][0] as number;
    if (Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(b))) throw new Error(`${name}: smaltdb ${a}, SQLite ${b}`);
    liteCell = fmt(time(() => lite.selectArrays(sql)));
  } catch (e) {
    if (!/no such function/.test(String(e))) throw e;
  }
  console.log(`| ${name} | ${fmt(time(() => db.query(sql)))} | ${liteCell} |`);
}
