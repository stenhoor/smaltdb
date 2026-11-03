# Plugins

The `smaltdb` package is the core engine. It has no runtime dependencies and contains only smaltdb's own code.
Optional features ship as separate plugin packages ([ADR 0012](../adr/0012-plugins)). An application installs only the
plugins it uses.

| Package | Provides | Depends on |
|---|---|---|
| `@smaltdb/io` | The CSV, TSV, JSON and NDJSON formats for [external data](./external-data); `read_csv()` and `read_json()`; [import and export](./import-export) with `importCSV`, `importJSON`, `exportCSV` and `exportJSON` from `@smaltdb/io/client` | Nothing |
| `@smaltdb/external` | Where [external data](./external-data) is read from: registered files (`file:<name>`), `http://` and `https://` URLs, S3 (`s3://`), Azure Blob Storage (`az://`, `azure://`) and, in Node, local paths. The connection types `http` (also `https`), `s3` and `azure`. `registerFile`, `registerCredentials` and `setFetch` from `@smaltdb/external/client` | Nothing |
| `@smaltdb/parquet` | The Parquet format; `read_parquet()` | `hyparquet`; optionally `hyparquet-compressors` |

Reading external data needs a format and a source. `read_csv('file:prices.csv')` needs `@smaltdb/io` for the format and
`@smaltdb/external` for `file:`. `read_parquet('https://…')` needs `@smaltdb/parquet` and `@smaltdb/external`.

Plugins run inside the engine. In the browser, that is the engine worker, so you install a plugin by giving the
worker an entry script that lists your plugins.

## Installing plugins in the browser

1. Install the plugins next to smaltdb:

   ```sh
   npm install smaltdb @smaltdb/io @smaltdb/external @smaltdb/parquet
   ```

   For Parquet files compressed with gzip, zstd, brotli or LZ4, also install `hyparquet-compressors`. Snappy and
   uncompressed files need nothing more.

2. Write an engine worker entry that serves the engine with your plugins:

   <!-- docs:plugin @smaltdb/parquet -->
   ```ts
   // db-worker.ts
   import { serve } from 'smaltdb/worker-runtime';
   import io from '@smaltdb/io';
   import external from '@smaltdb/external';
   import parquet from '@smaltdb/parquet';

   serve({ plugins: [io, external, parquet] });
   ```

3. Open the database with that worker:

   ```ts
   import { open } from 'smaltdb';

   const db = await open('app', {
     worker: () => new Worker(new URL('./db-worker.ts', import.meta.url), { type: 'module' }),
   });
   ```

Write the `worker` option as a function that creates the worker:
- **Bundlers find the worker.** Bundlers recognise `new Worker(new URL(…, import.meta.url))` written out like this,
  and bundle the entry, the engine and the plugins' dependencies into one worker script. Vite does this with no
  configuration, in the dev server and in production builds (checked with Vite 8.3).
- **A plain URL is not enough.** Passing only `new URL('./db-worker.ts', import.meta.url)` does not work with Vite: it
  does not see a worker there, and treats the `.ts` file as an asset.
- **Another tab can start it again.** The client calls the function again when this tab takes over a shared database
  from another tab.

With other bundlers, build `db-worker.ts` as a module worker, and start it from the URL of the built file in the
function.

**The default worker has no plugins.** `open()` without a `worker` option starts the default worker
(`smaltdb/worker`), which is `serve()` with no plugins.

**Parallel readers and other tabs get the same plugins.** The engine starts its parallel reader workers from the same
script, so they have the same plugins. When several tabs share a database, the tab that owns it runs its own worker.
Use the same `worker` option in every tab, so each tab that may own the database has the same plugins.

## Installing plugins in Node

With the in-process engine, pass the plugins to `Database.open()` or `Database.openMemory()`:

<!-- docs:plugin @smaltdb/parquet -->
```ts
import { Database } from 'smaltdb/engine';
import external from '@smaltdb/external';
import parquet from '@smaltdb/parquet';

const db = Database.openMemory({ plugins: [external, parquet] });
const result = await db.queryAsync("SELECT count(*) FROM read_parquet('data/trips.parquet')");
console.log(db.plugins); // [{ name: '@smaltdb/external', version: … }, { name: '@smaltdb/parquet', version: … }]
```

`db.plugins` lists the installed plugins' names and versions.

Opening fails with `SMALT_MISUSE` when a plugin was written for another plugin interface version, when the same plugin
is listed twice, or when two plugins register the same format name, table function, source prefix or connection type.

## Plugin helpers

`@smaltdb/io` and `@smaltdb/external` have a second entry point, `/client`, with helpers that call the plugin in the
engine. Each takes the database as its first argument: a client `Database` from `smaltdb`, or an engine `Database` from
`smaltdb/engine`.

```ts
import { importCSV, exportJSON } from '@smaltdb/io/client';
import { registerFile } from '@smaltdb/external/client';

await registerFile(db, 'prices.csv', 'id,price\n1,9.5\n');
await importCSV(db, 'prices', 'id,price\n2,12\n', { create: true });
console.log(await exportJSON(db, 'SELECT * FROM prices'));
```

| Helper | From | See |
|---|---|---|
| `importCSV(db, table, source, options?)`, `importJSON(db, table, source, options?)` | `@smaltdb/io/client` | [Import and export](./import-export) |
| `exportCSV(db, sql, params?, options?)`, `exportJSON(db, sql, params?, options?)` | `@smaltdb/io/client` | [Import and export](./import-export) |
| `registerFile(db, name, file)` | `@smaltdb/external/client` | [Registering files](./external-data#registering-files) |
| `registerCredentials(db, name, provider)` | `@smaltdb/external/client` | [Credentials](./external-data#credentials) |
| `setFetch(db, fn)` | `@smaltdb/external/client` | [URLs](./external-data#urls) (in-process engine only) |

The client modules import nothing from smaltdb at run time. They call `db.callPlugin()`, which you rarely need
yourself; see [Writing plugins](../reference/api/plugins#calling-plugin-methods).

## When a plugin is missing

A statement or helper that needs a plugin the engine does not have fails with `SMALT_PLUGIN_MISSING`. The message names
the plugin to install:

<!-- docs:skip -->
```sql
SELECT * FROM read_parquet('file:sales.parquet');
-- SMALT_PLUGIN_MISSING: read_parquet('file:sales.parquet'): the parquet format needs the
-- @smaltdb/parquet plugin (install it and add it to the engine's plugins)
```

Other examples of the message:

| Missing | Message |
|---|---|
| `@smaltdb/io`, for `read_csv('file:a.csv')` | `read_csv('file:a.csv'): the csv format needs the @smaltdb/io plugin (…)` |
| `@smaltdb/external`, for `read_csv('file:a.csv')` | `read_csv('file:a.csv'): reading file:a.csv needs the @smaltdb/external plugin (…)` |
| `@smaltdb/external`, for `CREATE CONNECTION c WITH (type = 's3')` | `connection c: an s3 connection needs the @smaltdb/external plugin (…)` |
| `@smaltdb/io`, for `importCSV(db, …)` | `importCSV(): import and export needs the @smaltdb/io plugin (…)` |
| `@smaltdb/external`, for `registerFile(db, …)` | `registerFile(): registering files and credentials needs the @smaltdb/external plugin (…)` |

A database never needs a plugin to open. An external table or a connection created with a plugin:
- stays in the catalog, in `information_schema` and in `sqlite_schema`;
- can be dropped;
- fails with `SMALT_PLUGIN_MISSING` only when a statement reads it.

Every other table works as usual.

## Writing plugins

The plugin interface is `SmaltPlugin` in `smaltdb/engine`, API version 1. See [Writing plugins](../reference/api/plugins).
It is not stable yet: it will be declared stable before the 0.9.0 release. Until then, a plugin may need changes when
you upgrade smaltdb.
