# SELECT

`SELECT` reads rows. This page also covers `VALUES`, common table expressions (`WITH`), joins, compound queries and the `WINDOW` clause.

## Syntax

```text
[WITH [RECURSIVE] cte [, cte ...]]
select-core
  [{UNION | UNION ALL | INTERSECT | EXCEPT} select-core ...]
[ORDER BY ordering-term [, ...]]
[LIMIT count [OFFSET skip] | LIMIT skip, count]

select-core:
    SELECT [DISTINCT | ALL] result-column [, ...]
      [FROM from-item]
      [WHERE condition]
      [GROUP BY expr [, ...]]
      [HAVING condition]
      [WINDOW name AS (window-spec) [, ...]]
  | VALUES (expr [, ...]) [, (expr [, ...]) ...]

result-column:
    *  |  table.*  |  expr [[AS] alias]

from-item:
    [schema.]table [[AS] alias] [INDEXED BY index | NOT INDEXED]
  | [schema.]function(arg [, ...] [, name => value ...]) [[AS] alias]
  | (select) [[AS] alias]
  | (from-item)
  | from-item join-operator from-item [ON condition | USING (column [, ...])]
  | from-item, from-item

join-operator:
    [NATURAL] [INNER | CROSS | LEFT [OUTER] | RIGHT [OUTER] | FULL [OUTER]] JOIN

cte:
    name [(column [, ...])] AS [[NOT] MATERIALIZED] (select)

ordering-term:
    expr [COLLATE collation] [ASC | DESC] [NULLS FIRST | NULLS LAST]
```

The examples on this page use these tables:

```sql
CREATE TABLE dept(id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE emp(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  dept_id INTEGER REFERENCES dept(id),
  salary INTEGER,
  boss_id INTEGER
);
INSERT INTO dept VALUES (1, 'Engineering'), (2, 'Operations'), (3, 'Legal');
INSERT INTO emp VALUES
  (1, 'Ann', 1, 100, NULL),
  (2, 'Bob', 1, 80, 1),
  (3, 'Cid', 2, 70, 1),
  (4, 'Dee', 2, NULL, 3),
  (5, 'Eve', NULL, 60, 1);
```

## Result columns

`*` selects every column of every table in `FROM`, and `table.*` every column of one table. Any other expression may have an alias; without one, the result column is named after the column, or after the expression's source text (see [column names](./#column-names-in-results)).

```sql
SELECT e.name, salary * 12 AS yearly, upper(name) FROM emp e WHERE id <= 2
```

| name | yearly | upper(name) |
| --- | --- | --- |
| Ann | 1200 | ANN |
| Bob | 960 | BOB |

`SELECT DISTINCT` removes duplicate rows (NULLs count as equal); `SELECT ALL` is the default. A `SELECT` without `FROM` returns one row.

```sql
SELECT DISTINCT dept_id FROM emp ORDER BY dept_id
```

| dept_id |
| --- |
| NULL |
| 1 |
| 2 |

Every table also has the hidden column `rowid` (also `oid` and `_rowid_`), unless a real column has that name. For a table with an `INTEGER PRIMARY KEY`, it is that column.

## FROM

### Tables, subqueries and functions

A table name may be qualified with `main` or `temp`. A subquery in parentheses can be used like a table. Table-valued functions such as `pragma_table_info('t')`, `read_csv('file:x.csv')` and `read_json(…)` take positional arguments followed by named ones (`name => value`); see [table-valued functions](../functions/table-valued).

```sql
SELECT d.name, s.total
FROM dept d
JOIN (SELECT dept_id, sum(salary) AS total FROM emp GROUP BY dept_id) AS s ON s.dept_id = d.id
ORDER BY d.id
```

| name | total |
| --- | --- |
| Engineering | 180 |
| Operations | 70 |

`INDEXED BY index` makes the query use that index for the table, and fails with `no query solution` when the index cannot be used. `NOT INDEXED` forbids indexes for the table. Both are hints for testing plans; normally the [planner](./explain) chooses.

### Joins

| Join | Rows |
| --- | --- |
| `[INNER] JOIN`, `CROSS JOIN`, `,` | pairs that satisfy `ON` / `USING` (all pairs without a condition) |
| `LEFT [OUTER] JOIN` | as inner, plus left rows without a match, padded with NULLs |
| `RIGHT [OUTER] JOIN` | as inner, plus right rows without a match |
| `FULL [OUTER] JOIN` | as inner, plus unmatched rows of both sides |

`USING (col, …)` joins on equal columns of the same name and shows each such column once in `*`. `NATURAL` is `USING` with every column name the two sides share.

```sql
SELECT e.name, d.name AS dept
FROM emp e LEFT JOIN dept d ON d.id = e.dept_id
ORDER BY e.id
```

| name | dept |
| --- | --- |
| Ann | Engineering |
| Bob | Engineering |
| Cid | Operations |
| Dee | Operations |
| Eve | NULL |

```sql
SELECT e.name, d.name AS dept
FROM emp e FULL JOIN dept d ON d.id = e.dept_id
WHERE e.id IS NULL OR d.id IS NULL
```

<!-- docs:unordered -->
| name | dept |
| --- | --- |
| Eve | NULL |
| NULL | Legal |

Not supported (each fails with `SMALT_UNSUPPORTED`):

- `USING` or `NATURAL` with `RIGHT` or `FULL` joins. Write the condition with `ON` instead.
- A `LEFT JOIN` whose right side is a parenthesized join, as in `a LEFT JOIN (b JOIN c ON …) ON …`. Inner joins of a parenthesized join work.

<!-- docs:error SMALT_UNSUPPORTED -->
```sql
SELECT * FROM emp FULL JOIN dept USING (id)
```

## WHERE

`WHERE` keeps the rows for which the condition is true (not false and not NULL). See [Expressions](./expressions) for operators, subqueries, `IN`, `EXISTS` and `LIKE`.

```sql
SELECT name FROM emp WHERE salary BETWEEN 65 AND 90 AND name LIKE '%o%'
```

| name |
| --- |
| Bob |

## GROUP BY and HAVING

`GROUP BY` puts rows with equal values (NULLs equal) in one group and computes [aggregate functions](../functions/aggregate) per group. A group term can also be a result column's alias or its position (`GROUP BY 1`). `HAVING` filters groups. Without `GROUP BY`, an aggregate query returns exactly one row.

```sql
SELECT dept_id, count(*) AS n, sum(salary) AS total, avg(salary) AS avg
FROM emp
GROUP BY dept_id
HAVING count(*) > 1
ORDER BY dept_id
```

| dept_id | n | total | avg |
| --- | --- | --- | --- |
| 1 | 2 | 180 | 90 |
| 2 | 2 | 70 | 70 |

Aggregates accept `DISTINCT` and a `FILTER (WHERE …)` clause:

```sql
SELECT count(*) FILTER (WHERE salary >= 80) AS high, count(DISTINCT dept_id) AS depts FROM emp
```

| high | depts |
| --- | --- |
| 2 | 2 |

As in SQLite, a column that is neither grouped nor aggregated takes its value from some row of the group; with a single `min()` or `max()`, from the row that holds the minimum or maximum.

```sql
SELECT name, max(salary) FROM emp
```

| name | max(salary) |
| --- | --- |
| Ann | 100 |

`ORDER BY` inside an aggregate's arguments (`group_concat(x, ',' ORDER BY y)`) is parsed but not supported (`SMALT_UNSUPPORTED`).

## WINDOW and OVER

A [window function](../functions/window) call has an `OVER` clause. Named windows are defined in the `WINDOW` clause, and a window specification may start from a named one.

```text
function(args) [FILTER (WHERE cond)] OVER (window-spec)
function(args) [FILTER (WHERE cond)] OVER window-name

window-spec:
  [base-window-name]
  [PARTITION BY expr [, ...]]
  [ORDER BY ordering-term [, ...]]
  [{ROWS | RANGE | GROUPS} {frame-bound | BETWEEN frame-bound AND frame-bound}
     [EXCLUDE {NO OTHERS | CURRENT ROW | GROUP | TIES}]]

frame-bound:
  UNBOUNDED PRECEDING | expr PRECEDING | CURRENT ROW | expr FOLLOWING | UNBOUNDED FOLLOWING
```

```sql
SELECT name, dept_id,
  rank() OVER w AS rnk,
  sum(salary) OVER (w ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
FROM emp
WHERE dept_id IS NOT NULL
WINDOW w AS (PARTITION BY dept_id ORDER BY salary DESC)
ORDER BY dept_id, rnk
```

| name | dept_id | rnk | running |
| --- | --- | --- | --- |
| Ann | 1 | 1 | 100 |
| Bob | 1 | 2 | 180 |
| Cid | 2 | 1 | 70 |
| Dee | 2 | 2 | 70 |

`DISTINCT` is not allowed in a window function call.

## ORDER BY

Rows come back in no particular order unless `ORDER BY` is given. Each term is an expression, a result column's alias, or a 1-based result column position, optionally with a collation, `ASC` (default) or `DESC`, and `NULLS FIRST` or `NULLS LAST`. By default NULLs sort first in ascending order and last in descending order, as in SQLite.

```sql
SELECT name, salary FROM emp ORDER BY salary DESC NULLS FIRST, name
```

| name | salary |
| --- | --- |
| Dee | NULL |
| Ann | 100 |
| Bob | 80 |
| Cid | 70 |
| Eve | 60 |

## LIMIT and OFFSET

`LIMIT n` returns at most n rows; a negative limit means no limit. `OFFSET m` skips m rows first. SQLite's `LIMIT m, n` form means `LIMIT n OFFSET m`. Both take any constant expression or a parameter.

```sql
SELECT name FROM emp ORDER BY id LIMIT 2 OFFSET 1
```

| name |
| --- |
| Bob |
| Cid |

```sql
SELECT name FROM emp ORDER BY id LIMIT 3, 1
```

| name |
| --- |
| Dee |

## Compound queries

`UNION` (without duplicates), `UNION ALL`, `INTERSECT` and `EXCEPT` combine queries with the same number of columns. They are evaluated left to right with equal precedence. `ORDER BY` and `LIMIT` apply to the whole compound; its `ORDER BY` terms refer to the result columns, named after the first query.

```sql
SELECT dept_id AS d FROM emp
UNION
SELECT id FROM dept
ORDER BY d DESC
```

| d |
| --- |
| 3 |
| 2 |
| 1 |
| NULL |

```sql
SELECT id FROM dept EXCEPT SELECT dept_id FROM emp
```

| id |
| --- |
| 3 |

## VALUES

`VALUES` is a query on its own, or the source of a subquery or `INSERT`. Its columns are named `column1`, `column2`, …; every row must have the same number of values.

```sql
VALUES (1, 'one'), (2, 'two')
```

| column1 | column2 |
| --- | --- |
| 1 | one |
| 2 | two |

```sql
SELECT v.column2 AS word FROM (VALUES (1, 'one'), (2, 'two')) AS v WHERE v.column1 = 2
```

| word |
| --- |
| two |

## WITH (common table expressions)

`WITH` names subqueries for one statement. A CTE may list its column names; otherwise they come from its query. `MATERIALIZED` and `NOT MATERIALIZED` are accepted as hints and do not change results. `WITH` can also prefix [`INSERT … SELECT`](./insert#with), [`UPDATE`](./update) and [`DELETE`](./delete).

```sql
WITH totals(dept_id, total) AS (
  SELECT dept_id, sum(salary) FROM emp GROUP BY dept_id
)
SELECT d.name, t.total FROM totals t JOIN dept d ON d.id = t.dept_id ORDER BY t.total DESC
```

| name | total |
| --- | --- |
| Engineering | 180 |
| Operations | 70 |

### WITH RECURSIVE

A recursive CTE is an initial `SELECT`, then `UNION` or `UNION ALL`, then one or more `SELECT`s that read the CTE itself. It runs as in SQLite: each row produced is fed back to the recursive part until no new rows come out. `UNION` drops rows already produced; `LIMIT` stops the recursion; an `ORDER BY` in the CTE decides which queued row is processed next.

```sql
WITH RECURSIVE chain(id, name, depth) AS (
  SELECT id, name, 0 FROM emp WHERE boss_id IS NULL
  UNION ALL
  SELECT e.id, e.name, chain.depth + 1 FROM emp e JOIN chain ON e.boss_id = chain.id
)
SELECT name, depth FROM chain ORDER BY depth, name
```

| name | depth |
| --- | --- |
| Ann | 0 |
| Bob | 1 |
| Cid | 1 |
| Eve | 1 |
| Dee | 2 |

```sql
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT 5)
SELECT group_concat(i) AS seq FROM n
```

| seq |
| --- |
| 1,2,3,4,5 |

## Differences from SQLite

- `RIGHT` and `FULL` joins are supported, but not with `USING` or `NATURAL`.
- `ORDER BY` inside aggregate arguments is not supported.
- Row values (`(a, b) = (1, 2)`) are a syntax error.
- A double-quoted name that matches no column is an error, never a string.
- An integral REAL computed in an expression can come back as an INTEGER in some cases; see [Data types](./types#real).
