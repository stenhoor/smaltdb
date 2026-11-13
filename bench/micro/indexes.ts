// Index workloads (same as the browser harness's index section): smaltdb vs SQLite WASM, Node, in memory.
//   npm run bench:micro -- indexes
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { Database } from '../../src/engine/database.js';
import '@smaltworks/smaltql/register';
import { analyticRow } from '../browser/adapter.js';

async function main(): Promise<void> {
  const N = 200_000;
  const lite: any = await (sqliteInit as any)({ print() {}, printErr() {} });
  const s = new lite.oo1.DB(':memory:');
  s.exec('PRAGMA cache_size=-524288');
  const d = Database.openMemory();
  const ddl = 'CREATE TABLE a(id INTEGER PRIMARY KEY, b INT, c REAL, d INT, e TEXT)';
  d.exec(ddl);
  s.exec(ddl);
  const ins = d.prepare('INSERT INTO a VALUES (?, ?, ?, ?, ?)');
  d.exec('BEGIN');
  for (let i = 1; i <= N; i++) ins.run(analyticRow(i));
  d.exec('COMMIT');
  const st = s.prepare('INSERT INTO a VALUES (?, ?, ?, ?, ?)');
  s.exec('BEGIN');
  for (let i = 1; i <= N; i++) st.bind(analyticRow(i)).stepReset();
  s.exec('COMMIT');
  st.finalize();
  let ks = 7;
  const rnd = (m: number): number => ((ks = (Math.imul(ks, 1103515245) + 12345) >>> 0), ks % m);
  const eqKeys = Array.from({ length: 10_000 }, () => rnd(1000));
  const rangeKeys = Array.from({ length: 1_000 }, () => rnd(990));
  const dKeys = Array.from({ length: 1_000 }, () => rnd(100));
  const eKeys = Array.from({ length: 1_000 }, () => 'x' + rnd(50));
  const time = (f: () => unknown): [number, unknown] => {
    const t0 = performance.now();
    const v = f();
    return [performance.now() - t0, v];
  };
  const smaltLookups = (sql: string, keys: (number | string)[]): number => {
    const p = d.prepare(sql);
    let sum = 0;
    for (const k of keys) {
      const row = p.all([k])[0];
      if (row && row[0] !== null) sum += Number(row[0]);
    }
    return sum;
  };
  const liteLookups = (sql: string, keys: (number | string)[]): number => {
    const p = s.prepare(sql);
    let sum = 0;
    for (const k of keys) {
      p.bind([k]);
      if (p.step()) sum += Number(p.get(0) ?? 0);
      p.reset();
    }
    p.finalize();
    return sum;
  };
  const work: [string, () => unknown, () => unknown][] = [
    ['create index on 1 column', () => d.exec('CREATE INDEX a_b ON a(b)'), () => s.exec('CREATE INDEX a_b ON a(b)')],
    ['create index on 2 columns', () => d.exec('CREATE INDEX a_dc ON a(d, c)'), () => s.exec('CREATE INDEX a_dc ON a(d, c)')],
    ['create index on lower(e)', () => d.exec('CREATE INDEX a_le ON a(lower(e))'), () => s.exec('CREATE INDEX a_le ON a(lower(e))')],
    ['equality lookups x10k', () => smaltLookups('SELECT count(*) FROM a WHERE b = ?', eqKeys), () => liteLookups('SELECT count(*) FROM a WHERE b = ?', eqKeys)],
    ['range lookups x1k (1%)', () => smaltLookups('SELECT sum(d) FROM a WHERE b >= ?1 AND b < ?1 + 10', rangeKeys), () => liteLookups('SELECT sum(d) FROM a WHERE b >= ?1 AND b < ?1 + 10', rangeKeys)],
    ['composite lookups x1k', () => smaltLookups('SELECT count(*) FROM a WHERE d = ?1 AND c > 500', dKeys), () => liteLookups('SELECT count(*) FROM a WHERE d = ?1 AND c > 500', dKeys)],
    ['expression lookups x1k', () => smaltLookups('SELECT count(*) FROM a WHERE lower(e) = ?', eKeys), () => liteLookups('SELECT count(*) FROM a WHERE lower(e) = ?', eKeys)],
    ['update indexed column 10k rows', () => d.exec('UPDATE a SET b = b + 1 WHERE id % 20 = 0'), () => s.exec('UPDATE a SET b = b + 1 WHERE id % 20 = 0')],
    ['delete 10k rows (3 indexes)', () => d.exec('DELETE FROM a WHERE id % 20 = 1'), () => s.exec('DELETE FROM a WHERE id % 20 = 1')],
    [
      'insert 100k into 3-index table',
      () => {
        d.exec('CREATE TABLE ix(id INTEGER PRIMARY KEY, b INT, c REAL, d INT, e TEXT); CREATE INDEX ix_b ON ix(b); CREATE INDEX ix_dc ON ix(d, c); CREATE INDEX ix_e ON ix(e)');
        const p = d.prepare('INSERT INTO ix VALUES (?, ?, ?, ?, ?)');
        d.exec('BEGIN');
        for (let i = 1; i <= 100_000; i++) p.run(analyticRow(i));
        d.exec('COMMIT');
      },
      () => {
        s.exec('CREATE TABLE ix(id INTEGER PRIMARY KEY, b INT, c REAL, d INT, e TEXT); CREATE INDEX ix_b ON ix(b); CREATE INDEX ix_dc ON ix(d, c); CREATE INDEX ix_e ON ix(e)');
        const p = s.prepare('INSERT INTO ix VALUES (?, ?, ?, ?, ?)');
        s.exec('BEGIN');
        for (let i = 1; i <= 100_000; i++) p.bind(analyticRow(i)).stepReset();
        s.exec('COMMIT');
        p.finalize();
      },
    ],
  ];
  console.log('workload'.padEnd(34), 'smaltdb'.padStart(10), 'sqlite'.padStart(10), 'ratio'.padStart(8), ' check');
  for (const [name, a, b] of work) {
    const [ta, va] = time(a);
    const [tb, vb] = time(b);
    console.log(name.padEnd(34), ta.toFixed(1).padStart(10), tb.toFixed(1).padStart(10), (tb / ta).toFixed(2).padStart(7) + 'x', typeof va !== 'number' ? ' -' : va === vb ? ' ok' : ` DIFF ${va} ${vb}`);
  }
  for (const q of ['EXPLAIN QUERY PLAN SELECT count(*) FROM a WHERE b = 5', 'EXPLAIN QUERY PLAN SELECT sum(d) FROM a WHERE b >= 5 AND b < 15', 'EXPLAIN QUERY PLAN SELECT count(*) FROM a WHERE d = 5 AND c > 500', "EXPLAIN QUERY PLAN SELECT count(*) FROM a WHERE lower(e) = 'x5'"]) {
    console.log(q.slice(19), '\n   smalt:', d.query(q).rows.map((r) => r[3]).join(' | '), '\n   lite: ', s.selectArrays(q).map((r: unknown[]) => r[3]).join(' | '));
  }
}
void main();
