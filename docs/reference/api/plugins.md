# Writing plugins

A plugin adds features to the engine: file formats, table functions that read them, sources that external data is
read from, connection types, and methods that the application calls. smaltdb's own optional features are plugins:
`@smaltdb/io`, `@smaltdb/external` and `@smaltdb/parquet` ([ADR 0012](../../adr/0012-plugins)). The
[plugins guide](../../guide/plugins) shows how to install them.

This page describes the plugin interface, **API version 1**. It is not stable yet: it will be declared stable before
the 0.9.0 release. Until then it may change, and plugins written outside this repository may need changes when you
upgrade.

```ts
import type { SmaltPlugin, PluginHost, FormatReader, SourceHandler } from 'smaltdb/engine';
```

## Rules

- **Import only types from smaltdb.** A plugin imports nothing from `smaltdb` or `smaltdb/engine` at run time: only
  types, with `import type`. Everything it needs at run time comes through the [`PluginHost`](#pluginhost). So a
  plugin works with whichever copy of the engine an application bundles. The same goes for a plugin's client module.
- **Keep state in `setup`.** `setup(host)` runs once per engine instance (each `Database`), so state kept in its
  closure belongs to that database. Do not keep it in module variables.
- **Throw plain errors.** A plugin cannot create a `SmaltError`. Throw an `Error`; give it a `code` property that
  starts with `SMALT_` to choose the error code. See [Errors](#errors).

## A complete example

This plugin adds a `kv` format (lines of `key=value`), a `read_kv()` table function, and a `mem:` source whose files
the application puts into the engine with a plugin method.

```ts
import { Database } from 'smaltdb/engine';
import type { FormatColumn, FormatRequest, FormatResult, ListedFile, SmaltPlugin, SourceTarget, SqlValue } from 'smaltdb/engine';

/** The columns of a kv file. */
const KV_COLUMNS: FormatColumn[] = [
  { name: 'key', declType: 'TEXT' },
  { name: 'value', declType: 'TEXT' },
];

/** Parse `key=value` lines into the columns the engine asked for. */
function readKv(text: string, request: FormatRequest): FormatResult {
  const separator = request.options.separator ?? '=';
  if (typeof separator !== 'string' || separator.length !== 1) throw new Error('separator must be one character');
  const columns = request.columns ?? KV_COLUMNS;
  if (request.schemaOnly) return { columns, rows: [] };
  const rows: SqlValue[][] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    const at = line.indexOf(separator);
    if (at < 0) throw new Error(`line ${i + 1}: no '${separator}'`);
    const fields: Record<string, SqlValue> = { key: line.slice(0, at), value: line.slice(at + 1) };
    // Declared columns are matched by name; a column the file does not have is NULL.
    rows.push(columns.map((c) => fields[c.name.toLowerCase()] ?? null));
  });
  return { columns, rows };
}

const kv: SmaltPlugin = {
  name: '@acme/kv',
  version: '1.0.0',
  apiVersion: 1,
  setup(host) {
    // State of this engine instance: the mem: files, and the session that put each one.
    const files = new Map<string, { text: string; version: number; session: string }>();
    let nextVersion = 1;

    host.addFormat({
      name: 'kv',
      extensions: ['kv'],
      options: ['separator'],
      access: 'bytes',
      read: async (bytes, request) => readKv(new TextDecoder().decode(bytes), request),
    });
    host.addTableFunction('read_kv', { format: 'kv' });

    const fileOf = (target: SourceTarget) => {
      const name = target.location.slice('mem:'.length);
      const file = files.get(name);
      if (!file) throw new Error(`no mem: file named '${name}'`);
      return file;
    };
    host.addSource({
      name: 'mem',
      prefixes: ['mem:'],
      async open(target) {
        const file = fileOf(target);
        return { bytes: async () => ({ bytes: new TextEncoder().encode(file.text), validator: String(file.version) }) };
      },
      validator: async (target) => String(fileOf(target).version),
      async list(target): Promise<ListedFile[]> {
        const pattern = host.glob.regExp(target.location.slice('mem:'.length));
        return [...files.keys()]
          .filter((name) => pattern.test(name))
          .sort()
          .map((name) => ({ location: `mem:${name}`, path: name, validator: String(files.get(name)!.version) }));
      },
    });

    host.addMethod('put', (ctx, [name, text]) => {
      if (typeof name !== 'string' || typeof text !== 'string') {
        throw Object.assign(new Error('put(name, text) takes two strings'), { code: 'SMALT_MISUSE' });
      }
      files.set(name, { text, version: nextVersion++, session: ctx.session });
    });
    // A tab's files go with the tab.
    host.onSessionClosed((session) => {
      for (const [name, file] of files) if (file.session === session) files.delete(name);
    });
  },
};

// Use it in-process.
const db = Database.openMemory({ plugins: [kv] });
await db.callPlugin('@acme/kv', 'put', ['config/app.kv', 'theme=dark\nlang=en\n']);
const { rows } = await db.queryAsync("SELECT key, value FROM read_kv('mem:config/*.kv') ORDER BY key");
console.log(rows); // [['lang', 'en'], ['theme', 'dark']]
```

`read_kv('mem:config/*.kv')` uses both halves: the `mem:` source lists the files that match the pattern and opens
each, and the `kv` format parses them. The format also reads `.kv` files from any other source, such as
`read_kv('https://…/app.kv')` with `@smaltdb/external`, and the source serves other formats:
`read_csv('mem:a.csv')` with `@smaltdb/io`.

A plugin usually ships a client module with typed helpers, so the application does not call `callPlugin` itself.
The helper accepts any object with a `callPlugin` method, so it takes a client `Database` and an engine `Database`
alike, and imports nothing from smaltdb:

```ts
/** What the helper needs of a database: a client or engine `Database`. */
interface PluginCaller {
  callPlugin(plugin: string, method: string, args: unknown[], options?: { lock?: boolean; replay?: string; dropReplay?: boolean; signal?: AbortSignal }): Promise<unknown>;
}

/** Make `text` readable as `mem:<name>`. */
export async function put(db: PluginCaller, name: string, text: string): Promise<void> {
  await db.callPlugin('@acme/kv', 'put', [name, text], { replay: 'mem:' + name });
}
```

In the browser, the application installs the plugin in its engine worker entry, like smaltdb's own plugins:

```ts
// db-worker.ts
import { serve } from 'smaltdb/worker-runtime';
import type { SmaltPlugin } from 'smaltdb/engine';
declare const kv: SmaltPlugin; // import kv from '@acme/kv';

serve({ plugins: [kv] });
```

## SmaltPlugin

The object a plugin package exports, usually as its default export.

| Field | Type | Description |
|---|---|---|
| `name` | `string` | The package name, such as `@smaltdb/parquet`. Methods are called by this name. |
| `version` | `string` | The plugin's version. `db.plugins` lists it. |
| `apiVersion` | `number` | The plugin interface version it was written for: `1`. |
| `setup(host: PluginHost): void` | function | Registers what the plugin provides. Runs once per engine instance. |

Installing a plugin fails with `SMALT_MISUSE` when:
- its `apiVersion` is not the engine's `PLUGIN_API_VERSION` (`plugin … needs plugin API version 2; this engine implements version 1`);
- a plugin with the same `name` is already installed (`plugin … is installed twice`);
- it registers a name that is already taken (`plugin …: format 'csv' is already defined`). Names are compared without
  regard to case. This covers format names and aliases, table functions, source prefixes, a second source for plain
  paths, connection types and aliases, and method names within the plugin. A file extension may be registered again:
  the last plugin to register it wins.

`setup` runs when the database is created, in `Database.open()`, `Database.openMemory()` and in the engine worker. An
error that `setup` throws fails the open.

## PluginHost

What `setup` receives. Every member is safe to keep and use after `setup` returns.

| Member | Description |
|---|---|
| `apiVersion: number` | The engine's plugin interface version (`1`). |
| `addFormat(format: FormatReader): void` | A file format for external tables and table functions. See [Formats](#formats). |
| `addTableFunction(name: string, spec: { format: string \| ((location: string) => string) }): void` | A table function such as `read_parquet(location, …)` that reads one format. `format` may depend on the location: `read_csv` reads `.tsv` files as TSV. |
| `addSource(source: SourceHandler): void` | Where external data is read from. See [Sources](#sources). |
| `addConnectionType(type: string, spec: ConnectionTypeSpec): void` | A `CREATE CONNECTION … WITH (type = '…')` type. See [Connection types](#connection-types). |
| `addMethod(name: string, method: PluginMethod): void` | A method the application calls with `callPlugin(pluginName, name, args)`. See [Methods](#methods). |
| `onSessionClosed(listener: (session: string) => void): void` | Called when a client session (a tab) goes away. Drop what that session registered. |
| `ask(session: string, message: unknown, timeoutMs?: number): Promise<unknown>` | Ask a client session a question. See [Asking the client](#asking-the-client). |
| `glob: { isGlob(pattern), regExp(pattern), prefix(pattern) }` | Glob helpers for sources that list files. See [Patterns](#patterns). |
| `formatReal(value: number): string` | A REAL as SQLite prints it as text: `2.0`, `1.0e+20`, 17 significant digits. `@smaltdb/io` uses it to export REAL columns. |

## Formats

`host.addFormat(format)` registers a `FormatReader`:

| Field | Type | Description |
|---|---|---|
| `name` | `string` | The format name in `format = '…'`, lower case. |
| `aliases` | `string[]` | Other names for it in `format = '…'`, such as `jsonl` for `json`. |
| `extensions` | `string[]` | File extensions that select it, lower case, without the dot. |
| `options` | `string[]` | Reader options it accepts in SQL, besides `format` and `hive_partitioning`. |
| `pushdown` | `boolean` | It uses `projection`, `blockFilters` and `schemaOnly`, to read only what a statement needs. |
| `access` | `'bytes'` \| `'random'` | How it reads a file: all of it, or by byte ranges. |
| `read(file, request): Promise<FormatResult>` | function | With `access: 'bytes'`, `file` is a `Uint8Array` of the whole file. With `access: 'random'`, it is a `RandomAccessFile`. |

The format of a location is the `format` option if given, else the table function's format, else the format whose
extensions include the location's extension (ignoring a URL's `?…` and `#…`). The options SQL accepts are those of all
installed formats together, so one format may receive another's options. A reader option that no installed format accepts
fails with `SMALT_EXTERNAL` (`unknown option 'x'`). For a table function, `options.format` holds the function's format
when SQL gave none.

A `RandomAccessFile` is `{ byteLength: number; slice(start: number, end?: number): ArrayBuffer | Promise<ArrayBuffer> }`.
When the source has no random access, the engine reads the whole file and gives the format a `RandomAccessFile` over
the bytes.

A random-access format that finds the bytes inconsistent with the file's size throws an error with
`wholeFileMayHelp: true`. `@smaltdb/parquet` does this when there is no footer where the size puts it, as when a host
reports a compressed size. The engine then reads the whole file with the source's `bytes()` and calls `read` once more
over it, unless the source's `complete()` says the read was already over the whole file or an exact size (see
[OpenedFile](#openedfile)). Other errors, and errors with a `SMALT_` code, are reported at once.

### FormatRequest

What the engine asks the format for:

| Field | Type | Description |
|---|---|---|
| `label` | `string` | The table or table-function call, such as `orders` or `read_parquet('…')`. The engine already puts it in front of error messages. |
| `options` | `Record<string, SqlValue>` | Reader options from SQL (`WITH (…)` or named arguments), with lower-case keys. |
| `columns` | `FormatColumn[]` \| undefined | The columns to return, matched by name without regard to case. Undefined: return the file's own columns. |
| `projection` | `ReadonlySet<string>` \| undefined | With `pushdown`: the columns the statement reads, lower case. Others may be returned as NULL without being read. Undefined: every column. |
| `blockFilters` | array \| undefined | With `pushdown`: functions `(zones: Map<string, Zone>, rows: number) => boolean \| undefined` from the statement's `WHERE` clause. A block of rows (a Parquet row group) may be skipped when one returns `false` for the block's column statistics. `zones` is keyed by lower-case column name. |
| `schemaOnly` | `boolean` | With `pushdown`: return the columns only, no rows (when planning, and for `CREATE EXTERNAL TABLE` without a column list). Without `pushdown` it is always `false`, and the engine reads the whole file to learn its columns. |

A `Zone` is `{ nulls: number; numMin?: number; numMax?: number; textMin?: string; textMax?: string }`. `nulls` is the
number of NULLs, or `-1` when unknown. Set `numMin`/`numMax` when every non-NULL value is a number, and
`textMin`/`textMax` when every one is text, compared by code point (the order of SQLite's `BINARY` collation). Leave them out when you do not know
them: a block is then never skipped for that column.

### FormatResult

`{ columns: FormatColumn[]; rows: SqlValue[][] }`. A `FormatColumn` is `{ name: string; declType: string }`, where
`declType` is a declared type such as `INTEGER`, `REAL`, `TEXT`, `BLOB` or `ANY`.

- With `request.columns`, return those columns, in that order, and one value per column in each row.
- The engine types the columns from `declType` by SQLite's affinity rules.
- Values are `SqlValue`s: `null`, `number`, `bigint` (integers beyond 2^53), `string` or `Uint8Array`.

## Sources

`host.addSource(source)` registers a `SourceHandler`:

| Field | Type | Description |
|---|---|---|
| `name` | `string` | For messages. |
| `prefixes` | `string[]` | It handles locations that start with one of these, without regard to case: `https:`, `s3://`, `file:`. |
| `connectionTypes` | `string[]` | It also handles locations relative to a connection of one of these types. |
| `paths` | `boolean` | It handles plain paths with no connection (one source only; `@smaltdb/external` uses it for the Node file system). |
| `open(target, ctx): Promise<OpenedFile>` | function | Open a file for reading. |
| `validator(target, ctx): Promise<string \| null>` | function | The file's current validator only, without its data (a `HEAD` request, a stat). For `REFRESH … IF CHANGED`. |
| `isPattern(target): boolean` | optional | Whether `target` is a pattern to list. |
| `list(target, ctx): Promise<ListedFile[]>` | optional | The files a pattern matches, sorted by path. Without it, patterns fail with `wildcards need a source that can be listed, not <name>`. |

The engine picks the source for a location like this:
1. A location with a scheme (`x:`, but not a Windows drive such as `C:\`) goes to the source with a matching prefix.
2. Otherwise, a location read through a connection goes to the source for that connection's type.
3. Otherwise, it goes to the source with `paths`.

A **`SourceTarget`** is `{ location: string; connection?: { name: string; options: Record<string, SqlValue> } }`: the
location as written in SQL, and the connection it is relative to, with its options: keys in lower case, values
as written, including `type` and `credentials`. A **`SourceContext`** is `{ label: string; signal?: AbortSignal }`. Pass `signal` to your
requests: when the statement is cancelled, it aborts them.

### OpenedFile

Each way of reading the file returns its **validator** too: a string that changes when the file changes (an ETag,
Last-Modified, a file's mtime and size), or `null` for none. Take it from the same response or stat as the data. A
source with no validator makes a view over it count as changed at every `IF CHANGED` refresh.

| Member | Description |
|---|---|
| `bytes(): Promise<{ bytes: Uint8Array; validator: string \| null }>` | The whole file. |
| `random?(): Promise<{ file: RandomAccessFile; validator: string \| null; complete?: () => boolean }>` | Random access, for formats with `access: 'random'`. Absent: those formats get the whole file. |
| `close?(): Promise<void>` | Called when the read is done, also after an error. |

The engine calls `open`, then `random()` if the format has `access: 'random'` and the source has it, else `bytes()`,
then `close()`.

`complete()` returns `true` when reading the whole file could not change the result: the bytes in hand are already the
whole file (a server that ignored `Range`), or `byteLength` is exact (a local or registered file). The engine asks it
only after a format error with `wholeFileMayHelp`. When it returns `false`, or is absent, the engine calls `bytes()`
and reads once more. `@smaltdb/external` returns `true` for `file:` locations and local paths. For HTTP, S3 and Azure,
it returns `true` once it holds the whole body, because the server ignored a range or the size was unknown.

### Patterns

A `ListedFile` is `{ location: string; path: string; validator?: string | null }`:
- `location` is a location that `open` accepts with the same connection;
- `path` is the path the pattern matched, from which `key=value` partitions are read (`sales/year=2024/a.csv`);
- `validator` is the file's validator, when the listing has it. Without it, the engine calls `validator()` for that
  file at `IF CHANGED`.

Without `isPattern`, a location is a pattern when it has `*`, `?`, `[` or `{`, ignoring a URL's query after `?` for
`scheme://` locations. Give `isPattern` when your locations resolve differently: `@smaltdb/external` treats `?` in an
HTTP URL as the start of the query, but as a wildcard in S3 keys. `isPattern` must not throw: return `false` for a
location it cannot resolve, and let `open` report the problem.

`host.glob` gives the engine's pattern syntax, so every source matches the same way:

| Helper | Description |
|---|---|
| `isGlob(pattern)` | Whether `pattern` has a wildcard. |
| `regExp(pattern)` | A `RegExp` that matches whole paths: `*` within a directory, `**` across directories (also none), `?` one character, `[abc]`, `[a-z]`, `[!abc]`, `{a,b}`. |
| `prefix(pattern)` | The literal part before the first wildcard: the prefix to list. |

## Connection types

`host.addConnectionType(type, spec)` adds a type for `CREATE CONNECTION … WITH (type = '…')`. A `ConnectionTypeSpec`
is:

| Field | Type | Description |
|---|---|---|
| `options` | `string[]` | The options the type accepts, besides `type` and `credentials`. Others fail with `unknown option`. |
| `aliases` | `string[]` | Other names for the type. `@smaltdb/external` makes `https` an alias of `http`. |
| `validate(options)` | optional function | Check the options; throw to reject them. The error becomes `SMALT_ERROR`: `connection c: <message>`. |

A connection without `type` has type `http`. The engine checks the options when the connection is created. Statements
that read through the connection go to the source whose `connectionTypes` include its type.

## Methods

`host.addMethod(name, method)` adds a method that the application calls with `db.callPlugin(pluginName, name, args)`.
A `PluginMethod` is `(ctx: MethodContext, args: unknown[]) => unknown | Promise<unknown>`. Its result is the result
of `callPlugin`.

`MethodContext`:

| Member | Description |
|---|---|
| `db: Database` | The engine `Database` the call runs on, with its synchronous API: `exec`, `query`, `prepare`, `inTransaction`, `getTable`. |
| `session: string` | The calling client session (a tab), or `'local'` in-process. |
| `signal?: AbortSignal` | Aborted when the call is cancelled. |
| `query(sql, params?): Promise<{ columns: string[]; rows: SqlValue[][]; columnTypes: StaticType[] }>` | Run one statement that may read external data (its sources are fetched first). Returns its rows, column names, and the static type of each column: `'int'`, `'real'`, `'num'`, `'text'`, `'blob'`, `'null'` or `'any'`. |

Through the worker client, `args` and the result cross to the engine worker with `postMessage`, so they must be values
the browser can clone: no functions. In-process, they are passed as they are.

### Calling plugin methods

Client `Database` (`smaltdb`):

`db.callPlugin(plugin: string, method: string, args: unknown[], options?: { lock?: boolean; replay?: string; dropReplay?: boolean; signal?: AbortSignal }): Promise<unknown>`

| Option | Description |
|---|---|
| `lock` | Wait for earlier `exec` calls and transactions of this `Database`, and hold off later ones, as `exec` does. Use it for methods that write or read the database. Such a call inside a `db.transaction()` callback waits for the transaction, so it never finishes. |
| `replay` | A key under which this tab stores the call. When this tab takes over a shared database ([multi-tab access](../../guide/databases#multi-tab-access)), or the owning tab changes, it sends its stored calls again to the new engine worker. A later call with the same key replaces the stored one. Use it for state that lives in the worker, such as registered files. |
| `dropReplay` | With `replay`: remove the stored call. The call itself is still sent. |
| `signal` | Cancels the call; it rejects with `SMALT_INTERRUPT`. |

Engine `Database` (`smaltdb/engine`):

`db.callPlugin(plugin: string, method: string, args: unknown[], options?: { session?: string; signal?: AbortSignal }): Promise<unknown>`

`session` defaults to `'local'`; the engine worker sets it to the calling tab's session. A helper written against
the client's options works with both, since the engine ignores `lock`, `replay` and `dropReplay`.

`callPlugin` rejects with `SMALT_PLUGIN_MISSING` when the plugin is not installed, and with `SMALT_MISUSE` when it has
no such method (`plugin @acme/kv has no method get`).

### Asking the client

A method or source sometimes needs something only the tab has: fresh credentials from a function, a token from the
page. `host.ask(session, message, timeoutMs = 30000)` sends `message` to the client session `session` and resolves to
its answer.

The application answers with a handler on its client `Database`:

`db.onPluginMessage(plugin: string, handler: ((message: unknown) => unknown) | null): void`

The handler's return value, or the value its promise resolves to, is the answer. One handler per plugin; `null`
removes it. The message and the answer must be values the browser can clone.

Sources and formats do not get a session. Remember it from the method that registered the state, as the example
does with `ctx.session`.

`ask` rejects with an `AskError`. Its `reason` says why, and the plugin words its own message from it:

| `reason` | `code` | When |
|---|---|---|
| `'timeout'` | `SMALT_EXTERNAL` | No answer within `timeoutMs`. |
| `'closed'` | `SMALT_EXTERNAL` | The session closed before it answered. |
| `'failed'` | `SMALT_EXTERNAL` | The handler threw, or the tab has no handler for this plugin. `detail` holds the handler's error message, or `this tab has no handler for <plugin> (onPluginMessage)`. |
| `'no-session'` | `SMALT_MISUSE` | There is no client to ask: in-process, or for work the engine worker does by itself, such as a [refresh policy](../../guide/views-and-materialized-views#refresh-policies). |

`AskError` extends `Error` with `code`, `reason` and `detail?`.

## Errors

How the engine reports an error a plugin throws:

| Thrown by | An `Error` with a `code` starting with `SMALT_` | Any other error |
|---|---|---|
| A format's `read`, a source's `open`, `bytes`, `random`, `close`, `validator` or `list` | Passed through with its code and message. | `SMALT_EXTERNAL`, with the label in front: `read_kv('mem:x.kv'): line 2: no '='`. An `AbortError` becomes `SMALT_INTERRUPT`. |
| A method, in-process | Passed through as it is. | Passed through as it is. |
| A method, through the engine worker | The client gets its code and message. | The client gets `SMALT_INTERNAL` with its message. |
| A connection type's `validate` | `SMALT_ERROR`: `connection c: <message>`. | `SMALT_ERROR`: `connection c: <message>`. |
| `setup` | Opening the database fails with the error. | Opening the database fails with the error. |

So a format or source throws a plain `Error` for problems with the data or the network. A method that can fail for
reasons the application should handle gives its errors a code: `@smaltdb/io` throws errors with `code: 'SMALT_ERROR'`
for bad import data, and passes on the engine's own errors, such as `SMALT_CONSTRAINT_NOTNULL`.

Do not put the label in your messages: the engine adds it. For a pattern, the label also names the file:
`orders (sales/2024/a.csv): …`.

## When a plugin is missing

A database never needs a plugin to open. External tables and connections stay in the catalog without their plugins,
and can be listed and dropped. A statement that needs a missing plugin fails with `SMALT_PLUGIN_MISSING` when it is
planned or run, and so does `callPlugin` for a plugin that is not installed.

For smaltdb's own plugins, the engine knows which plugin provides what, so the message names it:
`read_parquet('file:x.parquet'): the parquet format needs the @smaltdb/parquet plugin (install it and add it to the
engine's plugins)`.

The engine knows nothing about other plugins, so what a missing one causes depends on the feature. With the example
plugin missing:

| Statement or call | Error |
|---|---|
| `db.callPlugin('@acme/kv', 'put', …)` | `SMALT_PLUGIN_MISSING`: `put(): this call needs the @acme/kv plugin (…)` |
| `read_csv('…', format => 'kv')` | `SMALT_PLUGIN_MISSING`: `no installed plugin provides the 'kv' format` |
| `read_kv('…')` | `SMALT_ERROR`: `no such table-valued function: read_kv` |
| An external table over `x.kv`, with no `format` | `SMALT_EXTERNAL`: `cannot tell the format of 'x.kv': add format = '…'` |
| A `mem:` location | `SMALT_EXTERNAL`: `unsupported location 'mem:…'` |
| `CREATE CONNECTION c WITH (type = 'kvc')` | `SMALT_ERROR`: `connection c: type 'kvc' is not supported` |

## How smaltdb's plugins use the interface

| Piece | `@smaltdb/io` | `@smaltdb/external` | `@smaltdb/parquet` |
|---|---|---|---|
| `addFormat` | `csv` (extensions `csv`, `txt`), `tsv`, `json` (aliases `ndjson`, `jsonl`); `access: 'bytes'` | | `parquet` (alias `pq`; extensions `parquet`, `pq`); `access: 'random'`, `pushdown: true` |
| `addTableFunction` | `read_csv` (TSV for `.tsv` locations), `read_json` | | `read_parquet` |
| `addSource` | | `file` (`file:`), `http` (`http:`, `https:`), `s3` (`s3://`), `azure` (`az://`, `azure://`), `path` (plain paths, with `paths: true`). All share one `isPattern` and `list`; listing fails for HTTP URLs. | |
| `addConnectionType` | | `http` (alias `https`), `s3`, `azure`, each with `validate` | |
| `addMethod` | `importCSV`, `importJSON` (write with `ctx.db` in one transaction), `exportCSV`, `exportJSON` (read with `ctx.query`) | `registerFile`, `registerCredentials`, `setFetch` | |
| `onSessionClosed` | | Drops credentials whose functions live in the closed tab | |
| `ask` | | Asks the registering tab for each request's credentials, with a 30-second timeout | |
| `glob` | | `regExp` and `prefix` to list registered files, S3, Azure and Node directories | |
| `formatReal` | REAL values in exports | | |
| Client helpers | `@smaltdb/io/client`: the four methods, with `lock: true` | `@smaltdb/external/client`: `registerFile` and `registerCredentials` with `replay` keys `file:<name>` and `cred:<name>`; `registerCredentials` sets an `onPluginMessage` handler for providers with functions | |
