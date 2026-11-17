// Version history (ADR 0033 step 7): the two methods, `versions` and `log`, against a table without history.
// Writes (a bulk insert, single-row inserts, updates in many commits, deletes), current reads, reads of the recent and
// the far past (`asOf`), and the file's size. Each case is the median of ROUNDS fresh runs.
// Run (N rows, default 100,000; update commits, default 20; rounds, default 3):
//   npm run bench:micro -- history 100000 20 3
import { Database } from '../../src/engine/database.js';
import '@smaltworks/smaltql/register';
import type { PlanStatementInput } from '../../src/engine/plan/statement.js';
import { MemoryVfs } from '../../src/engine/vfs/memory.js';

const N = Number(process.argv[2] ?? 100_000);
const COMMITS = Number(process.argv[3] ?? 20);
const ROUNDS = Number(process.argv[4] ?? 3);
const SINGLE = 2_000;

type Method = 'none' | 'versions' | 'log';
const col = (name: string, type: string) => ({ name, declaredType: type, type, notNull: false, collation: 'binary' });
const createT = (history: Method): PlanStatementInput =>
  ({
    kind: 'schema',
    op: {
      op: 'createTable',
      temp: false,
      ifNotExists: false,
      table: {
        name: 't',
        storage: 'row',
        ...(history === 'none' ? {} : { history }),
        columns: [col('id', 'INTEGER'), col('v', 'TEXT'), col('n', 'INTEGER')],
        keys: [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }], ofColumn: 0 }],
        checks: [],
        foreignKeys: [],
      },
    },
  }) as unknown as PlanStatementInput;
/** SELECT sum(n) FROM t [as of commit c]. */
const sumAsOf = (c?: number): PlanStatementInput =>
  ({
    kind: 'query',
    plan: {
      op: 'aggregate',
      input: { op: 'scan', table: 't', columns: [2], ...(c !== undefined ? { asOf: { commit: { k: 'lit', value: c, type: 'int' } } } : {}) },
      keys: [],
      aggs: [{ fn: 'sum', args: [{ k: 'col', input: 0, index: 0, depth: 0, type: 'int', collation: 'binary' }], star: false, distinct: false, collation: 'binary', type: 'int' }],
      carry: [],
    },
  }) as unknown as PlanStatementInput;

const ms = (f: () => void): number => {
  const t0 = performance.now();
  f();
  return performance.now() - t0;
};

interface Run {
  bulkInsert: number;
  singleInserts: number;
  updates: number;
  deletes: number;
  readCurrent: number;
  readRecent: number;
  readFarPast: number;
  fileKiB: number;
}

function run(method: Method): Run {
  const vfs = new MemoryVfs();
  const db = Database.openFile(vfs.openSync('h.db'), { cacheSizeBytes: 1 << 30 }, vfs.openSync('h.db-wal'));
  db.queryPlan(createT(method));
  const r = {} as Run;
  r.bulkInsert = ms(() => db.exec(`WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ${N}) INSERT INTO t SELECT i, 'value ' || i, i % 1000 FROM s`));
  const afterInsert = db.pager.commitId;
  const ins = db.prepare('INSERT INTO t VALUES (?, ?, ?)');
  r.singleInserts = ms(() => {
    for (let i = 1; i <= SINGLE; i++) ins.run([N + i, 'one', i]);
  });
  // Each commit updates a tenth of the rows: after COMMITS commits, each row has about COMMITS / 10 versions.
  r.updates = ms(() => {
    for (let k = 0; k < COMMITS; k++) db.exec(`UPDATE t SET n = n + 1 WHERE id % 10 = ${k % 10}`);
  });
  const recent = db.pager.commitId;
  r.deletes = ms(() => db.exec('DELETE FROM t WHERE id % 10 = 3'));
  const reads = (c?: number) => {
    const xs: number[] = [];
    for (let i = 0; i < 5; i++) xs.push(ms(() => db.queryPlan(sumAsOf(c))));
    return xs.sort((a, b) => a - b)[2]!;
  };
  r.readCurrent = reads();
  if (method !== 'none') {
    r.readRecent = reads(recent);
    r.readFarPast = reads(afterInsert);
  } else {
    r.readRecent = Number.NaN;
    r.readFarPast = Number.NaN;
  }
  db.exec('PRAGMA wal_checkpoint');
  r.fileKiB = Math.round((db.pager.pageCount * db.pager.pageSize) / 1024);
  db.close();
  return r;
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const results: Record<string, Record<string, number>> = {};
for (const method of ['none', 'versions', 'log'] as const) {
  const runs: Run[] = [];
  for (let i = 0; i < ROUNDS; i++) runs.push(run(method));
  results[method] = Object.fromEntries(Object.keys(runs[0]!).map((k) => [k, Math.round(median(runs.map((x) => x[k as keyof Run])) * 10) / 10]));
}
console.log(`history: ${N} rows, ${SINGLE} single-row inserts, ${COMMITS} update commits (a tenth of the rows each), ${ROUNDS} rounds (median ms; file in KiB)`);
console.table(results);
console.log(JSON.stringify({ n: N, single: SINGLE, commits: COMMITS, rounds: ROUNDS, results }));
