/**
 * The engine-comparison workloads, shared by the browser harness (bench/browser/worker.ts) and the Node harness
 * (bench/node/engine.ts): every engine runs exactly this sequence through the Adapter interface, and the result
 * checks must agree across engines.
 */
import { ANALYTIC_QUERIES, type Adapter, analyticRow } from '../browser/adapter.js';
import { JOIN_DDL, JOIN_INDEXES, JOIN_QUERIES, JOIN_SIZES, JOIN_TABLES, joinRows } from './joins.js';

export interface WorkloadOptions {
  rows: number;
  lookups: number;
  smallTxns: number;
  analyticRows: number;
  joins: boolean;
  indexes: boolean;
  matviews: boolean;
}

export interface WorkloadResult {
  workload: string;
  ops: number;
  ms: number;
  /** Deterministic summary of the result; must agree across engines. */
  check: string;
}

/** Canonical form of query results: numbers to 9 significant digits, bigint as number, rows sorted. */
function canon(rows: unknown[][]): string {
  const norm = (v: unknown): string => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'bigint') v = Number(v);
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toPrecision(9);
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return norm(Number(v)); // Postgres numeric as text
    return JSON.stringify(v);
  };
  return rows.map((r) => r.map(norm).join(',')).sort().join(';');
}

async function timed(out: WorkloadResult[], workload: string, ops: number, fn: () => Promise<unknown>): Promise<void> {
  const t0 = performance.now();
  const r = await fn();
  const ms = performance.now() - t0;
  out.push({ workload, ops, ms, check: Array.isArray(r) ? canon(r as unknown[][]) : String(r) });
}

/** Open `a`, run every workload, close it. */
export async function runWorkloads(a: Adapter, o: WorkloadOptions): Promise<{ openMs: number; results: WorkloadResult[] }> {
  const { rows: N, lookups, smallTxns, analyticRows, joins, indexes, matviews } = o;
  const results: WorkloadResult[] = [];
  const t0 = performance.now();
  await a.open();
  const openMs = performance.now() - t0;
  let s = 42;
  const keys = new Int32Array(lookups);
  for (let i = 0; i < lookups; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    keys[i] = s % N;
  }
  await timed(results, `bulk insert ${N} rows (1 txn)`, N, () => a.bulkInsert(N));
  await timed(results, `point lookup x${lookups} (warm)`, lookups, () => a.pointLookups(keys));
  await timed(results, 'scan read values (warm)', N, () => a.scanValues());
  await timed(results, `${smallTxns} single-row durable txns`, smallTxns, () => a.smallTxns(N, smallTxns));
  if (a.persistent !== false) {
    await a.reopen();
    await timed(results, `point lookup x${lookups} (cold)`, lookups, () => a.pointLookups(keys));
    await a.reopen();
    await timed(results, 'scan read values (cold)', N, () => a.scanValues());
  }
  await timed(results, `load analytic table (${analyticRows} rows)`, analyticRows, () => a.loadAnalytic(analyticRows));
  // Report both the first execution (includes JIT warm-up of generated code) and the steady state
  // (median of 5 repeats, e.g. a refreshed dashboard). WebAssembly engines warm up differently.
  for (const [name, sql] of Object.entries(ANALYTIC_QUERIES)) {
    await timed(results, `analytic: ${name} (first run)`, analyticRows, () => a.query(sql));
    const reps: WorkloadResult[] = [];
    for (let i = 0; i < 5; i++) await timed(reps, 'x', analyticRows, () => a.query(sql));
    const sorted = reps.map((x) => x.ms).sort((x, y) => x - y);
    results.push({ workload: `analytic: ${name} (repeat, median of 5)`, ops: analyticRows, ms: sorted[2], check: reps[0].check });
  }
  if (matviews) {
    // Columnar projection of `a` (smaltdb: columnar materialized view; others: CREATE TABLE AS).
    const sel = 'SELECT * FROM a';
    const projection = a.projection ? (n: string, q: string) => a.projection!(n, q) : (n: string, q: string) => a.exec(`CREATE TABLE ${n} AS ${q}`);
    const refresh = a.refreshProjection
      ? (n: string, q: string) => a.refreshProjection!(n, q)
      : async (n: string, q: string) => {
          await a.exec('BEGIN');
          await a.exec(`DELETE FROM ${n}`);
          await a.exec(`INSERT INTO ${n} ${q}`);
          await a.exec('COMMIT');
        };
    await timed(results, `mv: build projection of a (${analyticRows} rows)`, analyticRows, () => projection('a_proj', sel));
    for (const [name, sql] of Object.entries(ANALYTIC_QUERIES)) {
      const q = sql.replace('FROM a', 'FROM a_proj');
      await timed(results, `mv: ${name} on projection (first run)`, analyticRows, () => a.query(q));
      const reps: WorkloadResult[] = [];
      for (let i = 0; i < 5; i++) await timed(reps, 'x', analyticRows, () => a.query(q));
      const sorted = reps.map((x) => x.ms).sort((x, y) => x - y);
      results.push({ workload: `mv: ${name} on projection (repeat, median of 5)`, ops: analyticRows, ms: sorted[2], check: reps[0].check });
    }
    const starts = Array.from({ length: 20 }, (_, i) => 1 + ((i * 7919) % Math.max(1, analyticRows - analyticRows / 20)));
    await timed(results, 'mv: clustered range x20 on projection (5% of rows each)', 20, () =>
      a.lookups(`SELECT sum(b) FROM a_proj WHERE id >= ?1 AND id < ?1 + ${Math.floor(analyticRows / 20)}`, starts),
    );
    await timed(results, `mv: refresh projection (${analyticRows} rows)`, analyticRows, async () => {
      await refresh('a_proj', sel);
      return a.query('SELECT count(*), sum(b) FROM a_proj');
    });
  }
  if (indexes) {
    // Secondary indexes on the analytic table `a` (b = i % 1000, d = i % 100, e = 'x' || i % 50).
    let ks = 7;
    const rnd = (m: number): number => ((ks = (Math.imul(ks, 1103515245) + 12345) >>> 0), ks % m);
    const eqKeys = Array.from({ length: 10_000 }, () => rnd(1000));
    const rangeKeys = Array.from({ length: 1_000 }, () => rnd(990));
    const dKeys = Array.from({ length: 1_000 }, () => rnd(100));
    const eKeys = Array.from({ length: 1_000 }, () => 'x' + rnd(50));
    await timed(results, `index: create on 1 column (${analyticRows} rows)`, analyticRows, () => a.exec('CREATE INDEX a_b ON a(b)'));
    await timed(results, `index: create on 2 columns (${analyticRows} rows)`, analyticRows, () => a.exec('CREATE INDEX a_dc ON a(d, c)'));
    await timed(results, `index: create on expression lower(e) (${analyticRows} rows)`, analyticRows, () => a.exec('CREATE INDEX a_le ON a(lower(e))'));
    await timed(results, 'index: equality lookups x10k (200 rows each)', 10_000, () => a.lookups('SELECT count(*) FROM a WHERE b = ?', eqKeys));
    await timed(results, 'index: range lookups x1k (1% of rows each)', 1_000, () => a.lookups('SELECT sum(d) FROM a WHERE b >= ?1 AND b < ?1 + 10', rangeKeys));
    await timed(results, 'index: composite lookups x1k (d = ? AND c > 500)', 1_000, () => a.lookups('SELECT count(*) FROM a WHERE d = ?1 AND c > 500', dKeys));
    await timed(results, 'index: expression lookups x1k (lower(e) = ?)', 1_000, () => a.lookups('SELECT count(*) FROM a WHERE lower(e) = ?', eKeys));
    await timed(results, 'index: update indexed column, 10k rows (3 indexes)', 10_000, async () => {
      await a.exec('UPDATE a SET b = b + 1 WHERE id % 20 = 0');
      return a.query('SELECT count(*), sum(b) FROM a');
    });
    await timed(results, 'index: delete 10k rows (3 indexes)', 10_000, async () => {
      await a.exec('DELETE FROM a WHERE id % 20 = 1');
      return a.query('SELECT count(*), sum(b) FROM a');
    });
    await timed(results, 'index: bulk insert 100k rows into a table with 3 indexes', 100_000, async () => {
      await a.loadRows('CREATE TABLE ix(id INTEGER PRIMARY KEY, b INT, c REAL, d INT, e TEXT)', 'ix', 100_000, analyticRow, [
        'CREATE INDEX ix_b ON ix(b)',
        'CREATE INDEX ix_dc ON ix(d, c)',
        'CREATE INDEX ix_e ON ix(e)',
      ]);
      return a.query('SELECT count(*), sum(b), sum(d) FROM ix');
    });
  }
  if (joins) {
    const total = JOIN_TABLES.reduce((n, t) => n + JOIN_SIZES[t], 0);
    await timed(results, `load join tables (${total} rows, 2 indexes)`, total, async () => {
      for (let i = 0; i < JOIN_TABLES.length; i++) await a.loadRows(JOIN_DDL[i], JOIN_TABLES[i], JOIN_SIZES[JOIN_TABLES[i]], joinRows[JOIN_TABLES[i]]);
      for (const ix of JOIN_INDEXES) await a.exec(ix);
    });
    for (const [name, sql] of Object.entries(JOIN_QUERIES)) {
      await timed(results, `join: ${name} (first run)`, 1, () => a.query(sql));
      const reps: WorkloadResult[] = [];
      for (let i = 0; i < 5; i++) await timed(reps, 'x', 1, () => a.query(sql));
      const sorted = reps.map((x) => x.ms).sort((x, y) => x - y);
      results.push({ workload: `join: ${name} (repeat, median of 5)`, ops: 1, ms: sorted[2], check: reps[0].check });
    }
  }
  await a.close();
  return { openMs, results };
}
