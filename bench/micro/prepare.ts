// Planning cost of small statements: parse, plan and compile (no cached statement), in µs per statement. The plan
// layer (ADR 0014) adds passes between parsing and operators; this is its budget check for small queries. Each round
// runs every planning mode in turn in one process (SMALT_PLAN: the plan layer, and the planner's AST path), so the
// ratio is not skewed by machine noise between runs.
// Run (ROUNDS, default 7):
//   npx esbuild bench/micro/prepare.ts --bundle --platform=node --format=esm --outfile=.cache/prepare-bench.mjs && node .cache/prepare-bench.mjs
import { Database } from '../../src/engine/database.js';
import { MemoryVfs } from '../../src/engine/vfs/memory.js';
import { setPlanMode } from '../../src/engine/exec/plan-shadow.js';

const ROUNDS = Number(process.argv[2] ?? 7);
const N = 3000;

const SHAPES: [string, (i: number) => string][] = [
  ['point lookup', (i) => `SELECT name FROM t WHERE id = ${i}`],
  ['filter + arithmetic', (i) => `SELECT id, x * 2 + ${i} FROM t WHERE x > ${i} AND name LIKE 'a%' AND y BETWEEN 1 AND ${i}`],
  ['CASE, IN, functions', (i) => `SELECT CASE WHEN x > ${i} THEN upper(name) ELSE coalesce(name, 'n') END, abs(y - ${i}) FROM t WHERE x IN (1, 2, ${i})`],
  ['group by + having', (i) => `SELECT y, count(*), sum(x) FROM t WHERE x > ${i} GROUP BY y HAVING sum(x) > ${i}`],
  ['join', (i) => `SELECT t.name, u.v FROM t JOIN u ON u.t_id = t.id WHERE t.x = ${i}`],
  ['correlated subquery', (i) => `SELECT name FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.t_id = t.id AND u.v > ${i})`],
];

const vfs = new MemoryVfs();
const db = Database.openFile(vfs.openSync('p.db'), {}, vfs.openSync('p.db-wal'));
db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, x INT, y REAL); CREATE INDEX t_x ON t(x)');
db.exec('CREATE TABLE u(id INTEGER PRIMARY KEY, t_id INT, v REAL); CREATE INDEX u_t ON u(t_id)');
db.exec("INSERT INTO t VALUES (1, 'a', 1, 1.5), (2, 'b', 2, 2.5); INSERT INTO u VALUES (1, 1, 3.0)");

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const MODES = ['plan', 'legacy'] as const;
console.log(`planning cost per statement, median of ${ROUNDS} rounds of ${N} (µs)`);
console.log('| Statement | plan layer | AST path | ratio |');
console.log('|---|---|---|---|');
let base = 0;
for (const [name, sql] of SHAPES) {
  const run = (): void => {
    for (let i = 0; i < N; i++) db.prepare(sql(base++)).all();
  };
  const ms: Record<string, number[]> = { plan: [], legacy: [] };
  for (const m of MODES) {
    setPlanMode(m);
    run(); // warm up
  }
  for (let r = 1; r <= ROUNDS; r++) {
    for (const m of MODES) {
      setPlanMode(m);
      const t0 = performance.now();
      run();
      ms[m].push(performance.now() - t0);
    }
  }
  const us = (m: string): number => (median(ms[m]) * 1000) / N;
  console.log(`| ${name} | ${us('plan').toFixed(1)} | ${us('legacy').toFixed(1)} | ${(us('plan') / us('legacy')).toFixed(2)} |`);
}
setPlanMode(null);
