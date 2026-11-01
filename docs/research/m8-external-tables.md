# M8 external tables: research

Background for [ADR 0011](../adr/0011-external-tables.md). The ADR records the decisions; this note records the
options considered, what each library or approach offers, and the constraints that drove the choices.

## Goal

Developers using smaltdb should reach data the same way wherever it lives:
- a table in the local database;
- a CSV, Parquet or Excel file on the local file system, behind a URL or in a cloud bucket;
- a table in a remote database.

Their code issues SQL and gets rows back. The location is a property of the table, not of the calling code.

A second goal is groundwork for a later `smaltdb-sync` plugin: full or partial, one-way or bidirectional
synchronization with files, cloud stores and remote databases, on a schedule or whenever a connection is available.

## Prior art

| System | What it does | What we take |
|---|---|---|
| SQL/MED (SQL:2003) and PostgreSQL FDW | `CREATE SERVER`, `CREATE USER MAPPING`, `CREATE FOREIGN TABLE`; wrappers push filters, projections and (newer) joins and aggregates to the source | Separate *connections* (endpoint plus credentials) from *tables* (location plus format); capability-based pushdown |
| DuckDB (`read_csv`, `read_parquet`, httpfs, `ATTACH 'postgres:…'`) | Ad-hoc table functions over files and URLs; ranged HTTP reads of Parquet; scanners for remote databases | Table functions for ad-hoc use; byte-range reads guided by the Parquet footer; projection and filter pushdown into the scan |
| SQLite virtual tables (csv, Parquet extensions) | The engine calls a module for rows | We already have table-valued sources (`virtualTable`) for `information_schema` and pragma functions |
| Hive / Spark / Snowflake external tables | `CREATE EXTERNAL TABLE … LOCATION … FILE_FORMAT …` | The keyword `EXTERNAL` and declared schema plus format options; refresh of cached metadata |

## The central constraint: a synchronous engine

- **The engine is synchronous.** Every smaltdb storage read is synchronous: the pager never awaits, and the
  executor and generated pipelines call straight into it. This is a large part of smaltdb's speed (ADR 0001,
  ADR 0007).
- **External sources are asynchronous.** `fetch`, the File System Access API, `Blob.arrayBuffer()` and every
  database driver return promises.

Options for joining the two:

1. **An async phase before execution, the recommended default.** The planner determines what each external scan
   needs (whole file, column chunks, byte ranges, remote query results), and an async step fetches it. Execution
   then runs synchronously over the fetched buffers.
   - *Parquet fits ideally:* the footer gives exact byte ranges per column chunk, and row-group statistics allow
     skipping before fetching.
   - *CSV, Excel and JSON:* the whole object is fetched.
     - CSV and NDJSON can be streamed in chunks for large files.
     - Excel is a zip archive and needs the whole file.
   - *Remote databases:* the pushed-down query runs and its result is buffered, spilling (M7.2) when it is large.
   - *Cost:* the request API must become asynchronous end to end. It already is: the client API returns promises,
     and the server awaits `open`. Only the `Database` methods used in-process (Node, tests) gain async variants.
2. **A synchronous bridge with `Atomics.wait`.**
   - *How:* a helper worker performs fetches. The engine thread posts a request and blocks with `Atomics.wait` on a
     `SharedArrayBuffer` until the bytes arrive.
   - *Benefit:* true streaming of unbounded sources without the planner knowing sizes up front.
   - *Requirements:* cross-origin isolation, already needed for cancellation and parallel readers. `Atomics.wait`
     is allowed in dedicated workers but not on the main thread.
   - *Use:* a fallback for very large or unbounded scans.
3. **Cache first.** External data is copied into a local table or materialized view (`REFRESH` re-fetches), and
   queries run on the copy. This is the right default for slow or flaky sources and for offline use. It is also the
   basis of one-way sync.

All three are used: (1) by default, (3) when the user asks for caching (or the table declares it), and (2) as a
fallback for scans that would not fit memory or whose size is unknown.

## Sources

### Local files

| Environment | API | Notes |
|---|---|---|
| Node | `fs` (`open` / `read` with positions) | Ranged reads; any path the process can read. |
| Browser, user-picked file | `File` / `Blob` (`slice().arrayBuffer()`) | Ranged reads via `slice`; the handle lives only for the session, so the app re-supplies it after a reload (register a `File` under a name). |
| Browser, persistent access | File System Access API (`showOpenFilePicker`, `FileSystemFileHandle`) | Chromium only; handles can be stored in IndexedDB and re-permissioned. |
| Browser, app-private | OPFS | Files the app put there itself (downloads, exports). |

A browser cannot open arbitrary paths. A local external table in the browser therefore names a *registered* file,
`location = 'file:sales'`, where the app registers a `File` or handle as `sales` through the client API. In Node,
`location` is a path.

### HTTP(S) and cloud buckets

- **Plain URLs.** `fetch` with `Range` headers, provided the server sends `Accept-Ranges` and CORS headers
  (`Access-Control-Expose-Headers: Content-Range, Content-Length, ETag`).
- **S3 and S3-compatible stores** (R2, MinIO, Wasabi, GCS interop). Requests must be SigV4-signed, or use presigned
  URLs.
  - **`aws4fetch`:** about 2.5 KB, wraps `fetch`, signs SigV4, and runs in browsers, workers and Node. It is the
    better fit.
  - **`@aws-sdk/client-s3`:** the full AWS SDK v3. It is heavy for a browser bundle, though acceptable in Node.
  - *Credentials:* temporary credentials (STS / Cognito identity pools) or presigned URLs issued by the app's
    backend. Long-lived keys must never be shipped to a browser.
  - *CORS:* the bucket needs a CORS configuration allowing the app's origin, `GET`/`HEAD`, and the `Range` header.
- **Azure Blob and native GCS** later, through the same source interface (SAS URLs and signed URLs work today as
  plain URLs).
- **Change detection:** `ETag` and `Last-Modified` (and S3 object versions). These drive cache freshness: a cached
  external table is fresh while the object's ETag is unchanged.

## File formats

### CSV / TSV

- **Approach:** our own reader. It extends the existing importer (`io/import-export.ts`) to stream chunks and run
  incrementally.
- **Options:** `delimiter`, `quote`, `escape`, `header`, `null` (string treated as NULL), `skip` (rows), `encoding`
  (UTF-8 first), `columns` (declared types), and `infer` (sample size for type inference).
- **Types:**
  - CSV is untyped, and smaltdb tables are STRICT by default.
  - Inference runs once, when the external table is created. The resulting column list is stored in the catalog,
    so later reads are stable.
  - Rows that do not convert follow `on_error = 'fail' | 'null' | 'skip'`.

### Parquet

| Library | Size | Notes |
|---|---|---|
| **hyparquet** (recommended) | Small, pure JS, zero dependencies | Browser and Node; reads metadata separately; reads selected columns and row ranges through an async buffer that maps to ranged fetches; Snappy built in, other codecs (gzip, brotli, zstd, lz4) via `hyparquet-compressors`; also has a writer package. Started because parquetjs is unmaintained. |
| parquet-wasm (Rust arrow2/parquet2) | ~1 MB+ WASM | Fast and complete, and returns Arrow. The size and the Arrow dependency are not justified for reading into our own vectors. |
| parquetjs / parquets | Pure JS | Unmaintained. |
| DuckDB-wasm | Several MB | A second database engine: duplicates smaltdb. |

How Parquet maps onto smaltdb:
- **Row groups and statistics:** a Parquet row group is our row group, and its column statistics (min, max, null
  count) are a zone map. The columnar scan code (ADR 0008) and zone-map pushdown (ADR 0010) apply almost directly.
- **Fetching:** only the needed column chunks of the surviving row groups are fetched.
- **Types:**
  - INT32 and INT64 map to INTEGER (bigint beyond ±2^53);
  - FLOAT and DOUBLE map to REAL;
  - BYTE_ARRAY with UTF8 maps to TEXT; other BYTE_ARRAY to BLOB;
  - DATE and TIMESTAMP map to TEXT (ISO 8601) or INTEGER, by option;
  - DECIMAL maps to REAL or TEXT, by option;
  - nested types (LIST, MAP, STRUCT) map to JSON TEXT.

### Excel (.xlsx)

| Library | Notes |
|---|---|
| **SheetJS Community Edition** (recommended, vendored) | The most complete reader: xlsx, xlsb, xls, ods, csv; formulas' cached values, dates, merged cells, named ranges, tables. Distribution caveat: the public npm `xlsx` package stopped at 0.18.5, and current releases are published on the SheetJS CDN (cdn.sheetjs.com), which the maintainers recommend vendoring. Verify the license of the version we pin. |
| ExcelJS | Read and write, styling, streaming reader in Node. Larger, and Node-oriented; browser reading works but is slower. |
| read-excel-file | Small, xlsx only, simple; no named ranges or tables. |

How xlsx files are read:
- An `.xlsx` file is a zip archive, so it is fetched whole: there are no ranged reads.
- Cells hold cached formula values. smaltdb reads values, never evaluates formulas.

**Referencing sheets and ranges** follows Excel's own reference syntax, so spreadsheet users recognize it:

| Option | Meaning |
|---|---|
| `sheet = 'Sales'` | sheet by name |
| `sheet = 2` | sheet by 1-based position (in workbook order) |
| `range = 'A1:F200'` | cells of the chosen sheet (default: the sheet's used range) |
| `range = 'Sales!A1:F200'` | sheet and cells in one, as Excel writes them |
| `range = '''Q1 Sales''!A1:F200'` | quoted sheet name (spaces or punctuation), as in Excel: `'Q1 Sales'!A1:F200` |
| `range = 'SalesTable'` | an Excel *table* (ListObject) or a workbook-level *defined name* |
| `header = true` (default) | first row of the range holds column names |

- **Table functions:** the same options work positionally or by name, e.g.
  `read_excel('book.xlsx', sheet => 'Sales', range => 'A1:F200')`.
- **Date cells:** Excel stores dates as serial numbers in the 1900 or 1904 system. With a declared DATE or TIMESTAMP
  column, or `dates = 'iso'`, they are converted to ISO text.

### JSON / NDJSON

The existing importer handles both. NDJSON streams like CSV.

## Remote databases

### The browser constraint

Browsers cannot open TCP sockets, so the standard Node drivers cannot run there:
- `pg` and `postgres` (Postgres);
- `mysql2` (MySQL);
- `tedious` (SQL Server);
- `oracledb` (Oracle);
- `mongodb`.

Browser access is only possible to databases that expose HTTP or WebSocket endpoints, or through a server-side
gateway. The gateway is also where credentials belong.

### Options

| Driver | Speaks to | Runs in browser? | Notes |
|---|---|---|---|
| Neon serverless driver (`@neondatabase/serverless`) | Postgres (Neon; any Postgres behind Neon's WebSocket proxy) | Yes (HTTP / WebSocket) | Postgres wire semantics, `pg`-compatible API. |
| PlanetScale `database-js` | MySQL (PlanetScale/Vitess) | Yes (HTTP) | Simple query API. |
| `@libsql/client` | libSQL / Turso / sqld | Yes (HTTP) | SQLite dialect; embedded replicas in Node. |
| Cloudflare D1 HTTP API | D1 (SQLite) | Yes (HTTP, token) | Token must not be shipped to browsers without care. |
| Supabase (PostgREST) | Postgres via REST | Yes | Not SQL: filters map to REST query parameters; possible later as a separate connector. |
| `pg` / `postgres`, `mysql2`, `tedious`, `better-sqlite3`, `oracledb` | Everything | No (Node only) | The gateway's drivers. |
| **Kysely** | A type-safe query builder with pluggable *dialects* | Yes (with HTTP dialects) | Core dialects: Postgres, MySQL, SQL Server, SQLite; organization dialects: Postgres.js, SingleStore; community: Neon, PlanetScale, libSQL, D1, TiDB serverless, a fetch driver, PGlite, SQLite WASM. Actively maintained. |
| Knex | Query builder with many drivers | Node | Older and still maintained, but weaker typing; Kysely supersedes it for new code. |
| Drizzle, Prisma | ORMs | Partly | More than we need: we generate SQL ourselves and want rows plus types. |

### Recommendation

1. **A small connector interface owned by smaltdb.**
   - *Interface:* `describe(table) → columns`, `query(sql, params, signal) → async iterable of row batches with column
     types`, and `capabilities` (dialect, pushdown support, transactions, writes).
   - *Translation:* smaltdb generates the remote SQL from its own AST, so pushdown is under our control and testable.
     It translates filters, projections, LIMIT and ORDER BY first; aggregates and joins later. Each dialect gets a
     small printer for identifiers, literals and parameters.
2. **First-party direct connectors where browsers can reach the database:** Neon (Postgres), PlanetScale (MySQL),
   libSQL/Turso, and D1.
3. **A first-party `smaltdb-gateway`, a Node service** for every other database.
   - *Drivers:* it uses **Kysely** as its driver layer, which gives Postgres, MySQL, SQL Server and SQLite through one
     interface, plus the community dialects.
   - *Credentials:* they stay on the server.
   - *Protocol:* the browser speaks a simple authenticated HTTP or WebSocket protocol. Its requests are smaltdb's
     pushed-down SQL plus parameters, checked against an allow-list of external tables. The gateway is not a generic
     SQL proxy.
   - *Self-hosting:* the gateway is open source, and an app can embed it into its own backend.

**Not recommended:** an ORM (wrong abstraction), DuckDB-wasm (duplicates the engine and is several MB), or putting
database credentials into browser code.

## Pushdown

| Source | Projection | Filter | Limit | Aggregate / join |
|---|---|---|---|---|
| CSV / JSON | (parse all, keep needed) | no (local) | stop early when no ORDER BY | local |
| Parquet | column chunks | row-group statistics (zone maps), then local | stop early | local (statistics answer `count(*)` / min / max of whole files later) |
| Excel | — | local | local | local |
| Remote DB | `SELECT` list | `WHERE` (translated conjuncts; untranslatable ones stay local) | `LIMIT` when no local work above it | later (M8+): `GROUP BY`, joins of tables on the same connection |

**Joins across sources** run locally, using the existing hash join.
- *Small side:* the optimizer needs row estimates for external tables. These come from the Parquet footer, file
  sizes, remote `EXPLAIN` or statistics, or a declared `rows` option.
- *Remote side:* a parameterized remote lookup per probe batch (`WHERE key IN (…)`) is a later optimization.

## Consistency, transactions and failure

- **Transactions:** reads of external tables are not part of local transactions. Each query sees whatever the source
  returns at fetch time. Within one statement, every external scan of the same table reuses the same fetch.
- **Writes:** writes to remote databases (a later phase) cannot be atomic with local writes: there is no two-phase
  commit across a browser and a remote server. They will be documented as separate, non-atomic operations, or routed
  through sync.
- **Failures** are errors that name the source: `SMALT_EXTERNAL` with the HTTP status, driver code or parse
  position. Timeouts and cancellation reach the fetch through the existing interrupt flag and `AbortSignal`.
- **Offline:** a cached external table (materialized view) keeps answering. An uncached one fails clearly.

## Security

- **Credentials** never appear in SQL text, the catalog or the database file. A connection names a *credential
  provider* registered by the application at runtime. Providers can be a callback returning headers, temporary STS
  credentials, a token, or a presigned-URL issuer.
- **Allow-listing:** the database file stores only connection names, endpoints and options. An app opening a
  database from an untrusted source cannot be made to send its credentials elsewhere, because a provider is bound to
  an endpoint pattern by the app.
- **CORS** has to be configured on buckets and servers. Documentation and error messages should point at it, since
  it is the most common failure.
- **The gateway** authenticates callers itself (app session, JWT) and limits which tables and statements they may
  use.

## Packaging

The core engine stays dependency-free. Connectors and format readers are separate, lazily loaded packages:
`@smaltdb/csv` (in core, since it is small), `@smaltdb/parquet` (hyparquet), `@smaltdb/excel` (SheetJS, vendored),
`@smaltdb/s3` (aws4fetch), and one package each for Neon, PlanetScale, libSQL and D1, plus `smaltdb-gateway`. The
client registers them, and the engine worker loads them on first use (dynamic `import()` in the worker).

## Groundwork for smaltdb-sync

Projects that solved sync (ElectricSQL, PowerSync, Replicache, cr-sqlite, Litestream-style log shipping) agree on a
few prerequisites. These belong in the core long before a sync plugin exists:

1. **Stable row identity across replicas.** Integer rowids collide between independent databases. Tables meant to
   sync need globally unique keys (UUIDv7 or ULID, which also keep insert locality).
2. **Change capture in the same commit as the change.** A per-table change log (operation, primary key, changed
   columns, version), or per-row versions, written by the write path. Pull, push and conflict detection are built
   on it.
3. **Version clocks.** A per-database logical clock, such as a hybrid logical clock (HLC), so changes from different
   replicas can be ordered.
4. **Conflict policies per table:** last-writer-wins by row or by column, a custom resolver, or "remote wins" /
   "local wins". Bidirectional sync without an explicit policy silently loses data.

**One-way sync is mostly M8 already.**
- *Pull:* a materialized view over an external table, refreshed on a schedule or when the connection returns.
- *Push:* exporting the change log to an external target.

Bidirectional sync needs (1) to (4) and is the plugin's real work.

## Sources

- hyparquet: https://github.com/hyparam/hyparquet, https://www.npmjs.com/package/hyparquet
- Kysely dialects: https://kysely.dev/docs/dialects
- SheetJS installation and distribution: https://git.sheetjs.com/Joban/docs.sheetjs.com/src/commit/260bb7014e7e1bd446ffe68c958dd52edcc42662/docz/docs/02-installation/04-nodejs.md
- PostgreSQL foreign data wrappers (SQL/MED): https://www.postgresql.org/docs/current/ddl-foreign-data.html
- DuckDB Parquet and HTTP(S) support: https://duckdb.org/docs/data/parquet/overview, https://duckdb.org/docs/extensions/httpfs/overview
