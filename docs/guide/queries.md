# Queries

This page covers running SQL from JavaScript: `query`, `exec`, prepared statements and streams, parameters, the shape of results, how values map between JavaScript and SQL, and cancellation. Every method is on the `Database` that [`open()`](./databases) returns. The [client API reference](../reference/api/client) lists every signature.

## query, exec, prepare, stream

| Method | Runs | Returns |
|---|---|---|
| `db.query(sql, params?, options?)` | One statement | All result rows |
| `db.exec(sql, params?, options?)` | One statement with parameters, or a script of statements without | `{ changes, lastInsertRowid }` |
| `db.prepare(sql)` | Compiles one statement for repeated use | A `PreparedStatement` |
| `db.stream(sql, params?, options?)` | One statement | An async iterator over batches of rows |

### query

`query()` runs one statement and resolves to its rows. Rows are objects keyed by column name unless you ask for [another shape](#result-shapes):

```ts
const users = await db.query<{ id: number; name: string }>('SELECT id, name FROM users WHERE age > ?', [30]);
// [{ id: 1, name: 'Ada' }, …]
```

The type argument only describes the rows for TypeScript; nothing checks it at run time.

`query()` accepts any single statement. An `INSERT`, `UPDATE` or `DELETE` runs and returns its `RETURNING` rows, or `[]` without a `RETURNING` clause. Passing several statements fails with `SMALT_SYNTAX`.

### exec

`exec()` runs statements for their effect and resolves to a `RunResult`:

| Field | Type | Meaning |
|---|---|---|
| `changes` | `number` | Rows inserted, updated or deleted by the statement; `0` for any other statement, such as a `SELECT` |
| `lastInsertRowid` | `number` \| `bigint` | The rowid of the most recent successful `INSERT` on the engine's connection (an `UPDATE` or `DELETE` leaves it unchanged) |

```ts
const r = await db.exec('UPDATE users SET active = 0 WHERE last_seen < ?', ['2024-01-01']);
console.log(r.changes);
```

Without parameters, `exec()` accepts a script of several statements separated by `;` and runs them in order. Each statement commits on its own unless the script contains `BEGIN … COMMIT`. If a statement fails, the ones before it stay done and the rest do not run. For a script, `changes` is the count of the last `INSERT`, `UPDATE` or `DELETE` in it, or `0` if it has none.

```ts
await db.exec(`
  CREATE TABLE IF NOT EXISTS tags(id INTEGER PRIMARY KEY, name TEXT UNIQUE);
  INSERT OR IGNORE INTO tags(name) VALUES ('red'), ('green');
`);
```

With parameters, `exec()` runs exactly one statement; a script with parameters fails with `SMALT_MISUSE` ("parameters can only be bound with a single statement"). Rows of a `SELECT` run with `exec()` are discarded.

### Prepared statements

`prepare()` compiles a statement once. Run it many times with different parameters:

```ts
const find = await db.prepare('SELECT id, name FROM users WHERE email = ?');
console.log(find.columns, find.paramCount); // ['id', 'name'] 1

const rows = await find.query(['ada@example.com']);
await find.finalize();
```

| Member | Meaning |
|---|---|
| `columns` | Result column names (`[]` for statements without rows). |
| `paramCount` | The number of parameter slots. |
| `query(params?, options?)` | Run and return the rows, like `db.query`. |
| `stream(params?, options?)` | Run and stream the rows, like `db.stream`. |
| `run(params?, options?)` | Run for effect, like `db.exec`; returns `{ changes, lastInsertRowid }`. |
| `finalize()` | Free the statement in the engine. Afterwards, `query` and `run` reject with `SMALT_MISUSE`. |

Errors in the SQL, such as an unknown column, reject the `prepare()` call itself. A prepared statement stays valid when the schema changes: the engine compiles it again on its next run. Statements are kept by the engine worker until you finalize them or close the database. With [multi-tab access](./databases#multi-tab-access), a statement prepared before the owning tab changed rejects with `SMALT_RETRY`; prepare it again.

`db.query()` parses and plans its SQL on every call; a prepared statement does that once.

### Streaming

`stream()` returns an async iterator. Each step yields one **batch** of rows, in the chosen row shape:

```ts
for await (const rows of db.stream<{ id: number; body: string }>('SELECT id, body FROM log ORDER BY id', undefined, { batchSize: 500 })) {
  for (const row of rows) console.log(row.id, row.body);
}
```

The engine works ahead of your loop by at most `highWaterMark` batches (default 4), then pauses until you take more, so a large result never has to fit in memory at once. Leaving the loop early (`break`, `return` or an exception) closes the stream in the engine.

| Option | Default | Meaning |
|---|---|---|
| `batchSize` | `4096` | Rows per batch. |
| `highWaterMark` | `4` | Batches the engine may send before the consumer takes them. |
| `rowMode` | `'object'` | Shape of each batch (see [result shapes](#result-shapes)). |
| `signal` | | An `AbortSignal` that closes the stream. |

::: warning Writes while a stream is open
An open stream served by the owning engine worker keeps a read cursor open. While it is open, writes from the same tab fail at once with `SMALT_BUSY` ("cannot modify the database while a query cursor is open"), because waiting for your own stream would never end. Writes from other tabs wait until the stream ends. Reads go on. Finish or `break` out of the loop before you write.
:::

A stream served by a [parallel reader](./databases#parallel-readers) reads a snapshot and does not hold up writes.

## Result shapes

`rowMode` selects how rows come back from `query`, `stream` and `PreparedStatement.query`:

| `rowMode` | Result | Example for `SELECT id, name FROM t` |
|---|---|---|
| `'object'` (default) | An array of objects | `[{ id: 1, name: 'a' }]` |
| `'array'` | An array of value arrays, with a `columns` property | `[[1, 'a']]`, `.columns` is `['id', 'name']` |
| `'columnar'` | One array per column | `{ columns: ['id', 'name'], length: 1, data: { id: Float64Array [1], name: ['a'] } }` |

```ts
const arr = await db.query('SELECT id, name FROM t', undefined, { rowMode: 'array' });
console.log(arr.columns, arr[0]);

const cols = await db.query('SELECT id, price FROM t', undefined, { rowMode: 'columnar' });
console.log(cols.length, cols.data.price);
```

Notes:

- **Column names.** A column is named by its alias, or by the expression's text when it has none:

  ```sql
  SELECT 1 + 1, upper('a') AS u, count(*) FROM (SELECT 1);
  ```

  | 1 + 1 | u | count(*) |
  |---|---|---|
  | 2 | A | 1 |

- **Duplicate names in object rows.** When two columns have the same name, the later one wins: `SELECT 1 AS a, 2 AS a` gives `[{ a: 2 }]`. Use aliases or `rowMode: 'array'`.
- **Columnar data.** A column whose values are all numbers, with no NULL, is a `Float64Array`. Any other column, including one with a NULL, a `bigint`, text or blobs, is a plain array of values. An empty result gives empty `Float64Array`s.
- **Batches.** The engine always sends results in column batches of `batchSize` rows (numeric columns as transferred `Float64Array` buffers); the client builds the requested shape. `'columnar'` is the cheapest shape for large numeric results.

## Parameters

Never build SQL by joining strings with user input. Put placeholders in the SQL and pass the values separately.

| Placeholder | Example | Bind with |
|---|---|---|
| `?` | `WHERE a = ? AND b = ?` | An array, in order |
| `?NNN` | `WHERE a = ?1 OR b = ?1` | An array: `?1` is the first element |
| `:name`, `@name`, `$name` | `WHERE a = :a` | An object: `{ a: 1 }` (or `{ ':a': 1 }`) |

```ts
await db.query('SELECT * FROM t WHERE a = ? AND b = ?', [1, 'x']);
await db.query('SELECT * FROM t WHERE a = ?1 OR b = ?1', [5]);
await db.query('SELECT * FROM t WHERE a = :a AND b = @b', { a: 1, b: 'x' });
```

Rules:

- An array must have exactly as many values as the statement has parameter slots, or the call rejects with `SMALT_RANGE`. Named placeholders count as slots in order of first appearance, so an array also binds them.
- With an object, every named placeholder needs a key: a missing key (or a key whose value is `undefined`) rejects with `SMALT_RANGE`. Extra keys are ignored.
- An object binds named placeholders only. If the statement also has `?` or `?NNN` placeholders, binding it with an object rejects with `SMALT_RANGE`; bind it with an array instead.
- A statement without placeholders takes no parameters. Pass `undefined` (or leave the argument out); an empty array `[]` also works.

## Values

### From JavaScript to SQL

| JavaScript value | SQL value |
|---|---|
| `null`, `undefined` (in an array) | NULL |
| `number` with an integer value | INTEGER |
| other `number`, including `Infinity` and `-Infinity` | REAL |
| `NaN` | NULL, as in SQLite |
| `bigint` from −2^63 to 2^63 − 1 | INTEGER |
| `true`, `false` | INTEGER `1`, `0` |
| `string` | TEXT |
| `Uint8Array` | BLOB |
| other typed arrays and `DataView` | BLOB of their bytes |

A value is then converted to the column's type where the table's typing rules allow it, so `3` in a `REAL` column is stored as `3.0`, and `'7'` in an `INTEGER` column is stored as `7`. See [data types](../reference/sql/types).

The TypeScript type of parameters, `Params`, accepts these values: `SqlValue` (`null | number | bigint | string | Uint8Array`), `boolean`, and `undefined` in an array. Also:

- `undefined` as a value in an object counts as a missing value (`SMALT_RANGE`).
- A `bigint` outside the 64-bit range of INTEGER rejects with `SMALT_RANGE` ("integer … is out of range").
- `Date`, `ArrayBuffer` and other objects reject with `SMALT_MISMATCH` ("unsupported parameter type"). Pass dates as text (`date.toISOString()`) or numbers; wrap an `ArrayBuffer` in a `Uint8Array`.

```sql
SELECT typeof(2) AS a, typeof(2.5) AS b, typeof('x') AS c, typeof(x'00') AS d, typeof(NULL) AS e;
```

| a | b | c | d | e |
|---|---|---|---|---|
| integer | real | text | blob | null |

### From SQL to JavaScript

| SQL value | JavaScript value |
|---|---|
| NULL | `null` |
| INTEGER within ±(2^53 − 1) | `number` |
| INTEGER outside that range | `bigint` |
| REAL | `number` |
| TEXT | `string` |
| BLOB | `Uint8Array` |

```sql
SELECT 9007199254740991 AS safe, 9007199254740993 AS big, 2.0 AS real_two, x'cafe' AS bytes;
```

| safe | big | real_two | bytes |
|---|---|---|---|
| 9007199254740991 | 9007199254740993 | 2 | x'cafe' |

Here `safe` arrives as a `number` and `big` as a `bigint`. A REAL with an integral value, like `2.0`, is the `number` 2 in JavaScript: use `typeof()` in SQL if you need to tell INTEGER and REAL apart. Code that reads INTEGER columns which can hold large values should accept both `number` and `bigint`, for example with `BigInt(value)`.

There is no boolean type: comparisons give `1` or `0`.

```sql
SELECT 3 > 2 AS yes, 3 < 2 AS no;
```

| yes | no |
|---|---|
| 1 | 0 |

## Concurrency

Calls on one `Database` run in the engine worker one at a time, in the order the worker receives them. A few rules on top of that:

- `query()` and `stream()` calls do not wait for each other: start several and await them together with `Promise.all`. With [parallel readers](./databases#parallel-readers) they may run at the same time.
- `exec()`, `prepare()`, the import and export methods and `close()` wait for each other on the client, so they run in call order.
- While a [`db.transaction()`](./transactions) callback runs, every other call on the same `Database` and its prepared statements waits until it ends. Inside the callback, use the `tx` handle. See [transactions](./transactions#what-waits-for-a-transaction).

## Cancellation

`query`, `exec`, `stream`, and the prepared statement methods `query`, `stream` and `run` take an `AbortSignal` in `options.signal`:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 1000);
try {
  await db.query('SELECT count(*) FROM big a JOIN big b ON a.k = b.k', undefined, { signal: controller.signal });
} catch (e) {
  if ((e as { code?: string }).code === 'SMALT_INTERRUPT') console.log('cancelled');
  else throw e;
}
```

What aborting does depends on the state of the request:

| State | Effect |
|---|---|
| The signal is already aborted | The call rejects at once with `SMALT_INTERRUPT`. |
| Waiting behind other requests | It is removed and rejects with `SMALT_INTERRUPT`. |
| An open stream | The stream is closed; the next `next()` rejects with `SMALT_INTERRUPT`. |
| Fetching [external data](./external-data) | The fetches are aborted; the call rejects with `SMALT_INTERRUPT`. |
| Running, on a cross-origin isolated page, in the owning tab | The statement is interrupted and rolled back; the call rejects with `SMALT_INTERRUPT`. |
| Running, otherwise | The statement runs to the end and the call resolves normally. |

Interrupting a running statement uses a `SharedArrayBuffer` shared with the engine worker, which browsers allow only on [cross-origin isolated pages](./getting-started#browser-requirements). The engine checks it every few hundred page reads, so a statement stops shortly after the abort. An interrupted write changes nothing: it is rolled back like any failed statement.
