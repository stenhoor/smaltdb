/**
 * External data (M8, ADR 0011): the framework that external tables and table functions such as
 * `read_csv` run on. The engine stays synchronous: a statement over external data first has its
 * sources loaded here (`ExternalRegistry.acquire`), then runs over the loaded rows.
 *
 * Where data comes from (sources) and how files become rows (formats) are plugins (ADR 0012):
 * `@smaltdb/external` (URLs, S3, Azure, registered files, local paths), `@smaltdb/io` (CSV, JSON)
 * and `@smaltdb/parquet`. This file resolves a location to a plugin's source, expands patterns,
 * reads Hive partitions, merges files, and keeps the loaded rows for the statement.
 */
import { SmaltError, errorCode } from '../errors.js';
import type { StaticType } from '../exec/convert.js';
import { type FormatReader, PluginRegistry, type RandomAccessFile, type SourceHandler, type SourceTarget } from '../plugin.js';
import type { Zone } from '../storage/columnar.js';
import type { SqlValue } from '../values.js';
import { hivePartitions, isGlob, partitionValue } from './glob.js';

/** A named endpoint (`CREATE CONNECTION`). */
export interface ConnectionInfo {
  name: string;
  options: Record<string, SqlValue>;
}

/** A column of external data: its name, declared type (as written or inferred) and static type. */
export interface ExternalColumn {
  name: string;
  declType: string;
}

/** What to fetch and how to read it: an external table, or one call of a table function such as `read_csv`. */
export interface ExternalSource {
  /** Identity of the fetch: equal keys share one fetch per statement. */
  key: string;
  /** For messages and EXPLAIN (`orders`, `read_csv('…')`). */
  label: string;
  location: string;
  /** Format name (a plugin's format: csv, tsv, json, ndjson, parquet, …). */
  format: string;
  /** The format reads only what a statement needs (projection, block filters, schema only). */
  pushdown?: boolean;
  /** Reader options (header, delimiter, quote, null, skip, encoding, …). */
  options: Record<string, SqlValue>;
  connection?: ConnectionInfo;
  /** Declared columns; undefined: inferred from the data. */
  columns?: ExternalColumn[];
  /**
   * Partition pruning (M8.2), set by the planner from constant WHERE conditions on partition
   * columns: a file is skipped when one of these returns false for its `key=value` values
   * (lower-cased keys). They return undefined when they cannot decide.
   */
  prune?: ((partition: Map<string, SqlValue>) => boolean | undefined)[];
  /**
   * With `pushdown` (Parquet): the columns the statement reads (lower case; set by the planner).
   * Only their column chunks are fetched. undefined: every column.
   */
  projection?: Set<string>;
  /**
   * With `pushdown` (Parquet): row-group pruning from constant comparisons, set by the planner. A
   * row group is skipped when one returns false for its columns' statistics (zone maps, lower-cased names).
   */
  rowGroupPrune?: ((zones: Map<string, Zone>, rows: number) => boolean | undefined)[];
  /** Read only the schema (Parquet: the footer), no rows: for column lists at planning time. */
  schemaOnly?: boolean;
}

/** Rows read from a source. */
export interface ExternalData {
  columns: (ExternalColumn & { type: StaticType })[];
  rows: SqlValue[][];
  /** ETag or Last-Modified of the source, when it has one. */
  validator: string | null;
}

/** Thrown when a statement needs external data that has not been loaded (run it with queryAsync / execAsync). */
export class AsyncRequiredError extends SmaltError {
  constructor(readonly sources: ExternalSource[]) {
    super('SMALT_ASYNC_REQUIRED', `statement reads external data (${sources.map((s) => s.label).join(', ')}): run it with queryAsync / execAsync, or through the worker client`);
    this.name = 'AsyncRequiredError';
  }
}

/** A failed fetch or parse of external data. */
export function externalError(source: { label: string }, message: string): SmaltError {
  return new SmaltError('SMALT_EXTERNAL', `${source.label}: ${message}`);
}

/** The format of `location`: the `format` option, a table function's format, or the file extension. */
export function formatOf(location: string, options: Record<string, SqlValue>, label: string, plugins: PluginRegistry): FormatReader {
  const given = options.format;
  if (given !== undefined && given !== null) {
    const f = plugins.format(String(given));
    if (!f) throw plugins.formatMissing(label, String(given));
    return f;
  }
  const path = location.replace(/[?#].*$/, '');
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  const f = ext ? plugins.formatForExtension(ext) : undefined;
  if (f) return f;
  // An extension one of smaltdb's plugins reads: name the plugin to install.
  if (ext && plugins.isKnownFormat(ext)) throw plugins.formatMissing(label, ext);
  throw externalError({ label }, `cannot tell the format of '${location}': add format = '…'`);
}

/** Reject unknown reader options (typos would otherwise be silently ignored). */
export function checkReaderOptions(options: Record<string, SqlValue>, allowed: ReadonlySet<string>, label: string): void {
  for (const k of Object.keys(options)) if (!allowed.has(k)) throw externalError({ label }, `unknown option '${k}'`);
}

const truthyOption = (v: SqlValue | undefined, dflt: boolean): boolean => {
  if (v === undefined || v === null) return dflt;
  if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
  return Number(v) !== 0;
};

// ------------------------------------------------------------------ types

/** Static type of a declared column type (SQLite affinity rules). */
export function staticTypeOf(declType: string): StaticType {
  const t = declType.toUpperCase();
  if (t.includes('INT')) return 'int';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'text';
  if (t.includes('BLOB')) return 'blob';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'real';
  return 'any';
}

const INT_RE = /^[+-]?\d+$/;
const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** `text` as a number when it is one (integers beyond 2^53 as bigint), else the text. */
function numericOrText(s: string): SqlValue {
  const t = s.trim();
  if (INT_RE.test(t)) {
    const b = BigInt(t);
    return b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b;
  }
  if (NUM_RE.test(t)) return Number(t);
  return s;
}

/** `text` converted for a column of `declType` (affinity: text that does not fit stays text). */
function convertText(text: string, declType: string): SqlValue {
  const st = staticTypeOf(declType);
  if (st === 'text' || st === 'blob') return text;
  const v = numericOrText(text);
  if (st === 'real' && typeof v === 'number') return v;
  if (st === 'real' && typeof v === 'bigint') return Number(v);
  return v;
}

/** Whether `v` fits static type `t` (otherwise the column is typed 'any' so no plan assumes more). */
function fits(v: SqlValue, t: StaticType): boolean {
  if (v === null || t === 'any') return true;
  if (t === 'int') return typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v));
  if (t === 'real') return typeof v === 'number';
  if (t === 'text') return typeof v === 'string';
  if (t === 'blob') return v instanceof Uint8Array;
  return true;
}

function typed(columns: ExternalColumn[], rows: SqlValue[][]): ExternalData['columns'] {
  return columns.map((c, i) => {
    const t = staticTypeOf(c.declType);
    return { ...c, type: rows.every((r) => fits(r[i], t)) ? t : 'any' };
  });
}

/** Type of partition values: INTEGER, REAL, TEXT, or ANY when they mix. */
function valuesType(values: SqlValue[]): string {
  let t: string | null = null;
  for (const v of values) {
    if (v === null) continue;
    const vt = typeof v === 'number' ? (Number.isInteger(v) ? 'INTEGER' : 'REAL') : typeof v === 'string' ? 'TEXT' : 'ANY';
    if (t === null || t === vt) t = vt;
    else if ((t === 'INTEGER' && vt === 'REAL') || (t === 'REAL' && vt === 'INTEGER')) t = 'REAL';
    else return 'ANY';
  }
  return t ?? 'TEXT';
}

/** Run `fn` over `items` with at most `limit` running at once. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}

const fromBytes = (b: Uint8Array): RandomAccessFile => ({ byteLength: b.byteLength, slice: (s, e) => b.slice(s, e).buffer as ArrayBuffer });

/** One file of a source (a pattern expands to many). */
interface FileRef {
  target: SourceTarget;
  /** For messages, and the partition columns. */
  path: string;
  /** Validator from the listing, when the listing gives one. */
  validator?: string | null;
}

/** Loads external sources through plugins' sources and formats, and keeps the rows for the statements reading them. */
export class ExternalRegistry {
  /** @param plugins Sources and formats from plugins (ADR 0012). */
  constructor(readonly plugins: PluginRegistry = new PluginRegistry()) {}

  /**
   * Data loaded for statements being run, by source key. Reference-counted: concurrent async calls
   * that read the same source share one fetch, and one call finishing does not drop another's data.
   */
  private readonly loaded = new Map<string, { refs: number; data?: ExternalData; pending: Promise<ExternalData> }>();

  /** The loaded rows of `source`; throws AsyncRequiredError when they were not loaded. */
  data(source: ExternalSource): ExternalData {
    const d = this.loaded.get(source.key)?.data;
    if (!d) throw new AsyncRequiredError([source]);
    return d;
  }

  /** Fetch and read `sources` (concurrently; already loaded ones are shared). Returns the keys to release. */
  async acquire(sources: ExternalSource[], signal?: AbortSignal): Promise<string[]> {
    const unique = new Map<string, ExternalSource>();
    for (const s of sources) unique.set(s.key, s);
    const keys = [...unique.keys()];
    const entries = [...unique.values()].map((s) => {
      let e = this.loaded.get(s.key);
      if (!e) {
        e = { refs: 0, pending: this.read(s, signal) };
        this.loaded.set(s.key, e);
      }
      e.refs++;
      return e;
    });
    try {
      await Promise.all(entries.map(async (e) => void (e.data ??= await e.pending)));
    } catch (err) {
      this.release(keys);
      throw err;
    }
    return keys;
  }

  /** Done with the data of `keys` (from {@link acquire}). */
  release(keys: string[]): void {
    for (const k of keys) {
      const e = this.loaded.get(k);
      if (e && --e.refs <= 0) this.loaded.delete(k);
    }
  }

  // ---------------------------------------------------------------- reading

  private targetOf(source: ExternalSource, location = source.location): SourceTarget {
    return source.connection ? { location, connection: { name: source.connection.name, options: source.connection.options } } : { location };
  }

  /** Whether the location is a pattern to list (the source decides; default: wildcards in the path, not in a URL's query). */
  private isPattern(source: ExternalSource, handler: SourceHandler): boolean {
    const target = this.targetOf(source);
    const path = /^[a-z][a-z0-9+.-]*:\/\//i.test(source.location) ? source.location.replace(/[?#].*$/, '') : source.location;
    let pattern: boolean;
    try {
      pattern = handler.isPattern ? handler.isPattern(target) : isGlob(path);
    } catch (e) {
      // Errors from a plugin's isPattern: like its other errors, labelled SMALT_EXTERNAL (or its own SMALT_ code).
      if (e instanceof SmaltError || errorCode(e) !== 'SMALT_INTERNAL') throw e;
      throw externalError(source, (e as Error)?.message ?? String(e));
    }
    if (!pattern) return false;
    if (!handler.list) throw externalError(source, `wildcards need a source that can be listed, not ${handler.name}`);
    return true;
  }

  /**
   * Fetch and parse one source. A pattern reads every matching file (8 at a time) and merges them by
   * column name; `key=value` directories add partition columns, and files the planner's partition
   * filters exclude are not read at all.
   */
  async read(source: ExternalSource, signal?: AbortSignal): Promise<ExternalData> {
    const fmt = formatOf(source.location, source.options, source.label, this.plugins);
    const target = this.targetOf(source);
    const handler = this.plugins.sourceFor(target, source.label);
    const glob = this.isPattern(source, handler);
    const hive = truthyOption(source.options.hive_partitioning, glob);
    if (!glob) {
      const parts = hive ? hivePartitions(source.location) : [];
      const fileCols = source.columns?.filter((c) => !parts.some(([k]) => k.toLowerCase() === c.name.toLowerCase()));
      const { parsed, validator } = await this.readFile(source, handler, target, fmt, fileCols, signal);
      return { ...this.merge(source, [{ parsed, partitions: parts }]), validator };
    }
    const files = await this.list(source, handler, target, signal);
    if (files.length === 0) throw externalError(source, `no files match ${source.location}`);
    const validator = await this.combinedValidator(source, handler, files, signal);
    // Partition values as the rows will hold them (declared columns convert by their type).
    const declared = new Map((source.columns ?? []).map((c) => [c.name.toLowerCase(), c.declType]));
    const kept = files.filter((f) => {
      if (!hive || !source.prune?.length) return true;
      const values = new Map(
        hivePartitions(f.path).map(([k, v]) => {
          const t = declared.get(k.toLowerCase());
          return [k.toLowerCase(), t !== undefined ? (v === null ? null : convertText(v, t)) : partitionValue(v)] as [string, SqlValue];
        }),
      );
      return source.prune!.every((p) => p(values) !== false);
    });
    const partitionNames = new Set(hive ? files.flatMap((f) => hivePartitions(f.path).map(([k]) => k.toLowerCase())) : []);
    const fileCols = source.columns?.filter((c) => !partitionNames.has(c.name.toLowerCase()));
    const parsed = await mapLimit(kept, 8, async (f) => {
      const { parsed: p } = await this.readFile({ ...source, label: `${source.label} (${f.path})` }, handler, f.target, fmt, fileCols, signal);
      return { parsed: p, partitions: hive ? hivePartitions(f.path) : [] };
    });
    return { ...this.merge(source, parsed, [...partitionNames]), validator };
  }

  /** The files a pattern matches. */
  private async list(source: ExternalSource, handler: SourceHandler, target: SourceTarget, signal?: AbortSignal): Promise<FileRef[]> {
    const files = await this.guard(source, () => handler.list!(target, { label: source.label, signal }));
    return files.map((f) => ({ target: this.targetOf(source, f.location), path: f.path, validator: f.validator }));
  }

  /** Errors from plugins as SMALT_EXTERNAL with the source's label (SmaltErrors pass through). */
  private async guard<T>(source: { label: string }, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      // SmaltErrors, and plugin errors that carry a SMALT_ code, pass through unchanged.
      if (e instanceof SmaltError || errorCode(e) !== 'SMALT_INTERNAL') throw e;
      if ((e as Error)?.name === 'AbortError') throw new SmaltError('SMALT_INTERRUPT', 'interrupted');
      throw externalError(source, (e as Error)?.message ?? String(e));
    }
  }

  /** One file's rows, read by its format (random access when both the format and the source support it). */
  private async readFile(
    source: ExternalSource,
    handler: SourceHandler,
    target: SourceTarget,
    reader: FormatReader,
    columns: ExternalColumn[] | undefined,
    signal?: AbortSignal,
  ): Promise<{ parsed: Omit<ExternalData, 'validator'>; validator: string | null }> {
    const ctx = { label: source.label, signal };
    const request = { label: source.label, options: source.options, columns, projection: source.projection, blockFilters: source.rowGroupPrune, schemaOnly: !!source.schemaOnly };
    return this.guard(source, async () => {
      const file = await handler.open(target, ctx);
      try {
        let validator: string | null;
        let result: { columns: ExternalColumn[]; rows: SqlValue[][] };
        if (reader.access === 'random') {
          const r = file.random ? await file.random() : await file.bytes().then((b) => ({ file: fromBytes(b.bytes), validator: b.validator }));
          validator = r.validator;
          result = await reader.read(r.file, request);
        } else {
          const b = await file.bytes();
          validator = b.validator;
          result = await reader.read(b.bytes, request);
        }
        return { parsed: { columns: typed(result.columns, result.rows), rows: result.rows }, validator };
      } finally {
        await file.close?.();
      }
    });
  }

  /**
   * Files' rows as one table: declared columns (partition columns filled from the path), or the
   * union of the files' columns by name (first seen first) followed by the partition columns.
   */
  private merge(source: ExternalSource, parts: { parsed: Omit<ExternalData, 'validator'>; partitions: [string, string | null][] }[], partitionNames: string[] = []): Omit<ExternalData, 'validator'> {
    const lower = (s: string): string => s.toLowerCase();
    let columns: ExternalColumn[];
    if (source.columns) columns = source.columns;
    else {
      const byName = new Map<string, ExternalColumn>();
      for (const p of parts) {
        for (const c of p.parsed.columns) {
          const old = byName.get(lower(c.name));
          if (!old) byName.set(lower(c.name), { name: c.name, declType: c.declType });
          else if (old.declType !== c.declType) old.declType = [old.declType, c.declType].every((t) => t === 'INTEGER' || t === 'REAL') ? 'REAL' : 'ANY';
        }
      }
      const names = new Set([...partitionNames, ...parts.flatMap((p) => p.partitions.map(([k]) => lower(k)))]);
      for (const p of parts) for (const [k] of p.partitions) if (names.has(lower(k)) && !byName.has(lower(k))) byName.set(lower(k), { name: k, declType: '' });
      columns = [...byName.values()];
    }
    const rows: SqlValue[][] = [];
    for (const p of parts) {
      const pos = new Map(p.parsed.columns.map((c, i) => [lower(c.name), i]));
      const pv = new Map(p.partitions.map(([k, v]) => [lower(k), v]));
      const map = columns.map((c) => {
        const i = pos.get(lower(c.name));
        if (i !== undefined) return (r: SqlValue[]) => r[i];
        if (pv.has(lower(c.name))) {
          const v = pv.get(lower(c.name))!;
          const value = source.columns ? (v === null ? null : convertText(v, c.declType)) : partitionValue(v);
          return () => value;
        }
        return () => null;
      });
      for (const r of p.parsed.rows) rows.push(map.map((f) => f(r)));
    }
    // Inferred partition columns are typed from the values in the paths (also when no rows were
    // read: a schema-only read must type them as a full read would).
    columns = columns.map((c) => {
      if (c.declType !== '') return c;
      const values = parts.flatMap((p) => p.partitions.filter(([k]) => lower(k) === lower(c.name)).map(([, v]) => partitionValue(v)));
      return { ...c, declType: valuesType(values) };
    });
    return { columns: typed(columns, rows), rows };
  }

  // ---------------------------------------------------------------- validators

  /**
   * The source's current validator without reading it (a HEAD request, a stat, a listing): ETag or
   * Last-Modified, a file's mtime and size, a registered File's lastModified and size, or for a
   * pattern a digest of every matching file's. null when it has none (it then counts as changed).
   */
  async currentValidator(source: ExternalSource, signal?: AbortSignal): Promise<string | null> {
    const target = this.targetOf(source);
    const handler = this.plugins.sourceFor(target, source.label);
    if (!this.isPattern(source, handler)) return this.guard(source, () => handler.validator(target, { label: source.label, signal }));
    return this.combinedValidator(source, handler, await this.list(source, handler, target, signal), signal);
  }

  private async combinedValidator(source: ExternalSource, handler: SourceHandler, files: FileRef[], signal?: AbortSignal): Promise<string | null> {
    const parts: string[] = [];
    for (const f of files) {
      const v = f.validator !== undefined ? f.validator : await this.guard(source, () => handler.validator(f.target, { label: source.label, signal }));
      if (v === null) return null;
      parts.push(`${f.path}\u0000${v}`);
    }
    return 'files:' + (await sha256Hex(parts.sort().join('\n')));
  }
}
