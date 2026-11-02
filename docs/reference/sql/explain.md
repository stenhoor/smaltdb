# EXPLAIN and ANALYZE

`EXPLAIN QUERY PLAN` shows how a query will run, `EXPLAIN ANALYZE` runs it and measures each step, and `ANALYZE` gathers the statistics the planner uses. For how to read plans and tune queries, see [Indexes and performance](../../guide/indexes-and-performance).

## Syntax

```text
EXPLAIN [QUERY PLAN] select
EXPLAIN ANALYZE select
ANALYZE [schema | [schema.]table-or-index]
```

The examples use this table:

```sql
CREATE TABLE visit(id INTEGER PRIMARY KEY, page TEXT, ms INTEGER);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT 2000)
INSERT INTO visit SELECT i, '/p' || (i % 500), i % 300 FROM n;
CREATE INDEX visit_page ON visit(page);
```

## EXPLAIN QUERY PLAN

Returns the plan as rows, one per operator, without running the query.

| Column | Meaning |
| --- | --- |
| `id` | operator number |
| `parent` | `id` of the operator this one feeds (0 for the top) |
| `notused` | always 0 (SQLite compatibility) |
| `detail` | what the operator does |

```sql
EXPLAIN QUERY PLAN SELECT * FROM visit WHERE page = '/p7'
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SEARCH visit USING INDEX visit_page (=?) |

```sql
EXPLAIN QUERY PLAN SELECT * FROM visit WHERE id = 42
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SEARCH visit USING INTEGER PRIMARY KEY (rowid=?) |

```sql
EXPLAIN QUERY PLAN SELECT page, count(*) FROM visit WHERE ms > 100 GROUP BY page
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SCAN visit (fused scan + filter + GROUP BY) |

```sql
EXPLAIN QUERY PLAN SELECT * FROM visit ORDER BY ms LIMIT 5
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | USE TEMP B-TREE FOR ORDER BY |
| 2 | 1 | 0 | SCAN visit (fused scan + filter) |

Detail texts follow SQLite's where they can (`SCAN`, `SEARCH … USING INDEX`, `USING COVERING INDEX`, `USE TEMP B-TREE FOR ORDER BY`) and add smaltdb operators such as `MATERIALIZE` and the fused scan pipelines. The exact texts may change between versions; do not parse them.

Plain `EXPLAIN` returns the same rows as `EXPLAIN QUERY PLAN`; there is no bytecode to list.

## EXPLAIN ANALYZE

Runs the query, discards its rows, and returns the plan with measurements.

| Column | Meaning |
| --- | --- |
| `id`, `parent`, `detail` | as in `EXPLAIN QUERY PLAN` |
| `est_rows` | the planner's estimate of the rows the operator produces (NULL where it has none) |
| `loops` | how many times the operator was started |
| `rows` | rows it actually produced |
| `time_ms` | time spent in it and its inputs, in milliseconds |

```sql
EXPLAIN ANALYZE SELECT * FROM visit WHERE page = '/p7'
```

A run of this example gave (times vary):

```text
id | parent | detail                                   | est_rows | loops | rows | time_ms
 1 |      0 | PROJECT                                  | NULL     |     1 |    4 | 0.815
 2 |      1 | SEARCH visit USING INDEX visit_page (=?) | 4        |     1 |    4 | 0.696
```

`EXPLAIN ANALYZE` is a smaltdb extension; SQLite has no equivalent statement. `EXPLAIN ANALYZE name` without a query is `EXPLAIN` of the statement `ANALYZE name`, which is not supported (see below).

## Only SELECT

`EXPLAIN` of anything other than a `SELECT` (or `VALUES` / `WITH … SELECT`) fails with `SMALT_UNSUPPORTED`.

<!-- docs:error SMALT_UNSUPPORTED -->
```sql
EXPLAIN QUERY PLAN UPDATE visit SET ms = 0 WHERE id = 1
```

## ANALYZE

`ANALYZE` counts rows, distinct values and NULLs per column and per index, and stores them. The cost-based planner uses them to choose indexes and join orders. Without them it estimates from the size of the B+trees and from a sample of the table.

| Form | Analyzes |
| --- | --- |
| `ANALYZE` or `ANALYZE main` | every table and row-storage materialized view in the database |
| `ANALYZE [main.]table` | one table (or materialized view) |
| `ANALYZE [main.]index` | the table the index belongs to |

TEMP tables and columnar tables and views are skipped, so `ANALYZE temp`, `ANALYZE temp.t` and `ANALYZE` of a TEMP table's index do nothing. An unknown name fails with `no such table or index: x` (`no such table or index: main.x` when qualified), and an unknown schema with `unknown database x`.

```sql
ANALYZE visit;
SELECT tbl, idx FROM smalt_stat ORDER BY idx
```

| tbl | idx |
| --- | --- |
| visit | NULL |
| visit | visit_page |

The statistics are kept in the internal table `smalt_stat` (readable, but its format is internal and may change). Statistics are not updated automatically: run `ANALYZE` again after large changes. `ALTER TABLE` deletes a table's statistics.

## VACUUM

`VACUUM` is parsed but not supported (`SMALT_UNSUPPORTED`). Freed pages are reused for new data, but the file does not shrink. [`PRAGMA freelist_count`](./pragmas#page-size-page-count-freelist-count) shows how many pages are free.
