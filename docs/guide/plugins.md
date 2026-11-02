# Plugins

The `smaltdb` package is the core engine. It has no runtime dependencies and contains only smaltdb's own code.
Features that depend on other projects ship as separate plugin packages, each with its own dependencies and licence
([ADR 0012](../adr/0012-plugins)). An application installs only the plugins it uses.

| Package | Provides | Depends on |
|---|---|---|
| `@smaltdb/parquet` | The Parquet format: `read_parquet()`, and external tables over `.parquet` files | `hyparquet`; optionally `hyparquet-compressors` |

Plugins run inside the engine. In the browser, that is the engine worker, so you install a plugin by giving the
worker an entry script that lists your plugins.

## Installing a plugin in the browser

1. Install the plugin next to smaltdb:

   ```sh
   npm install smaltdb @smaltdb/parquet
   ```

   For Parquet files compressed with gzip, zstd, brotli or LZ4, also install `hyparquet-compressors`. Snappy and
   uncompressed files need nothing more.

2. Write an engine worker entry that serves the engine with your plugins:

   ```ts
   // db-worker.ts
   import { serve } from 'smaltdb/worker-runtime';
   import parquet from '@smaltdb/parquet';

   serve({ plugins: [parquet] });
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
  and bundle the entry, the engine and the plugin's dependencies into one worker script. Vite does this with no
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

## Installing a plugin in Node

With the in-process engine, pass the plugins to `Database.open()` or `Database.openMemory()`:

```ts
import { Database } from 'smaltdb/engine';
import parquet from '@smaltdb/parquet';

const db = Database.openMemory({ plugins: [parquet] });
const result = await db.queryAsync("SELECT count(*) FROM read_parquet('data/trips.parquet')");
```

## When a plugin is missing

A statement that needs a plugin the engine does not have fails with `SMALT_PLUGIN_MISSING`. The message names the
plugin to install:

<!-- docs:skip -->
```sql
SELECT * FROM read_parquet('file:sales.parquet');
-- SMALT_PLUGIN_MISSING: read_parquet('file:sales.parquet'): reading Parquet needs the
-- @smaltdb/parquet plugin (install it and add it to the engine's plugins)
```

A database never needs a plugin to open. An external table over a Parquet file that was created with the plugin:
- stays in the catalog, in `information_schema` and in `sqlite_schema`;
- can be dropped;
- fails with `SMALT_PLUGIN_MISSING` only when a statement reads it.

Every other table works as usual.

## Writing plugins

The plugin interface (`SmaltPlugin` in `smaltdb/engine`) is experimental. It may change between minor versions until
smaltdb's own plugins have proven it, so plugins written outside this repository may need changes when you upgrade.
