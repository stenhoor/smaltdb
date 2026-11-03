# ADR 0012: Plugins: a dependency-free core, optional features as packages

- **Status:** accepted (2026-11-02); amended 2026-11-02: one repository per plugin, and the full interface (sources,
  connection types, methods, questions to client sessions). See the implementation plan for progress.
- **Date:** 2026-11-02

## Context

A licence scan (JFrog) flagged the `smaltdb` package. Reviewing it showed two problems with how optional code ships today.

**Third-party code ships inside our bundles, without its notices.**
- The browser worker bundles the Parquet reader into `dist/chunks/`:
  - `hyparquet` (MIT);
  - `hyparquet-compressors` (MIT, containing Google's Brotli decoder under Apache-2.0 and gzip code adapted from fflate);
  - `fzstd` and `hysnappy` (MIT).
- None of their copyright or licence texts are in `dist/`.
- `package.json` declares only `MIT` and lists `hyparquet` as a peer dependency.

**Features that many applications never use ship in every install.** Each application gets them whether it uses them
or not:
- **External data** (`src/engine/external/`, about 1,300 lines): HTTP/S3/Azure sources, request signing, globs,
  credentials and the CSV/JSON readers.
- **CSV/JSON import and export** (`src/engine/io/`, about 500 lines).

The goal:
- The core package contains only our own code, with no runtime dependencies.
- Code that depends on other projects, and functionality not every application needs, lives in separately published
  packages, each with its own licence and notices.

The project owner decided these questions on 2026-11-02:
- **Scope:** Parquet, external data and import/export become plugins. Columnar tables, materialized views, spilling
  and parallel readers stay in core.
- **Packaging:** separate npm packages under the `@smaltdb` scope.
- **Loading:** a custom worker entry written by the application.
- **API:** internal first. The plugin API is experimental until our own plugins have proven it.

## Decisions

### 1. What is core, and what becomes a plugin

| Package | Contents | Runtime dependencies |
|---|---|---|
| `smaltdb` (core) | Client, engine, worker runtime, storage, SQL, all built-in functions, columnar tables, materialized views, spilling, parallel readers, `information_schema`. **Also the external-table framework**: the SQL syntax (`CREATE CONNECTION`, `CREATE EXTERNAL TABLE`, `read_*` calls), catalog entries, the async fetch phase, the scan operator, projection and partition / row-group pruning hooks, cache validators and refresh policies. | none |
| `@smaltdb/external` | Sources: `file:` (registered files), Node paths, HTTP(S), S3, Azure Blob Storage; SigV4 and Azure Shared Key signing; credential providers; glob listing and Hive partitions. Client helpers `registerFile`, `registerCredentials`. | none |
| `@smaltdb/io` | The CSV, TSV, JSON and NDJSON formats: parsers and type inference, used by external tables and `read_csv` / `read_json`. Import and export: `importCSV`, `importJSON`, `exportCSV`, `exportJSON`. | none |
| `@smaltdb/parquet` | The Parquet format: footer and schema reading, ranged column-chunk reads, row-group statistics, `read_parquet`. | `hyparquet`; optional `hyparquet-compressors` |

**Why columnar tables and materialized views stay in core:** they change the database file. A database that uses
them could not be opened, or recovered after a crash, without the plugin. They are also our own code, with no
licence cost.

**Why the external-table framework stays in core:** the SQL syntax, the catalog and the fetch phase are what every
source and format plugin builds on, including the remote-database connectors planned for M8.5. Keeping them in core
gives one extension point, instead of one per plugin.

What remains in core is our own code and roughly the size of the planner glue (estimated at a few hundred lines).
The source handlers, signing, parsers and Parquet code all move out.

**Why sources and formats are separate plugins:** a statement combines one of each. Reading Parquet from S3 needs
`@smaltdb/external` and `@smaltdb/parquet`; importing a CSV file needs only `@smaltdb/io`. An application installs
only the pieces it uses.

### 2. Packaging

- **One repository per plugin** (amended; the first version kept plugins in this repository as npm workspaces):
  `stenhoor/smaltdb-parquet`, `stenhoor/smaltdb-external`, `stenhoor/smaltdb-io`. The core repository contains no
  plugins and no third-party runtime dependencies, so a licence scan of it, its lockfile included, finds none. Each
  plugin repository has its own licence, lockfile, tests, CI and releases, and a scan of one shows only that plugin's
  dependencies. The core tests the plugin interface with test plugins defined in its own test suite.
- **Before the first publish** (amended, step 5): smaltdb 0.9.0 and the plugins are not on npm yet, and nothing uses
  git dependencies. Each repository has a `packed.json` that pins the packages it needs to commits, and the same
  `scripts/fetch-packed.mjs`, which checks out those commits, builds them, runs `npm pack` and installs the tarballs
  with `npm install --no-save`. CI and developers run it after `npm ci`. Nothing reaches a `package.json` or lockfile,
  so there is no core-to-plugin cycle to clean up: at release, the script and the pin files are deleted, and pins that
  are still wanted become `^0.9.0` development dependencies.
- **Notices travel with each package.** Every package has its own `LICENSE`. A package that depends on third-party
  code declares it as a normal `dependency`, so npm installs it with its own licence file next to it, where scanners
  expect it.
- **No vendored third-party code.** We publish no bundle that contains third-party code.
  - The core's prebuilt worker contains core only.
  - An application that uses `@smaltdb/parquet` bundles `hyparquet` itself, through its own build, from the
    installed package and its licence.
- **Versions.** While the API is experimental (section 6), each plugin's peer dependency on `smaltdb` pins the minor
  version (`~0.9.0`).
- **Releases.** Core and plugins are released together with the same version number.
- **npm scope.** Publishing needs a free `smaltdb` organisation on npmjs.com, which the owner creates.

### 3. Loading plugins: a worker entry the application writes

Plugins run where the engine runs: in the engine worker, in its parallel reader workers, and in-process with
`smaltdb/engine`.

The core gains a worker runtime, `smaltdb/worker-runtime`, with a `serve()` function. The default worker
(`smaltdb/worker`) becomes `serve({ plugins: [] })`. An application that wants plugins writes its own worker entry:

```ts
// db-worker.ts: the application's engine worker
import { serve } from 'smaltdb/worker-runtime';
import external from '@smaltdb/external';
import io from '@smaltdb/io';
import parquet from '@smaltdb/parquet';

serve({ plugins: [external, io, parquet] });
```

It then passes that file to `open()`:

```ts
import { open } from 'smaltdb';

const db = await open('app', {
  worker: () => new Worker(new URL('./db-worker.ts', import.meta.url), { type: 'module' }),
});
```

**Why this design:**
- **Bundlers handle it statically.** Every import is static, so bundlers resolve, bundle and tree-shake it like any
  other code.
- **The option is a function that creates the worker.** Vite recognises `new Worker(new URL(…, import.meta.url))`
  only when it is written out, so the `worker` option accepts a function. A bare URL passed as the option is not
  recognised: Vite treated the `.ts` entry as an asset in testing. The client calls the function again when the tab
  takes over a shared database.
- **No run-time module URLs.** Those would break with bundlers and Content Security Policy.
- **Type-checked.** Plugin options are typed.

**Consistency across workers and tabs:**
- **Parallel reader workers** are started from the running worker's own script (`new Worker(self.location.href)`),
  so they get the same plugins with no extra step.
- **Other tabs:** when another tab takes over a shared database, it starts its engine worker from its own `worker`
  option. An application that loads the same entry in every tab therefore gets the same plugins everywhere.
- **Reporting:** the open handshake reports the owner's plugin list (name and version) in `capabilities`, so a
  mismatch can be seen and reported.

**In-process (Node, tests):**

```ts
import { Database } from 'smaltdb/engine';
import io from '@smaltdb/io';

const db = await Database.open(vfs, 'app.db', { plugins: [io] });
```

### 4. The plugin interface

```ts
interface SmaltPlugin {
  name: string;                 // '@smaltdb/parquet'
  version: string;
  apiVersion: 1;                // the engine refuses plugins with an API version it does not support
  setup(host: PluginHost): void;
}
```

`setup` runs once per engine instance and registers what the plugin provides through `PluginHost`:

| Registration | Used by | Example |
|---|---|---|
| `addSource(handler)` | external tables, `read_*` | location prefixes (`https://`, `s3://`, `az://`, `file:`), connection types, plain paths: open (whole file or random access), validator (HEAD, stat), list (patterns) |
| `addConnectionType(type, spec)` | `CREATE CONNECTION` | `s3`: allowed options, aliases, a check of the options |
| `addFormat(reader)` | external tables, `read_*` | `csv`, `json`, `parquet`: names and aliases, file extensions, options, a reader with projection and zone (statistics) hooks |
| `addTableFunction(name, spec)` | `FROM f(…)` | `read_parquet` → the `parquet` format |
| `addMethod(name, handler)` | `callPlugin` | `importCSV`, `registerFile`, `registerCredentials` |
| `onSessionClosed(listener)` | tabs that go away | drop the credential callbacks a tab registered |
| `ask(session, message)` | questions to a tab | fresh credentials for one request, answered by the tab's `onPluginMessage` handler |

Host helpers: `glob` (pattern matching for sources that list files) and `formatReal` (REALs as SQLite prints them).
Methods get a `MethodContext`: the engine `db`, the calling `session`, a `signal`, and `query(sql, params)`, which
fetches external data first and returns rows with their columns' static types.

**Calling a plugin method.** The client and the engine `Database` both have
`callPlugin(plugin, method, args, options)`. On the client, `lock` makes the call wait for other requests and
transactions, and `replay` re-sends it to a new owner tab (state that lives in the engine worker, such as registered
files). Each plugin package exports helpers that wrap it, working with either `Database`:

```ts
import { importCSV } from '@smaltdb/io/client';

await importCSV(db, 'sales', file);
```

The existing methods move out of the core client this way: `db.importCSV`, `db.importJSON`, `db.exportCSV`,
`db.exportJSON`, `db.registerFile` and `db.registerCredentials`.

**Messages initiated by the engine.** `host.ask(session, message)` sends a `pluginAsk` message to that tab, whose
handler (`db.onPluginMessage(plugin, handler)`) answers with `pluginReply`. Asks time out (30 s by default) and fail
when the tab closes.

**User-defined functions.** `addScalarFunction` and `addAggregateFunction` follow the same pattern. They are
deliberately not in the first version (section 6).

### 5. Databases that need a plugin the engine does not have

The catalog records, for each external table and connection, the format, source scheme and connection type it uses.

| Situation | Behaviour |
|---|---|
| Opening the database | Always works: a missing plugin never blocks opening, recovery or other tables. |
| Reading such an object | Fails with a new error code, `SMALT_PLUGIN_MISSING`, e.g. "table sales needs the parquet format (@smaltdb/parquet)". |
| `DROP`, `information_schema`, `sqlite_schema` | Work. |
| Automatic refresh of a materialized view whose source needs a missing plugin | Records the error in `last_refresh_error`. The view keeps its last rows. |
| Calling a client helper whose plugin the engine lacks | Fails with `SMALT_PLUGIN_MISSING`. |

### 6. API stability

- **Phase 1:** the plugin interface is internal and marked experimental. Its first users are our own three plugins.
- **Phase 2:** the interface is declared stable as API version 1, public and documented, once all three plugins run
  on it unchanged from their own repositories. Nothing is published before then (owner's decision, 2026-11-02).
  User-defined functions come later as an addition to version 1.
- **Versioning:** `apiVersion` lets a later engine reject an incompatible plugin with a clear message instead of
  failing at run time.

## Consequences

- **Licensing.**
  - The core package has no runtime dependencies and contains only our own MIT code.
  - Third-party code reaches an application only through the plugin that needs it, installed by npm with its own
    licence file.
  - Removing the bundled Parquet reader from `dist/` fixes the missing-notices problem in the published package.
- **Size.** The default worker no longer carries external sources, the CSV/JSON code or Parquet support.
- **Breaking change, released as 0.9.0.**

  | Before | After |
  |---|---|
  | `read_csv`, `read_json`, `read_parquet`, external tables and connections work with the default worker | Install the plugins and use a custom worker entry |
  | `db.importCSV(…)` and the other import/export methods | `importCSV(db, …)` from `@smaltdb/io/client` |
  | `db.registerFile(…)`, `db.registerCredentials(…)` | Helpers from `@smaltdb/external/client` |
  | `smaltdb/engine` exports `importCSV` and the other import/export functions | Moved to `@smaltdb/io` |

  Existing database files still open. Their external tables need the plugins to be read.
- **Documentation.**
  - The external data and import/export guides gain installation steps.
  - Getting started gains the worker-entry pattern.
  - The reference pages say which plugin provides each function and statement.
  - The docs examples (amended, owner's decision 2026-11-03) are split by plugin. The core's harness installs
    `@smaltdb/io` and `@smaltdb/external`, which contain no third-party code, from their pins. Blocks that need
    `@smaltdb/parquet` are marked `<!-- docs:plugin @smaltdb/parquet -->`: the core skips them, and
    `smaltdb-parquet` runs every page that has one, with all three plugins, against the docs at its pinned core commit.
- **Process.** A release publishes the core from this repository and each plugin from its own.

## Implementation plan

1. **Plugin host.** ✅ The registry (`src/engine/plugin.ts`), `serve()` in `smaltdb/worker-runtime`,
   `Database.open(…, { plugins })`, `SMALT_PLUGIN_MISSING`, `addFormat`, `addTableFunction`.
2. **Parquet out.** ✅ `@smaltdb/parquet`; `hyparquet` is no longer a dependency of the core or in `dist/`.
3. **The full interface.** ✅ `addSource`, `addConnectionType`, `addMethod`, `onSessionClosed`, `ask`, `callPlugin`,
   `onPluginMessage`, the `pluginCall` / `pluginAsk` / `pluginReply` protocol. Core keeps only the external-data
   framework: SQL, catalog, fetch phase, patterns, partitions, pruning, validators.
4. **External sources and CSV/JSON out.** `@smaltdb/external` (sources, signing, credentials, registered files) and
   `@smaltdb/io` (CSV/JSON formats, import and export).
5. **Separate repositories.** ✅ Each plugin moves to its own repository with its tests; the core keeps test plugins.
   The plugins' tests that use the engine's internals (its server and worker protocol) import them from the source in
   the packed core build.
6. **Declare API version 1 stable**, with a public reference for writing plugins.
7. **Release** 0.9.0: `smaltdb` and the three `@smaltdb/*` packages, together.
