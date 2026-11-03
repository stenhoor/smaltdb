/**
 * Statistical aggregates (stat-aggregates.ts).
 * - The moments (variance, standard deviation, covariance, correlation, skewness, kurtosis) against reference values
 *   computed with numpy 2.5 and scipy 1.18 (np.var/np.std with ddof, np.cov, np.corrcoef, scipy.stats.skew and
 *   kurtosis with bias=False for the sample statistics and bias=True for the `_pop` ones), including data with a large
 *   offset, where the sum-of-squares formulas lose every digit.
 * - median and the percentile functions against SQLite (official WASM build 3.54) on random data, with GROUP BY,
 *   window frames, DISTINCT, FILTER and columnar tables, and their errors.
 */
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { select } from '../src/engine/exec/stat-aggregates.js';
import type { SqlValue } from '../src/engine/values.js';
import { rng } from './helpers.js';

type Sqlite = { exec(sql: string): void; selectArrays(sql: string): unknown[][] };
let lite: Sqlite;

beforeAll(async () => {
  const s3 = await (sqliteInit as unknown as (o: object) => Promise<{ oo1: { DB: new (n: string) => Sqlite } }>)({ print: () => {}, printErr: () => {} });
  lite = new s3.oo1.DB(':memory:');
});

/** The data sets the reference values were computed from (x, y). */
function d3(): [number[], number[]] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 1; i <= 1000; i++) {
    const x = ((i * 7919) % 1000) / 10 - 30 + (i % 7) * 0.37;
    xs.push(x);
    ys.push(x * 0.5 + ((i * 104729) % 97) / 10);
  }
  return [xs, ys];
}
const SETS: Record<string, [number[], number[]]> = {
  d1: [[2, 4, 4, 4, 5, 5, 7, 9], [1, 2, 3, 4, 5, 6, 7, 8]],
  d2: [[1.5, -3.25, 10, 7, 7, 0.125, 100, -42, 3], [3, 1, 4, 1, 5, 9, 2, 6, 5]],
  d3: d3(),
  d4: [[1e9 + 4, 1e9 + 7, 1e9 + 13, 1e9 + 16], [1, 2, 3, 5]],
};

/** numpy / scipy results for SETS (see the file comment). */
const REFERENCE: Record<string, Record<string, number>> =
{
 "d1": {
  "var_samp": 4.571428571428571,
  "var_pop": 4.0,
  "stddev_samp": 2.138089935299395,
  "stddev_pop": 2.0,
  "skewness": 0.8184875533567996,
  "skewness_pop": 0.65625,
  "kurtosis": 0.9406249999999998,
  "kurtosis_pop": -0.21875,
  "covar_samp": 4.857142857142857,
  "covar_pop": 4.25,
  "corr": 0.9274260335029676,
  "median": 4.5
 },
 "d2": {
  "var_samp": 1401.431423611111,
  "var_pop": 1245.7168209876543,
  "stddev_samp": 37.435697183451936,
  "stddev_pop": 35.29471378248667,
  "skewness": 1.8651330153193544,
  "skewness_pop": 1.5386562367717667,
  "kurtosis": 5.619912774067739,
  "kurtosis_pop": 2.350454206385564,
  "covar_samp": -35.765625,
  "covar_pop": -31.791666666666664,
  "corr": -0.36772910662060126,
  "median": 3.0
 },
 "d3": {
  "var_samp": 834.9494987666666,
  "var_pop": 834.1145492679,
  "stddev_samp": 28.895492706764262,
  "stddev_pop": 28.881041346667192,
  "skewness": 0.00022787322711825754,
  "skewness_pop": 0.00022753127475703852,
  "kurtosis": -1.197950233153546,
  "kurtosis_pop": -1.1979628676520453,
  "covar_samp": 417.8151606786288,
  "covar_pop": 417.39734551795016,
  "corr": 0.9817664156855404,
  "median": 21.090000000000003
 },
 "d4": {
  "var_samp": 30.0,
  "var_pop": 22.5,
  "stddev_samp": 5.477225575051661,
  "stddev_pop": 4.743416490252569,
  "skewness": 0.0,
  "skewness_pop": 0.0,
  "kurtosis": -3.3000000000000007,
  "kurtosis_pop": -1.64,
  "covar_samp": 9.0,
  "covar_pop": 6.75,
  "corr": 0.9621404708847278,
  "median": 1000000010.0
 }
}
;

function load(db: Database, name: string): void {
  const [xs, ys] = SETS[name];
  db.exec(`CREATE TABLE ${name}(id INTEGER PRIMARY KEY, x REAL, y REAL)`);
  db.exec(`INSERT INTO ${name}(x, y) VALUES ${xs.map((x, i) => `(${x}, ${ys[i]})`).join(', ')}`);
}

/** Within a relative error of 1e-10 (one-pass Welford and numpy's two-pass sums round differently). */
function close(got: unknown, want: number): boolean {
  return typeof got === 'number' && Math.abs(got - want) <= 1e-10 * Math.max(1, Math.abs(want));
}

describe('moments match numpy and scipy', () => {
  const ONE = ['var_samp', 'variance', 'var_pop', 'stddev_samp', 'stddev', 'stddev_pop', 'skewness', 'skewness_pop', 'kurtosis', 'kurtosis_pop', 'median'];
  const ALIAS: Record<string, string> = { variance: 'var_samp', stddev: 'stddev_samp' };
  for (const storage of ['row', 'columnar']) {
    it(`on ${Object.keys(SETS).join(', ')} (${storage} table)`, () => {
      const db = Database.openMemory();
      const bad: string[] = [];
      for (const name of Object.keys(SETS)) {
        load(db, name);
        if (storage === 'columnar') {
          db.exec(`CREATE TABLE c_${name}(id INTEGER PRIMARY KEY, x REAL, y REAL) WITH (storage = 'columnar'); INSERT INTO c_${name} SELECT * FROM ${name}`);
        }
        const table = storage === 'columnar' ? `c_${name}` : name;
        const exprs = [...ONE.map((f) => `${f}(x)`), 'covar_samp(x, y)', 'covar_pop(x, y)', 'corr(x, y)'];
        const row = db.query(`SELECT ${exprs.join(', ')} FROM ${table}`).rows[0];
        exprs.forEach((e, i) => {
          const f = e.slice(0, e.indexOf('('));
          const want = REFERENCE[name][ALIAS[f] ?? f];
          if (!close(row[i], want)) bad.push(`${name} ${e}: smaltdb ${String(row[i])}, numpy/scipy ${want}`);
        });
      }
      expect(bad).toEqual([]);
      db.close();
    });
  }

  it('stay accurate with a large offset, where sum-of-squares formulas cancel', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE t(x REAL)');
    db.exec(`INSERT INTO t VALUES ${[4, 7, 13, 16].map((d) => `(${1e12 + d})`).join(', ')}`);
    const [vs, vp, naive] = db.query('SELECT var_samp(x), var_pop(x), (sum(x * x) - sum(x) * sum(x) / count(x)) / (count(x) - 1) FROM t').rows[0] as number[];
    expect([vs, vp]).toEqual([30, 22.5]);
    expect(naive).not.toBe(30); // what the one-line formula gives instead
    db.close();
  });

  it('are NULL when undefined, and skip NULLs (rows with a NULL in either argument for two-argument ones)', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE t(g INTEGER, x REAL, y REAL)');
    db.exec('INSERT INTO t VALUES (0, NULL, NULL), (1, 5, 1), (2, 5, 1), (2, 5, 2), (3, 1, 1), (3, 2, NULL), (3, 3, 3), (4, 1, 1), (4, 2, 2), (4, 4, 3), (4, 8, 5)');
    const q = (sql: string): SqlValue[][] => db.query(sql).rows;
    // g=0: no non-NULL values. g=1: one value. g=2: constant x. g=3: three x values, pairs (1,1),(3,3). g=4: four values.
    expect(q('SELECT g, var_pop(x), var_samp(x), stddev_samp(x), skewness_pop(x), skewness(x), kurtosis_pop(x), kurtosis(x) FROM t GROUP BY g ORDER BY g')).toEqual([
      [0, null, null, null, null, null, null, null],
      [1, 0, null, null, null, null, null, null],
      [2, 0, 0, 0, null, null, null, null],
      [3, 2 / 3, 1, 1, 0, 0, -1.5, null],
      [4, q("SELECT var_pop(x) FROM t WHERE g = 4")[0][0], q("SELECT var_samp(x) FROM t WHERE g = 4")[0][0], q("SELECT stddev_samp(x) FROM t WHERE g = 4")[0][0], q("SELECT skewness_pop(x) FROM t WHERE g = 4")[0][0], q("SELECT skewness(x) FROM t WHERE g = 4")[0][0], q("SELECT kurtosis_pop(x) FROM t WHERE g = 4")[0][0], q("SELECT kurtosis(x) FROM t WHERE g = 4")[0][0]],
    ]);
    expect(q('SELECT g, covar_pop(x, y), covar_samp(x, y), corr(x, y) FROM t WHERE g IN (0, 1, 2, 3) GROUP BY g ORDER BY g')).toEqual([
      [0, null, null, null],
      [1, 0, null, null],
      [2, 0, 0, null], // x is constant: no correlation
      [3, 1, 2, 1], // pairs (1,1) and (3,3); the row with y NULL is skipped
    ]);
    expect(q('SELECT var_pop(x), typeof(var_pop(x)) FROM t WHERE x IS NULL')).toEqual([[null, 'null']]);
    db.close();
  });

  it('convert text like sum() and avg(), and work as window functions, with DISTINCT and FILTER', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v ANY)');
    db.exec("INSERT INTO t(v) VALUES (1), ('3'), (5), (7)");
    expect(db.query('SELECT var_samp(v), avg(v) FROM t').rows).toEqual([[20 / 3, 4]]);
    expect(db.query('SELECT id, var_pop(v) OVER (ORDER BY id ROWS 1 PRECEDING) FROM t ORDER BY id').rows).toEqual([[1, 0], [2, 1], [3, 1], [4, 1]]);
    expect(db.query('SELECT var_pop(DISTINCT v % 2), stddev_pop(v) FILTER (WHERE id > 2) FROM t').rows).toEqual([[0, 1]]);
    db.close();
  });
});

describe('median and the percentile functions match SQLite', () => {
  function both(setup: string, queries: string[]): void {
    const db = Database.openMemory();
    lite.exec('DROP TABLE IF EXISTS t; DROP TABLE IF EXISTS c');
    // smaltdb tables are STRICT by default; SQLite's need the keyword (and have no columnar storage).
    lite.exec(setup.replace(/(CREATE TABLE \w+\([^)]*\))( WITH \(storage = 'columnar'\))?/g, '$1 STRICT'));
    db.exec(setup);
    const bad: string[] = [];
    for (const sql of queries) {
      const want = JSON.stringify(lite.selectArrays(sql));
      const got = JSON.stringify(db.query(sql).rows);
      if (want !== got) bad.push(`${sql}\n  SQLite  ${want}\n  smaltdb ${got}`);
    }
    expect(bad).toEqual([]);
    db.close();
  }

  it('on random data: fractions, groups, window frames, DISTINCT, FILTER, row and columnar tables', () => {
    const r = rng(36);
    const rows: string[] = [];
    for (let i = 1; i <= 400; i++) {
      const v = r() < 0.1 ? 'NULL' : r() < 0.5 ? String(Math.floor(r() * 50) - 10) : (Math.floor(r() * 2000) / 16 - 40).toString();
      rows.push(`(${i}, ${Math.floor(r() * 7)}, ${v})`);
    }
    const setup = `CREATE TABLE t(id INTEGER PRIMARY KEY, g INTEGER, v REAL); CREATE TABLE c(id INTEGER PRIMARY KEY, g INTEGER, v REAL) WITH (storage = 'columnar');
      INSERT INTO t VALUES ${rows.join(', ')}; INSERT INTO c SELECT * FROM t`;
    const queries: string[] = [];
    for (const table of ['t', 'c']) {
      queries.push(`SELECT median(v), percentile(v, 0), percentile(v, 100), percentile(v, 33.3), percentile(v, '25') FROM ${table}`);
      for (const p of ['0', '0.1', '0.25', '0.333', '0.5', '0.9', '0.99', '1']) {
        queries.push(`SELECT g, percentile_cont(v, ${p}), percentile_disc(v, ${p}), count(v) FROM ${table} GROUP BY g ORDER BY g`);
      }
      queries.push(`SELECT g, median(DISTINCT v), median(v) FILTER (WHERE id % 3 = 0), typeof(median(v)) FROM ${table} GROUP BY g ORDER BY g`);
      queries.push(`SELECT id, median(v) OVER (ORDER BY id ROWS BETWEEN 3 PRECEDING AND 2 FOLLOWING), percentile_disc(v, 0.75) OVER (PARTITION BY g ORDER BY id) FROM ${table} ORDER BY id`);
      queries.push(`SELECT median(v), percentile_cont(v, 0.5), percentile_disc(v, 0.5) FROM ${table} WHERE g = 99`);
    }
    both(setup, queries);
  });

  it('on integers, including large ones', () => {
    both('CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER); INSERT INTO t(v) VALUES (9223372036854775807), (9223372036854775806), (-5), (3), (3), (12)', [
      'SELECT median(v), percentile(v, 10), percentile_disc(v, 0.4), typeof(percentile_disc(v, 0.4)) FROM t',
      'SELECT median(v) FROM t WHERE id < 3',
    ]);
  });

  it('raise the same errors', () => {
    const db = Database.openMemory();
    lite.exec("DROP TABLE IF EXISTS e; CREATE TABLE e(id INTEGER PRIMARY KEY, v ANY, p ANY) STRICT; INSERT INTO e VALUES (1, 1, 10), (2, NULL, 20), (3, 'abc', 10), (4, x'01', 10), (5, 1e999, 10)");
    db.exec("CREATE TABLE e(id INTEGER PRIMARY KEY, v ANY, p ANY) STRICT; INSERT INTO e VALUES (1, 1, 10), (2, NULL, 20), (3, 'abc', 10), (4, x'01', 10), (5, 1e999, 10)");
    const msg = (run: () => unknown): string => {
      try {
        run();
        return 'no error';
      } catch (e) {
        return (e as Error).message.replace(/^.*result code \d+: /, '');
      }
    };
    for (const sql of [
      'SELECT median(v) FROM e WHERE id IN (1, 3)',
      'SELECT median(v) FROM e WHERE id IN (1, 4)',
      'SELECT median(v) FROM e WHERE id IN (1, 5)',
      'SELECT percentile(v, p) FROM e WHERE id IN (1, 2)',
      'SELECT percentile(v, NULL) FROM e WHERE id = 1',
      'SELECT percentile(v, 101) FROM e WHERE id = 1',
      'SELECT percentile(v, -1) FROM e WHERE id = 1',
      'SELECT percentile_cont(v, 1.5) FROM e WHERE id = 1',
      "SELECT percentile_disc(v, 'x') FROM e WHERE id = 1",
      'SELECT percentile(v) FROM e',
      'SELECT median(v, 1) FROM e',
    ]) {
      expect(msg(() => db.query(sql)), sql).toBe(msg(() => lite.selectArrays(sql)));
    }
    // corr and the other moments are not in SQLite: their argument counts are checked the same way.
    expect(msg(() => db.query('SELECT corr(v) FROM e'))).toBe('wrong number of arguments to function corr()');
    expect(msg(() => db.query('SELECT stddev(v, v) FROM e'))).toBe('wrong number of arguments to function stddev()');
    db.close();
  });
});

describe('an aggregate used twice in one query', () => {
  it('has its result type both times (typeof(avg(x)) next to avg(x))', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE t(v INTEGER); INSERT INTO t VALUES (1), (3)');
    // avg of integers is a REAL even when it is whole; the second reference used to be typed ANY, so typeof said integer.
    expect(db.query('SELECT avg(v), typeof(avg(v)), median(v), typeof(median(v)) FROM t').rows).toEqual([[2, 'real', 2, 'real']]);
    db.close();
  });
});

describe('select (the k-th smallest, for median and the percentiles)', () => {
  it('agrees with a full sort at every k, on random, sorted, reversed, constant and duplicate-heavy data', () => {
    const r = rng(7);
    const shapes: [string, (n: number) => number[]][] = [
      ['random', (n) => Array.from({ length: n }, () => r() * 1000 - 500)],
      ['sorted', (n) => Array.from({ length: n }, (_v, i) => i)],
      ['reversed', (n) => Array.from({ length: n }, (_v, i) => n - i)],
      ['constant', (n) => Array.from({ length: n }, () => 3)],
      ['few values', (n) => Array.from({ length: n }, () => Math.floor(r() * 3))],
      ['organ pipe', (n) => Array.from({ length: n }, (_v, i) => Math.min(i, n - i))],
    ];
    for (const [shape, make] of shapes) {
      for (const n of [1, 2, 3, 15, 16, 17, 100, 1001]) {
        const data = make(n);
        const sorted = Float64Array.from(data).sort();
        for (let k = 0; k < n; k += n > 100 ? 37 : 1) {
          const a = Float64Array.from(data);
          select(a, k);
          expect(a[k], `${shape} n=${n} k=${k}`).toBe(sorted[k]);
          for (let i = 0; i < k; i++) if (a[i] > a[k]) throw new Error(`${shape} n=${n} k=${k}: a[${i}] > a[k]`);
          for (let i = k + 1; i < n; i++) if (a[i] < a[k]) throw new Error(`${shape} n=${n} k=${k}: a[${i}] < a[k]`);
        }
      }
    }
  });
});

describe('sliding window frames (rows leaving the frame are removed, not recomputed)', () => {
  /** Two-pass variance of the non-NULL values: the exact reference. */
  function variance(xs: (number | null)[], pop: boolean): number | null {
    const v = xs.filter((x): x is number => x !== null);
    if (v.length < (pop ? 1 : 2)) return null;
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    return v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - (pop ? 0 : 1));
  }
  const near = (a: unknown, b: number | null): boolean =>
    b === null ? a === null : typeof a === 'number' && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

  it('stay exact after large values leave the frame (the state is rebuilt when rounding could show)', () => {
    const db = Database.openMemory();
    const xs = [1e9, 1e9 + 1, 1e9 + 2, 1e9 + 4, 1, 2, 3, 4, 5, 6, 1e15, 7, 8, 9, 10, 11, 12];
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, x REAL)');
    db.exec(`INSERT INTO t(x) VALUES ${xs.map((x) => `(${x})`).join(', ')}`);
    const got = db.query('SELECT var_samp(x) OVER (ORDER BY id ROWS 2 PRECEDING) FROM t ORDER BY id').rows.map((r: SqlValue[]) => r[0]);
    const bad = xs.map((_x, i) => [got[i], variance(xs.slice(Math.max(0, i - 2), i + 1), false)] as const).filter(([g, w]) => !near(g, w));
    expect(bad).toEqual([]);
    db.close();
  });

  it('give the same variance as recomputing each frame, for every frame type', () => {
    const r = rng(99);
    const n = 3000;
    const xs = Array.from({ length: n }, () => (r() < 0.05 ? null : Math.round((r() * 2000 - 500) * 100) / 100));
    const gs = Array.from({ length: n }, () => Math.floor(r() * 4));
    const db = Database.openMemory();
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, g INTEGER, x REAL)');
    db.exec(`INSERT INTO t VALUES ${xs.map((x, i) => `(${i + 1}, ${gs[i]}, ${x ?? 'NULL'})`).join(', ')}`);
    const frames: [string, (part: number[], k: number) => number[]][] = [
      ['ROWS 20 PRECEDING', (p, k) => p.slice(Math.max(0, k - 20), k + 1)],
      ['ROWS BETWEEN 5 PRECEDING AND 7 FOLLOWING', (p, k) => p.slice(Math.max(0, k - 5), k + 8)],
      ['ROWS BETWEEN 3 FOLLOWING AND 9 FOLLOWING', (p, k) => p.slice(k + 3, k + 10)],
      ['ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING', (p, k) => p.slice(k)],
    ];
    const bad: string[] = [];
    for (const [frame, slice] of frames) {
      for (const [fn, pop] of [['var_samp', false], ['var_pop', true]] as const) {
        const got = db.query(`SELECT id, ${fn}(x) OVER (PARTITION BY g ORDER BY id ${frame}) FROM t ORDER BY id`).rows;
        const parts = new Map<number, number[]>();
        xs.forEach((_x, i) => (parts.get(gs[i]) ?? parts.set(gs[i], []).get(gs[i])!).push(i));
        for (const [, idx] of parts) {
          idx.forEach((i, k) => {
            const want = variance(slice(idx, k).map((j) => xs[j]), pop);
            if (!near(got[i][1], want)) bad.push(`${fn} ${frame} id ${i + 1}: ${String(got[i][1])} vs ${want}`);
          });
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    // RANGE and GROUPS frames, and FILTER: against the recomputing path. With a unique ORDER BY, EXCLUDE TIES excludes
    // nothing, so the frames are the same, but frames with an exclusion are always recomputed.
    for (const [fn, frame] of [
      ['stddev(x)', 'RANGE BETWEEN 40 PRECEDING AND 15 FOLLOWING'],
      ['var_pop(x)', 'GROUPS BETWEEN 12 PRECEDING AND CURRENT ROW'],
      ['var_samp(x) FILTER (WHERE x > 0)', 'ROWS 30 PRECEDING'],
    ]) {
      const sql = `SELECT id, ${fn} OVER (PARTITION BY g ORDER BY id ${frame}) FROM t ORDER BY id`;
      const sliding = db.query(sql).rows;
      const recomputed = db.query(sql.replace(frame, `${frame} EXCLUDE TIES`)).rows;
      sliding.forEach((row: SqlValue[], i: number) => {
        if (!near(row[1], recomputed[i][1] as number | null)) bad.push(`${sql} id ${String(row[0])}: ${String(row[1])} vs ${String(recomputed[i][1])}`);
      });
    }
    expect(bad.slice(0, 5)).toEqual([]);
    db.close();
  });

  it("give SQLite's median and percentiles for every frame type", () => {
    const r = rng(5);
    const rows = Array.from({ length: 600 }, (_v, i) => `(${i + 1}, ${Math.floor(r() * 5)}, ${r() < 0.08 ? 'NULL' : Math.floor(r() * 400) / 4 - 20})`);
    const db = Database.openMemory();
    const ddl = 'CREATE TABLE w(id INTEGER PRIMARY KEY, g INTEGER, v REAL)';
    db.exec(`${ddl}; INSERT INTO w VALUES ${rows.join(', ')}`);
    lite.exec(`DROP TABLE IF EXISTS w; ${ddl} STRICT; INSERT INTO w VALUES ${rows.join(', ')}`);
    const bad: string[] = [];
    for (const frame of ['ROWS 10 PRECEDING', 'ROWS BETWEEN 4 PRECEDING AND 6 FOLLOWING', 'ROWS BETWEEN 2 FOLLOWING AND 30 FOLLOWING', 'RANGE BETWEEN 1 PRECEDING AND 1 FOLLOWING', 'GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW']) {
      const order = frame.startsWith('ROWS') ? 'id' : 'g';
      for (const f of ['median(v)', 'percentile_cont(v, 0.9)', 'percentile_disc(v, 0.25)', 'percentile(v, 40)']) {
        const sql = `SELECT id, ${f} OVER (PARTITION BY id % 3 ORDER BY ${order} ${frame}) FROM w ORDER BY id`;
        const want = JSON.stringify(lite.selectArrays(sql));
        const got = JSON.stringify(db.query(sql).rows);
        if (want !== got) bad.push(sql);
      }
    }
    expect(bad).toEqual([]);
    db.close();
  });
});
