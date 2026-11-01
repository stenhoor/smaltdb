# SQL Dialect

> Status: draft. The baseline is **SQLite 3.4x syntax and semantics**. Deviations are listed explicitly.

## 1. Statements (initial scope)

| Category | Statements |
|---|---|
| Query | `SELECT` (joins: inner/left/right/full/cross, `USING`, `NATURAL`), `WITH [RECURSIVE]`, compound `UNION [ALL]`/`INTERSECT`/`EXCEPT`, `ORDER BY … NULLS FIRST/LAST`, `LIMIT/OFFSET`, window functions, `FILTER` clause, `VALUES` |
| DML | `INSERT` (incl. `INSERT … SELECT`, `ON CONFLICT … DO UPDATE/NOTHING`, `RETURNING`), `UPDATE … FROM`, `DELETE`, `REPLACE` |
| DDL | `CREATE/DROP TABLE` (incl. `WITHOUT ROWID`, `STRICT`, generated columns, `CHECK`, `FOREIGN KEY`), `ALTER TABLE` (rename, add/drop/rename column), `CREATE/DROP INDEX` (partial, expression), `CREATE/DROP VIEW`, `CREATE/DROP MATERIALIZED VIEW`, `REFRESH MATERIALIZED VIEW`. *(Triggers: post-v1)* |
| Transactions | `BEGIN [DEFERRED/IMMEDIATE/EXCLUSIVE]`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE` |
| Utility | `EXPLAIN [ANALYZE|QUERY PLAN]`, `ANALYZE`, `VACUUM`, `PRAGMA` (subset). *(`ATTACH`/`DETACH`: open question Q-10)* |

## 2. Type system (decided: ADR 0001)

SQLite uses dynamic typing with *type affinity*: any column can hold any value. That is flexible, but it blocks
efficient fixed-width columnar storage and vectorization.

**Decision:**
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
- *Post-v1 extensions*: JSON (`json_*`, `->`, `->>`) and JS user-defined functions. The function registry must allow them to be added without engine changes.

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

> **Implemented in M4** (`src/engine/catalog/information-schema.ts`): `schemata`, `tables`, `columns`, `views`, `table_constraints`,
> `key_column_usage`, `referential_constraints`, `check_constraints`, `routines` (built-in functions) and `statistics`.
> Constraints without a name get PostgreSQL-style names (`t_pkey`, `t_col_key`, `t_col_fkey`, `t_check1`). Internal tables
> (`smalt_*`) are not listed. Not yet: `parameters` (no per-function signatures), `materialized_views` (M5), TEMP objects.
> Table-valued pragmas: `pragma_table_info`, `pragma_table_xinfo`, `pragma_index_list`, `pragma_index_info`,
> `pragma_index_xinfo`, `pragma_foreign_key_list`; their arguments may reference earlier FROM sources
> (`FROM sqlite_schema m JOIN pragma_table_info(m.name)`), which plans them as lateral joins.

## 5. Materialized views

```sql
CREATE MATERIALIZED VIEW sales_by_day
  [WITH (refresh = 'manual')]   -- 'incremental' / 'on_commit' reserved for later
AS SELECT day, sum(amount) AS total, count(*) AS n FROM sales GROUP BY day;

REFRESH MATERIALIZED VIEW sales_by_day [CONCURRENTLY];
```

- Stored as a regular table with a hidden catalog link to its definition. MVs can have indexes.
- **v1**: `manual` refresh, which is a full recompute.
- **Later**:
  - `incremental`: maintained by delta rules for select/project/inner-join/group-by with distributive and algebraic
    aggregates. Deltas are captured from the WAL or a change log.
  - `on_commit`: incremental maintenance runs inside the writing transaction.
- `REFRESH … CONCURRENTLY` builds a new copy and swaps it in, so readers are never blocked.
- The optimizer can optionally rewrite queries to use a fresh MV.

## 6. Known deviations from SQLite (proposed)

- Tables are STRICT by default (`LOOSE` opt-in).
- Identifiers: case-insensitive, as in SQLite. Double quotes are identifiers only; the SQLite double-quoted string-literal quirk is not supported.
- `RIGHT`/`FULL OUTER JOIN` are supported.
- Collations: `BINARY` (default), `NOCASE` (ASCII only), and `RTRIM`. No locale collations in v1.
- Additions: `CREATE MATERIALIZED VIEW`, `INCLUDE` columns on indexes, `information_schema`, and `WITH (…)` storage options.

## 7. Implementation status (M1)

**Works today** (verified against SQLite with differential tests):
- `SELECT` with `WHERE`, `[LEFT] JOIN ... ON/USING`, `NATURAL JOIN`, comma joins, `GROUP BY` / `HAVING`, aggregates
  (`count`, `sum`, `total`, `avg`, `min`, `max`, `group_concat`, `string_agg`, `DISTINCT`, `FILTER`), `DISTINCT`, `ORDER BY`
  (`ASC`/`DESC`, `NULLS FIRST/LAST`, ordinals, aliases), `LIMIT`/`OFFSET`, `UNION [ALL]` / `INTERSECT` / `EXCEPT`, `VALUES`,
  derived tables, non-recursive CTEs, scalar / `EXISTS` / `IN` subqueries (correlated or not), and SQLite's bare-column rule for min/max.
- Expressions: SQLite affinity and collation rules for comparisons, three-valued logic, int64-exact arithmetic with overflow to REAL,
  `CASE`, `CAST`, `LIKE` / `GLOB` / `ESCAPE`, `IN` lists, `BETWEEN`, `IS [NOT]`, `||`, bitwise operators, and about 45 scalar functions
  (string, numeric, `printf`/`format`, `typeof`, `quote`, `hex`, `coalesce`/`ifnull`/`iif`/`nullif`, `last_insert_rowid`, `changes`, …).
- `INSERT` (VALUES, SELECT, DEFAULT VALUES, column lists, `OR IGNORE` / `OR REPLACE`), `UPDATE` (two-pass, SQLite order),
  `DELETE` (with a truncate fast path).
- (M4) `RETURNING` on INSERT/UPDATE/DELETE (`*`, expressions, aliases; aggregates rejected like SQLite);
  upsert `ON CONFLICT [(cols)] DO NOTHING | DO UPDATE SET … [WHERE …]` with `excluded.*`, several clauses tried in order;
  `UPDATE … FROM` (joined sources; with several matching FROM rows the first one wins, as in SQLite).
- (M4) `WITH RECURSIVE`, evaluated like SQLite: a queue seeded by the initial SELECT, one row per recursive step,
  `UNION` de-duplication, `ORDER BY` in the CTE as a priority queue (breadth/depth-first traversals), `LIMIT`/`OFFSET`,
  several recursive SELECTs.
- `CREATE` / `DROP TABLE` (`IF [NOT] EXISTS`, `INTEGER PRIMARY KEY` rowid alias, `PRIMARY KEY`, `UNIQUE`, `NOT NULL`, `DEFAULT`,
  `CHECK`, `COLLATE`), `CREATE [UNIQUE] INDEX` (multi-column, `ASC`/`DESC`, collations), and `DROP INDEX`.
- `CREATE VIEW [IF NOT EXISTS] name [(columns)] AS select` and `DROP VIEW [IF EXISTS]` (M4). As in SQLite, a view's body is
  resolved when the view is used, not when it is created, and views cannot be modified or indexed. Simple views and FROM
  subqueries (no aggregates, DISTINCT, LIMIT, ORDER BY, compound, window functions or subquery expressions) are flattened
  into the referencing query, so their tables join and use indexes like tables written out directly.
- `BEGIN` / `COMMIT` / `ROLLBACK`, `SAVEPOINT` / `RELEASE` / `ROLLBACK TO` (M2), with statement-level atomicity inside transactions.
- `EXPLAIN QUERY PLAN`, `EXPLAIN ANALYZE` (SELECT; estimated vs actual rows, loops and time per operator), and `ANALYZE [table]`
  (statistics in `smalt_stat`; M3); `PRAGMA table_info / index_list / index_info / page_size / page_count / freelist_count /
  schema_version / integrity_check / journal_mode / wal_checkpoint`; `smalt_schema` (also `sqlite_schema` / `sqlite_master`).

**Type mapping (STRICT by default):** declared types map to storage types by SQLite's affinity rules. *INT* → INTEGER;
*CHAR*/*CLOB*/*TEXT* → TEXT; *BLOB* → BLOB; *REAL*/*FLOA*/*DOUB* → REAL; `ANY` or no type → ANY; anything else
(NUMERIC, DECIMAL, BOOLEAN, DATE, …) → NUMERIC, meaning ANY with numeric conversion of numeric-looking text. Values are converted
losslessly as SQLite STRICT tables do (`'5'` into an INTEGER column becomes 5), and anything else is rejected with
`cannot store TEXT value in INTEGER column t.c`.

**Not yet supported** (each gives a clear `SMALT_UNSUPPORTED` error): window functions, `RIGHT` / `FULL` joins,
TEMP views, materialized views (M5), `ON CONFLICT` targets with WHERE, row-value assignments (`SET (a, b) = …`), `ALTER TABLE`, expression and
partial indexes, `INCLUDE` columns, `WITHOUT ROWID`, `LOOSE` tables, generated columns, TEMP tables, date/time and JSON
functions, and `VACUUM`. Plain `EXPLAIN` returns the `EXPLAIN QUERY PLAN` output (there is no bytecode to list). Foreign keys are parsed and stored but not yet enforced (M4).

**Known deviations:**
- An integral REAL with magnitude below 2^53 stored in an `ANY`/`NUMERIC` column, or flowing through an untyped expression, reads back as
  INTEGER. This affects `typeof()`, text conversion and integer division (ADR 0003, decision 2). REALs outside ±2^53, such as int64-overflow
  results, are always treated as REAL, because smaltdb represents such integers as `bigint`.
- `AUTOINCREMENT` is accepted but behaves like a plain `INTEGER PRIMARY KEY` (the max rowid + 1 can be reused after deleting
  the largest row).
- PRIMARY KEY columns are always NOT NULL.
- `OR FAIL` behaves like `OR ABORT`.
- In `GROUP BY` / `DISTINCT` over NOCASE or RTRIM text, values that compare equal form one group, and which spelling is returned is unspecified.
  smaltdb returns the first row in scan order; SQLite returns the first in its own sort order, which can differ.
- Index keys must fit in about a quarter of a page (≈2 KB with 8 KiB pages); SQLite allows larger keys via overflow pages.
