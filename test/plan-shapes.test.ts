/**
 * Golden corpus of physical plan shapes (ADR 0014, step 2). Each query's plan is rendered as its operator
 * tree (operator class, EXPLAIN detail and the planner's row estimate), the plans of subqueries run from
 * expressions, and the result columns, and compared with the files in test/plan-shapes/. Later steps of
 * the plan layer must not change these shapes unnoticed: an intended change updates the files with
 * `npx vitest run test/plan-shapes.test.ts -u`, and the diff shows in review.
 *
 * The shapes are those of the default configuration, so the corpus skips when code generation,
 * flattening or decorrelation is switched off.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import type { Operator } from '../src/engine/exec/operators.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const switchedOff = !!(env.SMALT_NO_CODEGEN || env.SMALT_NO_FLATTEN || env.SMALT_NO_DECORRELATE);

/** A fixed database: row tables with indexes, a columnar table, views, materialized views and statistics. */
async function fixture(): Promise<Database> {
  const db = await Database.open(new MemoryVfs(), 'db');
  db.exec(`
    CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT, region TEXT, tier INT);
    CREATE INDEX customers_region ON customers(region);
    CREATE INDEX customers_lower_name ON customers(lower(name));
    CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INT REFERENCES customers(id), day INT, status TEXT, amount REAL);
    CREATE INDEX orders_customer ON orders(customer_id);
    CREATE INDEX orders_day_status ON orders(day, status);
    CREATE TABLE products(sku TEXT PRIMARY KEY, category TEXT, price REAL);
    CREATE INDEX products_category ON products(category, price);
    CREATE TABLE items(id INTEGER PRIMARY KEY, order_id INT, sku TEXT, qty INT);
    CREATE INDEX items_order ON items(order_id);
    CREATE TABLE tiers(tier INT PRIMARY KEY, label TEXT);
    CREATE TABLE empty_t(a INT, b TEXT);
    CREATE TABLE events(id INTEGER PRIMARY KEY, kind INT, ts INT, v REAL) WITH (storage = 'columnar');
  `);
  db.exec('BEGIN');
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
    INSERT INTO customers SELECT i, 'Name' || (i * 7 % 2000), CASE i % 5 WHEN 0 THEN 'EU' WHEN 1 THEN 'US' WHEN 2 THEN 'APAC' WHEN 3 THEN 'LATAM' ELSE 'MEA' END, i % 4 FROM n`);
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
    INSERT INTO orders SELECT i, (i * 13) % 2000 + 1, i % 365, CASE i % 4 WHEN 0 THEN 'open' WHEN 1 THEN 'paid' WHEN 2 THEN 'shipped' ELSE 'void' END, (i % 997) / 4.0 FROM n`);
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
    INSERT INTO products SELECT 'sku' || i, 'cat' || (i % 12), (i % 50) + 0.99 FROM n`);
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000)
    INSERT INTO items SELECT i, (i * 7) % 20000 + 1, 'sku' || ((i % 300) + 1), i % 5 + 1 FROM n`);
  db.exec("INSERT INTO tiers VALUES (0, 'free'), (1, 'basic'), (2, 'pro'), (3, 'enterprise')");
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30000)
    INSERT INTO events SELECT i, i % 8, i, (i % 1000) / 10.0 FROM n`);
  db.exec('COMMIT');
  db.exec(`
    CREATE VIEW paid_orders AS SELECT id, customer_id, day, amount FROM orders WHERE status = 'paid';
    CREATE VIEW customer_totals AS SELECT customer_id, count(*) AS n, sum(amount) AS total FROM orders GROUP BY customer_id;
    CREATE MATERIALIZED VIEW region_day AS
      SELECT c.region, o.day, count(*) AS n, sum(o.amount) AS total FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.region, o.day;
    CREATE MATERIALIZED VIEW events_by_kind WITH (storage = 'columnar') AS SELECT kind, count(*) AS n, sum(v) AS total FROM events GROUP BY kind;
    PRAGMA matview_rewrite = 1;
    ANALYZE;
  `);
  return db;
}

/** Three significant digits: estimates are compared as shapes, not to the last bit. */
const est = (x: number): string => String(Number(x.toPrecision(3)));

function render(db: Database, sql: string): string {
  const p = db.planOf(sql);
  const lines: string[] = [`> ${sql.replace(/\s+/g, ' ').trim()}`];
  lines.push(`columns: ${p.columns.map((c) => `${c.name} ${c.type}`).join(', ')}`);
  const walk = (op: Operator, depth: number): void => {
    const e = p.estimates.get(op);
    lines.push(`${'  '.repeat(depth)}${op.constructor.name}${op.detail ? `: ${op.detail}` : ''}${e === undefined ? '' : ` [est ${est(e)}]`}`);
    for (const c of op.children) walk(c, depth + 1);
  };
  walk(p.root, 1);
  for (const s of p.subplans) {
    lines.push(`  ${s.label}:`);
    walk(s.root, 2);
  }
  return lines.join('\n');
}

const CORPUS: Record<string, string[]> = {
  'access-paths': [
    'SELECT * FROM customers WHERE id = 42',
    'SELECT name FROM customers WHERE id BETWEEN 10 AND 20',
    "SELECT name FROM customers WHERE region = 'EU'",
    "SELECT count(*) FROM customers WHERE region = 'EU'",
    "SELECT id FROM customers WHERE region IN ('EU', 'US')",
    "SELECT id FROM customers WHERE lower(name) = 'name14'",
    'SELECT id FROM orders WHERE day = 10',
    "SELECT id FROM orders WHERE day = 10 AND status = 'paid'",
    'SELECT id FROM orders WHERE day BETWEEN 10 AND 12',
    "SELECT id FROM orders WHERE status = 'paid'",
    'SELECT id FROM orders WHERE customer_id = 5 OR day = 3',
    "SELECT price FROM products WHERE category = 'cat3' AND price > 20",
    "SELECT * FROM products WHERE sku = 'sku10'",
    'SELECT * FROM orders WHERE amount > 100',
    'SELECT * FROM empty_t WHERE a = 1',
    'SELECT min(day), max(day) FROM orders',
    'SELECT count(*) FROM orders',
  ],
  joins: [
    'SELECT c.name, o.amount FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.id = 7',
    "SELECT c.name, o.amount FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.region = 'EU'",
    'SELECT c.region, sum(o.amount) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.region',
    'SELECT o.id, i.qty, p.price FROM orders o JOIN items i ON i.order_id = o.id JOIN products p ON p.sku = i.sku WHERE o.day = 3',
    `SELECT c.region, p.category, sum(i.qty * p.price) FROM customers c JOIN orders o ON o.customer_id = c.id
       JOIN items i ON i.order_id = o.id JOIN products p ON p.sku = i.sku WHERE c.tier = 3 GROUP BY c.region, p.category`,
    'SELECT c.name, t.label FROM customers c JOIN tiers t ON t.tier = c.tier WHERE c.id < 50',
    'SELECT c.id, o.id FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE c.id < 10',
    'SELECT c.id FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE o.id IS NULL',
    'SELECT t.label, c.id FROM customers c RIGHT JOIN tiers t ON t.tier = c.tier AND c.id < 5',
    'SELECT t.label, c.id FROM tiers t FULL JOIN customers c ON c.tier = t.tier AND c.id < 3',
    'SELECT count(*) FROM tiers, products',
    'SELECT o.id FROM orders o JOIN customers c USING (id) WHERE c.tier = 1',
    'SELECT a.id, b.id FROM orders a JOIN orders b ON b.customer_id = a.customer_id WHERE a.id = 100',
    'SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id JOIN tiers t ON t.tier = c.tier WHERE t.label = ?',
  ],
  aggregates: [
    'SELECT status, count(*), sum(amount), avg(amount) FROM orders GROUP BY status',
    'SELECT day, count(*) FROM orders GROUP BY day ORDER BY day',
    'SELECT customer_id, sum(amount) FROM orders GROUP BY customer_id HAVING sum(amount) > 100',
    'SELECT count(DISTINCT customer_id) FROM orders',
    'SELECT DISTINCT region FROM customers',
    'SELECT DISTINCT status, day FROM orders WHERE day < 3',
    'SELECT sum(amount) FROM orders WHERE day < 30',
    'SELECT tier, group_concat(name) FROM customers WHERE id < 20 GROUP BY tier',
    'SELECT median(amount), stddev(amount) FROM orders',
  ],
  ordering: [
    'SELECT * FROM orders ORDER BY id DESC LIMIT 5',
    'SELECT * FROM orders ORDER BY amount DESC LIMIT 10',
    'SELECT * FROM orders ORDER BY amount DESC LIMIT 10 OFFSET 20',
    'SELECT id FROM orders WHERE day = 4 ORDER BY status',
    'SELECT name FROM customers ORDER BY region, name',
    'SELECT name FROM customers ORDER BY lower(name) LIMIT 3',
    'SELECT * FROM customers LIMIT 3',
  ],
  subqueries: [
    'SELECT name FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.amount > 240)',
    'SELECT name FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)',
    "SELECT name FROM customers WHERE id IN (SELECT customer_id FROM orders WHERE status = 'void' AND day = 1)",
    'SELECT name FROM customers WHERE id NOT IN (SELECT customer_id FROM orders WHERE day < 100)',
    'SELECT name, (SELECT count(*) FROM orders o WHERE o.customer_id = c.id) FROM customers c WHERE c.tier = 2',
    'SELECT name, (SELECT max(day) FROM orders o WHERE o.customer_id = c.id AND o.status = c.region) FROM customers c WHERE c.id < 5',
    'SELECT * FROM orders WHERE amount > (SELECT avg(amount) FROM orders)',
    'SELECT x.customer_id, x.total FROM (SELECT customer_id, sum(amount) AS total FROM orders GROUP BY customer_id) x WHERE x.total > 200',
    'SELECT * FROM (SELECT id, amount * 2 AS a2 FROM orders WHERE day = 1) WHERE a2 > 10',
    'WITH big AS (SELECT * FROM orders WHERE amount > 200) SELECT c.name, big.amount FROM big JOIN customers c ON c.id = big.customer_id',
    'WITH s AS (SELECT day, sum(amount) AS t FROM orders GROUP BY day) SELECT a.day FROM s a JOIN s b ON b.day = a.day + 1 WHERE b.t > a.t',
    'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10) SELECT sum(i) FROM n',
  ],
  'views-and-matviews': [
    'SELECT * FROM paid_orders WHERE customer_id = 9',
    'SELECT p.amount, c.name FROM paid_orders p JOIN customers c ON c.id = p.customer_id WHERE p.day = 2',
    'SELECT * FROM customer_totals WHERE customer_id = 9',
    'SELECT c.name, t.total FROM customers c JOIN customer_totals t ON t.customer_id = c.id WHERE c.region = ?',
    'SELECT region, sum(total) FROM region_day GROUP BY region',
    'SELECT c.region, sum(o.amount) FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.region',
    'SELECT c.region, o.day, count(*) FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.day < 10 GROUP BY c.region, o.day',
    'SELECT kind, sum(v) FROM events GROUP BY kind',
  ],
  columnar: [
    'SELECT count(*) FROM events',
    'SELECT sum(v) FROM events WHERE ts BETWEEN 1000 AND 2000',
    'SELECT kind, avg(v), max(ts) FROM events WHERE v > 50 GROUP BY kind',
    'SELECT id, v FROM events WHERE kind = 3 AND ts > 29000',
    'SELECT * FROM events WHERE id = 77',
    'SELECT e.kind, count(*) FROM events e JOIN tiers t ON t.tier = e.kind GROUP BY e.kind',
    'SELECT * FROM events ORDER BY v DESC LIMIT 5',
  ],
  windows: [
    'SELECT id, row_number() OVER (ORDER BY id) FROM orders WHERE day = 1',
    'SELECT id, rank() OVER (PARTITION BY status ORDER BY amount DESC) FROM orders WHERE day < 3',
    'SELECT id, sum(amount) OVER (PARTITION BY customer_id ORDER BY day ROWS 2 PRECEDING) FROM orders WHERE customer_id < 5',
    'SELECT day, sum(amount) OVER w, avg(amount) OVER w FROM orders WHERE day < 5 WINDOW w AS (ORDER BY day RANGE BETWEEN 1 PRECEDING AND CURRENT ROW)',
    'SELECT * FROM (SELECT id, lag(amount) OVER (ORDER BY id) AS prev FROM orders) WHERE prev > 200',
  ],
  compound: [
    "SELECT id FROM customers WHERE region = 'EU' UNION SELECT customer_id FROM orders WHERE day = 1",
    'SELECT id FROM customers UNION ALL SELECT id FROM orders ORDER BY 1 LIMIT 3',
    'SELECT customer_id FROM orders WHERE day = 1 INTERSECT SELECT id FROM customers WHERE tier = 1',
    'SELECT id FROM customers EXCEPT SELECT customer_id FROM orders',
    'VALUES (1, 2), (3, 4)',
    'SELECT 1 + 2, ? AS p',
  ],
};

describe.skipIf(switchedOff)('physical plan shapes (golden corpus)', async () => {
  const db = await fixture();
  for (const [group, queries] of Object.entries(CORPUS)) {
    it(group, async () => {
      const text = queries.map((q) => render(db, q)).join('\n\n') + '\n';
      await expect(text).toMatchFileSnapshot(`plan-shapes/${group}.txt`);
    });
  }
});
