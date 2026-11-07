/**
 * Plugins (ADR 0012): optional features published as separate packages, each in its own
 * repository (`@smaltdb/parquet`, `@smaltdb/external`, `@smaltdb/io`), installed into an engine with
 * `Database.open(…, { plugins })` or, in the browser, a worker entry that calls
 * `serve({ plugins })` (smaltdb/worker-runtime).
 *
 * A plugin imports nothing from the engine at run time (only these types), so it works with any
 * copy of the engine an application bundles. Everything it needs comes through `PluginHost`.
 *
 * API version 1 is stable (ADR 0013): within it, changes are additive only (new optional members of what
 * plugins implement, new PluginHost members, new fields passed in). Anything else is a new
 * PLUGIN_API_VERSION. test/plugin-api.test.ts fails to type-check when a change would break a version 1 plugin.
 */
import { SmaltError, errorCode } from './errors.js';
import type { Database } from './database.js';
import { formatReal } from './catalog/schema.js';
import { globPrefix, globRegExp, isGlob } from './external/glob.js';
import type { StaticType } from './exec/convert.js';
import type { PlanStatementInput } from './plan/statement.js';
import type { Zone } from './storage/columnar.js';
import type { SqlValue } from './values.js';

export type { SqlValue, StaticType, Zone };

/** The plugin interface version this engine implements. */
export const PLUGIN_API_VERSION = 1;

export interface SmaltPlugin {
  /** Package name, e.g. `@smaltdb/parquet`. */
  name: string;
  version: string;
  /** The plugin interface it was written for: an engine refuses other versions. */
  apiVersion: number;
  /** Register what the plugin provides; runs once per engine instance (state kept in its closure is per engine). */
  setup(host: PluginHost): void;
}

export interface PluginHost {
  /** The engine's plugin interface version ({@link PLUGIN_API_VERSION}). */
  readonly apiVersion: number;
  /** A file format for external tables and table functions. */
  addFormat(format: FormatReader): void;
  /**
   * A table function such as `read_parquet(location, …)` that reads one format. `format` may be a
   * function of the location (`read_csv` reads `.tsv` files as TSV).
   */
  addTableFunction(name: string, spec: { format: string | ((location: string) => string) }): void;
  /** Where external data comes from: URLs, object stores, registered files, local paths. */
  addSource(source: SourceHandler): void;
  /**
   * A `CREATE CONNECTION … WITH (type = '…')` type: the options it accepts (besides `type` and
   * `credentials`), other names for the type, and a check of the options (throw to reject them).
   */
  addConnectionType(type: string, spec: ConnectionTypeSpec): void;
  /** A method the application calls with `callPlugin(plugin, name, args)` (client or engine). */
  addMethod(name: string, method: PluginMethod): void;
  /**
   * Called when a client session (a tab) goes away, after its transaction is rolled back: drop what
   * it registered. A listener that throws is logged and does not stop the others.
   */
  onSessionClosed(listener: (session: string) => void): void;
  /**
   * Ask the client session `session` a question, answered by the handler the application set with
   * `onPluginMessage(plugin, handler)` (e.g. fresh credentials). It rejects with an {@link AskError}:
   * after `timeoutMs` (default 30 s), when the session closes, when the handler fails or is missing,
   * or in-process, where there is no client to ask. Plugins word their own messages from its `reason`.
   */
  ask(session: string, message: unknown, timeoutMs?: number): Promise<unknown>;
  /** Glob helpers, for sources that list files: the regular expression and the fixed prefix of a pattern. */
  readonly glob: { isGlob(pattern: string): boolean; regExp(pattern: string): RegExp; prefix(pattern: string): string };
  /** A REAL as SQLite prints it as text (`2.0`, `1.0e+20`, 17 significant digits). */
  formatReal(value: number): string;
}

export interface ConnectionTypeSpec {
  options: string[];
  aliases?: string[];
  validate?(options: Record<string, SqlValue>): void;
}

/** Why {@link PluginHost.ask} failed, for the plugin to word its own message. */
export interface AskError extends Error {
  code: 'SMALT_EXTERNAL' | 'SMALT_MISUSE';
  reason: 'timeout' | 'closed' | 'failed' | 'no-session';
  /** For 'failed': the handler's error message (or that the tab has no handler). */
  detail?: string;
}

/** An {@link AskError}. */
export function askError(reason: AskError['reason'], message: string, detail?: string): AskError {
  return Object.assign(new SmaltError(reason === 'no-session' ? 'SMALT_MISUSE' : 'SMALT_EXTERNAL', message), { reason, detail }) as unknown as AskError;
}

/** A plugin method: runs in the engine with the database and the calling session. */
export type PluginMethod = (ctx: MethodContext, args: unknown[]) => unknown | Promise<unknown>;

export interface MethodContext {
  /** The engine database the call runs on. */
  db: Database;
  /** The calling session (a tab), or `'local'` in-process. */
  session: string;
  /**
   * Aborted when the call is cancelled, or (engine worker) when its session closes. In the engine
   * worker a method whose write hits SMALT_BUSY (another tab's open result) is run again from the
   * start once the reads end: keep side effects before its first write idempotent.
   */
  signal?: AbortSignal;
  /**
   * Run one statement that may read external data (its sources are fetched first) and return its
   * rows, column names and the static type of each column.
   */
  query(sql: string, params?: readonly SqlValue[] | Readonly<Record<string, SqlValue>>): Promise<{ columns: string[]; rows: SqlValue[][]; columnTypes: StaticType[] }>;
  /**
   * Run one statement given as plan data (`Database.preparePlan`; the plan format is experimental) and return its
   * rows, column names and static types. Its external sources are fetched first. Optional: engines before 0.9.0 lack it.
   */
  queryPlan?(stmt: PlanStatementInput, params?: readonly SqlValue[]): Promise<{ columns: string[]; rows: SqlValue[][]; columnTypes: StaticType[] }>;
}

// ------------------------------------------------------------------ formats

/** A column of external data: its name and declared type (INTEGER, REAL, TEXT, BLOB, ANY, …). */
export interface FormatColumn {
  name: string;
  declType: string;
  /**
   * Dates and times (ADR 0019): the column's values are integers of this type, days for `date` and µs for the others,
   * and results give them as text (`2026-11-07`). Lists and structs (ADR 0020): a `list<…>` or `struct<…>` type, the
   * values JS arrays and objects (or their bytes). Absent: the column is typed from `declType`. Optional since API
   * version 1 (engines before it ignore it).
   */
  type?: 'date' | 'datetime' | 'time' | 'duration' | `list<${string}>` | `struct<${string}>`;
}

/** Random access to a file: its size and byte ranges (HTTP Range requests, Blob slices, file reads). */
export interface RandomAccessFile {
  byteLength: number;
  slice(start: number, end?: number): ArrayBuffer | Promise<ArrayBuffer>;
}

/** What the engine asks a format reader for. */
export interface FormatRequest {
  /** For messages: the table or table-function call (`orders`, `read_parquet('…')`). */
  label: string;
  /** Reader options from SQL (`WITH (…)` or named arguments), lower-case keys. */
  options: Record<string, SqlValue>;
  /** The columns to return, matched by name (case-insensitive); undefined: the file's own columns. */
  columns?: FormatColumn[];
  /**
   * With {@link FormatReader.pushdown}: the columns the statement reads (lower case). Columns not
   * in it may be returned as NULL without being read. undefined: every column.
   */
  projection?: ReadonlySet<string>;
  /**
   * With {@link FormatReader.pushdown}: conditions from the statement's WHERE clause. A block of
   * rows (a Parquet row group) may be skipped when one returns false for its columns' statistics
   * (lower-case names).
   */
  blockFilters?: readonly ((zones: Map<string, Zone>, rows: number) => boolean | undefined)[];
  /** Return the columns only, no rows (planning and column inference). */
  schemaOnly: boolean;
}

/** A format reader's result. */
export interface FormatResult {
  columns: FormatColumn[];
  rows: SqlValue[][];
}

/**
 * A file format. `access: 'random'` readers get a {@link RandomAccessFile}, so they can read only
 * the parts they need; `'bytes'` readers get the whole file. Errors thrown are reported as
 * SMALT_EXTERNAL with the source's label in front.
 *
 * A random-access reader that finds the bytes inconsistent with the file's size (a Parquet footer
 * missing where the size puts it: some hosts report a compressed size) throws an error with
 * `wholeFileMayHelp: true`. The engine then reads the file once more in full ({@link OpenedFile.bytes})
 * and retries, unless the source says the bytes it gave were already the whole file or the size was
 * exact ({@link RandomFile.complete}); other errors are reported at once.
 */
export type FormatReader = {
  /** Format name, as in `format = 'parquet'` (lower case). */
  name: string;
  /** Other names for it in `format = '…'` (e.g. `jsonl` for `ndjson`). */
  aliases?: string[];
  /** File extensions that select it (lower case, no dot). */
  extensions: string[];
  /** Reader options it accepts in SQL (besides `format` and `hive_partitioning`). */
  options?: string[];
  /** It uses `projection`, `blockFilters` and `schemaOnly` (reads only what a statement needs). */
  pushdown?: boolean;
} & (
  | { access: 'random'; read(file: RandomAccessFile, request: FormatRequest): Promise<FormatResult> }
  | { access: 'bytes'; read(bytes: Uint8Array, request: FormatRequest): Promise<FormatResult> }
);

// ------------------------------------------------------------------ sources

/** Where to read from: a location as written in SQL, and the connection it is relative to. */
export interface SourceTarget {
  location: string;
  connection?: { name: string; options: Record<string, SqlValue> };
}

export interface SourceContext {
  /** For messages: the table or table-function call. */
  label: string;
  signal?: AbortSignal;
}

/**
 * An opened file. Each way of reading it also returns its validator (ETag, Last-Modified, a file's
 * mtime and size; null: none), taken from the same response or stat as the data.
 */
export interface OpenedFile {
  /** The whole file. */
  bytes(): Promise<{ bytes: Uint8Array; validator: string | null }>;
  /** Random access, for formats that read parts (absent: the whole file is read). */
  random?(): Promise<RandomFile>;
  close?(): Promise<void>;
}

/** What {@link OpenedFile.random} returns. */
export interface RandomFile {
  file: RandomAccessFile;
  validator: string | null;
  /**
   * True when a read that failed would fail the same way with the whole file: the bytes in hand
   * are the whole file (a server that ignored ranges), or `byteLength` is exact (a local or
   * registered file). Asked after a reader error with `wholeFileMayHelp`; false or absent, the
   * engine reads the whole file with {@link OpenedFile.bytes} and retries once (a remote size can
   * be wrong: a host that reports a compressed size).
   */
  complete?: () => boolean;
}

/** A file a pattern matched. */
export interface ListedFile {
  /** A location {@link SourceHandler.open} accepts with the same connection. */
  location: string;
  /** The path the pattern matched and partitions are read from (`sales/year=2024/a.csv`). */
  path: string;
  /** Its validator, when the listing has it. */
  validator?: string | null;
}

/**
 * A source: the locations it handles are those starting with one of `prefixes` (`https://`,
 * `s3://`, `file:`), locations relative to a connection of one of `connectionTypes`, and, with
 * `paths`, plain paths with no connection (the Node file system).
 */
export interface SourceHandler {
  name: string;
  prefixes: string[];
  connectionTypes?: string[];
  paths?: boolean;
  open(target: SourceTarget, ctx: SourceContext): Promise<OpenedFile>;
  /** The validator only (a HEAD request, a stat): for REFRESH … IF CHANGED. */
  validator(target: SourceTarget, ctx: SourceContext): Promise<string | null>;
  /**
   * Whether `target` is a pattern to list. Default: the location has a wildcard (`*`, `?`, `[`, `{`),
   * ignoring a URL's query after `?` for `scheme://` locations. A source decides itself when its
   * locations resolve differently (a key relative to a connection, `?` as a wildcard in object keys).
   */
  isPattern?(target: SourceTarget): boolean;
  /** The files a pattern (`*`, `**`, `?`, `[…]`, `{a,b}`) matches, sorted by path. Without it, patterns are errors. */
  list?(target: SourceTarget, ctx: SourceContext): Promise<ListedFile[]>;
}

// ------------------------------------------------------------------ registry

/** What smaltdb's own plugins provide, for an error that names the package to install. */
const KNOWN_FORMATS: Record<string, string> = {
  parquet: '@smaltdb/parquet',
  pq: '@smaltdb/parquet',
  csv: '@smaltdb/io',
  tsv: '@smaltdb/io',
  txt: '@smaltdb/io',
  json: '@smaltdb/io',
  ndjson: '@smaltdb/io',
  jsonl: '@smaltdb/io',
};
const KNOWN_FUNCTIONS: Record<string, { plugin: string; format: (location: string) => string }> = {
  read_parquet: { plugin: '@smaltdb/parquet', format: () => 'parquet' },
  read_csv: { plugin: '@smaltdb/io', format: (l) => (/\.tsv([?#]|$)/i.test(l) ? 'tsv' : 'csv') },
  read_json: { plugin: '@smaltdb/io', format: () => 'json' },
};
const KNOWN_SOURCES: [RegExp, string][] = [[/^(https?:|s3:\/\/|az:\/\/|azure:\/\/|file:)/i, '@smaltdb/external']];
const KNOWN_CONNECTIONS: Record<string, string> = { http: '@smaltdb/external', https: '@smaltdb/external', s3: '@smaltdb/external', azure: '@smaltdb/external' };
const KNOWN_METHODS: Record<string, string> = { '@smaltdb/io': 'import and export', '@smaltdb/external': 'registering files and credentials' };

/** 'a' or 'an' before a word (`an s3 connection`, `an http connection`). */
const article = (word: string): string => (/^([aeiou]|s3|https?\b)/i.test(word) ? 'an' : 'a');

/** A feature that needs a plugin the engine does not have. */
export function pluginMissing(label: string, what: string, plugin?: string): SmaltError {
  return new SmaltError(
    'SMALT_PLUGIN_MISSING',
    plugin ? `${label}: ${what} needs the ${plugin} plugin (install it and add it to the engine's plugins)` : `${label}: ${what} needs a plugin this engine does not have`,
  );
}

/** Is `location` an absolute location with a scheme (not a Windows drive path)? */
const hasScheme = (location: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(location) && !/^[a-z]:[\\/]/i.test(location);

/** The plugins installed in one engine instance, and what they registered. */
export class PluginRegistry {
  readonly plugins: { name: string; version: string }[] = [];
  readonly formats = new Map<string, FormatReader>();
  private readonly formatNames = new Map<string, FormatReader>();
  private readonly byExtension = new Map<string, FormatReader>();
  readonly tableFunctions = new Map<string, { format: string | ((location: string) => string) }>();
  readonly sources: SourceHandler[] = [];
  readonly connectionTypes = new Map<string, { type: string; options: Set<string>; validate?: (options: Record<string, SqlValue>) => void }>();
  private readonly methods = new Map<string, Map<string, PluginMethod>>();
  private readonly sessionListeners: { plugin: string; listener: (session: string) => void }[] = [];
  /** How questions reach client sessions; set by the worker server (none in-process). */
  asker: ((session: string, plugin: string, message: unknown, timeoutMs: number) => Promise<unknown>) | null = null;

  constructor(plugins: readonly SmaltPlugin[] = []) {
    for (const p of plugins) this.install(p);
  }

  private install(p: SmaltPlugin): void {
    if (p.apiVersion !== PLUGIN_API_VERSION) {
      throw new SmaltError('SMALT_MISUSE', `plugin ${p.name} ${p.version} needs plugin API version ${p.apiVersion}; this engine implements version ${PLUGIN_API_VERSION}`);
    }
    if (this.plugins.some((q) => q.name === p.name)) throw new SmaltError('SMALT_MISUSE', `plugin ${p.name} is installed twice`);
    const taken = (what: string, name: string): SmaltError => new SmaltError('SMALT_MISUSE', `plugin ${p.name}: ${what} '${name}' is already defined`);
    const methods = new Map<string, PluginMethod>();
    const host: PluginHost = {
      apiVersion: PLUGIN_API_VERSION,
      addFormat: (f) => {
        for (const n of [f.name, ...(f.aliases ?? [])].map((x) => x.toLowerCase())) {
          if (this.formatNames.has(n)) throw taken('format', n);
          this.formatNames.set(n, f);
        }
        this.formats.set(f.name.toLowerCase(), f);
        for (const e of f.extensions) this.byExtension.set(e.toLowerCase(), f);
      },
      addTableFunction: (name, spec) => {
        const n = name.toLowerCase();
        if (this.tableFunctions.has(n)) throw taken('table function', n);
        this.tableFunctions.set(n, spec);
      },
      addSource: (s) => {
        for (const prefix of s.prefixes) if (this.sources.some((x) => x.prefixes.some((y) => y.toLowerCase() === prefix.toLowerCase()))) throw taken('source prefix', prefix);
        if (s.paths && this.sources.some((x) => x.paths)) throw taken('source for', 'plain paths');
        this.sources.push(s);
      },
      addConnectionType: (type, spec) => {
        const entry = { type: type.toLowerCase(), options: new Set(['type', ...spec.options.map((o) => o.toLowerCase()), 'credentials']), validate: spec.validate };
        for (const t of [type, ...(spec.aliases ?? [])].map((x) => x.toLowerCase())) {
          if (this.connectionTypes.has(t)) throw taken('connection type', t);
          this.connectionTypes.set(t, entry);
        }
      },
      addMethod: (name, method) => {
        if (methods.has(name)) throw taken('method', name);
        methods.set(name, method);
      },
      onSessionClosed: (listener) => void this.sessionListeners.push({ plugin: p.name, listener }),
      ask: (session, message, timeoutMs = 30_000) => {
        if (!this.asker) return Promise.reject(askError('no-session', `plugin ${p.name}: there is no client session to ask (in-process)`));
        return this.asker(session, p.name, message, timeoutMs);
      },
      glob: { isGlob, regExp: globRegExp, prefix: globPrefix },
      formatReal,
    };
    p.setup(host);
    this.methods.set(p.name, methods);
    this.plugins.push({ name: p.name, version: p.version });
  }

  // ---------------------------------------------------------------- formats and functions

  /** The format named in `format = '…'`, or undefined. */
  format(name: string): FormatReader | undefined {
    return this.formatNames.get(name.toLowerCase());
  }

  /** The plugin format registered for a file extension. */
  formatForExtension(ext: string): FormatReader | undefined {
    return this.byExtension.get(ext.toLowerCase());
  }

  /** Whether one of smaltdb's own plugins provides format (or extension) `name`. */
  isKnownFormat(name: string): boolean {
    return name.toLowerCase() in KNOWN_FORMATS;
  }

  /**
   * The error for a format nobody provides. Every format comes from a plugin, so this is
   * SMALT_PLUGIN_MISSING, naming smaltdb's plugin for it when there is one.
   */
  formatMissing(label: string, name: string): SmaltError {
    const n = name.toLowerCase();
    const plugin = KNOWN_FORMATS[n];
    const known = [...this.formatNames.keys()].sort();
    // smaltdb's plugin for it is installed and has no such format (`format = 'txt'`: txt is only an extension).
    if (plugin && this.plugins.some((p) => p.name === plugin)) return new SmaltError('SMALT_EXTERNAL', `${label}: unsupported format '${name}' (${known.join(', ')})`);
    if (plugin) return pluginMissing(label, `the ${n} format`, plugin);
    return new SmaltError('SMALT_PLUGIN_MISSING', `${label}: no installed plugin provides the '${name}' format${known.length ? ` (installed: ${known.join(', ')})` : ''}`);
  }

  /** Whether `name` is a table function that reads external data (from a plugin, or one smaltdb's plugins provide). */
  isExternalFunction(name: string): boolean {
    const n = name.toLowerCase();
    return this.tableFunctions.has(n) || n in KNOWN_FUNCTIONS;
  }

  /** The format a table function reads at `location`. */
  functionFormat(name: string, location: string): string {
    const n = name.toLowerCase();
    const f = this.tableFunctions.get(n)?.format ?? KNOWN_FUNCTIONS[n]?.format;
    if (f === undefined) throw new SmaltError('SMALT_ERROR', `no such table function: ${name}`);
    return typeof f === 'function' ? f(location) : f;
  }

  /** Reader options the installed formats accept. */
  readerOptions(): Set<string> {
    return new Set(['format', 'hive_partitioning', ...[...this.formats.values()].flatMap((f) => (f.options ?? []).map((o) => o.toLowerCase()))]);
  }

  // ---------------------------------------------------------------- sources and connections

  /** The source for `target`, or SMALT_PLUGIN_MISSING / SMALT_EXTERNAL. */
  sourceFor(target: SourceTarget, label: string): SourceHandler {
    const loc = target.location.toLowerCase();
    if (hasScheme(target.location)) {
      const s = this.sources.find((x) => x.prefixes.some((p) => loc.startsWith(p.toLowerCase())));
      if (s) return s;
      const known = KNOWN_SOURCES.find(([re]) => re.test(target.location));
      if (known) return this.throwMissing(pluginMissing(label, `reading ${target.location.replace(/[?#].*$/, '')}`, known[1]));
      throw new SmaltError('SMALT_EXTERNAL', `${label}: unsupported location '${target.location}'${this.sources.length ? ` (${this.sources.flatMap((x) => x.prefixes).join(', ')})` : ''}`);
    }
    if (target.connection) {
      const type = this.connectionType(String(target.connection.options.type ?? 'http'));
      const s = this.sources.find((x) => x.connectionTypes?.some((t) => t.toLowerCase() === type));
      if (s) return s;
      return this.throwMissing(pluginMissing(label, `${article(type)} ${type} connection`, KNOWN_CONNECTIONS[type]));
    }
    const s = this.sources.find((x) => x.paths);
    if (s) return s;
    return this.throwMissing(pluginMissing(label, `reading the path '${target.location}'`, '@smaltdb/external'));
  }

  private throwMissing(e: SmaltError): never {
    throw e;
  }

  /** A connection type's canonical name (aliases resolved; unknown types lower-cased). */
  connectionType(type: string): string {
    return this.connectionTypes.get(type.toLowerCase())?.type ?? type.toLowerCase();
  }

  /** Check a connection's options against its type, or the error for a type nobody provides. */
  checkConnection(name: string, options: Record<string, SqlValue>): void {
    const type = String(options.type ?? 'http');
    const t = type.toLowerCase();
    const spec = this.connectionTypes.get(t);
    if (!spec) {
      if (KNOWN_CONNECTIONS[t]) throw pluginMissing(`connection ${name}`, `${article(t)} ${t} connection`, KNOWN_CONNECTIONS[t]);
      const known = [...new Set([...this.connectionTypes.values()].map((x) => x.type))]; // registration order
      throw new SmaltError('SMALT_ERROR', `connection ${name}: type '${type}' is not supported${known.length ? ` (${known.join(', ')})` : ''}`);
    }
    for (const k of Object.keys(options)) {
      if (!spec.options.has(k)) throw new SmaltError('SMALT_ERROR', `connection ${name}: unknown option '${k}' for type ${spec.type} (${[...spec.options].join(', ')})`);
    }
    try {
      spec.validate?.(options);
    } catch (e) {
      // SmaltErrors, and plugin errors that carry a SMALT_ code, keep their code.
      if (e instanceof SmaltError || errorCode(e) !== 'SMALT_INTERNAL') throw e;
      throw new SmaltError('SMALT_ERROR', `connection ${name}: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- methods and sessions

  /** Run plugin method `plugin`.`method`. */
  async call(ctx: MethodContext, plugin: string, method: string, args: unknown[]): Promise<unknown> {
    const methods = this.methods.get(plugin);
    if (!methods) throw pluginMissing(`${method}()`, KNOWN_METHODS[plugin] ?? 'this call', plugin);
    const m = methods.get(method);
    if (!m) throw new SmaltError('SMALT_MISUSE', `plugin ${plugin} has no method ${method}`);
    return m(ctx, args);
  }

  /**
   * A client session went away. Each listener runs on its own: one that throws is reported and
   * does not keep the others (or the engine's own cleanup) from running.
   */
  sessionClosed(session: string): void {
    for (const { plugin, listener } of this.sessionListeners) {
      try {
        listener(session);
      } catch (e) {
        console.error(`plugin ${plugin}: onSessionClosed listener failed`, e);
      }
    }
  }
}
