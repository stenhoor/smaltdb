// Statistical aggregates (variance, stddev, skewness, kurtosis, covariance, corr, median, percentiles): cost per row
// in smaltdb (row and columnar tables), next to sum() and avg(), and in SQLite's WASM build where it has the function
// (median and the percentiles; for variance, the sum-of-squares formula one writes without var_samp).
// Run (N rows, default 1,000,000):
//   npx esbuild bench/micro/stats.ts --bundle --platform=node --format=esm --outfile=.cache/stats-bench.mjs \
//     --external:@sqlite.org/sqlite-wasm && node .cache/stats-bench.mjs 1000000
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { Database } from '../../src/engine/database.js';
import 'smaltql/register';
import { MemoryVfs } from '../../src/engine/vfs/memory.js';

const N = Number(process.argv[2] ?? 1_000_000);
const ROUNDS = Number(process.argv[3] ?? 7);
/** Rows the sliding-window query reads (a window function re-reads every frame). */
const W = Math.min(N, 100_000);

const VAR_FORMULA = '(sum(x * x) - sum(x) * sum(x) / count(x)) / (count(x) - 1)';

/** [name, smaltdb SQL, SQLite SQL (null: SQLite has no such function)] */
const QUERIES: [string, string, string | null][] = [
  ['baseline: sum(x)', 'SELECT sum(x) FROM t', 'SELECT sum(x) FROM t'],
  ['baseline: avg(x)', 'SELECT avg(x) FROM t', 'SELECT avg(x) FROM t'],
  ['var_samp(x)', 'SELECT var_samp(x) FROM t', `SELECT ${VAR_FORMULA} FROM t`],
  ['stddev(x)', 'SELECT stddev(x) FROM t', null],
  ['skewness(x)', 'SELECT skewness(x) FROM t', null],
  ['kurtosis(x)', 'SELECT kurtosis(x) FROM t', null],
  ['covar_samp(x, y)', 'SELECT covar_samp(x, y) FROM t', null],
  ['corr(x, y)', 'SELECT corr(x, y) FROM t', null],
  ['median(x)', 'SELECT median(x) FROM t', 'SELECT median(x) FROM t'],
  ['percentile_cont(x, 0.9)', 'SELECT percentile_cont(x, 0.9) FROM t', 'SELECT percentile_cont(x, 0.9) FROM t'],
  ['group by k (16): stddev(x)', 'SELECT k, stddev(x) FROM t GROUP BY k', null],
  ['group by k (16): median(x)', 'SELECT k, median(x) FROM t GROUP BY k', 'SELECT k, median(x) FROM t GROUP BY k'],
  [
    `median over 51-row window (${W.toLocaleString('en')} rows)`,
    `SELECT sum(m) FROM (SELECT median(x) OVER (ORDER BY id ROWS 50 PRECEDING) AS m FROM t WHERE id <= ${W})`,
    `SELECT sum(m) FROM (SELECT median(x) OVER (ORDER BY id ROWS 50 PRECEDING) AS m FROM t WHERE id <= ${W})`,
  ],
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
for (let id = 1; id <= N; id++) {
  const x = ((id * 7919) % 100000) / 100 + 0.25;
  rows.push([id, x, x * 0.5 + ((id * 104729) % 97) / 10, id % 16]);
}

const vfs = new MemoryVfs();
const db = Database.openFile(vfs.openSync('s.db'), { cacheSizeBytes: 1 << 30 }, vfs.openSync('s.db-wal'));
db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, x REAL, y REAL, k INTEGER)');
db.exec("CREATE TABLE c(id INTEGER PRIMARY KEY, x REAL, y REAL, k INTEGER) WITH (storage = 'columnar')");
for (const table of ['t', 'c']) {
  const ins = db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?)`);
  db.exec('BEGIN');
  for (const r of rows) ins.run(r);
  db.exec('COMMIT');
}
db.exec('PRAGMA compact(c)');

const s3 = await (sqliteInit as unknown as (o: object) => Promise<{ oo1: { DB: new (n: string) => { exec(s: string): unknown; selectArrays(s: string): unknown[][]; prepare(s: string): { bind(v: unknown[]): unknown; stepReset(): unknown; finalize(): void } } } }>)({ print: () => {}, printErr: () => {} });
const lite = new s3.oo1.DB(':memory:');
lite.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, x REAL, y REAL, k INTEGER)');
lite.exec('BEGIN');
const st = lite.prepare('INSERT INTO t VALUES (?, ?, ?, ?)');
for (const r of rows) {
  st.bind(r);
  st.stepReset();
}
st.finalize();
lite.exec('COMMIT');

console.log(`statistical aggregates, ${N.toLocaleString('en')} rows, median of ${ROUNDS} (ms; ns/row in brackets)`);
console.log('| Query | smaltdb row table | smaltdb columnar | SQLite WASM |');
console.log('|---|---|---|---|');
for (const [name, sql, liteSql] of QUERIES) {
  const rowsRead = sql.includes(`id <= ${W}`) ? W : N;
  const fmt = (ms: number): string => `${ms.toFixed(1)} (${((ms * 1e6) / rowsRead).toFixed(1)})`;
  const colSql = sql.replace(/FROM t\b/, 'FROM c');
  const rowMs = time(() => db.query(sql));
  const colMs = time(() => db.query(colSql));
  const liteCell = liteSql === null ? 'no such function' : `${fmt(time(() => lite.selectArrays(liteSql)))}${liteSql === sql ? '' : ' (formula)'}`;
  console.log(`| ${name} | ${fmt(rowMs)} | ${fmt(colMs)} | ${liteCell} |`);
}
