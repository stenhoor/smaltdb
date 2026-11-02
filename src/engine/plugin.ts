/**
 * Plugins (ADR 0012): optional features published as separate packages (`@smaltdb/parquet`, …)
 * and installed into an engine with `Database.open(…, { plugins })` or, in the browser, a worker
 * entry that calls `serve({ plugins })` (smaltdb/worker-runtime).
 *
 * A plugin imports nothing from the engine at run time (only these types), so it works with any
 * copy of the engine an application bundles. Everything it needs comes through `PluginHost`.
 *
 * Experimental: the interface may change between minor versions until it is declared stable.
 */
import { SmaltError } from './errors.js';
import type { Zone } from './storage/columnar.js';
import type { SqlValue } from './values.js';

export type { SqlValue, Zone };

/** The plugin interface version this engine implements. */
export const PLUGIN_API_VERSION = 1;

export interface SmaltPlugin {
  /** Package name, e.g. `@smaltdb/parquet`. */
  name: string;
  version: string;
  /** The plugin interface it was written for: an engine refuses other versions. */
  apiVersion: number;
  /** Register what the plugin provides; runs once per engine instance. */
  setup(host: PluginHost): void;
}

export interface PluginHost {
  /** The engine's plugin interface version ({@link PLUGIN_API_VERSION}). */
  readonly apiVersion: number;
  /** A file format for external tables and table functions. */
  addFormat(format: FormatReader): void;
  /** A table function such as `read_parquet(location, …)` that reads one format. */
  addTableFunction(name: string, spec: { format: string }): void;
}

/** A column of external data: its name and declared type (INTEGER, REAL, TEXT, BLOB, ANY, …). */
export interface FormatColumn {
  name: string;
  declType: string;
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
 */
export type FormatReader = {
  /** Format name, as in `format = 'parquet'` (lower case). */
  name: string;
  /** File extensions that select it (lower case, no dot). */
  extensions: string[];
  /** Reader options it accepts beyond the common ones. */
  options?: string[];
  /** It uses `projection`, `blockFilters` and `schemaOnly` (reads only what a statement needs). */
  pushdown?: boolean;
} & (
  | { access: 'random'; read(file: RandomAccessFile, request: FormatRequest): Promise<FormatResult> }
  | { access: 'bytes'; read(bytes: Uint8Array, request: FormatRequest): Promise<FormatResult> }
);

/** Formats and table functions provided by plugins that are not installed: for a helpful error. */
const KNOWN_PLUGINS: Record<string, { plugin: string; what: string }> = {
  parquet: { plugin: '@smaltdb/parquet', what: 'Parquet' },
};
const KNOWN_FUNCTIONS: Record<string, string> = { read_parquet: 'parquet' };

/** A feature that needs a plugin the engine does not have. */
export function pluginMissing(label: string, format: string): SmaltError {
  const k = KNOWN_PLUGINS[format];
  return new SmaltError(
    'SMALT_PLUGIN_MISSING',
    k ? `${label}: reading ${k.what} needs the ${k.plugin} plugin (install it and add it to the engine's plugins)` : `${label}: no plugin provides the '${format}' format`,
  );
}

/** The plugins installed in one engine instance, and what they registered. */
export class PluginRegistry {
  readonly plugins: { name: string; version: string }[] = [];
  readonly formats = new Map<string, FormatReader>();
  private readonly byExtension = new Map<string, FormatReader>();
  readonly tableFunctions = new Map<string, { format: string }>();

  constructor(plugins: readonly SmaltPlugin[] = []) {
    for (const p of plugins) this.install(p);
  }

  private install(p: SmaltPlugin): void {
    if (p.apiVersion !== PLUGIN_API_VERSION) {
      throw new SmaltError('SMALT_MISUSE', `plugin ${p.name} ${p.version} needs plugin API version ${p.apiVersion}; this engine implements version ${PLUGIN_API_VERSION}`);
    }
    if (this.plugins.some((q) => q.name === p.name)) throw new SmaltError('SMALT_MISUSE', `plugin ${p.name} is installed twice`);
    const host: PluginHost = {
      apiVersion: PLUGIN_API_VERSION,
      addFormat: (f) => {
        const name = f.name.toLowerCase();
        if (this.formats.has(name) || BUILTIN_FORMATS.has(name)) throw new SmaltError('SMALT_MISUSE', `plugin ${p.name}: format '${name}' is already defined`);
        this.formats.set(name, f);
        for (const e of f.extensions) this.byExtension.set(e.toLowerCase(), f);
      },
      addTableFunction: (name, spec) => {
        const n = name.toLowerCase();
        if (this.tableFunctions.has(n) || BUILTIN_TABLE_FUNCTIONS.has(n)) throw new SmaltError('SMALT_MISUSE', `plugin ${p.name}: table function '${n}' is already defined`);
        this.tableFunctions.set(n, { format: spec.format.toLowerCase() });
      },
    };
    p.setup(host);
    this.plugins.push({ name: p.name, version: p.version });
  }

  /** The plugin format registered for a file extension. */
  formatForExtension(ext: string): FormatReader | undefined {
    return this.byExtension.get(ext.toLowerCase());
  }

  /** Whether `name` is a table function that reads external data (built in, from a plugin, or one a known plugin would provide). */
  isExternalFunction(name: string): boolean {
    const n = name.toLowerCase();
    return BUILTIN_TABLE_FUNCTIONS.has(n) || this.tableFunctions.has(n) || n in KNOWN_FUNCTIONS;
  }

  /** The format a table function reads; undefined for a built-in one (its format comes from options and extension). */
  functionFormat(name: string): string | undefined {
    const n = name.toLowerCase();
    return this.tableFunctions.get(n)?.format ?? KNOWN_FUNCTIONS[n];
  }

  /** Extra reader options plugin formats accept. */
  extraOptions(): Set<string> {
    return new Set([...this.formats.values()].flatMap((f) => f.options ?? []));
  }
}

/** Formats built into the engine (CSV / JSON; ADR 0012 moves them to @smaltdb/io later). */
export const BUILTIN_FORMATS: ReadonlySet<string> = new Set(['csv', 'tsv', 'json', 'ndjson']);
/** Table functions built into the engine. */
export const BUILTIN_TABLE_FUNCTIONS: ReadonlySet<string> = new Set(['read_csv', 'read_json']);

/** File extensions of the built-in formats and of known plugin formats (for the missing-plugin error). */
export const KNOWN_EXTENSIONS: Record<string, string> = { parquet: 'parquet', pq: 'parquet' };
