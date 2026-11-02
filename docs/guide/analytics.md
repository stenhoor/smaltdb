# Analytics

smaltdb's default storage keeps each row together in a B-tree, which is right for applications that read and write individual rows. For analytical queries (aggregates and filters over many rows), it has:

- **columnar tables and materialized views**, which store each column separately and skip blocks of rows with zone maps;
- **spilling**, so large sorts and aggregations are not limited by the worker's memory;
- **parallel readers**, which answer queries and split large aggregates across several workers in Chromium-based browsers.

This guide explains when each applies. Materialized views, which precompute results, are covered in [Views and materialized views](./views-and-materialized-views).

## Row or columnar storage

| | Row storage (default) | Columnar storage |
| --- | --- | --- |
| Layout | Whole rows in a B-tree, by rowid | Each column in compressed chunks of 8,192 rows |
| Full scans, aggregates, `GROUP BY` | Good | Several times faster |
| Filters on a column | Need an index to avoid a full scan | Zone maps skip row groups that cannot match |
| Point lookup by rowid or index | Fast | Slower: no B-tree to descend |
| Secondary indexes, `UNIQUE`, foreign keys, `ALTER TABLE` | Yes | No |
| Writes | Fast | Slower: each row is written twice (see below) |

Choose columnar storage for tables that are mostly appended to and mostly read in bulk: events, logs, measurements, imported datasets. Keep row storage for tables your application reads and updates row by row.

Measured on the project's benchmark machine (Node, one million rows of five columns, in memory, from [ADR 0010](../adr/0010-analytics-and-mixed-storage)), as a guide to the trade-off rather than a promise:

| Operation | Row table | Columnar table |
| --- | --- | --- |
| `sum` / `avg` / `count` over all rows | 84.6 ms | 13.7 ms |
| `GROUP BY` with 100 groups | 90.7 ms | 13.9 ms |
| Filtered aggregate | 72.3 ms | 2.2 ms |
| Point lookup | 0.02 ms | 1.24 ms |
| Insert one million rows | 2.9 s | 4.2 s |

## Columnar tables

Add `WITH (storage = 'columnar')` after the column list:

```sql
CREATE TABLE events (
  id     INTEGER PRIMARY KEY,
  kind   TEXT,
  amount REAL,
  at     TEXT
) WITH (storage = 'columnar');

INSERT INTO events (kind, amount, at)
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
SELECT CASE i % 3 WHEN 0 THEN 'view' WHEN 1 THEN 'click' ELSE 'buy' END,
       i % 100,
       date('2026-01-01', '+' || (i / 100) || ' days')
FROM n;

SELECT kind, count(*) AS n, sum(amount) AS total FROM events GROUP BY kind ORDER BY kind;
```

| kind | n | total |
| --- | --- | --- |
| buy | 6667 | 329967 |
| click | 6667 | 330000 |
| view | 6666 | 330033 |

A columnar table is queried and changed with ordinary SQL: `SELECT`, `INSERT` (including `OR REPLACE`, `OR IGNORE`, upsert and `RETURNING`), `UPDATE` and `DELETE`, inside transactions like any table. `NOT NULL`, `CHECK` and `DEFAULT` work as usual.

```sql
UPDATE events SET amount = 0 WHERE id <= 10;
DELETE FROM events WHERE id > 19990;
SELECT count(*) AS n, sum(amount) AS total FROM events;
```

| n | total |
| --- | --- |
| 19990 | 989090 |

### What is not supported

These fail with `SMALT_UNSUPPORTED`:

- secondary indexes (`CREATE INDEX` on a columnar table);
- `UNIQUE` constraints, and any `PRIMARY KEY` other than `INTEGER PRIMARY KEY`;
- foreign keys, to or from a columnar table;
- `ALTER TABLE`;
- `CREATE TEMP TABLE … WITH (storage = 'columnar')`.

<!-- docs:error SMALT_UNSUPPORTED -->
```sql
CREATE INDEX events_kind ON events(kind);
```

`ANALYZE` skips columnar tables; their row counts come from the column store itself.

### How writes are stored

A columnar table has three parts:

- a **delta store**: new rows land here first, in row format, so inserts, constraints and conflict handling work exactly as for row tables;
- **segments**: the column store, in groups of 8,192 rows;
- a **deletion list**: rows of the segments that were deleted, or updated (an updated row moves back to the delta store).

At the end of each write statement, once the delta store holds 8,192 rows, whole groups of them are moved into new segments. When deleted rows exceed both a quarter of the segment rows and 8,192, the segments are rewritten without them. This happens inside the statement's transaction, so a failure rolls it back.

A scan reads the delta store and then the segments, so rows come back in no particular order. Add `ORDER BY` when order matters.

### PRAGMA compact

`PRAGMA compact(table)` rewrites a columnar table's segments now: every live row, including those still in the delta store, without deleted rows. Run it after a large batch of updates or deletes, when you want the fastest scans:

```sql
PRAGMA compact(events);
SELECT count(*) AS n FROM events;
```

| n |
| --- |
| 19990 |

`DELETE FROM t` without a `WHERE` clause also empties the segments at once.

## Zone maps

For every row group and column, the column store keeps a **zone map**: the minimum, maximum and NULL count of the group's values. A comparison of a column with a constant or a parameter (`=`, `<`, `<=`, `>`, `>=`; `BETWEEN` counts as two; `IN` lists are not used) is tested against the zone maps first, and row groups that cannot contain a match are skipped without being decoded.

`EXPLAIN QUERY PLAN` lists the comparisons it uses this way:

```sql
EXPLAIN QUERY PLAN
SELECT kind, count(*) FROM events WHERE at >= '2026-06-01' GROUP BY kind;
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SCAN events (columnar table: delta + segments, fused scan + filter + group aggregate, zone maps: at >= ?) |

Zone maps pay off when values are clustered: rows inserted in time order make a filter on the time column skip most row groups. On randomly ordered values every row group spans almost the whole range and little is skipped.

Notes:

- Zone maps only skip row groups; the filter still checks every row that is read, so results are always exact.
- Text comparisons use zone maps only under the `BINARY` collation.
- A lookup by rowid or `INTEGER PRIMARY KEY` is also a zone-map test, not a B-tree descent. This is why point lookups are slower than in row tables.

```sql
EXPLAIN QUERY PLAN SELECT * FROM events WHERE id = 5;
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SCAN events (columnar table: delta + segments, zone maps: rowid = ?) |

## Columnar materialized views

A materialized view can also be stored in columns, with `WITH (storage = 'columnar')`. It has the same zone maps and fast aggregates, has no delta store (a refresh writes all of it at once), and cannot be indexed. A columnar view over a row table is a good way to get fast analytics on data your application also changes row by row: refresh it when you need current numbers.

```sql
CREATE TABLE orders (id INTEGER PRIMARY KEY, region TEXT, total REAL);
INSERT INTO orders (region, total)
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
SELECT CASE i % 2 WHEN 0 THEN 'north' ELSE 'south' END, i FROM n;

CREATE MATERIALIZED VIEW orders_columnar WITH (storage = 'columnar') AS
  SELECT region, total FROM orders;

SELECT region, sum(total) AS total FROM orders_columnar WHERE total > 900 GROUP BY region ORDER BY region;
```

| region | total |
| --- | --- |
| north | 47550 |
| south | 47500 |

See [Views and materialized views](./views-and-materialized-views#columnar-storage).

## Memory limits and spilling

Sorts (`ORDER BY`) and hash aggregates (`GROUP BY`) hold their rows in the engine worker's memory. When one operator's estimated memory use passes the **work memory** limit, it writes the excess to a scratch file and continues from there:

- a sort becomes an external merge sort: sorted runs are written out and merged as rows are read;
- a hash aggregate keeps the groups it has, and writes rows for new groups to partitions on disk, which are aggregated one at a time afterwards.

Results are the same as in memory, including the order of `group_concat` values and bare columns.

```sql
PRAGMA work_mem;
```

| work_mem |
| --- |
| 268435456 |

| Setting | Meaning |
| --- | --- |
| `PRAGMA work_mem` | The limit in bytes per operator. Default 268435456 (256 MiB). `0` turns spilling off. |
| `PRAGMA work_mem = n` | Changes it for this connection, until the database is closed. |
| `PRAGMA spill_bytes` | Bytes written to the scratch file since the database was opened. |

```sql
PRAGMA work_mem = 67108864;
PRAGMA work_mem;
```

| work_mem |
| --- |
| 67108864 |

The estimate is deliberately rough (strings count two bytes per character, plus a fixed amount per row and group), so treat `work_mem` as a guide, not an exact cap. In the in-process engine, the `workMem` open option sets the starting value.

What to know:

- **Where it spills.** The scratch file is `<database>-spill` next to the database in OPFS (parallel readers use their own files). It is truncated when the statement that used it finishes, and never holds anything after that.
- **In-memory databases never spill**: there is no scratch file, so the operators stay in memory whatever `work_mem` says. `PRAGMA spill_bytes` stays 0.

  ```sql
  PRAGMA spill_bytes;
  ```

  | spill_bytes |
  | --- |
  | 0 |

- **What does not spill yet**: window function partitions, hash join build sides, `SELECT DISTINCT`, and values that grow inside one aggregate (such as a long `group_concat` result). Keep these within memory.
- **Cancellation**: a spilling query can be cancelled like any other; see [Queries](./queries).

## Parallel readers

The engine runs in a dedicated Web Worker that owns the database. Where the browser allows it, that worker also starts **parallel reader workers**: separate connections that open the same OPFS files read-only. Readers are used only when all of these hold:

- the database is stored in OPFS (`storage: 'opfs'`, the default);
- multi-tab sharing is on (`multiTab`, on by default where Web Locks and `BroadcastChannel` exist), since the multi-tab lock guarantees a single owner;
- the browser's OPFS sync access handles support `mode: 'readwrite-unsafe'`, which at the time of writing means Chromium-based browsers;
- the device has more than one CPU core.

The engine then starts up to three readers (one fewer than `navigator.hardwareConcurrency`, at most three). In other browsers, and in the in-process engine, everything runs on one worker.

Readers are used in two ways.

### Concurrent queries

When requests are waiting in the queue, a read-only query outside a transaction can go to an idle reader instead of waiting its turn. The reader answers from a snapshot of the latest commit, so it sees exactly the data committed when the query started, while the owner keeps writing. A query that arrives with nothing waiting runs on the owner, which is faster for a single query.

You do not need to do anything to use this. Queries that read `TEMP` tables, [memory-resident views](./views-and-materialized-views#memory-resident-views) or [external data](./external-data) always run on the owner, as do all writes and `PRAGMA` statements.

### Parallel aggregates (morsels)

An aggregate over one large table can be split into rowid ranges ("morsels"), aggregated on several readers at once, and merged on the owner. This happens automatically when:

- at least two readers are idle;
- the table has at least 200,000 rows;
- the query is a single `SELECT` over one table (row table, columnar table or columnar materialized view) stored in the file: no joins, subqueries, window functions, `DISTINCT` or `UNION`;
- every aggregate merges exactly: `count`, `sum`, `total`, `min`, `max` (one argument) and `avg`, with `FILTER` allowed but not `DISTINCT` or `ORDER BY` inside the call;
- `GROUP BY` keys compare with the `BINARY` collation;
- no fresh materialized view answers the query (see [matview_rewrite](./views-and-materialized-views#answering-queries-from-materialized-views)).

`HAVING`, `ORDER BY` and `LIMIT` are applied after the merge, so results are the same as without parallelism. Writes wait until every morsel is back, so all morsels see the same commit. If a reader fails, the owner runs the query itself.

In the project's measurements (Chromium, three readers), a `GROUP BY` over 600,000 rows took 37 ms as morsels and 184 ms on the owner alone. The speed-up depends on the number of readers and on whether the table fits in the page cache.

`PRAGMA parallel_aggregates = 0` turns morsels off for the connection (for example to compare timings); `1` turns them back on. It is on by default:

```sql
PRAGMA parallel_aggregates;
```

| parallel_aggregates |
| --- |
| 1 |

Readers apply the owner's `work_mem` and `matview_rewrite` settings to each query they run. Their spilled bytes go to their own scratch files and are not counted in the owner's `PRAGMA spill_bytes`.

The client counts the queries that were answered by merging morsels, which is useful when checking that parallelism applies:

```ts
await db.query('SELECT region, sum(total) FROM orders GROUP BY region');
const { morselQueries } = db.stats;
console.log(`answered by morsels so far: ${morselQueries}`);
```

## Checklist for analytical workloads

1. Store large, append-mostly tables as columnar tables, inserting in the order you usually filter by (often time).
2. For data the application also edits row by row, keep a row table and add a columnar materialized view, refreshed when needed.
3. Precompute frequent aggregates in materialized views, and consider `PRAGMA matview_rewrite = 1`.
4. Raise the page cache (`cacheMB`) when the data you scan repeatedly is larger than 16 MiB; see [Indexes and performance](./indexes-and-performance#page-cache).
5. Lower `work_mem` if large sorts or aggregates make the tab run out of memory; raise it if `PRAGMA spill_bytes` shows spilling you can afford to avoid.
6. Check plans with `EXPLAIN QUERY PLAN`: look for `columnar`, `fused scan` and `zone maps` in the details.
