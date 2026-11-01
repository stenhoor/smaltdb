/**
 * Join workloads shared by the Node micro-benchmark (bench/micro/joins.ts) and the browser harness.
 * Four tables (10k customers, 200k orders, 2k products, 400k line items) with deterministic data.
 */
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

/** Table names, in load order. */
export const JOIN_TABLES = Object.keys(JOIN_SIZES) as (keyof typeof JOIN_SIZES)[];
