# Import and export

The `@smaltdb/io` [plugin](./plugins) loads CSV and JSON into tables and writes query results out as CSV or JSON. The work happens inside the engine: the client sends the file's bytes once, and rows never cross to the page one by one.

The plugin's client module, `@smaltdb/io/client`, exports four helpers. Each takes the database as its first argument:

| Helper | Does |
|---|---|
| [`importCSV(db, table, source, options?)`](#importcsv) | Insert CSV records into a table |
| [`importJSON(db, table, source, options?)`](#importjson) | Insert a JSON array or NDJSON into a table |
| [`exportCSV(db, sql, params?, options?)`](#exportcsv) | Run a query and return CSV text |
| [`exportJSON(db, sql, params?, options?)`](#exportjson) | Run a query and return JSON or NDJSON text |

`db` is a client `Database` (from `smaltdb`) or an engine `Database` (from `smaltdb/engine`). Either way, the engine must have the plugin installed.

To query a CSV, JSON or Parquet file without importing it, see [external data](./external-data).

## Installing the plugin

```sh
npm install smaltdb @smaltdb/io
```

`@smaltdb/io` has no dependencies. It also provides the CSV, TSV and JSON formats and `read_csv()` / `read_json()` for [external data](./external-data).

In the browser, install it in the engine worker. Write a worker entry that serves the engine with the plugin:

```ts
// db-worker.ts
import { serve } from 'smaltdb/worker-runtime';
import io from '@smaltdb/io';

serve({ plugins: [io] });
```

Then open the database with that worker:

```ts
import { open } from 'smaltdb';
import { importCSV } from '@smaltdb/io/client';

const db = await open('app', {
  worker: () => new Worker(new URL('./db-worker.ts', import.meta.url), { type: 'module' }),
});
await importCSV(db, 'notes', 'body\nhello\n', { create: true });
```

With the in-process engine (Node, tests), pass the plugin to `Database.openMemory()` or `Database.open()`. See [In-process use](#in-process-use).

Without the plugin, every helper rejects with `SMALT_PLUGIN_MISSING`: `importCSV(): import and export needs the @smaltdb/io plugin (install it and add it to the engine's plugins)`. See [plugins](./plugins) for the details of worker entries.

The examples below assume an open `db` with the plugin installed.

## How imports work

Both imports:

- take the data as a `string`, `Uint8Array`, `ArrayBuffer`, or `Blob` (a `File` from an `<input type="file">` is a `Blob`). Bytes are decoded as UTF-8, and a leading byte order mark is skipped;
- insert with one prepared `INSERT` per row, in a single transaction. Every constraint, type conversion, default and foreign key applies, exactly as for `INSERT` statements;
- are all or nothing: if a row fails, every row of the import is rolled back and the call rejects. The error has the code of the underlying failure, and the message names the CSV line or JSON item, for example `CSV line 3: NOT NULL constraint failed: people.name`;
- resolve to `{ rows }`, the number of rows inserted.

If a transaction opened with SQL `BEGIN` is open, the import runs inside it, in a savepoint: if a row fails, the import's rows (and a table it created) are rolled back, the transaction stays open with your earlier statements, and it commits or rolls back with the rest of the transaction. Through the client, all four helpers wait for earlier `exec` calls and transactions of the same `Database`, as `exec` does. Do not call them inside a [`db.transaction()`](./transactions#what-waits-for-a-transaction) callback: they wait for the transaction to end.

Column names are matched to the table's columns without regard to case. Columns the data does not mention take their `DEFAULT` (or NULL).

## importCSV

```ts
import { importCSV } from '@smaltdb/io/client';

const file = (document.querySelector('input[type=file]') as HTMLInputElement).files![0];
const { rows } = await importCSV(db, 'people', file, { create: true });
console.log(`imported ${rows} rows`);
```

The parser follows RFC 4180: fields may be quoted, quoted fields may contain the delimiter, line breaks and doubled quotes (`""`), and lines may end with LF or CRLF. Blank lines are skipped.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `header` | `boolean` | `true` | The first record holds column names; fields are matched to columns by name. With `false`, fields map to the table's columns in order. |
| `columns` | `string[]` | | The target columns, in field order. Overrides the header (the header record is still skipped when `header` is `true`). |
| `delimiter` | `string` | `','` | Field separator: a single character. |
| `quote` | `string` | `'"'` | Quote character: a single character. |
| `emptyAsNull` | `boolean` | `true` | An unquoted empty field becomes NULL. A quoted empty field (`""`) is always an empty string. |
| `create` | `boolean` | `false` | Create the table if it does not exist. Needs column names from the header or `columns`. |

Each record must have as many fields as there are columns, or the import fails (`CSV line 2: expected 2 fields but found 1`). Header names are trimmed.

```ts
import { importCSV } from '@smaltdb/io/client';

// people(id INTEGER PRIMARY KEY, name TEXT, age REAL) exists
await importCSV(db, 'people', 'id,name,age\n1,"Lee, A",31\n2,Kim,\n3,"",4.5\n');
// rows: [1, 'Lee, A', 31], [2, 'Kim', null], [3, '', 4.5]

// No header, semicolons, fields in table order:
await importCSV(db, 'people', '4;Ng;20\n', { header: false, delimiter: ';' });

// Pick and order the target columns yourself:
await importCSV(db, 'people', 'Full name,Years\nBo,40\n', { columns: ['name', 'age'] });
```

**Values.** CSV fields are text. They are converted to each column's type as an `INSERT` would convert them: `'31'` into an `INTEGER` column becomes `31`, while `'x'` into a `REAL` column fails with `SMALT_CONSTRAINT_DATATYPE`. In `ANY` and `NUMERIC` columns, fields that look like numbers are stored as numbers and the rest as text.

**Creating the table.** With `create: true` and no table of that name, the import creates one first. Each column's type is inferred from all its values: `INTEGER` if every non-empty value is an integer, `REAL` if every one is a number, otherwise `TEXT` (also `TEXT` when the column is empty).

```ts
import { importCSV } from '@smaltdb/io/client';

await importCSV(db, 'scores', 'player,points,ratio\nann,12,0.5\nbob,7,\n', { create: true });
// CREATE TABLE "scores"("player" TEXT, "points" INTEGER, "ratio" REAL)
```

The created table has no primary key or constraints. Create the table yourself when you need them. The table is created in the import's transaction: if the import fails, the table is removed again with its rows.

## importJSON

```ts
import { importJSON } from '@smaltdb/io/client';

await importJSON(db, 'events', [
  '[',
  '  {"id": 1, "kind": "click", "ok": true, "tags": ["a", "b"]},',
  '  {"id": 2, "kind": "view", "meta": {"page": "/"}}',
  ']',
].join('\n'));
```

Accepted input:

- **A JSON array of objects.** Keys are matched to column names without regard to case. The columns are all keys seen in any object, in first-seen order; a key missing from one object takes the column's `DEFAULT` for that row.
- **A JSON array of arrays.** Values map to the table's columns in order, or to `columns`. Each array must have that many values.
- **NDJSON**: one JSON value per line (objects or arrays as above). Blank lines are skipped. Input that does not start with `[` is read as NDJSON.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `columns` | `string[]` | the table's columns | Target columns for arrays of arrays. |
| `create` | `boolean` | `false` | Create the table if it does not exist, with types inferred from the values. For arrays of arrays it needs `columns`. |

**Values.**

| JSON | SQL |
|---|---|
| `null` | NULL |
| number | An integer written without fraction or exponent is INTEGER if it fits in 64 bits, exactly, also beyond 2^53; beyond 64 bits it is REAL, as in SQLite. Another number is INTEGER if it has an integer value below 2^53 in magnitude (so `1.0` is `1`), else REAL. Then converted to the column's type |
| string | TEXT, then converted to the column's type |
| `true` / `false` | `1` / `0` |
| array or object | TEXT holding its JSON |

Input with a run of 16 or more digits (an integer that `JSON.parse` could round) is read by a slower parser that keeps such integers exact; other input goes through `JSON.parse` alone. Nested arrays and objects keep their exact integers in the stored JSON text.

```ts
import { importJSON } from '@smaltdb/io/client';

await importJSON(db, 'events', '{"id": 3, "kind": "click"}\n{"id": 4, "kind": "view"}\n'); // NDJSON
await importJSON(db, 'events', '[[5, "click"]]', { columns: ['id', 'kind'] }); // arrays
```

Mixing objects and arrays in one input fails with `SMALT_ERROR`, as does any other kind of item. The message names the first offending item, for example `JSON item 1: expected an object or an array, found a number (…)` for `[1, 2]`, or `JSON item 3: expected an object like JSON item 1, found an array (…)`.

## exportCSV

```ts
import { exportCSV } from '@smaltdb/io/client';

const csv = await exportCSV(db, 'SELECT id, name, age FROM people WHERE age > ? ORDER BY id', [30]);
// 'id,name,age\n1,"Lee, A",31.0\n'
```

| Option | Type | Default | Meaning |
|---|---|---|---|
| `header` | `boolean` | `true` | Write the column names as the first line. |
| `delimiter` | `string` | `','` | Field separator. |
| `nullString` | `string` | `''` | Text written for NULL. |
| `crlf` | `boolean` | `false` | End lines with CRLF instead of LF. |

Output rules:

- Every line, including the last, ends with a line break. An empty result gives just the header line, or `''` without a header.
- A field is quoted when it contains the delimiter, a quote, a line break, or leading or trailing whitespace. Quotes inside are doubled.
- Values of `REAL` columns and expressions print with a decimal point, as in SQLite: `31.0`, `2.0`.
- Integers print exactly, also beyond 2^53. Blobs print as uppercase hex (`00FF`).

```ts
import { exportCSV } from '@smaltdb/io/client';

const text = await exportCSV(db, 'SELECT id, age FROM people', undefined, { header: false, delimiter: ';', nullString: 'NULL', crlf: true });
```

To let the user save the file:

```ts
import { exportCSV } from '@smaltdb/io/client';

const csv = await exportCSV(db, 'SELECT * FROM people');
const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
Object.assign(document.createElement('a'), { href: url, download: 'people.csv' }).click();
URL.revokeObjectURL(url);
```

## exportJSON

```ts
import { exportJSON } from '@smaltdb/io/client';

const json = await exportJSON(db, 'SELECT id, name, age FROM people ORDER BY id');
// '[{"id":1,"name":"Lee, A","age":31.0},{"id":2,"name":"Kim","age":null}, …]'
```

| Option | Type | Default | Meaning |
|---|---|---|---|
| `format` | `'array'` \| `'ndjson'` | `'array'` | `'array'`: one JSON array of objects. `'ndjson'`: one object per line, each line ending with `\n`. |

Output rules:

- Keys are the column names. NULL is `null`.
- `REAL` values print with a decimal point (`31.0`). NaN and infinities are written as `null`.
- Integers are written with all their digits, also beyond 2^53. JSON allows that, but `JSON.parse` in JavaScript rounds such numbers.
- Blobs are written as strings of uppercase hex.
- An empty result is `[]`, or `''` for NDJSON.

## Exports and parameters

`exportCSV` and `exportJSON` take `params` like [`query`](./queries#parameters). The export runs one statement; any `SELECT` works, including joins, aggregates and queries over [external data](./external-data).

## In-process use

The helpers work the same with the in-process engine. Install the plugin when you open the database:

```ts
import { Database } from 'smaltdb/engine';
import io from '@smaltdb/io';
import { importCSV, exportJSON } from '@smaltdb/io/client';

const db = Database.openMemory({ plugins: [io] });
await importCSV(db, 'p', 'a,b\n1,2\n', { create: true }); // { rows: 1 }
console.log(await exportJSON(db, 'SELECT * FROM p')); // [{"a":1,"b":2}]
```

They return promises here too. Exports over [external data](./external-data) fetch their sources first, as `queryAsync()` does.

## Calling the plugin directly

The helpers are thin wrappers over `db.callPlugin()`. `importCSV(db, table, source, options)` is the same as:

```ts
declare const source: string;
await db.callPlugin('@smaltdb/io', 'importCSV', ['people', source, { create: true }], { lock: true });
```

The methods are `importCSV`, `importJSON`, `exportCSV` and `exportJSON`, with the helpers' arguments after `db`. Use the helpers: they carry the types. See [Writing plugins](../reference/api/plugins#calling-plugin-methods).
