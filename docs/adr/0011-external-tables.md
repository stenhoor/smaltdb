# ADR 0011: External tables (M8)

- **Status:** accepted (2026-11-01; the open questions are decided at the end)
- **Date:** 2026-11-01
- **Research:** [M8 external tables](../research/m8-external-tables.md)

## Context

Applications built on smaltdb also need data that lives elsewhere:
- CSV, Parquet and Excel files on the local file system;
- files behind URLs or in cloud buckets such as S3;
- tables in remote databases.

Today they reach that data with separate libraries and their own glue code, then import it.

M8 makes these sources queryable with the same SQL as local tables, so application code does not depend on where
data lives. It is also the base for a later `smaltdb-sync` plugin: one-way or bidirectional synchronization with
files, cloud stores and remote databases, on a schedule or when connections allow.

Constraints:
- **Synchronous engine:** the engine reads storage synchronously, while every external source is asynchronous.
- **Browser networking:** browsers cannot open TCP connections to databases.
- **Browser credentials:** anything shipped to a browser is visible to its user.
- **Core size:** the core must stay small and dependency-free.

## Decisions

### 1. SQL surface: connections, external tables, table functions

The syntax follows SQL/MED and PostgreSQL foreign tables in separating endpoints from tables, and uses smaltdb's
`WITH (…)` option style:

```sql
-- An endpoint and how to authenticate: no secrets, only the name of a provider the app registers.
CREATE CONNECTION warehouse WITH (type = 'postgres', url = 'https://db.example.com', credentials = 'warehouse-token');
CREATE CONNECTION lake WITH (type = 's3', region = 'eu-west-1', bucket = 'analytics', credentials = 'lake-sts');

-- A table whose rows live elsewhere. Columns may be declared or inferred once at creation.
CREATE EXTERNAL TABLE orders (id INTEGER, placed TEXT, total REAL)
  WITH (connection = 'warehouse', remote_table = 'public.orders');
CREATE EXTERNAL TABLE events WITH (connection = 'lake', location = 'events/2026/*.parquet', format = 'parquet');
CREATE EXTERNAL TABLE budget WITH (location = 'file:budget', format = 'excel', range = '''FY 2026''!A1:H40');
CREATE EXTERNAL TABLE prices WITH (location = 'https://example.com/prices.csv', format = 'csv', header = true);

-- Ad hoc, without a catalog entry.
SELECT * FROM read_csv('https://example.com/prices.csv');
SELECT * FROM read_parquet('s3://analytics/events/2026/01.parquet', connection => 'lake');
SELECT * FROM read_excel('file:budget', sheet => 'FY 2026', range => 'A1:H40');

-- Caching (offline, fast repeat reads): a materialized view, with M7.5 freshness.
CREATE MATERIALIZED VIEW orders_local WITH (storage = 'columnar') AS SELECT * FROM orders;
```

Rules for external tables:
- **Querying:** they work in SELECTs, joins, subqueries and views like any table. They are read-only in M8, and
  they cannot be indexed (partitions and statistics do that job).
- **Catalog:** `information_schema.tables` lists them with `table_type = 'EXTERNAL'`. A new
  `information_schema.external_tables` view shows location, format, connection and the cached schema.
- **DROP:** `DROP EXTERNAL TABLE` and `DROP CONNECTION` remove catalog entries only. They never touch the source.

### 2. Sources and formats

| Source | Location | Access |
|---|---|---|
| Local file (Node) | a path | `fs`, ranged reads |
| Local file (browser) | `file:<name>`, where the app registers a `File` or `FileSystemFileHandle` under that name | `Blob.slice`, ranged reads |
| HTTP(S) | URL | `fetch` with `Range`; ETag / Last-Modified for freshness |
| S3 and compatible | `s3://bucket/key`, or a key relative to a connection | SigV4 (on WebCrypto, in the core), or presigned URLs from a provider |
| Azure Blob Storage (added with M8.2) | `az://container/path`, or a path relative to a connection | SAS tokens, Shared Key signing (account key, on WebCrypto) or Entra ID bearer tokens |
| Remote database | `connection` + `remote_table` (or a remote query) | connector interface (decision 5) |

Globs (`*.parquet`, `year=*/`) expand to several files of one table. Hive-style `key=value` path segments become
columns, and filters on them prune whole files.

| Format | Reader | Notes |
|---|---|---|
| CSV / TSV | built in (streaming, extends the M4 importer) | Required. `delimiter`, `quote`, `escape`, `header`, `null`, `skip`, `encoding`, `on_error`. Types are inferred once at creation and stored, unless declared. |
| JSON / NDJSON | built in | NDJSON streams. |
| Parquet | hyparquet, an optional peer dependency loaded on first use (a separate chunk of the engine worker) | Footer first, then only the needed column chunks of row groups that survive row-group statistics (used as zone maps). Codecs beyond Snappy come via hyparquet-compressors. |
| Excel (.xlsx, .xlsb, .ods), **deferred** (see the decisions below) | `@smaltdb/excel` (SheetJS Community Edition, a pinned version vendored from the SheetJS CDN) | Whole file (it is a zip archive); cached formula values; dates converted by the declared type or `dates = 'iso'`. |

**Excel sheet and range references** use Excel's own syntax:
- `sheet = 'Sales'` (by name) or `sheet = 2` (1-based position);
- `range = 'A1:F200'` or `range = 'Sales!A1:F200'`, with quoted names as in Excel (`'Q1 Sales'!A1:F200`);
- `range = 'SalesTable'` for an Excel table or a workbook-level defined name;
- `header = true` (default) takes column names from the first row of the range.

Without a range, the sheet's used range is read.

### 3. Execution: async fetch, then synchronous execution

- **Fetch first.** The engine stays synchronous. Planning a statement that reads external tables produces a *fetch
  plan*: the columns, row groups, byte ranges or remote queries each external scan needs, after pruning. An async
  step performs it, with requests running concurrently. Execution then runs synchronously over the buffers.
  - *Large results* spill (M7.2).
  - *Repeated scans* of one table in one statement share a single fetch.
- **API impact:** `Database.query`, `run` and `prepare` keep working for local data. Statements that touch external
  tables need `await db.queryAsync(…)` in-process (Node, tests); the worker client is already asynchronous. Calling
  the synchronous API on such a statement throws `SMALT_ASYNC_REQUIRED`.
- **Streaming bridge.** For scans too large or unbounded to buffer, a helper worker performs fetches while the engine
  blocks on an `Atomics.wait` handshake (cross-origin isolated contexts only). This is the fallback, not the default.
- **Caching** is explicit: a materialized view over the external table.
  - *Freshness:* a cached view is fresh while the source's ETag / Last-Modified (files, objects) or the connector's
    change token (databases, when available) is unchanged. `REFRESH` re-fetches.
  - *Scheduling:* "refresh on reconnect" and "refresh every N minutes" policies run in the engine worker, the
    seed of one-way sync.

### 4. Pushdown and planning

**Projection.** Only the referenced columns are read: Parquet column chunks, or the remote `SELECT` list. CSV,
JSON and Excel files are parsed whole and keep only those columns.

**Filters.**
- *Parquet:* comparisons with constants prune row groups through their statistics, reusing the zone-map machinery
  from ADR 0008 and ADR 0010.
- *Remote databases:* translatable WHERE conjuncts are printed in the remote dialect. Untranslatable ones stay local.
- *Partitioned paths:* filters on path-derived columns prune files.

**Limits.** `LIMIT` without local work above it goes to the remote query. Local scans stop early when there is no
ORDER BY.

**Estimates.** Row estimates for join ordering come from Parquet footers, file sizes, a connector's estimate, or a
declared `rows` option.

**EXPLAIN** shows what each external scan fetches and pushes down, for example:
`SCAN EXTERNAL orders (postgres warehouse: WHERE total > ?; columns id, total)`.

**Joins** across sources run locally. Pushing joins and aggregates of tables on the same connection to the remote
database is a later step.

### 5. Remote databases: smaltdb's connector interface, direct browser drivers, and a Kysely-based gateway

- **Interface (owned by smaltdb):**
  - `describe(remoteTable) → columns with types`;
  - `query(sql, params, signal) → async iterable of typed row batches`;
  - `capabilities` (dialect, pushdown support, estimates, change token).

  smaltdb prints the remote SQL from its own AST, through a small printer per dialect, so pushdown is ours to
  control and test.
- **First-party direct connectors** for databases reachable from browsers over HTTP or WebSocket:
  - Postgres via the Neon serverless driver;
  - MySQL via PlanetScale `database-js`;
  - libSQL / Turso via `@libsql/client`;
  - Cloudflare D1.

  All of these also run in Node.
- **`smaltdb-gateway`:** a first-party Node service for every other database.
  - *Drivers:* Kysely's dialects (Postgres, MySQL, SQL Server, SQLite, plus community dialects) as its driver layer.
  - *Protocol:* an authenticated HTTP or WebSocket protocol. Requests are smaltdb's pushed-down queries over
    allow-listed tables, not arbitrary SQL.
  - *Credentials* stay on the server. The gateway can be embedded in an app's own backend.
- **Not used:** ORMs (Prisma, Drizzle), whose abstraction does not fit; DuckDB-wasm, which duplicates the engine at
  several MB; and native TCP drivers in the browser, which is impossible.

### 6. Security

**Secrets.** Credentials never appear in SQL text, the catalog or the database file. A connection names a
*credential provider* that the application registers at runtime with the client. Providers can be:
- a callback returning headers;
- temporary STS or Cognito credentials;
- a bearer token;
- a presigned-URL issuer.

**Endpoint binding.** Each provider is bound to an endpoint pattern. A database file from an untrusted source
therefore cannot redirect an app's credentials to another host.

**Errors** about CORS and authentication name the source, and say which header or bucket policy is missing.

### 7. Consistency and failure

- **Transactions:** external reads are not part of local transactions. A statement sees what each source returned
  when it was fetched.
- **Writes:** writes to remote databases are out of scope for M8. When they come, they will not be atomic with
  local writes, because there is no two-phase commit across browser and server.
- **Errors:** failures raise `SMALT_EXTERNAL`, with the source, the HTTP status or driver code, and the parse
  position. Cancellation and timeouts reach fetches through the existing interrupt flag and `AbortSignal`.
- **Offline:** cached views keep answering. Uncached external tables fail with a clear error.

### 8. Packaging

The core stays dependency-free. It includes the CSV and JSON readers, HTTP and `file:` sources, the connector
interface and the dialect printers.

Optional packages, loaded with dynamic `import()` inside the engine worker on first use:
- ~~`@smaltdb/parquet`~~: Parquet uses hyparquet (and hyparquet-compressors) as optional peer dependencies loaded
  with dynamic `import()`; the engine worker build puts them in separate chunks. No wrapper package is needed.
- `@smaltdb/excel`
- ~~`@smaltdb/s3`~~: SigV4 and Azure Shared Key turned out to be about 150 lines on WebCrypto, so object-store
  signing is in the core (no `aws4fetch` dependency).
- `@smaltdb/connector-neon`
- `@smaltdb/connector-planetscale`
- `@smaltdb/connector-libsql`
- `@smaltdb/connector-d1`

`smaltdb-gateway` is a separate server package.

### 9. Groundwork for smaltdb-sync

Sync itself is a later plugin. M8 includes the core pieces that sync needs and that would be costly to retrofit:
- **Stable row identity:** a documented recommendation, plus helpers `uuid7()` and `ulid()`, for tables meant to
  sync, because integer rowids collide across replicas.
- **Change capture in the same commit:** `CREATE TABLE … WITH (track_changes = true)` records the operation, key,
  changed columns and a version in a per-table change log, written by the write path in the same transaction.
- **A logical clock:** a per-database hybrid logical clock stamps those versions.
- **One-way sync:**
  - *pull:* a materialized view over an external table with a refresh policy;
  - *push:* exporting a change-log range to an external target.

Bidirectional sync, conflict policies and resolvers belong to the plugin.

### Phasing

| Part | Scope |
|---|---|
| M8.1 ✅ | `CREATE CONNECTION` / `CREATE EXTERNAL TABLE`, catalog and information_schema, async fetch phase, `file:` and HTTP sources, CSV and JSON readers, `read_csv` / `read_json`, caching through materialized views. Follow-ups ✅: freshness of such caches (`REFRESH … IF CHANGED` revalidates the recorded ETag / Last-Modified / file times with HEAD requests or stats), refresh policies (`refresh_every`, `refresh_on_reconnect`) run by the engine worker, credential callbacks across the worker boundary, export over external data |
| M8.2 ✅ | S3 and S3-compatible stores and Azure Blob Storage (signing on WebCrypto in the core, credential providers with AWS keys / Azure SAS, account key or bearer tokens / presigned URLs, also as callbacks across the worker), globs over listings, local directories and registered files, Hive partitions with pruning from WHERE conditions |
| M8.3 ✅ | Parquet: footer, column chunks, row-group pruning, ranged fetches, `read_parquet` (hyparquet 1.31; tested against files written by pyarrow) |
| M8.4 | Excel: sheets, A1 ranges, tables and defined names, dates, `read_excel`. **Deferred** (after M8.5; library to be chosen then) |
| M8.5 | Connector interface, dialect printers, the Neon / PlanetScale / libSQL / D1 connectors, `smaltdb-gateway` on Kysely, filter / projection / limit pushdown |
| ~~M8.6~~ | Sync groundwork (change tracking, logical clock, id helpers): **moved to its own milestone** before the sync plugin, with its own ADR. Refresh policies for cached views stay in M8.1 |

## Consequences

**Benefits.**
- One SQL surface over local tables, files, buckets and remote databases.
- External data joins with local data without copying, or is cached as a columnar materialized view for offline,
  fast reads.
- Parquet reuses the columnar and zone-map work from M5 and M7, so selective reads fetch a fraction of a file.

**Costs.**
- External statements need an async entry point in-process.
- The planner gains a fetch phase.
- There are more packages to maintain, and the gateway is a server component with its own security surface.

**Limits.**
- Location is transparent in syntax but not in behavior: latency, failures and the lack of cross-source atomicity
  remain. EXPLAIN, errors and capability flags make them visible instead of hiding them.
- Browsers need CORS on every bucket and server they read from directly.

## Decisions on the open questions (2026-11-01)

1. **Writes:** read-only in M8. Writes to remote databases come later.
2. **Gateway:** `smaltdb-gateway` is a first-party package (the recommendation; no objection raised). It is needed
   only from M8.5.
3. **Excel:** deferred. M8 delivers CSV, JSON, Parquet and remote databases first; the Excel reader and its library
   (SheetJS vendored or ExcelJS) are decided when M8.4 is picked up.
4. **Async API:** `queryAsync` in-process. Local statements keep the synchronous API; statements that read external
   tables need `queryAsync` (or the worker client, which is asynchronous anyway), and the synchronous API throws
   `SMALT_ASYNC_REQUIRED` for them.
5. **Sync groundwork:** a separate milestone before the sync plugin, not part of M8. Section 9 describes its scope.

## Open questions as proposed

1. **Writes:** stay read-only in M8 (recommended), or include INSERT, UPDATE and DELETE on remote database tables?
2. **Gateway:** is `smaltdb-gateway` a first-party, maintained package (recommended: the only safe route from
   browsers to most databases), or left to applications?
3. **SheetJS:** is a vendored dependency acceptable, given CDN-only distribution of current versions and a license
   check per pinned version? The alternative is ExcelJS, which is heavier and slower in browsers.
4. **Async API:** `queryAsync` in-process, or make the in-process `Database` API asynchronous for every statement?
   The recommendation is `queryAsync`: local statements keep their synchronous fast path.
5. **Sync groundwork:** does change tracking (M8.6) belong in M8, or in its own milestone before the sync plugin?
