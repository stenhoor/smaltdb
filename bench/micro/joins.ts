// Join workloads: smaltdb vs SQLite WASM in Node (both in memory). Used to drive M3 (optimizer).
// Run: npx esbuild bench/micro/joins.ts --bundle --platform=node --format=esm --outfile=.cache/joins.mjs --external:@sqlite.org/sqlite-wasm && node .cache/joins.mjs
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { Database } from '../../src/engine/database.js';
import { MemoryVfs } from '../../src/engine/vfs/memory.js';

export const JOIN_DDL = [
  'CREATE TABLE customers(id INTEGER PRIMARY KEY, region INT, name TEXT)',
  'CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INT, amount REAL, status INT)',
  'CREATE TABLE products(id INTEGER PRIMARY KEY, category INT, price REAL)',
  'CREATE TABLE line_items(id INTEGER PRIMARY KEY, order_id INT, product_id INT, qty INT)',
];
export const JOIN_INDEXES = ['CREATE INDEX orders_customer ON orders(customer_id)', 'CREATE INDEX line_items_order ON line_items(order_id)'];
export const JOIN_SIZES = { customers: 10_000, orders: 200_000, products: 2_000, line_items: 400_000 };
export const joinRows: Record<string, (i: number) => (number | string)[]> = {
  customers: (i) => [i, i % 20, 'customer-' + i],
  orders: (i) => [i, ((i * 7919) % JOIN_SIZES.customers) + 1, ((i * 31) % 1000) / 4, i % 5],
  products: (i) => [i, i % 50, ((i * 13) % 500) / 4 + 1],
  line_items: (i) => [i, ((i * 104729) % JOIN_SIZES.orders) + 1, ((i * 17) % JOIN_SIZES.products) + 1, (i % 7) + 1],
};
export const JOIN_QUERIES: Record<string, string> = {
  'J1 join + group by (10k x 200k)': 'SELECT c.region, count(*), sum(o.amount) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.region',
  'J2 selective filter on small side': 'SELECT count(*), sum(o.amount) FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.region = 3 AND c.id < 600',
  'J3 written in a bad order': "SELECT o.id, o.amount FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.name = 'customer-42'",
  'J4 3-way join + group by': 'SELECT p.category, sum(li.qty * p.price) FROM orders o JOIN line_items li ON li.order_id = o.id JOIN products p ON p.id = li.product_id WHERE o.status = 1 GROUP BY p.category',
  'J5 point join': 'SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = 12345',
  'J6 left join, unmatched': 'SELECT count(*) FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status = 4 WHERE o.id IS NULL',
  'J7 join on non-indexed column': 'SELECT count(*) FROM products p JOIN line_items li ON li.qty = p.category WHERE p.price > 120',
};

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
