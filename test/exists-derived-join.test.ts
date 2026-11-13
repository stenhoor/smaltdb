/**
 * A correlated EXISTS whose subquery joins a derived table to a base table (issue #230, found by smaltbi's link
 * tables). Checked against SQLite on both paths: decorrelated (an equality on the enclosing row) and per row (a
 * condition the planner can't decorrelate, or a derived table that reads the enclosing row itself).
 *
 * The bug: in a nested-loop join, a derived table that doesn't read the enclosing row was materialized once, after the
 * filters local to it had been applied, including one that reads the enclosing row (`x.tag_id >= tags.id`). Every
 * enclosing row then saw the rows filtered for the first one. Whether the planner chose that join depended on the
 * tables' sizes, so the last test runs the queries at every size up to 80 products. Before #221 the issue's own query
 * took the per-row path too; since #221 it is decorrelated, and only conditions that can't be still met the bug.
 */
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';

type Lite = { exec(s: string): void; selectArrays(s: string): unknown[][] };
let newLite: () => Lite;

// Tags 1–5; products 1–8; the link lists (2, 1) twice, product 8 has no tags, tag 5 no products, tag NULL one product.
const SETUP = `
  CREATE TABLE tags(id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT, category TEXT);
  CREATE TABLE product_tags(product_id INTEGER, tag_id INTEGER);
  INSERT INTO tags VALUES (1, 'Organic'), (2, 'Fair trade'), (3, 'Gift idea'), (4, 'Bestseller'), (5, 'New');
  INSERT INTO products VALUES (1, 'Espresso', 'Coffee'), (2, 'Sencha', 'Tea'), (3, 'Mug', 'Accessories'), (4, 'Lungo', 'Coffee'),
    (5, 'Assam', 'Tea'), (6, 'Grinder', 'Accessories'), (7, 'Ristretto', 'Coffee'), (8, 'Rooibos', 'Tea');
  INSERT INTO product_tags VALUES (1, 1), (1, 2), (2, 1), (2, 1), (3, 3), (4, 2), (4, 4), (5, 1), (5, 4), (6, 3), (7, NULL);
`;

// As imported from CSV (smaltbi's sample data): no keys, so every join and lookup is by value.
const UNKEYED = SETUP.replace('id INTEGER PRIMARY KEY, name TEXT);', 'id INTEGER, name TEXT);').replace('id INTEGER PRIMARY KEY, name TEXT, category', 'id INTEGER, name TEXT, category');

const LINK = '(SELECT DISTINCT tag_id, product_id FROM product_tags) AS x JOIN products ON x.product_id = products.id';
const QUERIES = [
  // The issue's query, and its NOT EXISTS (decorrelated: an equality on the enclosing row).
  `SELECT name FROM tags WHERE EXISTS (SELECT 1 FROM ${LINK} WHERE x.tag_id = tags.id AND products.id IN (4, 5))`,
  `SELECT name FROM tags WHERE NOT EXISTS (SELECT 1 FROM ${LINK} WHERE x.tag_id = tags.id AND products.id IN (4, 5))`,
  `SELECT name FROM tags WHERE EXISTS (SELECT 1 FROM ${LINK} WHERE x.tag_id = tags.id AND products.category = 'Tea')`,
  `SELECT name FROM tags WHERE EXISTS (SELECT 1 FROM ${LINK} WHERE x.tag_id = tags.id)`,
  // The derived table on the right of the join, and grouped instead of DISTINCT.
  `SELECT name FROM tags WHERE EXISTS (SELECT 1 FROM products JOIN (SELECT DISTINCT tag_id, product_id FROM product_tags) AS x
     ON x.product_id = products.id WHERE x.tag_id = tags.id AND products.id IN (4, 5))`,
  `SELECT name FROM tags WHERE EXISTS (SELECT 1 FROM (SELECT tag_id, product_id FROM product_tags GROUP BY 1, 2) AS x
     JOIN products ON x.product_id = products.id WHERE x.tag_id = tags.id AND products.id IN (4, 5))`,
  // Both sides of a link in one selection: the other direction, products with a tag.
  `SELECT name FROM products WHERE EXISTS (SELECT 1 FROM (SELECT DISTINCT tag_id, product_id FROM product_tags) AS x
     JOIN tags ON x.tag_id = tags.id WHERE x.product_id = products.id AND tags.name IN ('Organic', 'Bestseller'))`,
  // Per row: conditions the planner can't decorrelate.
  `SELECT name FROM tags WHERE EXISTS (SELECT 1 FROM ${LINK} WHERE x.tag_id >= tags.id AND products.id IN (4, 5))`,
  `SELECT name FROM tags WHERE EXISTS (SELECT 1 FROM ${LINK} WHERE x.tag_id = tags.id OR products.id = tags.id + 5)`,
  `SELECT name FROM tags WHERE NOT EXISTS (SELECT 1 FROM ${LINK} WHERE x.tag_id >= tags.id AND products.id IN (4, 5))`,
  // Per row: the derived table reads the enclosing row itself.
  `SELECT name FROM tags WHERE EXISTS (SELECT 1 FROM (SELECT DISTINCT tag_id, product_id FROM product_tags WHERE tag_id = tags.id) AS x
     JOIN products ON x.product_id = products.id WHERE products.id IN (4, 5))`,
  // The same selections written with IN, the workaround smaltbi uses: the same rows.
  `SELECT name FROM tags WHERE id IN (SELECT x.tag_id FROM ${LINK} WHERE products.id IN (4, 5))`,
  `SELECT name FROM tags WHERE id NOT IN (SELECT x.tag_id FROM ${LINK} WHERE products.id IN (4, 5) AND x.tag_id IS NOT NULL)`,
];

beforeAll(async () => {
  const s3 = await (sqliteInit as unknown as (o: object) => Promise<{ oo1: { DB: new (n: string) => Lite } }>)({ print() {}, printErr() {} });
  newLite = () => new s3.oo1.DB(':memory:');
});

const sorted = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();

describe.each([
  ['keyed tables', SETUP],
  ['tables without keys, as imported from CSV', UNKEYED],
])('correlated EXISTS over a derived table joined to a base table (#230): %s', (_name, setup) => {
  it.each(QUERIES.map((q, n) => [n + 1, q]))('query %i matches SQLite', (_n, q) => {
    const lite = newLite();
    lite.exec(setup);
    const db = Database.openMemory();
    db.exec(setup);
    expect(sorted(db.query(q).rows)).toEqual(sorted(lite.selectArrays(q)));
  });

  it('gives the rows the issue expects', () => {
    const db = Database.openMemory();
    db.exec(setup);
    expect(sorted(db.query(QUERIES[0]).rows)).toEqual(sorted([['Fair trade'], ['Organic'], ['Bestseller']]));
  });
});

describe('correlated EXISTS over a derived table joined to a base table (#230): every table size', () => {
  it('matches SQLite from 1 to 80 products, with keys and without', () => {
    const queries = QUERIES.slice(0, 11);
    for (const key of [' PRIMARY KEY', '']) {
      for (let n = 1; n <= 80; n++) {
        const setup = `CREATE TABLE tags(id INTEGER${key}, name TEXT);
          INSERT INTO tags VALUES (1, 'Organic'), (2, 'Fair trade'), (3, 'Gift idea'), (4, 'Bestseller'), (5, 'New');
          CREATE TABLE products(id INTEGER${key}, name TEXT, category TEXT);
          INSERT INTO products VALUES ${Array.from({ length: n }, (_, i) => `(${i + 1}, 'p${i + 1}', '${i % 2 ? 'Tea' : 'Coffee'}')`).join(', ')};
          CREATE TABLE product_tags(product_id INTEGER, tag_id INTEGER); INSERT INTO product_tags VALUES (4, 1);`;
        const lite = newLite();
        lite.exec(setup);
        const db = Database.openMemory();
        db.exec(setup);
        for (const q of queries) expect(sorted(db.query(q).rows), `${n} products${key}: ${q}`).toEqual(sorted(lite.selectArrays(q)));
      }
    }
  });
});
