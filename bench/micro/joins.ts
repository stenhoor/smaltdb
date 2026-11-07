// Join workloads: smaltdb vs SQLite WASM in Node (both in memory). Used to drive M3 (optimizer).
// Run: npx esbuild bench/micro/joins.ts --bundle --platform=node --format=esm --outfile=.cache/joins.mjs --external:@sqlite.org/sqlite-wasm && node .cache/joins.mjs
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { Database } from '../../src/engine/database.js';
import '@smaltworks/smaltql/register';
import { MemoryVfs } from '../../src/engine/vfs/memory.js';

import { JOIN_DDL, JOIN_INDEXES, JOIN_QUERIES, JOIN_SIZES, joinRows } from '../shared/joins.js';

export { JOIN_DDL, JOIN_INDEXES, JOIN_QUERIES, JOIN_SIZES, joinRows };

async function main(): Promise<void> {
  const vfs = new MemoryVfs();
  const db = Database.openFile(vfs.openSync('j.db'), { cacheSizeBytes: 512 << 20 }, vfs.openSync('j.db-wal'));
  const lite: any = await (sqliteInit as any)({ print() {}, printErr() {} });
  const s = new lite.oo1.DB(':memory:');
  s.exec('PRAGMA cache_size=-524288');
  for (const ddl of JOIN_DDL) {
    db.exec(ddl);
    s.exec(ddl + ' STRICT');
  }
  for (const [table, n] of Object.entries(JOIN_SIZES)) {
    const ncols = joinRows[table](1).length;
    const sql = `INSERT INTO ${table} VALUES (${new Array(ncols).fill('?').join(', ')})`;
    const ins = db.prepare(sql);
    db.exec('BEGIN');
    for (let i = 1; i <= n; i++) ins.run(joinRows[table](i));
    db.exec('COMMIT');
    const st = s.prepare(sql);
    s.exec('BEGIN');
    for (let i = 1; i <= n; i++) st.bind(joinRows[table](i)).stepReset();
    s.exec('COMMIT');
    st.finalize();
  }
  for (const ix of JOIN_INDEXES) {
    db.exec(ix);
    s.exec(ix);
  }
  if (process.argv.includes('--analyze')) {
    s.exec('ANALYZE');
    try {
      db.exec('ANALYZE');
    } catch {
      /* not implemented yet */
    }
  }
  // Median of at least `reps` runs, and enough runs to cover ~300 ms (millisecond queries are noisy).
  const time = (f: () => unknown, reps: number): number => {
    f();
    const t: number[] = [];
    let total = 0;
    while (t.length < reps || (total < 300 && t.length < 2000)) {
      const t0 = performance.now();
      f();
      const dt = performance.now() - t0;
      t.push(dt);
      total += dt;
    }
    return t.sort((a, b) => a - b)[t.length >> 1];
  };
  const canon = (rows: unknown[][]): string => JSON.stringify(rows.map((r) => r.map((v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(10)) : typeof v === 'bigint' ? Number(v) : v)).join('|')).sort());
  console.log('query'.padEnd(40), 'smaltdb      sqlite     ratio   result   plan');
  for (const [name, sql] of Object.entries(JOIN_QUERIES)) {
    const p = db.prepare(sql);
    const reps = 5;
    let tSmalt: number;
    let a: unknown[][] = [];
    const t0 = performance.now();
    a = p.all();
    const first = performance.now() - t0;
    tSmalt = first > 3000 ? first : time(() => p.all(), reps);
    const b = s.selectArrays(sql);
    const tLite = time(() => s.selectArrays(sql), reps);
    const ok = canon(a) === canon(b) ? 'ok' : 'MISMATCH';
    const plan = db.query('EXPLAIN QUERY PLAN ' + sql).rows.map((r) => r[3]).join(' | ');
    console.log(`${name.padEnd(40)} ${tSmalt.toFixed(2).padStart(8)} ms ${tLite.toFixed(2).padStart(8)} ms ${(tLite / tSmalt).toFixed(2).padStart(7)}x  ${ok.padEnd(8)} ${plan}`);
  }
}
if (/joins\.(ts|mjs)$/.test(process.argv[1] ?? "")) void main();
