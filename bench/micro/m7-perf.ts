// M7 code-review performance items (docs/research/m7-code-review.md, "Performance"), Node, file
// database on MemoryVfs:
//   npm run bench:micro -- m7-perf
// Each case reports the median of `reps` runs in ms.
import { Database } from '../../src/engine/database.js';
import '@smaltworks/smaltql/register';
import { MemoryVfs } from '../../src/engine/vfs/memory.js';

const reps = Number(process.env.REPS ?? 5);

async function time(fn: () => void | Promise<void>, setup?: () => Promise<void>): Promise<number> {
  const xs: number[] = [];
  for (let i = 0; i < reps; i++) {
    await setup?.();
    const t = performance.now();
    await fn();
    xs.push(performance.now() - t);
  }
  xs.sort((a, b) => a - b);
  return +xs[xs.length >> 1].toFixed(2);
}

async function columnarDb(rows: number) {
  const db = await Database.open(new MemoryVfs(), 'db');
  db.exec("CREATE TABLE c(id INTEGER PRIMARY KEY, g INT, x REAL) WITH (storage = 'columnar')");
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows}) INSERT INTO c SELECT i, i % 100, i / 3.0 FROM n`);
  return db;
}

async function main(): Promise<void> {
  const out: Record<string, number> = {};

  // P1: single-row autocommit INSERTs into a columnar table (count() of delta + deletions per statement).
  let db!: Database;
  out['columnar: 8000 single-row INSERTs'] = await time(
    () => {
      const ins = db.prepare('INSERT INTO c(g, x) VALUES (?, ?)');
      for (let i = 0; i < 8000; i++) ins.run([i % 100, i]);
    },
    async () => {
      db = await columnarDb(100_000);
    },
  );

  // P2: UPDATE / DELETE of rows that live in the segments (locateInSegments per row).
  out['columnar: UPDATE 5k segment rows'] = await time(
    () => void db.exec('UPDATE c SET x = 0 WHERE g = 7'),
    async () => {
      db = await columnarDb(500_000);
    },
  );
  out['columnar: DELETE 5k segment rows'] = await time(
    () => void db.exec('DELETE FROM c WHERE g = 9'),
    async () => {
      db = await columnarDb(500_000);
    },
  );

  // P3: scans with pending deletions (deletion set + bitmaps rebuilt per scan).
  db = await columnarDb(500_000);
  db.exec('DELETE FROM c WHERE g = 9');
  db.query('SELECT g, sum(x) FROM c GROUP BY g');
  out['columnar: GROUP BY with 5k deletions'] = await time(() => void db.query('SELECT g, sum(x) FROM c GROUP BY g'));
  out['columnar: selective filter with 5k deletions'] = await time(() => void db.query('SELECT count(*) FROM c WHERE id BETWEEN 1000 AND 2000'));

  // P5: sorting on a file database (rowBytes accounting per row under the default work_mem).
  const sdb = await Database.open(new MemoryVfs(), 'db');
  sdb.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)');
  sdb.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300000) INSERT INTO t SELECT i, (i * 7919) % 100003, 'n' || i FROM n");
  sdb.query('SELECT id, a, b FROM t ORDER BY a, id');
  out['sort: 300k rows ORDER BY'] = await time(() => void sdb.query('SELECT id, a, b FROM t ORDER BY a, id'));

  // P4 / P6: single-row DML on a file database (per-statement memory snapshot, touchTable scan).
  const wdb = await Database.open(new MemoryVfs(), 'db');
  wdb.exec('CREATE TABLE w(id INTEGER PRIMARY KEY, v INT)');
  for (let i = 0; i < 20; i++) wdb.exec(`CREATE TABLE other${i}(a)`);
  wdb.exec('CREATE MATERIALIZED VIEW wv AS SELECT count(*) AS n FROM other0');
  const ins = wdb.prepare('INSERT INTO w(v) VALUES (?)');
  const upd = wdb.prepare('UPDATE w SET v = v + 1 WHERE id = ?');
  out['dml: 5000 single-row INSERT + UPDATE'] = await time(() => {
    wdb.exec('BEGIN');
    for (let i = 1; i <= 5000; i++) {
      ins.run([i]);
      upd.run([i]);
    }
    wdb.exec('COMMIT');
  });

  // P7: requests while a TEMP table exists (usesMemoryObjects walks the AST every time).
  wdb.exec('CREATE TEMP TABLE scratch(a)');
  const sel = wdb.prepare('SELECT v FROM w WHERE id = ?');
  out['usesMemoryObjects x 20000'] = await time(() => {
    for (let i = 0; i < 20000; i++) void sel.usesMemoryObjects;
  });

  for (const [k, v] of Object.entries(out)) console.log(`${k.padEnd(48)} ${String(v).padStart(10)} ms`);
}

void main();
