// Spike: how much faster could a columnar segment format make analytical scans than the current
// row store (B+tree records + generated fused pipelines)? Same data as the browser analytic
// workload plus a clustered "ts" column; both engines in memory, Node.
//   npx tsx bench/micro/columnar-spike.ts [rows]
import { Database } from '../../src/engine/database.js';
import { MemoryVfs } from '../../src/engine/vfs/memory.js';
import { analyticRow } from '../browser/adapter.js';

const N = Number(process.argv[2] ?? 200_000);
const BLOCK = 4096;

const db = Database.openFile(new MemoryVfs().openSync('c.db'), { cacheSizeBytes: 1 << 30 });
db.exec('CREATE TABLE a(id INTEGER PRIMARY KEY, b INT, c REAL, d INT, e TEXT, ts INT)');
const ins = db.prepare('INSERT INTO a VALUES (?, ?, ?, ?, ?, ?)');
db.exec('BEGIN');
for (let i = 1; i <= N; i++) ins.run([...analyticRow(i), i]);
db.exec('COMMIT');

// Columnar copy: one typed array per column + per-block zone maps (min/max).
const b = new Int32Array(N);
const c = new Float64Array(N);
const d = new Int32Array(N);
const ts = new Int32Array(N);
for (let i = 0; i < N; i++) {
  const [, bb, cc, dd] = analyticRow(i + 1);
  b[i] = bb;
  c[i] = cc;
  d[i] = dd;
  ts[i] = i + 1;
}
const nb = Math.ceil(N / BLOCK);
const tsMin = new Int32Array(nb);
const tsMax = new Int32Array(nb);
const cMax = new Float64Array(nb);
for (let k = 0; k < nb; k++) {
  let lo = Infinity;
  let hi = -Infinity;
  let cm = -Infinity;
  for (let i = k * BLOCK; i < Math.min(N, (k + 1) * BLOCK); i++) {
    lo = Math.min(lo, ts[i]);
    hi = Math.max(hi, ts[i]);
    cm = Math.max(cm, c[i]);
  }
  tsMin[k] = lo;
  tsMax[k] = hi;
  cMax[k] = cm;
}

const cut = Math.floor(N * 0.95);
const queries: { name: string; sql: string; col: () => unknown }[] = [
  {
    name: 'filter + sum',
    sql: 'SELECT sum(b) FROM a WHERE c > 500',
    col: () => {
      let s = 0;
      for (let k = 0; k < nb; k++) {
        if (cMax[k] <= 500) continue; // zone map
        const end = Math.min(N, (k + 1) * BLOCK);
        for (let i = k * BLOCK; i < end; i++) if (c[i] > 500) s += b[i];
      }
      return s;
    },
  },
  {
    name: 'group by (100 groups)',
    sql: 'SELECT d, count(*), avg(c), max(b) FROM a GROUP BY d',
    col: () => {
      // Generic hash grouping (a Map), as an engine would do without knowing the key domain.
      const groups = new Map<number, { n: number; sc: number; mb: number }>();
      for (let i = 0; i < N; i++) {
        let g = groups.get(d[i]);
        if (g === undefined) groups.set(d[i], (g = { n: 0, sc: 0, mb: -Infinity }));
        g.n++;
        g.sc += c[i];
        if (b[i] > g.mb) g.mb = b[i];
      }
      return groups.size;
    },
  },
  {
    name: 'arith filter + aggregate',
    sql: 'SELECT sum(b * 2 + d), avg(c * 1.1) FROM a WHERE b % 7 = 3 AND c < 900',
    col: () => {
      let s = 0;
      let sc = 0;
      let n = 0;
      for (let i = 0; i < N; i++) {
        if (b[i] % 7 === 3 && c[i] < 900) {
          s += b[i] * 2 + d[i];
          sc += c[i] * 1.1;
          n++;
        }
      }
      return [s, sc / n];
    },
  },
  {
    name: 'range on clustered column (5%)',
    sql: `SELECT sum(b) FROM a WHERE ts > ${cut}`,
    col: () => {
      let s = 0;
      for (let k = 0; k < nb; k++) {
        if (tsMax[k] <= cut) continue; // zone map skips 95% of blocks
        const end = Math.min(N, (k + 1) * BLOCK);
        for (let i = Math.max(k * BLOCK, 0); i < end; i++) if (ts[i] > cut) s += b[i];
      }
      return s;
    },
  },
];

const median = (f: () => unknown, n = 21): number => {
  f();
  const t: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    f();
    t.push(performance.now() - t0);
  }
  return t.sort((x, y) => x - y)[n >> 1];
};

console.log(`rows=${N}  (median of 21, ms)`);
console.log('query'.padEnd(34), 'row store'.padStart(10), 'columnar'.padStart(10), 'ratio'.padStart(8));
for (const q of queries) {
  const st = db.prepare(q.sql);
  const rs = median(() => st.all());
  const cs = median(q.col);
  console.log(q.name.padEnd(34), rs.toFixed(2).padStart(10), cs.toFixed(2).padStart(10), (rs / cs).toFixed(1).padStart(7) + 'x');
}
