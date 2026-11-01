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

const canon = (v: unknown): string => (typeof v === 'number' ? (Number.isInteger(v) ? 'i' + v : 'r' + v.toPrecision(10)) : JSON.stringify(v));

describe('RIGHT and FULL OUTER JOIN', () => {
  it('random join chains agree with SQLite', () => {
    const r = rng(4242);
    const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
    const lite = newLite();
    const d = Database.openFile(new MemoryVfs().openSync('o.db'));
    const names = ['a', 'b', 'c', 'e'];
    let ddl = '';
    for (const t of names) {
      ddl += `CREATE TABLE ${t}(id INTEGER PRIMARY KEY, k INT, v TEXT);`;
      const rows: string[] = [];
      const n = 3 + Math.floor(r() * 8);
      for (let i = 1; i <= n; i++) rows.push(`(${i}, ${r() < 0.15 ? 'NULL' : Math.floor(r() * 6)}, ${r() < 0.2 ? 'NULL' : `'${t}${i}'`})`);
      ddl += `INSERT INTO ${t} VALUES ${rows.join(',')};`;
    }
    ddl += 'CREATE INDEX b_k ON b(k);';
    lite.exec(ddl);
    d.exec(ddl);
    const total = Number(process.env.DIFF_OUTER ?? 1500);
    for (let i = 0; i < total; i++) {
      const n = 2 + Math.floor(r() * 3);
      const ts = Array.from({ length: n }, (_, j) => ({ t: pick(names), a: `t${j}` }));
      let sql = `FROM ${ts[0].t} ${ts[0].a}`;
      for (let j = 1; j < n; j++) {
        const jt = pick(['JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'FULL OUTER JOIN', 'RIGHT OUTER JOIN', ',']);
        const other = ts[Math.floor(r() * j)].a;
        const on = pick([`${other}.k = ${ts[j].a}.k`, `${other}.id = ${ts[j].a}.k`, `${other}.k = ${ts[j].a}.k AND ${ts[j].a}.id > 2`, `${other}.k < ${ts[j].a}.k`, `${ts[j].a}.v IS NOT NULL AND ${other}.k = ${ts[j].a}.id`]);
        sql += jt === ',' ? `, ${ts[j].t} ${ts[j].a}` : ` ${jt} ${ts[j].t} ${ts[j].a} ON ${on}`;
      }
      const w = r() < 0.6 ? ` WHERE ${pick(ts).a}.${pick(['k', 'id'])} ${pick(['>', '<', '=', 'IS NOT', 'IS'])} ${pick(['1', '3', 'NULL'])}` : '';
      const proj = r() < 0.2 ? 'count(*), sum(t0.id)' : ts.map((x) => `${x.a}.id, ${x.a}.v`).join(', ');
      const q = `SELECT ${proj} ${sql}${w}`;
      let a: string[] | string;
      let b: string[] | string;
      try {
        a = lite.selectArrays(q).map((row) => row.map(canon).join('|')).sort();
      } catch (e) {
        a = 'ERROR';
      }
      try {
        b = d.query(q).rows.map((row) => row.map(canon).join('|')).sort();
      } catch (e) {
        b = 'ERROR ' + (e as Error).message;
      }
      expect(JSON.stringify(b), q).toBe(JSON.stringify(a));
    }
  }, 120_000);
});
