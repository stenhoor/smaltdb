# Indexes and performance

This guide covers the tools that decide how fast a query runs: indexes, the query planner and how to read its plans, statistics, prepared statements and the page cache. For analytical workloads (large scans and aggregates), also read [Analytics](./analytics).

Full syntax is in the reference: [CREATE INDEX](../reference/sql/create-index), [EXPLAIN and ANALYZE](../reference/sql/explain) and [PRAGMA](../reference/sql/pragmas).

## Sample data

The examples on this page use one table of 5,000 orders, filled with a recursive CTE:

```sql
CREATE TABLE orders (
  id       INTEGER PRIMARY KEY,
  customer TEXT,
  status   TEXT,
  total    REAL,
  placed   TEXT
);

INSERT INTO orders (customer, status, total, placed)
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
SELECT 'c' || (i % 500),
       CASE WHEN i % 50 = 0 THEN 'open' ELSE 'done' END,
       i % 97 * 1.5,
       date('2026-01-01', '+' || (i % 300) || ' days')
FROM n;

SELECT count(*) AS orders, count(DISTINCT customer) AS customers FROM orders;
```

| orders | customers |
| --- | --- |
| 5000 | 500 |

## Reading a query plan

`EXPLAIN QUERY PLAN` shows how the planner will run a statement, without running it. Each row is one step. `parent` links a step to the step it feeds, so the rows form a tree. `notused` is always 0; it is there for compatibility with SQLite's output.

Without an index, a lookup by customer reads the whole table:

```sql
EXPLAIN QUERY PLAN SELECT * FROM orders WHERE customer = 'c42';
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SCAN orders (fused scan + filter) |

`SCAN` means every row is read. `fused scan + filter` means the scan and the WHERE clause run as one generated loop, which is the fastest way to read a whole table.

The `detail` texts you will see most often:

| Detail | Meaning |
| --- | --- |
| `SCAN t` | Reads every row of `t`. |
| `SCAN t (fused scan + filter …)` | A full scan compiled into one loop with the filter and, where shown, the aggregate or `GROUP BY`. |
| `SCAN t (count)` | `count(*)` answered by counting B-tree cells, without reading rows. |
| `SEARCH t USING INTEGER PRIMARY KEY (rowid=?)` | A lookup by rowid. `rowid>? AND rowid<?` is a rowid range. |
| `SEARCH t USING INDEX i (=?,range)` | An index lookup: one `=?` per equality column, then `range` if the next column has a range condition. |
| `SEARCH t USING COVERING INDEX i (…)` | The index holds every column the query needs, so table rows are not read. |
| `USE TEMP B-TREE FOR ORDER BY` | The rows are sorted (also `GROUP BY` and `DISTINCT`). |
| `HASH JOIN`, `LEFT HASH JOIN` | A hash join of the two steps below it. |
| `SCAN t (columnar …, zone maps: …)` | A columnar scan; see [Analytics](./analytics#zone-maps). |
| `SCAN EXTERNAL t (location)` | External data; see [External data](./external-data). |

Plain `EXPLAIN` returns the same rows as `EXPLAIN QUERY PLAN`. smaltdb has no bytecode program to list, unlike SQLite.

## Creating indexes

An index on `customer` turns the scan into a search:

```sql
CREATE INDEX orders_customer ON orders(customer);
EXPLAIN QUERY PLAN SELECT * FROM orders WHERE customer = 'c42';
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SEARCH orders USING INDEX orders_customer (=?) |

The `INTEGER PRIMARY KEY` is the rowid, so it needs no index. Equality, `IN` lists and ranges on it are direct lookups:

```sql
EXPLAIN QUERY PLAN SELECT * FROM orders WHERE id BETWEEN 10 AND 20;
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SEARCH orders USING INTEGER PRIMARY KEY (rowid>? AND rowid<?) |

Indexes are maintained on every INSERT, UPDATE and DELETE, so each one makes writes slower. Create the ones your queries use and check with `EXPLAIN QUERY PLAN` that they are used. `DROP INDEX name` removes one.

### Multi-column indexes

A multi-column index serves equality on its leading columns, followed by one range on the next column. An index on `(customer, placed)` also serves every lookup by `customer` alone, so it replaces `orders_customer`:

```sql
DROP INDEX orders_customer;
CREATE INDEX orders_cust_placed ON orders(customer, placed);
EXPLAIN QUERY PLAN SELECT * FROM orders WHERE customer = 'c42' AND placed >= '2026-06-01';
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SEARCH orders USING INDEX orders_cust_placed (=?,range) |

A condition on `placed` alone cannot use this index, because `placed` is not its first column:

```sql
EXPLAIN QUERY PLAN SELECT * FROM orders WHERE placed >= '2026-06-01';
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SCAN orders (fused scan + filter) |

When the index holds every column the query reads, the planner uses it as a covering index and never reads the table rows. The rowid is part of every index entry, so `id` counts as covered:

```sql
EXPLAIN QUERY PLAN SELECT id, placed FROM orders WHERE customer = 'c42';
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SEARCH orders USING COVERING INDEX orders_cust_placed (=?) |

`INCLUDE` columns (non-key columns stored in an index) are not supported and fail with `SMALT_UNSUPPORTED`.

::: tip ORDER BY is sorted, even with a matching index
The planner does not use an index's order to skip a sort. `ORDER BY placed` still shows `USE TEMP B-TREE FOR ORDER BY`, even with an index whose next column is `placed`. The only ordered scan is `ORDER BY rowid` (or the `INTEGER PRIMARY KEY`) on a single table, which reads the table in key order. With a `LIMIT`, the sort keeps only the top rows.
:::

```sql
EXPLAIN QUERY PLAN SELECT * FROM orders ORDER BY id DESC LIMIT 5;
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SCAN orders |

### Expression indexes

An index can be built on an expression. The planner uses it when the query contains the same expression (table qualifiers are ignored):

```sql
CREATE INDEX orders_lower_customer ON orders(lower(customer));
EXPLAIN QUERY PLAN SELECT * FROM orders WHERE lower(customer) = 'c42';
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SEARCH orders USING INDEX orders_lower_customer (=?) |

Index expressions must be deterministic and cannot contain subqueries or parameters, as in SQLite. Date and time functions are allowed as long as they do not read the clock (see [CREATE INDEX](../reference/sql/create-index)):

<!-- docs:error SMALT_ERROR -->
```sql
CREATE INDEX orders_bad ON orders(random());
```

### Partial indexes

A partial index has a `WHERE` clause and holds only the rows that match it. It is small, and cheap to maintain when few rows match. Here 100 of the 5,000 orders are open:

```sql
CREATE INDEX orders_open ON orders(placed) WHERE status = 'open';
EXPLAIN QUERY PLAN SELECT * FROM orders WHERE status = 'open' AND placed = '2026-10-01';
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SEARCH orders USING INDEX orders_open (=?) |

The planner considers a partial index only when the query's WHERE clause contains every condition of the index's WHERE clause. Without `status = 'open'`, the index cannot answer the query:

```sql
EXPLAIN QUERY PLAN SELECT * FROM orders WHERE placed = '2026-10-01';
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SCAN orders (fused scan + filter) |

### Unique indexes

`CREATE UNIQUE INDEX` rejects a second row with the same key. `UNIQUE` and `PRIMARY KEY` constraints create such an index automatically. As in SQLite, NULLs never conflict with each other.

```sql
CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
CREATE UNIQUE INDEX users_email ON users(email);
INSERT INTO users (email) VALUES ('ann@example.com'), (NULL), (NULL);
SELECT count(*) AS users FROM users;
```

| users |
| --- |
| 3 |

<!-- docs:error SMALT_CONSTRAINT_UNIQUE -->
```sql
INSERT INTO users (email) VALUES ('ann@example.com');
```

### Collations

An index stores keys in the order of a collation: `BINARY` (the default), `NOCASE` or `RTRIM`. A comparison can use the index only when it uses the same collation. A column's declared collation applies to both, so a `COLLATE NOCASE` column needs nothing extra. For a column without one, put the collation on the index and on the comparison:

```sql
CREATE TABLE people (id INTEGER PRIMARY KEY, email TEXT);
INSERT INTO people (email)
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
SELECT 'User' || i || '@Example.com' FROM n;

CREATE INDEX people_email_nocase ON people(email COLLATE NOCASE);
EXPLAIN QUERY PLAN SELECT * FROM people WHERE email = 'user7@example.com' COLLATE NOCASE;
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SEARCH people USING INDEX people_email_nocase (=?) |

```sql
SELECT * FROM people WHERE email = 'user7@example.com' COLLATE NOCASE;
```

| id | email |
| --- | --- |
| 7 | User7@Example.com |

The plain comparison `email = 'user7@example.com'` uses `BINARY`, so it cannot use this index:

```sql
EXPLAIN QUERY PLAN SELECT * FROM people WHERE email = 'user7@example.com';
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SCAN people (fused scan + filter) |

`NOCASE` folds ASCII letters only. There are no locale-aware collations.

### Forcing or forbidding an index

As in SQLite, `INDEXED BY name` after a table name makes the planner use that index, and `NOT INDEXED` stops it from using any. A query that cannot be planned with the forced index fails with `no query solution`. Use these hints to compare plans; prefer letting the planner choose.

```sql
EXPLAIN QUERY PLAN SELECT * FROM orders NOT INDEXED WHERE customer = 'c42';
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SCAN orders (fused scan + filter) |

## When the planner ignores an index

The planner is cost-based: it estimates how many rows each access path returns and picks the cheapest. An index lookup costs a B-tree descent plus a table-row fetch for each match, while a scan reads rows sequentially and cheaply. So an index wins only when it returns a small fraction of the table.

An index on a column with few distinct values is therefore usually ignored. `status` has two values; the planner estimates that `status = 'open'` matches half the rows (one over the number of distinct values) and scans:

```sql
CREATE INDEX orders_status ON orders(status);
EXPLAIN QUERY PLAN SELECT * FROM orders WHERE status = 'open';
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SCAN orders (fused scan + filter) |

The estimate has no histograms or most-common-value lists, so skewed data is not taken into account. When a rare value matters, a partial index (above) is the better tool.

Range conditions (`<`, `>`, `BETWEEN`, `LIKE`) are estimated with fixed fractions, so a range on a single-column index is often costed as a scan. Check with `EXPLAIN QUERY PLAN`.

`LIKE` never uses an index.

## Joins

For each join, the planner chooses an index or rowid lookup into the inner table, a hash join, or a nested loop, and orders the tables by cost (up to 8 tables exhaustively, greedily beyond). `LEFT JOIN` tables keep their position.

```sql
CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT);
INSERT INTO customers
WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 499)
SELECT 'c' || i, 'Customer ' || i FROM n;

EXPLAIN QUERY PLAN
SELECT c.name, o.total
FROM customers c JOIN orders o ON o.customer = c.id
WHERE c.name = 'Customer 7';
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SCAN customers (fused scan + filter) |
| 2 | 0 | 0 | SEARCH orders USING INDEX orders_cust_placed (=?) |

Here the planner reads `customers`, then looks up each matching customer's orders through the leading column of `orders_cust_placed`. Without a usable index on the join column, the same query becomes a `HASH JOIN`.

## EXPLAIN ANALYZE

`EXPLAIN ANALYZE` runs a `SELECT` and reports, for every operator, the planner's estimate next to what happened:

| Column | Meaning |
| --- | --- |
| `id`, `parent` | The plan tree, as in `EXPLAIN QUERY PLAN`. |
| `detail` | The operator. Operators that have no `EXPLAIN QUERY PLAN` line appear under their class name (`PROJECT`, `FILTER`, …). |
| `est_rows` | The planner's estimate of rows per loop, or NULL where it makes none. |
| `loops` | How many times the operator was started. |
| `rows` | Rows it actually produced, over all loops. |
| `time_ms` | Time spent in the operator, including its children. |

```sql
EXPLAIN ANALYZE SELECT * FROM orders WHERE customer = 'c42';
```

The output looks like this (times vary from run to run):

| id | parent | detail | est_rows | loops | rows | time_ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | PROJECT | NULL | 1 | 10 | 0.41 |
| 2 | 1 | SEARCH orders USING INDEX orders_cust_placed (=?) | 10 | 1 | 10 | 0.294 |

A large gap between `est_rows` and `rows` means the planner is working from a poor estimate. Running `ANALYZE` (below) often fixes it. Only `SELECT` statements can be analysed this way; page reads and cache hits are not reported.

## Statistics and ANALYZE

The planner estimates row counts from the shape of each table's B-tree, and the number of distinct values and NULLs per column from statistics:

- **Without ANALYZE**, statistics are sampled the first time the planner needs them: an exact scan for tables up to 4,096 rows, otherwise a sample of 512 rows at random positions. They are kept until the table grows or shrinks four-fold.
- **`ANALYZE`** (all tables) or **`ANALYZE name`** (one table, or the table of a named index) computes exact statistics for each table and index and stores them in the database file, in the internal table `smalt_stat`. They stay until the next `ANALYZE` on that table.

```sql
ANALYZE orders;
SELECT tbl, idx, stat FROM smalt_stat WHERE idx IS NULL OR idx = 'orders_cust_placed';
```

| tbl | idx | stat |
| --- | --- | --- |
| orders | NULL | {"rows":5000,"ndv":[5000,501,2,96,302],"nulls":[0,0,0,0,0]} |
| orders | orders_cust_placed | {"rows":5000,"avg":[10,3.3333333333333335]} |

The table row holds the row count, the estimated distinct values (`ndv`) and the NULL count of each column. An index row holds the average number of rows per key prefix: 10 orders per customer, and about 3.3 per distinct (customer, placed) pair. The `ndv` values are estimates (HyperLogLog), so they can be slightly off, as the 501 here for 500 customers shows. The format of `stat` is internal and may change.

Run `ANALYZE` after loading data or after large changes in data distribution, when `EXPLAIN ANALYZE` shows estimates far from the actual rows. TEMP tables and [columnar tables](./analytics#columnar-tables) are not analysed.

## Prepared statements and plan caching

Planning a statement takes time, so reuse plans for statements you run often:

- **`db.prepare(sql)`** (client and engine) parses and plans once. Each run binds new parameters and reuses the plan.
- In the in-process engine (`smaltdb/engine`), `db.query()` and `db.run()` keep the most recently used statements in a cache keyed by SQL text: 64 by default, set with the `statementCacheSize` open option. In the worker client, `db.exec(sql, params)` with parameters uses that cache; `db.query()` plans its statement on every call.

Always pass values as parameters rather than building SQL text, so the text, and with it the cached plan, stays the same:

```ts
const byCustomer = await db.prepare('SELECT id, total FROM orders WHERE customer = ?');
for (const c of ['c1', 'c2', 'c3']) {
  const rows = await byCustomer.query([c]);
  console.log(c, rows.length);
}
await byCustomer.finalize();
```

A prepared statement is planned again automatically:

- after any schema change (`CREATE`, `DROP`, `ALTER`, `ANALYZE`, …);
- when a table the plan relied on has grown or shrunk four-fold since it was planned, so a plan made for an empty table does not outlive it filling up.

See [Queries](./queries) for parameters and the rest of the query API.

## Page cache

The engine keeps recently used database pages in memory. The default budget is 16 MiB. Raise it when your working set (the tables and indexes your queries touch repeatedly) is larger:

```ts
import { open } from 'smaltdb';

const db = await open('analytics', { cacheMB: 64 });
```

In the in-process engine the option is `cacheSizeBytes`. Parallel reader workers (see [Analytics](./analytics#parallel-readers)) each get a cache of the same size. Pages are 8 KiB unless the database was created with another `pageSize`.

`PRAGMA page_count` and `PRAGMA page_size` give the size of the database file in pages and bytes per page:

```sql
PRAGMA page_size;
```

| page_size |
| --- |
| 8192 |

## Practical tips

- **Look before you index.** Run `EXPLAIN QUERY PLAN` on slow queries. A `SCAN` of a large table under a selective `WHERE` is the usual sign of a missing index.
- **Index join and filter columns**, with the equality columns first and at most one range column last.
- **Make lookups covering** for hot queries by adding the selected columns to the end of the index key.
- **Use partial indexes** for rare values (open orders, unread messages) instead of an index on a low-cardinality column.
- **Batch writes in a transaction.** Each commit is flushed to storage; many small transactions cost far more than one large one. See [Transactions](./transactions).
- **Prepare repeated statements** and bind parameters.
- **Run `ANALYZE`** after bulk loads.
- **Use columnar storage and materialized views** for dashboards and aggregates over large tables; see [Analytics](./analytics) and [Views and materialized views](./views-and-materialized-views).
