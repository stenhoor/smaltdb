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
- Date/time: `date`, `time`, `datetime`, `julianday`, `unixepoch`, `strftime`, `timediff`, and `CURRENT_DATE` / `CURRENT_TIME` /
  `CURRENT_TIMESTAMP`, with SQLite 3.54 semantics (a port of SQLite's `date.c`, checked against the SQLite WASM build in
  `test/datetime.test.ts`). All time-value formats are supported (`YYYY-MM-DD[ |T]HH:MM[:SS[.SSS]]`, `HH:MM…` alone, `24:00`, time-zone
  suffixes `[+-]HH:MM` / `Z`, `'now'`, `'subsec'`, julian day or Unix numbers), as are all modifiers (`±NNN days|hours|minutes|seconds|months|years`,
  `±HH:MM[:SS[.SSS]]`, `±YYYY-MM-DD[ HH:MM[:SS[.SSS]]]`, `start of day|month|year`, `weekday [-]N`, `unixepoch`, `julianday`, `auto`,
  `localtime`, `utc`, `subsec`/`subsecond`, `ceiling`, `floor`) and all `strftime` codes (`%d %e %f %F %G %g %H %I %j %J %k %l %m %M %p %P
  %R %s %S %T %u %U %V %w %W %Y %%`). Invalid input gives NULL where SQLite does. `'localtime'` and `'utc'` use the host (browser) time zone.
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
> (`smalt_*`) are not listed. Not yet: `parameters` (no per-function signatures), TEMP objects (TEMP tables are not listed). `materialized_views` (extension) arrived with M5.
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

> **Implemented in M5.** `CREATE MATERIALIZED VIEW [IF NOT EXISTS] name [(columns)] [WITH (storage = 'row' | 'columnar',
> refresh = 'manual')] AS select [WITH [NO] DATA]`, `REFRESH MATERIALIZED VIEW [CONCURRENTLY] name [WITH [NO] DATA]`,
> `DROP MATERIALIZED VIEW [IF EXISTS] name`.
> - Column types come from the query: a column copied from a table keeps its declared type (and collation); computed
>   values get their static type (INTEGER, REAL, TEXT, BLOB) or ANY. A refresh that produces a value its column cannot
>   hold exactly fails and leaves the old rows (add a CAST to the view).
> - Every refresh builds new trees and then swaps them in (copy-on-write). `CONCURRENTLY` therefore never blocks
>   readers and, unlike PostgreSQL, needs no unique index. The two forms differ only once concurrent readers arrive (M6).
> - `WITH NO DATA` leaves the view unpopulated; reading it is an error until it is refreshed (PostgreSQL behaviour).
> - The view is read-only (INSERT/UPDATE/DELETE/ALTER fail) and can have indexes, which every refresh rebuilds.
> - `storage = 'columnar'` stores the rows as columnar segments: 8,192-row groups of encoded column chunks with zone
>   maps (min/max/null count) that let scans skip row groups, and generated aggregate pipelines over the column
>   arrays. Columnar views cannot have indexes. See [ADR 0008](adr/0008-materialized-views-and-columnar-segments.md).
> - Catalog: `sqlite_schema` lists it with type `matview`; `information_schema.tables` reports `MATERIALIZED VIEW`, and
>   `information_schema.materialized_views` gives the definition, storage, population state and last refresh time.

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
  `UPDATE … FROM` (joined sources; with several matching FROM rows the first one wins, as in SQLite); `WITH [RECURSIVE]`
  on INSERT … SELECT, UPDATE and DELETE.
- (M4) Foreign keys are enforced, with SQLite's semantics: immediate constraints are checked at the end of each
  statement (temporary violations inside a statement are fine), `DEFERRABLE INITIALLY DEFERRED` ones at COMMIT;
  `ON DELETE` / `ON UPDATE` `NO ACTION | RESTRICT | CASCADE | SET NULL | SET DEFAULT` (actions recurse; RESTRICT is
  checked when its turn comes, newest constraint first, like SQLite); composite and self-referencing keys; REPLACE
  conflicts and `DROP TABLE` of a parent apply them; "foreign key mismatch" errors for parent keys that are not
  PRIMARY KEY/UNIQUE. **Deviation:** enforcement is **on by default** (SQLite's default is off);
  `PRAGMA foreign_keys = OFF` turns it off (not inside a transaction, as in SQLite).
- (M4) `ALTER TABLE … RENAME TO | RENAME COLUMN | ADD COLUMN | DROP COLUMN`, like SQLite: renames rewrite the
  stored SQL of the table, its indexes, other tables' `REFERENCES` clauses and views (only references that resolve
  to the altered table/column change; quoting style is kept); every object is re-validated and the ALTER fails with
  SQLite's "error in view v after drop column: …" style messages; `ADD COLUMN` takes a constant default and existing
  rows read it without being rewritten; `DROP COLUMN` rewrites the rows.
- (M4) `RIGHT [OUTER] JOIN` and `FULL [OUTER] JOIN` (hash-matched on equality conditions, with any residual ON
  condition; WHERE conditions are not pushed below them, and FROM order is kept in queries that use them).
- (M4) Expression and partial indexes: `CREATE [UNIQUE] INDEX i ON t(lower(name), a + b DESC) [WHERE cond]`.
  Expressions must be deterministic and free of subqueries and parameters (SQLite's errors). The planner matches
  query terms against index expressions (table qualifiers ignored) and uses a partial index only when the query's
  WHERE contains every conjunct of the index's WHERE.
- (M4) Window functions: `row_number`, `rank`, `dense_rank`, `percent_rank`, `cume_dist`, `ntile`, `lag`, `lead`,
  `first_value`, `last_value`, `nth_value`, and every aggregate (with `FILTER`) over a window; `PARTITION BY`, `ORDER BY`,
  `ROWS` / `RANGE` / `GROUPS` frames with `UNBOUNDED` / `n PRECEDING|FOLLOWING` / `CURRENT ROW` bounds and `EXCLUDE`
  options; named windows (`WINDOW w AS (...)`, `OVER w`, `OVER (w ORDER BY ...)`); window functions over aggregates
  (`rank() OVER (ORDER BY count(*))`). Errors match SQLite's.
- (M4) `WITH RECURSIVE`, evaluated like SQLite: a queue seeded by the initial SELECT, one row per recursive step,
  `UNION` de-duplication, `ORDER BY` in the CTE as a priority queue (breadth/depth-first traversals), `LIMIT`/`OFFSET`,
  several recursive SELECTs.
- `CREATE` / `DROP TABLE` (`IF [NOT] EXISTS`, `INTEGER PRIMARY KEY` rowid alias, `PRIMARY KEY`, `UNIQUE`, `NOT NULL`, `DEFAULT`,
  `CHECK`, `COLLATE`), `CREATE [UNIQUE] INDEX` (multi-column, `ASC`/`DESC`, collations), and `DROP INDEX`.
- `CREATE [TEMP] VIEW [IF NOT EXISTS] name [(columns)] AS select` and `DROP VIEW [IF EXISTS]` (M4). TEMP views exist for
  the connection only and shadow main views of the same name.
- (M7) `CREATE TEMP|TEMPORARY TABLE`: lives in the connection's memory store (no pages written to the file, even in an
  OPFS database), shadows a main table of the same name, takes indexes, and is gone when the database closes. Temp DDL
  and writes roll back with the transaction. `CREATE MATERIALIZED VIEW … WITH (location = 'memory')` keeps an MV's rows
  and indexes in memory and its definition in the file; it is recomputed when the database opens (ADR 0010).
- (M7) `CREATE TABLE t(…) WITH (storage = 'columnar')`: a columnar table (column segments with zone maps, plus a
  row delta store and deletions; full DML). Analytics scans are several times faster; point lookups are slower.
  `PRAGMA compact(t)` rewrites its segments. No secondary indexes, UNIQUE constraints (other than INTEGER PRIMARY
  KEY), foreign keys or ALTER TABLE yet. `storage = 'row'` is the default.
- `x [NOT] IN table` / `x IN f(args)`: SQLite's shorthand for `x IN (SELECT * FROM …)`. As in SQLite, a view's body is
  resolved when the view is used, not when it is created, and views cannot be modified or indexed. Simple views and FROM
  subqueries (no aggregates, DISTINCT, LIMIT, ORDER BY, compound, window functions or subquery expressions) are flattened
  into the referencing query, so their tables join and use indexes like tables written out directly.
- `BEGIN` / `COMMIT` / `ROLLBACK`, `SAVEPOINT` / `RELEASE` / `ROLLBACK TO` (M2), with statement-level atomicity inside transactions.
- `EXPLAIN QUERY PLAN`, `EXPLAIN ANALYZE` (SELECT; estimated vs actual rows, loops and time per operator), and `ANALYZE [table]`
  (statistics in `smalt_stat`; M3); `PRAGMA table_info / index_list / index_info / page_size / page_count / freelist_count /
  schema_version / integrity_check / journal_mode / wal_checkpoint / work_mem / spill_bytes / compact / parallel_aggregates / matview_rewrite`. `PRAGMA matview_rewrite = 1` (per connection, off by default) answers queries from fresh materialized views when they provably can (ADR 0010, section 5); parallel readers use the connection's `work_mem` and `matview_rewrite` too; `PRAGMA work_mem = bytes`
  (default 256 MiB) is how much a sort or hash aggregate may hold before spilling to the scratch file `<db>-spill`;
  `spill_bytes` reports scratch bytes written since open (M7); `smalt_schema` (also `sqlite_schema` / `sqlite_master`).

**Type mapping (STRICT by default):** declared types map to storage types by SQLite's affinity rules. *INT* → INTEGER;
*CHAR*/*CLOB*/*TEXT* → TEXT; *BLOB* → BLOB; *REAL*/*FLOA*/*DOUB* → REAL; `ANY` or no type → ANY; anything else
(NUMERIC, DECIMAL, BOOLEAN, DATE, …) → NUMERIC, meaning ANY with numeric conversion of numeric-looking text. Values are converted
losslessly as SQLite STRICT tables do (`'5'` into an INTEGER column becomes 5), and anything else is rejected with
`cannot store TEXT value in INTEGER column t.c`.

**Not yet supported** (each gives a clear `SMALT_UNSUPPORTED` error): `USING` / `NATURAL` with `RIGHT` / `FULL` joins,
materialized views (M5), `ON CONFLICT` targets with WHERE, row-value assignments (`SET (a, b) = …`), `INCLUDE` columns, `WITHOUT ROWID`, `LOOSE` tables, generated columns, JSON
functions, and `VACUUM`. Plain `EXPLAIN` returns the `EXPLAIN QUERY PLAN` output (there is no bytecode to list).

**Known deviations:**
- Foreign keys are enforced by default (`PRAGMA foreign_keys` is 1); SQLite starts with 0.
- An integral REAL with magnitude below 2^53 stored in an `ANY`/`NUMERIC` column, or flowing through an untyped expression, reads back as
  INTEGER. This affects `typeof()`, text conversion and integer division (ADR 0003, decision 2). REALs outside ±2^53, such as int64-overflow
  results, are always treated as REAL, because smaltdb represents such integers as `bigint`.
- `AUTOINCREMENT` is accepted but behaves like a plain `INTEGER PRIMARY KEY` (the max rowid + 1 can be reused after deleting
  the largest row).
- PRIMARY KEY columns are always NOT NULL.
- `OR FAIL` behaves like `OR ABORT`.
- In `GROUP BY` / `DISTINCT` over NOCASE or RTRIM text, values that compare equal form one group, and which spelling is returned is unspecified.
  smaltdb returns the first row in scan order; SQLite returns the first in its own sort order, which can differ.
- Date/time: `'now'` (and `CURRENT_*`) is read once per statement execution, so every row of a query sees the same instant (SQLite
  guarantees this only within one `sqlite3_step()`). `unixepoch(…, 'subsec')` returns a REAL that reads back as INTEGER when it has no
  fractional part (the integral-REAL deviation above). Julian-day arithmetic is done in doubles, exact up to ±2^53 ms, so modifier chains whose
  intermediate values exceed that (e.g. `'+400000000000000 seconds', '-400000000000000 seconds'`) can be off by a few milliseconds where
  SQLite's int64 arithmetic is exact. Date functions are not rejected in CHECK constraints (SQLite rejects `'now'`
  and `'localtime'` there).
- Index keys must fit in about a quarter of a page (≈2 KB with 8 KiB pages); SQLite allows larger keys via overflow pages.
