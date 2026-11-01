/**
 * Differential testing of multi-table joins against SQLite: 3–4 table INNER/LEFT/CROSS mixes over
 * tables of very different sizes, so the cost-based optimizer actually reorders joins and picks
 * different join methods. Each seed runs once without statistics and once after ANALYZE.
 *
 *   DIFF_JOINS=5000 npx vitest run test/differential-joins.test.ts
 */
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import type { SqlValue } from '../src/engine/values.js';
import { rng } from './helpers.js';

type Sqlite = { exec(sql: string): void; selectArrays(sql: string): unknown[][] };
let sqlite3: { oo1: { DB: new (name: string) => Sqlite } };

beforeAll(async () => {
  sqlite3 = (await (sqliteInit as unknown as (o: object) => Promise<unknown>)({ print: () => {}, printErr: () => {} })) as never;
});

const SCHEMA = `
  CREATE TABLE big(id INTEGER PRIMARY KEY, k INTEGER, g INTEGER, s TEXT) STRICT;
  CREATE INDEX big_k ON big(k);
  CREATE TABLE mid(id INTEGER PRIMARY KEY, big_id INTEGER, h INTEGER, t TEXT) STRICT;
  CREATE INDEX mid_big ON mid(big_id);
  CREATE TABLE small(id INTEGER PRIMARY KEY, h INTEGER, name TEXT) STRICT;
  CREATE TABLE tiny(g INTEGER, label TEXT) STRICT;
`;

const TEXTS = ["'a'", "'b'", "'B'", "'xy'", "''", "'10'"];

function buildData(r: () => number): string[] {
  const out: string[] = [];
  const maybe = (p: number, v: string): string => (r() < p ? 'NULL' : v);
  for (let i = 1; i <= 400; i++)
    out.push(`INSERT INTO big VALUES (${i}, ${maybe(0.1, String(Math.floor(r() * 50)))}, ${maybe(0.1, String(Math.floor(r() * 6)))}, ${maybe(0.1, TEXTS[Math.floor(r() * TEXTS.length)])})`);
  for (let i = 1; i <= 120; i++)
    out.push(`INSERT INTO mid VALUES (${i}, ${maybe(0.1, String(1 + Math.floor(r() * 420)))}, ${maybe(0.1, String(Math.floor(r() * 12)))}, ${maybe(0.1, TEXTS[Math.floor(r() * TEXTS.length)])})`);
  for (let i = 1; i <= 15; i++) out.push(`INSERT INTO small VALUES (${i}, ${maybe(0.1, String(Math.floor(r() * 12)))}, ${maybe(0.1, TEXTS[Math.floor(r() * TEXTS.length)])})`);
  for (let i = 0; i < 5; i++) out.push(`INSERT INTO tiny VALUES (${maybe(0.15, String(i + (r() < 0.3 ? 1 : 0)))}, ${maybe(0.1, TEXTS[i])})`);
  return out;
}

function pick<T>(r: () => number, xs: T[]): T {
  return xs[Math.floor(r() * xs.length)];
}

interface Rel {
  alias: string;
  table: string;
  num: string[];
  text: string[];
}

const TABLES: Record<string, { num: string[]; text: string[] }> = {
  big: { num: ['id', 'k', 'g'], text: ['s'] },
  mid: { num: ['id', 'big_id', 'h'], text: ['t'] },
  small: { num: ['id', 'h'], text: ['name'] },
  tiny: { num: ['g'], text: ['label'] },
};

/** Join predicates between two relations (by table names), oriented a→b. */
function joinPreds(a: Rel, b: Rel): string[] {
  const P = (x: string, y: string): string => `${a.alias}.${x} = ${b.alias}.${y}`;
  const key = `${a.table}-${b.table}`;
  const map: Record<string, string[]> = {
    'big-mid': [P('id', 'big_id'), P('k', 'h')],
    'mid-big': [P('big_id', 'id'), P('h', 'k')],
    'mid-small': [P('h', 'h'), P('id', 'id')],
    'small-mid': [P('h', 'h'), P('id', 'id')],
    'big-tiny': [P('g', 'g')],
    'tiny-big': [P('g', 'g')],
    'small-tiny': [P('id', 'g'), P('name', 'label')],
    'tiny-small': [P('g', 'id'), P('label', 'name')],
    'big-small': [P('k', 'id'), P('s', 'name')],
    'small-big': [P('id', 'k'), P('name', 's')],
    'mid-tiny': [P('h', 'g')],
    'tiny-mid': [P('g', 'h')],
  };
  const ps = map[key] ?? [];
  // Self-joins (same table, different alias): join on a shared column.
  if (a.table === b.table) return [`${a.alias}.${TABLES[a.table].num[1] ?? 'g'} = ${b.alias}.${TABLES[b.table].num[1] ?? 'g'}`];
  return ps.length ? ps : [`${a.alias}.${TABLES[a.table].num[0]} = ${b.alias}.${TABLES[b.table].num[0]}`];
}

function localPred(r: () => number, x: Rel): string {
  const k = r();
  if (k < 0.45) return `${x.alias}.${pick(r, x.num)} ${pick(r, ['<', '>', '=', '<=', '!='])} ${Math.floor(r() * 30)}`;
  if (k < 0.65) return `${x.alias}.${pick(r, x.text)} ${pick(r, ['=', '<', 'IS NOT'])} ${pick(r, TEXTS)}`;
  if (k < 0.8) return `${x.alias}.${pick(r, x.num)} IS ${r() < 0.5 ? 'NOT ' : ''}NULL`;
  return `${x.alias}.${pick(r, x.num)} IN (${Array.from({ length: 1 + Math.floor(r() * 3) }, () => Math.floor(r() * 12)).join(', ')})`;
}

function genQuery(r: () => number): string {
  const n = 2 + Math.floor(r() * 3); // 2–4 relations
  const rels: Rel[] = [];
  for (let i = 0; i < n; i++) {
    const table = pick(r, ['big', 'mid', 'small', 'tiny']);
    rels.push({ alias: `r${i}`, table, ...TABLES[table] });
  }
  let sql = `FROM ${rels[0].table} ${rels[0].alias}`;
  const where: string[] = [];
  for (let i = 1; i < n; i++) {
    const x = rels[i];
    const partner = rels[Math.floor(r() * i)];
    const pred = pick(r, joinPreds(partner, x));
    const k = r();
    if (k < 0.3) {
      // Comma join with the predicate in WHERE (reorderable).
      sql += `, ${x.table} ${x.alias}`;
      where.push(pred);
    } else if (k < 0.55) {
      sql += ` JOIN ${x.table} ${x.alias} ON ${pred}${r() < 0.3 ? ` AND ${localPred(r, x)}` : ''}`;
    } else if (k < 0.85) {
      sql += ` LEFT JOIN ${x.table} ${x.alias} ON ${pred}${r() < 0.3 ? ` AND ${localPred(r, x)}` : ''}`;
    } else if (k < 0.93) {
      sql += ` CROSS JOIN ${x.table} ${x.alias}`;
      where.push(pred);
    } else {
      // Cartesian with a tiny table only, to keep row counts sane.
      if (x.table === 'tiny' || x.table === 'small') sql += `, ${x.table} ${x.alias}`;
      else {
        sql += `, ${x.table} ${x.alias}`;
        where.push(pred);
      }
    }
  }
  const nLocal = Math.floor(r() * 3);
  for (let i = 0; i < nLocal; i++) where.push(localPred(r, pick(r, rels)));
  if (r() < 0.15) {
    // Anti-join shape: a LEFT-joined relation's key IS NULL.
    const x = pick(r, rels);
    where.push(`${x.alias}.${x.num[0]} IS NULL`);
  }
  const proj = rels.flatMap((x) => [`${x.alias}.${x.num[0]}`, `${x.alias}.${pick(r, x.text)}`]);
  const kind = r();
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  if (kind < 0.25) return `SELECT count(*), sum(${rels[0].alias}.${rels[0].num[0]}) ${sql}${w}`;
  if (kind < 0.4) {
    const g = `${rels[0].alias}.${pick(r, rels[0].num)}`;
    return `SELECT ${g}, count(*), max(${rels[n - 1].alias}.${rels[n - 1].num[0]}) ${sql}${w} GROUP BY ${g}`;
  }
  return `SELECT ${proj.join(', ')} ${sql}${w}`;
}

function canon(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'bigint') return 'i' + v.toString();
  if (typeof v === 'number') return Number.isInteger(v) ? 'i' + v : 'r' + v.toPrecision(12);
  if (typeof v === 'string') return 's' + JSON.stringify(v);
  return '?' + String(v);
}

function run(seed: number, queries: number, analyze: boolean): { failures: string[]; compared: number } {
  const r = rng(seed);
  const lite = new sqlite3.oo1.DB(':memory:');
  const smalt = Database.openFile(new MemoryVfs().openSync('d.db'));
  lite.exec(SCHEMA);
  smalt.exec(SCHEMA.replaceAll(' STRICT', ''));
  for (const s of buildData(r)) {
    lite.exec(s);
    smalt.exec(s);
  }
  if (analyze) smalt.exec('ANALYZE');
  const failures: string[] = [];
  let compared = 0;
  for (let q = 0; q < queries && failures.length < 5; q++) {
    let sql = genQuery(r);
    // Huge results (low-NDV many-to-many chains) are compared through aggregates over them, which
    // still checks every joined row's contribution without materializing ~10^6 rows in both engines.
    try {
      const [[n]] = lite.selectArrays(`SELECT count(*) FROM (${sql})`) as [[number]];
      if (n > 20000) {
        const cols = sql.slice(7, sql.indexOf(' FROM ')).split(', ');
        sql = `SELECT count(*), ${cols.map((_, i) => `total(c${i}), count(c${i}), total(length(c${i}))`).join(', ')} FROM (${sql.replace(/^SELECT (.*?) FROM /, (_m, list: string) => `SELECT ${list.split(', ').map((c, i) => `${c} AS c${i}`).join(', ')} FROM `)})`;
      }
    } catch {
      /* error path compared below */
    }
    let a: unknown[][] | Error;
    let b: SqlValue[][] | Error;
    const t0 = performance.now();
    try {
      a = lite.selectArrays(sql);
    } catch (e) {
      a = e as Error;
    }
    const t1 = performance.now();
    try {
      b = smalt.query(sql).rows;
    } catch (e) {
      b = e as Error;
    }
    const t2 = performance.now();
    if (process.env.DIFF_SLOW && t2 - t1 > 20) console.log(`SLOW smalt=${(t2 - t1).toFixed(1)} sqlite=${(t1 - t0).toFixed(1)} rows=${Array.isArray(b) ? b.length : 'err'}\n  ${sql}`);
    if (a instanceof Error || b instanceof Error) {
      if (a instanceof Error && b instanceof Error) continue;
      failures.push(`${sql}\n  sqlite: ${a instanceof Error ? 'ERROR ' + a.message : `${a.length} rows`}\n  smalt:  ${b instanceof Error ? 'ERROR ' + b.message : `${b.length} rows`}`);
      continue;
    }
    compared++;
    const ca = a.map((row) => row.map(canon).join('|')).sort();
    const cb = b.map((row) => row.map(canon).join('|')).sort();
    if (ca.length !== cb.length || ca.some((x, i) => x !== cb[i])) {
      const sb = new Set(cb);
      const sa = new Set(ca);
      failures.push(
        `${sql}\n  rows sqlite=${ca.length} smalt=${cb.length}\n  only sqlite: ${JSON.stringify(ca.filter((x) => !sb.has(x)).slice(0, 3))}\n  only smalt:  ${JSON.stringify(cb.filter((x) => !sa.has(x)).slice(0, 3))}`,
      );
    }
  }
  return { failures, compared };
}

describe('differential multi-table joins vs SQLite', () => {
  const total = Number(process.env.DIFF_JOINS ?? 600);
  for (const analyze of [false, true]) {
    for (let s = 1; s <= 2; s++) {
      it(`joins agree with SQLite (seed ${s}, ${analyze ? 'after ANALYZE' : 'no statistics'})`, () => {
        const { failures, compared } = run(s * 104729, Math.ceil(total / 2), analyze);
        if (failures.length) throw new Error(`${failures.length} mismatches:\n\n${failures.join('\n\n')}`);
        expect(compared).toBeGreaterThan(total / 4);
      }, 60_000);
    }
  }
});

// ------------------------------------------------------------------ views and derived tables (flattening)

const VIEWS = `
  CREATE VIEW v_big AS SELECT id, k, g AS grp, s FROM big WHERE k IS NOT NULL;
  CREATE VIEW v_join AS SELECT m.id AS mid, b.k, m.h, b.s FROM mid m JOIN big b ON b.id = m.big_id;
  CREATE VIEW v_left AS SELECT s.id, s.h, s.name, t.label FROM small s LEFT JOIN tiny t ON t.g = s.h;
  CREATE VIEW v_agg AS SELECT g, count(*) AS n FROM big GROUP BY g;
  CREATE VIEW v_star AS SELECT * FROM small WHERE id > 3;
  CREATE VIEW v_v(a, b) AS SELECT k, grp FROM v_big WHERE grp < 4;
`;

const VREL: Record<string, { num: string[]; text: string[] }> = {
  big: { num: ['id', 'k', 'g'], text: ['s'] },
  mid: { num: ['id', 'big_id', 'h'], text: ['t'] },
  small: { num: ['id', 'h'], text: ['name'] },
  tiny: { num: ['g'], text: ['label'] },
  v_big: { num: ['id', 'k', 'grp'], text: ['s'] },
  v_join: { num: ['mid', 'k', 'h'], text: ['s'] },
  v_left: { num: ['id', 'h'], text: ['name', 'label'] },
  v_agg: { num: ['g', 'n'], text: [] },
  v_star: { num: ['id', 'h'], text: ['name'] },
  v_v: { num: ['a', 'b'], text: [] },
};

function genViewQuery(r: () => number): string {
  const n = 1 + Math.floor(r() * 3);
  const names = Object.keys(VREL);
  const rels = Array.from({ length: n }, (_, i) => {
    const kind = r();
    const table = pick(r, names);
    // Sometimes wrap a relation in a FROM subquery.
    const src = kind < 0.2 ? `(SELECT * FROM ${table} WHERE ${pick(r, VREL[table].num)} IS NOT NULL)` : table;
    return { alias: `q${i}`, table, src, ...VREL[table] };
  });
  let sql = `FROM ${rels[0].src} ${rels[0].alias}`;
  const where: string[] = [];
  for (let i = 1; i < n; i++) {
    const x = rels[i];
    const p = rels[Math.floor(r() * i)];
    const pred = `${p.alias}.${pick(r, p.num)} = ${x.alias}.${pick(r, x.num)}`;
    const k = r();
    if (k < 0.4) sql += ` JOIN ${x.src} ${x.alias} ON ${pred}`;
    else if (k < 0.7) sql += ` LEFT JOIN ${x.src} ${x.alias} ON ${pred}`;
    else {
      sql += `, ${x.src} ${x.alias}`;
      where.push(pred);
    }
  }
  if (r() < 0.7) {
    const x = pick(r, rels);
    where.push(`${x.alias}.${pick(r, x.num)} ${pick(r, ['<', '>', '=', '!=', 'IS NOT'])} ${r() < 0.15 ? 'NULL' : Math.floor(r() * 12)}`);
  }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const k = r();
  if (k < 0.2) return `SELECT count(*) ${sql}${w}`;
  if (k < 0.35) return `SELECT * ${sql}${w}`;
  if (k < 0.5) {
    const x = rels[0];
    const col = pick(r, x.num);
    return `SELECT ${x.alias}.${col}, count(*) ${sql}${w} GROUP BY ${x.alias}.${col}`;
  }
  const proj = rels.flatMap((x) => [`${x.alias}.${x.num[0]}`, ...(x.text.length ? [`${x.alias}.${pick(r, x.text)}`] : [])]);
  // Unqualified references exercise name resolution through flattened views.
  if (n === 1 && r() < 0.5) return `SELECT ${rels[0].num.join(', ')} ${sql}${w}`;
  return `SELECT ${proj.join(', ')} ${sql}${w}`;
}

describe('differential views and FROM subqueries vs SQLite', () => {
  const total = Number(process.env.DIFF_VIEWS ?? 600);
  for (let s = 1; s <= 2; s++) {
    it(`view queries agree with SQLite (seed ${s})`, () => {
      const r = rng(s * 7907);
      const lite = new sqlite3.oo1.DB(':memory:');
      const smalt = Database.openFile(new MemoryVfs().openSync('d.db'));
      lite.exec(SCHEMA + VIEWS);
      smalt.exec(SCHEMA.replaceAll(' STRICT', '') + VIEWS);
      for (const q of buildData(r)) {
        lite.exec(q);
        smalt.exec(q);
      }
      const failures: string[] = [];
      let compared = 0;
      for (let i = 0; i < Math.ceil(total / 2) && failures.length < 5; i++) {
        const sql = genViewQuery(r);
        let a: unknown[][] | Error;
        let b: SqlValue[][] | Error;
        try {
          a = lite.selectArrays(sql);
        } catch (e) {
          a = e as Error;
        }
        try {
          b = smalt.query(sql).rows;
        } catch (e) {
          b = e as Error;
        }
        if (a instanceof Error || b instanceof Error) {
          if (a instanceof Error && b instanceof Error) continue;
          failures.push(`${sql}\n  sqlite: ${a instanceof Error ? 'ERROR ' + a.message : a.length + ' rows'}\n  smalt:  ${b instanceof Error ? 'ERROR ' + b.message : b.length + ' rows'}`);
          continue;
        }
        compared++;
        const ca = a.map((row) => row.map(canon).join('|')).sort();
        const cb = b.map((row) => row.map(canon).join('|')).sort();
        if (ca.length !== cb.length || ca.some((x, j) => x !== cb[j])) failures.push(`${sql}\n  rows sqlite=${ca.length} smalt=${cb.length}\n  e.g. sqlite ${ca.find((x) => !cb.includes(x))} smalt ${cb.find((x) => !ca.includes(x))}`);
      }
      if (failures.length) throw new Error(`${failures.length} mismatches:\n\n${failures.join('\n\n')}`);
      expect(compared).toBeGreaterThan(total / 4);
    }, 60_000);
  }
});

