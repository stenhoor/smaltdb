# SQL Dialect

> Status: draft. The baseline is **SQLite 3.4x syntax and semantics**. Deviations are listed explicitly.

## 1. Statements (initial scope)

| Category | Statements |
|---|---|
| Query | `SELECT` (joins: inner/left/right/full/cross, `USING`, `NATURAL`), `WITH [RECURSIVE]`, compound `UNION [ALL]`/`INTERSECT`/`EXCEPT`, `ORDER BY … NULLS FIRST/LAST`, `LIMIT/OFFSET`, window functions, `FILTER` clause, `VALUES` |
| DML | `INSERT` (incl. `INSERT … SELECT`, `ON CONFLICT … DO UPDATE/NOTHING`, `RETURNING`), `UPDATE … FROM`, `DELETE`, `REPLACE` |
| DDL | `CREATE/DROP TABLE` (incl. `WITHOUT ROWID`, `STRICT`, generated columns, `CHECK`, `FOREIGN KEY`), `ALTER TABLE` (rename, add/drop/rename column), `CREATE/DROP INDEX` (partial, expression), `CREATE/DROP VIEW`, `CREATE/DROP MATERIALIZED VIEW`, `REFRESH MATERIALIZED VIEW`, triggers **[Q-8]** |
| Transactions | `BEGIN [DEFERRED/IMMEDIATE/EXCLUSIVE]`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE` |
| Utility | `EXPLAIN [ANALYZE|QUERY PLAN]`, `ANALYZE`, `VACUUM`, `PRAGMA` (subset), `ATTACH`/`DETACH` **[Q-10]** |

## 2. Type system **[Q-5]**

SQLite uses dynamic typing with *type affinity*: any column can hold any value. That is flexible, but it blocks
efficient fixed-width columnar storage and vectorization.

**Proposal:**
- Tables are `STRICT` by default (as in SQLite `STRICT` tables). Each column has a declared type that is enforced.
- Storage types: `INTEGER` (int64), `REAL` (float64), `TEXT` (UTF-8), `BLOB`, `BOOLEAN`, `ANY`.
  Optional extensions: `DATE`/`TIMESTAMP`, `DECIMAL`, `JSON`.
- `CREATE TABLE … LOOSE` (or a database-level pragma) enables SQLite-style affinity for compatibility. Such tables
  use a slower, tagged-value path.
- Integers surface in JS as `number` when they are within the safe range, and as `bigint` otherwise (configurable).

## 3. Functions

- Core scalar functions: SQLite's full core set (`abs`, `coalesce`, `ifnull`, `instr`, `length`, `lower`, `printf`/`format`, `replace`, `round`, `substr`, `trim`, `typeof`, …)
- Date/time: `date`, `time`, `datetime`, `julianday`, `unixepoch`, `strftime`
- Math: SQLite math functions
- Aggregates: `count`, `sum`, `total`, `avg`, `min`, `max`, `group_concat`/`string_agg`
- Window functions: `row_number`, `rank`, `dense_rank`, `ntile`, `lag`, `lead`, `first_value`, `last_value`, `nth_value`, and aggregates over frames
- JSON: `json_*` / `->` / `->>` (optional module) **[Q-12]**
- **User-defined functions** in JS, registered from the client and shipped to the worker as source text **[Q-13]**

## 4. information_schema

These are read-only views over the internal catalog and follow the SQL-standard / PostgreSQL shape:

| View | Notes |
|---|---|
| `information_schema.schemata` | `main`, `temp`, and attached databases |
| `information_schema.tables` | `table_type` ∈ `BASE TABLE`, `VIEW`, `MATERIALIZED VIEW`, `LOCAL TEMPORARY` |
| `information_schema.columns` | ordinal position, data type, nullability, default, generated expression |
| `information_schema.views` | view definition |
| `information_schema.table_constraints`, `key_column_usage`, `referential_constraints`, `check_constraints` | |
| `information_schema.routines`, `parameters` | built-in and user-defined functions |
| `information_schema.statistics` (non-standard, like MySQL) | indexes and index columns |
| `information_schema.materialized_views` (extension) | refresh mode, last refresh time, staleness |

SQLite compatibility: `sqlite_schema` / `sqlite_master`, `pragma_table_info()`, `pragma_index_list()`, and the related table-valued pragma functions.

## 5. Materialized views **[Q-7]**

```sql
CREATE MATERIALIZED VIEW sales_by_day
  [WITH (refresh = 'manual' | 'on_commit' | 'incremental', storage = 'row' | 'column')]
AS SELECT day, sum(amount) AS total, count(*) AS n FROM sales GROUP BY day;

REFRESH MATERIALIZED VIEW sales_by_day [CONCURRENTLY];
```

- Stored as a regular table with a hidden catalog link to its definition. MVs can have indexes.
- Refresh modes (proposed phasing):
  1. `manual`: full recompute.
  2. `incremental`: maintained by delta rules for select/project/inner-join/group-by with distributive and algebraic
     aggregates (`count`, `sum`, `avg`, and `min`/`max` when inserts only). Deltas are captured from the WAL or a change log.
  3. `on_commit`: incremental maintenance runs inside the writing transaction.
- `REFRESH … CONCURRENTLY` builds a new copy and swaps it in, so readers are never blocked.
- The optimizer can optionally rewrite queries to use a fresh MV.

## 6. Known deviations from SQLite (proposed)

- Tables are STRICT by default **[Q-5]**.
- Identifiers: case-insensitive, as in SQLite. Double quotes are identifiers only; the SQLite double-quoted string-literal quirk is not supported.
- `RIGHT`/`FULL OUTER JOIN` are supported.
- Additions: `CREATE MATERIALIZED VIEW`, `INCLUDE` columns on indexes, `information_schema`, and `WITH (…)` storage options.
