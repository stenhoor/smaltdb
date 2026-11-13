// Planning cost of small statements: parse, plan and compile (no cached statement), in µs per statement. The plan
// layer (ADR 0014) adds passes between parsing and operators; this is its budget check for small queries (compare
// with bench/results/ and docs/research/plan-layer-implementation.md).
// Run (ROUNDS, default 7):
//   npm run bench:micro -- prepare
import { Database } from '../../src/engine/database.js';
import '@smaltworks/smaltql/register';
import { MemoryVfs } from '../../src/engine/vfs/memory.js';

const ROUNDS = Number(process.argv[2] ?? 7);
const N = 3000;

const SHAPES: [string, (i: number) => string][] = [
  ['point lookup', (i) => `SELECT name FROM t WHERE id = ${i}`],
  ['filter + arithmetic', (i) => `SELECT id, x * 2 + ${i} FROM t WHERE x > ${i} AND name LIKE 'a%' AND y BETWEEN 1 AND ${i}`],
  ['CASE, IN, functions', (i) => `SELECT CASE WHEN x > ${i} THEN upper(name) ELSE coalesce(name, 'n') END, abs(y - ${i}) FROM t WHERE x IN (1, 2, ${i})`],
  ['group by + having', (i) => `SELECT y, count(*), sum(x) FROM t WHERE x > ${i} GROUP BY y HAVING sum(x) > ${i}`],
  ['join', (i) => `SELECT t.name, u.v FROM t JOIN u ON u.t_id = t.id WHERE t.x = ${i}`],
  ['correlated subquery', (i) => `SELECT name FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.t_id = t.id AND u.v > ${i})`],
  // Writes (steps 8a-8c), on their own table, each round in one transaction so commits don't dilute the ratio.
  ['INSERT VALUES', (i) => `INSERT INTO w(k, v, s) VALUES (${i}, ${i} * 0.5, 'w${i}')`],
  ['INSERT … ON CONFLICT DO UPDATE', (i) => `INSERT INTO w(k, v) VALUES (${i % 50}, ${i}) ON CONFLICT(k) DO UPDATE SET v = w.v + excluded.v`],
  ['INSERT … SELECT', (i) => `INSERT INTO w2 SELECT ${i}, x, name FROM t WHERE id = ${i % 2 + 1}`],
  ['UPDATE by key', (i) => `UPDATE w SET v = v + 1, s = 's${i}' WHERE k = ${i % 50}`],
  ['DELETE by key', (i) => `DELETE FROM w WHERE k = ${-i}`],
];

const vfs = new MemoryVfs();
const db = Database.openFile(vfs.openSync('p.db'), {}, vfs.openSync('p.db-wal'));
db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, x INT, y REAL); CREATE INDEX t_x ON t(x)');
db.exec('CREATE TABLE u(id INTEGER PRIMARY KEY, t_id INT, v REAL); CREATE INDEX u_t ON u(t_id)');
db.exec('CREATE TABLE w(id INTEGER PRIMARY KEY, k INT UNIQUE, v REAL, s TEXT DEFAULT \'d\', CHECK (v >= 0)); CREATE TABLE w2(a INT, b INT, c TEXT)');
db.exec("INSERT INTO t VALUES (1, 'a', 1, 1.5), (2, 'b', 2, 2.5); INSERT INTO u VALUES (1, 1, 3.0)");

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

console.log(`planning cost per statement, median of ${ROUNDS} rounds of ${N} (µs)`);
console.log('| Statement | µs |');
console.log('|---|---|');
let base = 0;
for (const [name, sql] of SHAPES) {
  const run = (): void => {
    db.exec('BEGIN');
    for (let i = 0; i < N; i++) db.prepare(sql(base++)).all();
    db.exec('COMMIT');
  };
  run(); // warm up
  const ms: number[] = [];
  for (let r = 1; r <= ROUNDS; r++) {
    const t0 = performance.now();
    run();
    ms.push(performance.now() - t0);
  }
  console.log(`| ${name} | ${((median(ms) * 1000) / N).toFixed(1)} |`);
}
