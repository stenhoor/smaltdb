# SQL reference

smaltdb speaks a dialect of SQLite's SQL. Most SQLite statements and expressions work unchanged; the differences are listed on each statement's page and collected in [Differences from SQLite](../../guide/sqlite-differences).

This page covers the lexical structure: how the text of a statement is split into literals, identifiers, keywords, parameters and comments. The statements are listed at the end.

## Statements and scripts

A script is a list of statements separated by `;`. Empty statements (`;;`) are skipped, and the last statement does not need a `;`. Each statement runs on its own: in autocommit mode every statement is its own transaction (see [Transactions](./transactions)).

```sql
CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT);
INSERT INTO notes(body) VALUES ('first');;
SELECT * FROM notes
```

| id | body |
| --- | --- |
| 1 | first |

A syntax error reports SQLite's message plus the position, for example `near "FORM": syntax error (line 1, column 10)`, with the error code `SMALT_SYNTAX`.

<!-- docs:skip -->
```sql
SELECT * FORM notes
```

## Comments

| Form | Ends at |
| --- | --- |
| `-- text` | the end of the line |
| `/* text */` | the closing `*/`, or the end of the input when there is none |

Block comments do not nest.

```sql
SELECT 1 /* inline */ + 1 AS two -- trailing comment
```

| two |
| --- |
| 2 |

## Literals

| Literal | Examples | Value |
| --- | --- | --- |
| Integer | `42`, `-7`, `0x1F` | INTEGER |
| Real | `1.5`, `.5`, `1e3`, `2.5E-3` | REAL |
| String | `'text'`, `'it''s'` | TEXT; a quote inside is written twice |
| Blob | `x'CAFE'`, `X'00ff'` | BLOB; an even number of hex digits |
| `NULL` | `NULL` | NULL |
| `TRUE`, `FALSE` | `TRUE` | the integers 1 and 0 |
| `CURRENT_DATE`, `CURRENT_TIME`, `CURRENT_TIMESTAMP` | | the current UTC date and time as text (see [date and time functions](../functions/datetime)) |

```sql
SELECT 42 AS i, 0x1F AS hex, 1e3 AS r, 'it''s' AS s, x'CAFE' AS b, TRUE AS t, typeof(1.0) AS ty
```

| i | hex | r | s | b | t | ty |
| --- | --- | --- | --- | --- | --- | --- |
| 42 | 31 | 1000 | it's | x'cafe' | 1 | real |

Integers are 64-bit. A decimal integer literal outside the 64-bit range becomes a REAL, as in SQLite. A hexadecimal literal is read as a 64-bit two's complement number, so `0xFFFFFFFFFFFFFFFF` is -1; one larger than 64 bits is a syntax error (`hex literal too big`).

```sql
SELECT 0xFFFFFFFFFFFFFFFF AS hex, typeof(9223372036854775807) AS max_int, typeof(9223372036854775808) AS beyond
```

| hex | max_int | beyond |
| --- | --- | --- |
| -1 | integer | real |

Integers beyond ±(2<sup>53</sup>−1) reach JavaScript as `bigint`; see [Data types](./types#integers).

Digit separators (`1_000`) are not supported. Double-quoted text is an identifier, never a string: SQLite's fallback that treats an unknown `"name"` as a string literal does not exist in smaltdb.

<!-- docs:error SMALT_ERROR -->
```sql
SELECT "hello"
```

The message is `no such column: "hello" - should this be a string literal in single-quotes?`.

## Identifiers

An identifier names a table, column, index, view or other object.

| Form | Example |
| --- | --- |
| Plain | `orders`, `_tmp`, `total$2` (letters, digits, `_`, `$`; not starting with a digit; any non-ASCII character counts as a letter) |
| Double quotes | `"order items"`, `"say ""hi"""` (a quote inside is written twice) |
| Square brackets | `[order items]` |
| Backticks | `` `order items` `` |

Names are matched without regard to ASCII case, as in SQLite: `Orders`, `ORDERS` and `"orders"` are the same table. The spelling used in `CREATE` is kept for display.

```sql
CREATE TABLE "Order Items"(qty INTEGER);
INSERT INTO [order items] VALUES (3);
SELECT `QTY` FROM "ORDER ITEMS"
```

| QTY |
| --- |
| 3 |

Names that start with `smalt_` or `sqlite_` are reserved for the engine; creating such an object fails with `object name reserved for internal use`.

### Keywords

These keywords are reserved: to use one as a name, quote it (`"order"` works, `order` does not).

`ADD` `ALL` `ALTER` `AND` `AS` `AUTOINCREMENT` `BETWEEN` `CASE` `CAST` `CHECK` `COLLATE` `COMMIT` `CONSTRAINT` `CREATE` `CROSS` `CURRENT_DATE` `CURRENT_TIME` `CURRENT_TIMESTAMP` `DEFAULT` `DEFERRABLE` `DELETE` `DISTINCT` `DROP` `ELSE` `ESCAPE` `EXCEPT` `EXISTS` `FALSE` `FOREIGN` `FROM` `FULL` `GLOB` `GROUP` `HAVING` `IN` `INDEX` `INDEXED` `INNER` `INSERT` `INTERSECT` `INTO` `IS` `ISNULL` `JOIN` `LEFT` `LIKE` `LIMIT` `NATURAL` `NOT` `NOTNULL` `NULL` `ON` `OR` `ORDER` `OUTER` `PRIMARY` `REFERENCES` `RETURNING` `RIGHT` `SELECT` `SET` `TABLE` `THEN` `TO` `TRANSACTION` `TRUE` `UNION` `UNIQUE` `UPDATE` `USING` `VALUES` `WHEN` `WHERE`

All other keywords (`ACTION`, `BEGIN`, `KEY`, `REPLACE`, `TEMP`, `VIEW`, `WITH`, …) can be used as plain names where the grammar is not ambiguous, as in SQLite. `CONNECTION`, `EXTERNAL` and `CHANGED` are not keywords at all; they only have meaning in [external table](./external) and [`REFRESH`](./views#refresh-materialized-view) statements.

<!-- docs:skip -->
```sql
CREATE TABLE order(id INTEGER)
```

```sql
CREATE TABLE "order"(id INTEGER, key TEXT, action TEXT);
SELECT name FROM pragma_table_info('order')
```

| name |
| --- |
| id |
| key |
| action |

## Parameters

A statement can contain parameters, whose values are bound when it runs (see [Queries](../../guide/queries)).

| Form | Slot |
| --- | --- |
| `?` | the next slot (one more than the highest so far) |
| `?NNN` | slot NNN, from 1 to 32766 |
| `:name`, `@name`, `$name` | a slot assigned on first use; the same name reuses it |

Values are bound from an array, by slot, or from an object whose keys are the names without the prefix (`{ name: 1 }` binds `:name`, `@name` and `$name`). An array must have exactly as many values as the highest slot, otherwise the statement fails with `SMALT_RANGE` (`statement expects 2 parameter(s), got 3`). With an object, every named parameter needs a key (`missing value for parameter :name`); extra keys are ignored.

```ts
const rows = await db.query('SELECT ? + ?2 AS a, :x AS b', [1, 2, 'third']);
const same = await db.query('SELECT :x AS x, @x AS again', { x: 5 });
```

## Column names in results

A result column is named by its alias (`AS name`, or an alias without `AS`). Without one, a column reference gets the column's name and any other expression gets its source text exactly as written, as in SQLite.

```sql
SELECT 1+1, 1 + 1 AS two, upper('a')
```

| 1+1 | two | upper('a') |
| --- | --- | --- |
| 2 | 2 | A |

## Statements

| Statement | Page |
| --- | --- |
| `SELECT`, `VALUES`, `WITH` | [SELECT](./select) |
| `INSERT`, `REPLACE` | [INSERT](./insert) |
| `UPDATE` | [UPDATE](./update) |
| `DELETE` | [DELETE](./delete) |
| `CREATE [TEMP] TABLE` | [CREATE TABLE](./create-table) |
| `ALTER TABLE` | [ALTER TABLE](./alter-table) |
| `DROP TABLE`, `DROP INDEX`, `DROP VIEW`, `DROP MATERIALIZED VIEW`, `DROP EXTERNAL TABLE`, `DROP CONNECTION` | [DROP](./drop) |
| `CREATE [UNIQUE] INDEX` | [CREATE INDEX](./create-index) |
| `CREATE VIEW`, `CREATE MATERIALIZED VIEW`, `REFRESH MATERIALIZED VIEW` | [Views](./views) |
| `CREATE CONNECTION`, `CREATE EXTERNAL TABLE` | [External tables](./external) |
| `BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`, `RELEASE` | [Transactions](./transactions) |
| `EXPLAIN`, `EXPLAIN QUERY PLAN`, `EXPLAIN ANALYZE`, `ANALYZE` | [EXPLAIN and ANALYZE](./explain) |
| `PRAGMA` | [PRAGMA](./pragmas) |

Expressions, operators and `CAST` are described in [Expressions](./expressions), and values and column types in [Data types](./types). The catalog views are in [information_schema](./information-schema), and the functions in the [function reference](../functions/).

### Not supported

These statements are rejected:

| Statement | Result |
| --- | --- |
| `CREATE TRIGGER` | syntax error (`SMALT_SYNTAX`) |
| `DROP TRIGGER` | `SMALT_UNSUPPORTED` |
| `ATTACH`, `DETACH` | syntax error |
| `REINDEX` | syntax error |
| `VACUUM` | parsed, then `SMALT_UNSUPPORTED` |
| `CREATE VIRTUAL TABLE` | syntax error |

<!-- docs:error SMALT_UNSUPPORTED -->
```sql
VACUUM
```
