import sqliteInit from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import { rng } from './helpers.js';

type Lite = { exec(s: string): void; selectArrays(s: string): unknown[][] };
let newLite: () => Lite;
beforeAll(async () => {
  const s3 = (await (sqliteInit as unknown as (o: object) => Promise<{ oo1: { DB: new (n: string) => Lite } }>)({ print() {}, printErr() {} }));
  newLite = () => new s3.oo1.DB(':memory:');
});

function setup(r: () => number): string {
  const rows: string[] = [];
  for (let i = 1; i <= 40; i++) {
    const g = r() < 0.1 ? 'NULL' : `'${'abc'[Math.floor(r() * 3)]}'`;
    const x = r() < 0.1 ? 'NULL' : String(Math.floor(r() * 8));
    const y = r() < 0.1 ? 'NULL' : (Math.floor(r() * 100) / 4).toString();
    rows.push(`(${i}, ${g}, ${x}, ${y})`);
  }
  return `CREATE TABLE t(id INTEGER PRIMARY KEY, g TEXT, x INT, y REAL); INSERT INTO t VALUES ${rows.join(',')};`;
}

const canon = (v: unknown): string => (typeof v === 'number' ? (Number.isInteger(v) ? 'i' + v : 'r' + v.toPrecision(10)) : typeof v === 'bigint' ? 'i' + v : JSON.stringify(v));

function compare(lite: Lite, d: Database, q: string, ordered = false): void {
  let a: unknown;
  let b: unknown;
  try {
    a = lite.selectArrays(q);
  } catch (e) {
    a = 'ERROR ' + (e as Error).message.replace(/^SQLITE_\w+: sqlite3 result code \d+: /, '');
  }
  try {
    b = d.query(q).rows;
  } catch (e) {
    b = 'ERROR ' + (e as Error).message;
  }
  const norm = (x: unknown): string => {
    if (!Array.isArray(x)) return String(x);
    const rows = x.map((row: unknown[]) => row.map(canon).join('|'));
    return JSON.stringify(ordered ? rows : rows.sort());
  };
  expect(norm(b), q).toBe(norm(a));
}

describe('window functions', () => {
  it('hand-picked cases match SQLite', () => {
    const lite = newLite();
    const d = Database.openFile(new MemoryVfs().openSync('w.db'));
    const ddl = setup(rng(5));
    lite.exec(ddl);
    d.exec(ddl);
    const qs = [
      'SELECT id, row_number() OVER (ORDER BY id DESC) FROM t',
      'SELECT id, g, rank() OVER (PARTITION BY g ORDER BY x), dense_rank() OVER (PARTITION BY g ORDER BY x) FROM t',
      'SELECT id, percent_rank() OVER (ORDER BY x), cume_dist() OVER (ORDER BY x) FROM t',
      'SELECT id, ntile(3) OVER (ORDER BY id), ntile(7) OVER (PARTITION BY g ORDER BY id), ntile(100) OVER () FROM t',
      'SELECT id, lag(x) OVER (ORDER BY id), lead(x, 2, -1) OVER (ORDER BY id), lag(y, 0) OVER (ORDER BY id) FROM t',
      'SELECT id, first_value(x) OVER w, last_value(x) OVER w, nth_value(x, 3) OVER w FROM t WINDOW w AS (PARTITION BY g ORDER BY id)',
      'SELECT id, sum(x) OVER (ORDER BY id), count(*) OVER (ORDER BY id), avg(y) OVER (PARTITION BY g) FROM t',
      'SELECT id, sum(x) OVER (ORDER BY id ROWS BETWEEN 2 PRECEDING AND 1 FOLLOWING) FROM t',
      'SELECT id, sum(x) OVER (ORDER BY x RANGE BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t',
      'SELECT id, sum(x) OVER (ORDER BY x DESC RANGE BETWEEN 2 PRECEDING AND CURRENT ROW) FROM t',
      'SELECT id, sum(x) OVER (ORDER BY x GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING EXCLUDE GROUP) FROM t',
      'SELECT id, count(*) OVER (ORDER BY x ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE TIES) FROM t',
      'SELECT id, group_concat(id, \'-\') OVER (PARTITION BY g ORDER BY id ROWS 2 PRECEDING EXCLUDE CURRENT ROW) FROM t',
      'SELECT id, min(y) OVER (ORDER BY id ROWS BETWEEN 3 FOLLOWING AND 5 FOLLOWING), max(y) OVER (ORDER BY id ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) FROM t',
      'SELECT id, sum(x) FILTER (WHERE x > 3) OVER (ORDER BY id) FROM t',
      'SELECT g, count(*), sum(count(*)) OVER (ORDER BY g), rank() OVER (ORDER BY count(*) DESC) FROM t GROUP BY g',
      'SELECT g, sum(x) AS s, row_number() OVER (ORDER BY sum(x) DESC) FROM t GROUP BY g HAVING count(*) > 2',
      'SELECT id, x, row_number() OVER (ORDER BY x, id) AS rn FROM t ORDER BY rn LIMIT 5',
      'SELECT id FROM t ORDER BY rank() OVER (ORDER BY y DESC), id LIMIT 7',
      'SELECT id, total(y) OVER w2 FROM t WINDOW w1 AS (PARTITION BY g), w2 AS (w1 ORDER BY id ROWS 1 PRECEDING)',
      'SELECT * FROM (SELECT id, g, row_number() OVER (PARTITION BY g ORDER BY y DESC) AS r FROM t) WHERE r <= 2',
      'SELECT id, row_number() OVER () FROM t WHERE x > 5',
      'SELECT x, count(*) OVER (PARTITION BY x) FROM t WHERE 0',
      'SELECT id, sum(x) OVER (ORDER BY id ROWS -1 PRECEDING) FROM t',
      'SELECT id, ntile(0) OVER () FROM t',
      'SELECT id, sum(x) OVER (ORDER BY x, y RANGE 1 PRECEDING) FROM t',
      'SELECT id FROM t WHERE row_number() OVER () > 1',
      'SELECT id, abs(x) OVER () FROM t',
      'SELECT id, sum(x) OVER nope FROM t',
      'SELECT id, sum(DISTINCT x) OVER () FROM t',
      'SELECT id, nth_value(x, 0) OVER () FROM t',
      'SELECT id, sum(x) OVER (ROWS BETWEEN 1 FOLLOWING AND CURRENT ROW) FROM t',
    ];
    for (const q of qs) compare(lite, d, q, /ORDER BY rn|ORDER BY rank/.test(q));
  });

  it('random windows match SQLite', () => {
    const r = rng(77);
    const lite = newLite();
    const d = Database.openFile(new MemoryVfs().openSync('w.db'));
    const ddl = setup(r);
    lite.exec(ddl);
    d.exec(ddl);
    const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
    const n = Number(process.env.DIFF_WINDOWS ?? 600);
    for (let i = 0; i < n; i++) {
      const fn = pick([
        'row_number()', 'rank()', 'dense_rank()', 'percent_rank()', 'cume_dist()', 'ntile(4)', 'lag(x)', 'lead(y, 2)', 'lag(x, 1, 99)',
        'first_value(y)', 'last_value(x)', 'nth_value(x, 2)', 'sum(x)', 'count(*)', 'count(y)', 'avg(y)', 'min(x)', 'max(y)', 'total(x)', "group_concat(id, ',')",
      ]);
      const part = pick(['', 'PARTITION BY g ', 'PARTITION BY x % 2 ']);
      const order = pick(['', 'ORDER BY id', 'ORDER BY x', 'ORDER BY x DESC', 'ORDER BY y NULLS LAST', 'ORDER BY g, x']);
      let frame = '';
      if (order && r() < 0.6) {
        const unit = pick(['ROWS', 'GROUPS', ...(order === 'ORDER BY x' || order === 'ORDER BY x DESC' ? ['RANGE'] : ['RANGE'])]);
        const off = (): string => String(Math.floor(r() * 3));
        const canOffset = unit !== 'RANGE' || order === 'ORDER BY x' || order === 'ORDER BY x DESC';
        const starts = ['UNBOUNDED PRECEDING', 'CURRENT ROW', ...(canOffset ? [`${off()} PRECEDING`, `${off()} FOLLOWING`] : [])];
        const ends = ['UNBOUNDED FOLLOWING', 'CURRENT ROW', ...(canOffset ? [`${off()} PRECEDING`, `${off()} FOLLOWING`] : [])];
        frame = ` ${unit} BETWEEN ${pick(starts)} AND ${pick(ends)}${pick(['', '', ' EXCLUDE CURRENT ROW', ' EXCLUDE GROUP', ' EXCLUDE TIES'])}`;
      }
      const where = pick(['', '', ' WHERE x IS NOT NULL', ' WHERE id % 3 = 0']);
      compare(lite, d, `SELECT id, ${fn} OVER (${part}${order}${frame}) FROM t${where}`);
    }
  });
});
