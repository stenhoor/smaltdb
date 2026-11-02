# Views and materialized views

A **view** is a named query. Reading it runs the query, so it always shows current data and stores nothing.

A **materialized view** stores the result of its query as rows. Reading it is as fast as reading a table, but the rows change only when you refresh it.

| | View | Materialized view |
| --- | --- | --- |
| Stores rows | No | Yes |
| Shows current data | Always | As of the last refresh |
| Cost of reading | The cost of its query | The cost of a table scan or index lookup |
| Indexes | No | Yes (row storage) |
| Writable | No | No (only `REFRESH`) |

Full syntax: [CREATE VIEW and CREATE MATERIALIZED VIEW](../reference/sql/views).

## Sample data

```sql
CREATE TABLE sales (
  id       INTEGER PRIMARY KEY,
  region   TEXT,
  product  TEXT,
  customer INTEGER,
  amount   REAL
);

INSERT INTO sales (region, product, customer, amount)
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
SELECT CASE i % 4 WHEN 0 THEN 'north' WHEN 1 THEN 'south' WHEN 2 THEN 'east' ELSE 'west' END,
       CASE i % 3 WHEN 0 THEN 'apple' WHEN 1 THEN 'pear' ELSE 'plum' END,
       i % 300,
       i % 50
FROM n;

CREATE INDEX sales_customer ON sales(customer);
SELECT count(*) AS n, sum(amount) AS total FROM sales;
```

| n | total |
| --- | --- |
| 3000 | 73500 |

## Views

```sql
CREATE VIEW north_sales AS
  SELECT id, product, customer, amount FROM sales WHERE region = 'north';

SELECT * FROM north_sales WHERE customer = 8 ORDER BY id;
```

| id | product | customer | amount |
| --- | --- | --- | --- |
| 8 | plum | 8 | 8 |
| 308 | plum | 8 | 8 |
| 608 | plum | 8 | 8 |
| 908 | plum | 8 | 8 |
| 1208 | plum | 8 | 8 |
| 1508 | plum | 8 | 8 |
| 1808 | plum | 8 | 8 |
| 2108 | plum | 8 | 8 |
| 2408 | plum | 8 | 8 |
| 2708 | plum | 8 | 8 |

Use views to name a query you use in several places, to hide columns, or to give an application a stable shape while the tables underneath change.

What to know:

- **Read-only.** INSERT, UPDATE and DELETE on a view fail.
- **Resolved when used.** As in SQLite, a view's body is checked when a query reads the view, not when the view is created. A view over a table that does not exist yet can be created; reading it fails until the table exists.
- **Column names.** `CREATE VIEW v(a, b) AS …` renames the result columns.
- **TEMP views.** `CREATE TEMP VIEW` exists only for this connection and shadows a view of the same name.
- **Dropping.** `DROP VIEW [IF EXISTS] name`.

### Flattening

A simple view is merged ("flattened") into the query that reads it, so its tables join and use indexes as if you had written them out. The query above uses the index on `sales.customer`:

```sql
EXPLAIN QUERY PLAN SELECT * FROM north_sales WHERE customer = 8;
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SEARCH sales USING INDEX sales_customer (=?) |

Views and `FROM` subqueries are flattened when their body is a plain selection, projection or join of tables. A body with aggregates, `DISTINCT`, `LIMIT`, `ORDER BY`, a compound (`UNION` …), window functions or subquery expressions runs as a separate step instead, and a condition on the view is applied to its result:

```sql
CREATE VIEW customer_totals AS
  SELECT customer, sum(amount) AS total FROM sales GROUP BY customer;

EXPLAIN QUERY PLAN SELECT * FROM customer_totals WHERE customer = 8;
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SCAN sales (fused scan + filter + GROUP BY) |

Here every customer's total is computed and then filtered. When a query like this is slow and runs often, a materialized view is the usual answer.

## Materialized views

```sql
CREATE MATERIALIZED VIEW sales_by_region AS
  SELECT region, product, sum(amount) AS total, count(*) AS n
  FROM sales
  GROUP BY region, product;

SELECT * FROM sales_by_region WHERE region = 'north' ORDER BY product;
```

| region | product | total | n |
| --- | --- | --- | --- |
| north | apple | 6000 | 250 |
| north | pear | 6000 | 250 |
| north | plum | 6000 | 250 |

Creating the view runs its query and stores the rows. Use materialized views for:

- aggregates and joins that are expensive and read much more often than the data changes (dashboards, reports);
- a local copy of [external data](./external-data#caching-in-a-materialized-view), for fast repeat reads and offline use.

### Refreshing

The rows do not change when the base tables change:

```sql
INSERT INTO sales (region, product, customer, amount) VALUES ('north', 'apple', 1, 1000);
SELECT total, n FROM sales_by_region WHERE region = 'north' AND product = 'apple';
```

| total | n |
| --- | --- |
| 6000 | 250 |

`REFRESH MATERIALIZED VIEW` runs the query again and replaces the rows:

```sql
REFRESH MATERIALIZED VIEW sales_by_region;
SELECT total, n FROM sales_by_region WHERE region = 'north' AND product = 'apple';
```

| total | n |
| --- | --- |
| 7000 | 251 |

A refresh is a full recomputation. It builds the new rows (and indexes) separately and swaps them in when done, so readers never see a half-refreshed view, and a refresh that fails leaves the old rows in place. `REFRESH MATERIALIZED VIEW CONCURRENTLY name` is accepted for PostgreSQL compatibility and does the same; unlike PostgreSQL, it needs no unique index.

Incremental maintenance is not supported: `WITH (refresh = 'incremental')` fails with `SMALT_UNSUPPORTED`. The only `refresh` mode is `'manual'`, the default.

### Freshness

smaltdb tracks whether a view is fresh: a write to any table it reads (directly, or through other views) marks it stale, and a refresh makes it fresh again. The flag is transactional, so a rolled-back write leaves the view fresh. `information_schema.materialized_views` shows it, with the time of the last refresh:

```sql
INSERT INTO sales (region, product, customer, amount) VALUES ('west', 'plum', 2, 5);
SELECT table_name, storage, location, refresh_mode, is_populated, is_fresh
FROM information_schema.materialized_views;
```

| table_name | storage | location | refresh_mode | is_populated | is_fresh |
| --- | --- | --- | --- | --- | --- |
| sales_by_region | row | file | MANUAL | YES | NO |

`REFRESH MATERIALIZED VIEW name IF CHANGED` refreshes only when needed. For a view over local tables, that means when it is stale:

```sql
REFRESH MATERIALIZED VIEW sales_by_region IF CHANGED;
SELECT is_fresh FROM information_schema.materialized_views WHERE table_name = 'sales_by_region';
```

| is_fresh |
| --- |
| YES |

For a view over external data, `IF CHANGED` asks each source whether it changed (an HTTP `HEAD` request, a file's modification time) without downloading it; see [External data](./external-data#caching-in-a-materialized-view).

::: warning IF CHANGED needs the asynchronous API
Checking sources is asynchronous. Through the worker client, run it with `db.exec()`. In the in-process engine (`smaltdb/engine`), use `execAsync()`; `exec()`, `run()`, `query()` and also `queryAsync()` and `runAsync()` fail with `SMALT_ASYNC_REQUIRED`.
:::

### Creating without data

`WITH NO DATA` creates the view without running its query. Reading it fails until the first refresh, as in PostgreSQL. This is useful when the query is expensive and you want to choose when it runs:

```sql
CREATE MATERIALIZED VIEW big_customers AS
  SELECT customer, sum(amount) AS total FROM sales GROUP BY customer HAVING sum(amount) > 300
  WITH NO DATA;
```

<!-- docs:error SMALT_ERROR -->
```sql
SELECT count(*) FROM big_customers;
```

```sql
REFRESH MATERIALIZED VIEW big_customers;
SELECT count(*) AS n FROM big_customers;
```

| n |
| --- |
| 115 |

`REFRESH MATERIALIZED VIEW name WITH NO DATA` empties a view again and marks it unpopulated (it cannot be combined with `CONCURRENTLY`).

### Column types

Each column takes its type from the query: a column copied from a table keeps its declared type and collation, and a computed value gets the type of its expression, or `ANY`. A list of names after the view name renames the columns:

```sql
CREATE MATERIALIZED VIEW product_stats (product, orders, average) AS
  SELECT product, count(*), avg(amount) FROM sales GROUP BY product;

SELECT name, type FROM pragma_table_info('product_stats');
```

| name | type |
| --- | --- |
| product | TEXT |
| orders | INTEGER |
| average | REAL |

Columns are typed strictly, like table columns. A refresh that produces a value its column cannot hold fails and keeps the old rows; add a `CAST` to the view's query if a column's values change type.

### Indexes on materialized views

A materialized view with row storage (the default) can have indexes. Every refresh rebuilds them.

```sql
CREATE INDEX big_customers_total ON big_customers(total);
SELECT * FROM big_customers WHERE total > 1000;
```

| customer | total |
| --- | --- |
| 1 | 1010 |

### Columnar storage

`WITH (storage = 'columnar')` stores the rows in column segments with zone maps instead of a B-tree. Aggregates and filtered scans over many rows run several times faster; point lookups are slower, and a columnar view cannot have indexes. See [Analytics](./analytics) for how columnar storage works and when to choose it.

```sql
CREATE MATERIALIZED VIEW sales_columnar WITH (storage = 'columnar') AS
  SELECT region, product, amount FROM sales;

EXPLAIN QUERY PLAN
SELECT region, sum(amount) FROM sales_columnar WHERE amount > 40 GROUP BY region;
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SCAN sales_columnar (columnar, fused scan + filter + group aggregate, zone maps: amount > ?) |

<!-- docs:error SMALT_ERROR -->
```sql
CREATE INDEX sales_columnar_region ON sales_columnar(region);
```

### Memory-resident views

In an OPFS database, `WITH (location = 'memory')` keeps the view's rows and indexes in memory and only its definition in the file. Refreshing such a view writes nothing to storage. The rows are recomputed each time the database is opened. Use it for derived data that is cheap enough to rebuild and changes often, so refreshes do not wear storage.

```sql
CREATE MATERIALIZED VIEW region_totals WITH (location = 'memory') AS
  SELECT region, sum(amount) AS total FROM sales GROUP BY region;
```

`information_schema.materialized_views.location` reports `memory` for these views. In an in-memory database (`storage: 'memory'`) everything already lives in memory: the option is accepted and the view is an ordinary one, reported as `file`.

Parallel reader workers cannot see memory-resident views; queries that read them run on the engine worker that owns the database. A materialized view cannot read `TEMP` tables.

### Refresh policies

Two options make the engine worker refresh a view by itself, with `REFRESH … IF CHANGED`:

| Option | Effect |
| --- | --- |
| `refresh_every = <seconds>` | Refresh when this many seconds have passed since the last refresh (or the last attempt). |
| `refresh_on_reconnect = true` | Refresh when the browser comes back online (the worker's `online` event). |

```sql
CREATE MATERIALIZED VIEW hourly_totals WITH (refresh_every = 3600, refresh_on_reconnect = true) AS
  SELECT region, sum(amount) AS total FROM sales GROUP BY region;

SELECT table_name, refresh_mode, last_refresh_error
FROM information_schema.materialized_views WHERE table_name = 'hourly_totals';
```

| table_name | refresh_mode | last_refresh_error |
| --- | --- | --- |
| hourly_totals | EVERY 3600 SECONDS, ON RECONNECT | NULL |

The worker checks the policies every second while the database is open. Scheduled refreshes queue behind other requests like any statement. If one fails (offline, an HTTP error), the error is shown in `last_refresh_error`.

Policies are mainly meant for views over [external data](./external-data). They run only in the engine worker used by the `smaltdb` client. In the in-process engine (`smaltdb/engine`, for example in Node), nothing runs on a timer: run `REFRESH … IF CHANGED` yourself.

### Read-only, and its own DROP

A materialized view cannot be changed with INSERT, UPDATE, DELETE or ALTER TABLE:

<!-- docs:error SMALT_ERROR -->
```sql
DELETE FROM sales_by_region;
```

Drop it with `DROP MATERIALIZED VIEW [IF EXISTS] name`; `DROP VIEW` and `DROP TABLE` refuse it. In `sqlite_schema` it has type `matview`, and `information_schema.tables` reports `MATERIALIZED VIEW`.

```sql
DROP MATERIALIZED VIEW sales_columnar;
SELECT type, name FROM sqlite_schema WHERE type = 'matview' ORDER BY name;
```

| type | name |
| --- | --- |
| matview | big_customers |
| matview | hourly_totals |
| matview | product_stats |
| matview | region_totals |
| matview | sales_by_region |

## Answering queries from materialized views

With `PRAGMA matview_rewrite = 1`, the planner answers queries over a table from a fresh materialized view of that table when the view provably holds what the query needs. Your queries keep naming the base table; the view is used behind the scenes. `EXPLAIN QUERY PLAN` shows the view when it is used.

The setting is per connection and off by default. It never changes a query's result, only where the rows come from.

```sql
PRAGMA matview_rewrite = 1;
REFRESH MATERIALIZED VIEW sales_by_region;

EXPLAIN QUERY PLAN SELECT region, sum(amount) FROM sales GROUP BY region;
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SCAN sales_by_region (fused scan + filter + GROUP BY) |

The query groups by `region` only, while the view groups by `region` and `product`; the planner adds up the view's `total` per region. The result is the same as from the table:

```sql
SELECT region, sum(amount) AS total FROM sales GROUP BY region ORDER BY region;
```

| region | total |
| --- | --- |
| east | 18000 |
| north | 19000 |
| south | 18750 |
| west | 18755 |

### When a query is rewritten

A view qualifies only when it is **fresh** (no write to its base table since its last refresh), **populated**, and reads **a single table**. Views over external data are never used, because the source can change without the database knowing.

Two kinds of query can be answered:

**Aggregate roll-ups.** The view is `SELECT keys…, aggregates… FROM t [WHERE p] GROUP BY keys`. A query over `t` qualifies when:

- its WHERE clause is the view's WHERE clause plus, optionally, conditions on the view's group keys;
- it groups by some or all of the view's keys (or does not group at all);
- each of its aggregates can be computed from the view's columns:

| Query aggregate | Needs in the view |
| --- | --- |
| `count(*)` | `count(*)` |
| `count(x)` | `count(x)` |
| `sum(x)` | `sum(x)` |
| `total(x)` | `total(x)` or `sum(x)` |
| `min(x)`, `max(x)` | `min(x)`, `max(x)` |
| `avg(x)` | `sum(x)` (or `total(x)`) and `count(x)` |

`count(DISTINCT …)`, aggregates with `ORDER BY` inside the call, and other aggregate functions (`group_concat`, …) are not rolled up.

**Selections.** The view is `SELECT columns FROM t [WHERE p]` (plain columns or `*`). A query over `t` without aggregates qualifies when its WHERE clause contains the view's WHERE clause and it reads only columns the view has.

Expressions are compared by structure, after dropping table qualifiers and ignoring the case of names: `WHERE amount >= 5` in the view matches `WHERE s.amount >= 5` in the query, but not `WHERE 5 <= amount`.

Here `max` is not in the view, so the query reads the table:

```sql
EXPLAIN QUERY PLAN SELECT region, max(amount) FROM sales GROUP BY region;
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SCAN sales (fused scan + filter + GROUP BY) |

A condition on a column that is not a group key of the view also rules it out, because the view's rows have already been aggregated over it:

```sql
EXPLAIN QUERY PLAN SELECT region, sum(amount) FROM sales WHERE amount > 10 GROUP BY region;
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SCAN sales (fused scan + filter + GROUP BY) |

After a write to `sales`, the view is stale and no longer used until it is refreshed:

```sql
INSERT INTO sales (region, product, customer, amount) VALUES ('east', 'pear', 3, 7);
EXPLAIN QUERY PLAN SELECT region, sum(amount) FROM sales GROUP BY region;
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SCAN sales (fused scan + filter + GROUP BY) |

### Where it applies

Matching applies to every `SELECT` the planner plans: the statement itself, `FROM` subqueries, scalar, `IN` and `EXISTS` subqueries, CTE bodies, view bodies, each branch of a `UNION`, and the `SELECT` of an `INSERT … SELECT`.

It does not apply to:

- correlated subqueries (those that read columns of the enclosing query);
- a name that refers to a CTE rather than a table;
- `UPDATE` and `DELETE`;
- `INSERT … SELECT` that writes to a base table of the view, or that may write other tables through foreign-key actions.

### Cost

Marking views stale costs the first write to a base table after each refresh a little extra work. Matching itself happens when a statement is planned; a prepared statement is planned again when a view becomes fresh or stale.

On parallel reader workers (see [Analytics](./analytics#parallel-readers)), the owner's `matview_rewrite` setting applies too. A query answered from a fresh view is never split into parallel morsels, since the view is cheaper.

## See also

- [Analytics](./analytics): columnar storage and parallel aggregates
- [External data](./external-data): caching remote files in materialized views
- [Introspection](./introspection): `information_schema.views` and `materialized_views`
- [ADR 0010](../adr/0010-analytics-and-mixed-storage), section 5: how matching works
