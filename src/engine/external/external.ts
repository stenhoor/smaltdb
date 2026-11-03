/**
 * External data (M8, ADR 0011): where an external table's or table function's rows come from, how
 * they are fetched (asynchronously, before the statement runs) and how CSV / JSON text becomes typed
 * rows. The engine stays synchronous: a statement over external data first has its sources loaded
 * here (`ExternalRegistry.load`), then runs over the loaded rows.
 */
import { SmaltError } from '../errors.js';
import type { StaticType } from '../exec/convert.js';
import { type Field, csvRecords, inferType, jsonValue, numericOrText } from '../io/import-export.js';
import type { SqlValue } from '../values.js';
import { globPrefix, globRegExp, hivePartitions, isGlob, partitionValue } from './glob.js';
import { AZURE_VERSION, type AwsKeys, signAzureSharedKey, signV4 } from './sign.js';
import type { Zone } from '../storage/columnar.js';
import { type FormatReader, KNOWN_EXTENSIONS, PluginRegistry, type RandomAccessFile, pluginMissing } from '../plugin.js';

export type { AwsKeys } from './sign.js';

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

/** What to fetch and how to read it: an external table, or one call of `read_csv` / `read_json`. */
export interface ExternalSource {
  /** Identity of the fetch: equal keys share one fetch per statement. */
  key: string;
  /** For messages and EXPLAIN (`orders`, `read_csv('…')`). */
  label: string;
  location: string;
  /** Format name: built in (csv, tsv, json, ndjson) or from a plugin (parquet). */
  format: string;
  /** The format reads only what a statement needs (projection, block filters, schema only). */
  pushdown?: boolean;
  /** Reader options (header, delimiter, quote, null, skip, encoding). */
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

/** A file the application registers under a name (`file:<name>` locations). */
export type FileSource = Blob | Uint8Array | ArrayBuffer | string | { getFile(): Promise<Blob> };

/** How a request to Azure Blob Storage authenticates. */
export type AzureAuth = { sasToken: string } | { accountKey: string } | { bearerToken: string };

/** What authenticates one request: headers, keys to sign it with, or a presigned URL to use instead. */
export interface CredentialMaterial {
  headers?: Record<string, string>;
  aws?: AwsKeys;
  azure?: AzureAuth;
  /** A presigned URL (S3, Azure SAS, GCS): fetched instead of the request URL, with no other auth. */
  url?: string;
}

/**
 * Credentials for a connection, registered at runtime (never stored in SQL or the database file).
 * They are only used for URLs that start with `endpoint`, so a database file from elsewhere cannot
 * point a connection at another host and collect them. Each part may be a value or a function
 * (called per request: tokens that expire, keys from STS / Cognito).
 */
export interface CredentialProvider {
  endpoint: string;
  /** Extra headers (`authorization: Bearer …`). */
  headers?: Record<string, string> | ((url: string) => Record<string, string> | Promise<Record<string, string>>);
  /** AWS keys: requests to S3 connections are signed with Signature Version 4. */
  aws?: AwsKeys | (() => AwsKeys | Promise<AwsKeys>);
  /** Azure: a SAS token, the account key (Shared Key signing) or an Entra ID bearer token. */
  azure?: AzureAuth | (() => AzureAuth | Promise<AzureAuth>);
  /** Issues a presigned URL for a request (the URL to use instead). */
  presign?: (url: string, method: 'GET' | 'HEAD') => string | Promise<string>;
  /** @internal All of the above for one request at once (credentials callbacks across the worker). */
  resolve?: (url: string, method: 'GET' | 'HEAD') => Promise<CredentialMaterial>;
}

/** The credential material of `p` for one request. */
export async function materialOf(p: CredentialProvider, url: string, method: 'GET' | 'HEAD'): Promise<CredentialMaterial> {
  if (p.resolve) return p.resolve(url, method);
  return {
    headers: typeof p.headers === 'function' ? await p.headers(url) : p.headers,
    aws: typeof p.aws === 'function' ? await p.aws() : p.aws,
    azure: typeof p.azure === 'function' ? await p.azure() : p.azure,
    url: p.presign ? await p.presign(url, method) : undefined,
  };
}

/** The subset of `fetch` the sources use (injectable for tests and custom transports). */
export type FetchFn = (url: string, init: { method?: 'GET' | 'HEAD'; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** A source's format: a built-in one (csv / json, with tsv as csv with tabs) or a plugin's reader. */
export interface FormatChoice {
  format: string;
  delimiter?: string;
  reader?: FormatReader;
}

const FORMATS: Record<string, FormatChoice> = {
  csv: { format: 'csv' },
  tsv: { format: 'csv', delimiter: '\t' },
  txt: { format: 'csv' },
  json: { format: 'json' },
  ndjson: { format: 'json' },
  jsonl: { format: 'json' },
};

/** Format of `location` from the `format` option or the file extension (plugin formats from `plugins`). */
export function formatOf(location: string, options: Record<string, SqlValue>, label: string, plugins?: PluginRegistry): FormatChoice {
  const names = (): string => ['csv', 'tsv', 'json', 'ndjson', ...(plugins?.formats.keys() ?? [])].join(', ');
  const given = options.format;
  if (given !== undefined && given !== null) {
    const g = String(given).toLowerCase();
    const f = g === 'txt' ? undefined : FORMATS[g];
    if (f) return f;
    const reader = plugins?.formats.get(g);
    if (reader) return { format: reader.name, reader };
    if (Object.values(KNOWN_EXTENSIONS).includes(g)) throw pluginMissing(label, g);
    throw externalError({ label }, `unsupported format '${given}' (${names()})`);
  }
  const path = location.replace(/[?#].*$/, '');
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  const f = ext ? FORMATS[ext] : undefined;
  if (f) return f;
  const reader = ext ? plugins?.formatForExtension(ext) : undefined;
  if (reader) return { format: reader.name, reader };
  if (ext && KNOWN_EXTENSIONS[ext]) throw pluginMissing(label, KNOWN_EXTENSIONS[ext]);
  throw externalError({ label }, `cannot tell the format of '${location}': add format = '…' (${names()})`);
}

const READER_OPTIONS = new Set(['header', 'delimiter', 'quote', 'null', 'skip', 'encoding', 'format', 'hive_partitioning']);

/** Reject unknown reader options (typos would otherwise be silently ignored). */
export function checkReaderOptions(options: Record<string, SqlValue>, extra: ReadonlySet<string>, label: string): void {
  for (const k of Object.keys(options)) if (!READER_OPTIONS.has(k) && !extra.has(k)) throw externalError({ label }, `unknown option '${k}'`);
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

// ------------------------------------------------------------------ readers

/** CSV / TSV text -> rows. Columns are declared (by position) or named by the header and inferred. */
export function readCsv(text: string, source: Pick<ExternalSource, 'label' | 'options' | 'columns'>, delimiter = ','): Omit<ExternalData, 'validator'> {
  const o = source.options;
  const delim = o.delimiter !== undefined && o.delimiter !== null ? String(o.delimiter) : delimiter;
  const quote = o.quote !== undefined && o.quote !== null ? String(o.quote) : '"';
  if (delim.length !== 1 || quote.length !== 1) throw externalError(source, 'delimiter and quote must be single characters');
  const header = truthyOption(o.header, true);
  const nullText = o.null === undefined || o.null === null ? null : String(o.null);
  let skip = Number(o.skip ?? 0);
  if (!Number.isInteger(skip) || skip < 0) throw externalError(source, 'skip must be a non-negative integer');
  const records: { fields: Field[]; line: number }[] = [];
  try {
    for (const r of csvRecords(text, delim, quote)) {
      if (skip > 0) {
        skip--;
        continue;
      }
      records.push(r);
    }
  } catch (e) {
    throw externalError(source, (e as Error).message);
  }
  let names: string[] | undefined;
  if (header && records.length > 0) names = records.shift()!.fields.map((f) => f.text.trim());
  // Declared columns match a header by name when every one is in it (files may order columns
  // differently); otherwise by position.
  let pick: number[] | null = null;
  if (names && source.columns) {
    const at = new Map(names.map((n, i) => [n.toLowerCase(), i]));
    if (source.columns.every((c) => at.has(c.name.toLowerCase()))) pick = source.columns.map((c) => at.get(c.name.toLowerCase())!);
    else if (names.length !== source.columns.length) throw externalError(source, `the header has ${names.length} fields but ${source.columns.length} columns are declared`);
  }
  const width = names?.length ?? source.columns?.length ?? records[0]?.fields.length ?? 0;
  const raw: (string | null)[][] = records.map((r) => {
    if (r.fields.length !== width) throw externalError(source, `CSV line ${r.line}: expected ${width} fields but found ${r.fields.length}`);
    const vals = r.fields.map((f) => (f.quoted ? f.text : f.text === '' || f.text === nullText ? null : f.text));
    return pick ? pick.map((i) => vals[i]) : vals;
  });
  let columns: ExternalColumn[];
  if (source.columns) columns = source.columns;
  else {
    const seen = new Set<string>();
    columns = Array.from({ length: width }, (_, i) => {
      let name = names?.[i] || `column${i + 1}`;
      // Duplicate or empty header names get a suffix, so every column can be referenced.
      for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${names?.[i] || 'column'}_${n}`;
      seen.add(name.toLowerCase());
      return { name, declType: inferType(raw.map((r) => r[i])) };
    });
  }
  const rows = raw.map((r) => r.map((v, i) => (v === null ? null : convertText(v, columns[i].declType))));
  return { columns: typed(columns, rows), rows };
}

/** Type of JSON values: INTEGER, REAL, TEXT, or ANY when they mix. */
export function jsonType(values: SqlValue[]): string {
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

/** A JSON array or NDJSON (objects, or arrays with declared columns) -> rows. */
export function readJson(text: string, source: Pick<ExternalSource, 'label' | 'options' | 'columns'>): Omit<ExternalData, 'validator'> {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let items: unknown[];
  if (body.trimStart().startsWith('[')) {
    try {
      const v = JSON.parse(body);
      if (!Array.isArray(v)) throw new Error('expected an array');
      items = v;
    } catch (e) {
      throw externalError(source, `invalid JSON: ${(e as Error).message}`);
    }
  } else {
    items = [];
    body.split(/\r?\n/).forEach((l, i) => {
      if (l.trim() === '') return;
      try {
        items.push(JSON.parse(l));
      } catch (e) {
        throw externalError(source, `NDJSON line ${i + 1}: ${(e as Error).message}`);
      }
    });
  }
  const objects = items.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x));
  let names: string[];
  if (source.columns) names = source.columns.map((c) => c.name);
  else if (objects) {
    const seen = new Map<string, string>();
    for (const x of items) for (const k of Object.keys(x as object)) if (!seen.has(k.toLowerCase())) seen.set(k.toLowerCase(), k);
    names = [...seen.values()];
  } else if (items.every(Array.isArray)) {
    names = Array.from({ length: Math.max(0, ...items.map((x) => (x as unknown[]).length)) }, (_, i) => `column${i + 1}`);
  } else throw externalError(source, 'expected JSON objects or arrays (not a mix)');
  const rows: SqlValue[][] = items.map((x, n) => {
    if (objects) {
      const byLower = new Map(Object.entries(x as object).map(([k, v]) => [k.toLowerCase(), v]));
      return names.map((c) => jsonValue(byLower.get(c.toLowerCase())));
    }
    if (!Array.isArray(x)) throw externalError(source, `item ${n + 1}: expected an array`);
    if (source.columns && x.length !== names.length) throw externalError(source, `item ${n + 1}: expected ${names.length} values but found ${x.length}`);
    return names.map((_, i) => jsonValue(x[i]));
  });
  const columns: ExternalColumn[] = source.columns ?? names.map((name, i) => ({ name, declType: jsonType(rows.map((r) => r[i])) }));
  if (source.columns) {
    // Declared types convert numeric-looking text and vice versa where the affinity says so.
    for (const r of rows) for (let i = 0; i < r.length; i++) if (typeof r[i] === 'string') r[i] = convertText(r[i] as string, columns[i].declType);
  }
  return { columns: typed(columns, rows), rows };
}

// ------------------------------------------------------------------ sources

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const isNode = (): boolean => typeof process !== 'undefined' && !!(process as { versions?: { node?: string } }).versions?.node;

/** Percent-encode a key's path segments (S3 keys and blob names), keeping `/`. */
const encodeKey = (key: string): string =>
  key
    .split('/')
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
    .join('/');

/** Where a location lives: the backend and what it needs to reach it. */
type Place =
  | { kind: 'http'; url: string }
  | { kind: 'file'; name: string }
  | { kind: 'node'; path: string }
  | { kind: 's3'; bucket: string; key: string; region: string; endpoint: string | null; pathStyle: boolean }
  | { kind: 'azure'; account: string; container: string; key: string; base: string };

/** One file of a source (a pattern expands to many). */
interface FileRef {
  place: Place;
  /** For messages, and the partition columns. */
  path: string;
  /** Validator from the listing, when the listing gives one. */
  validator?: string | null;
}

const opt = (o: Record<string, SqlValue> | undefined, k: string): string | null => {
  const v = o?.[k];
  return v === undefined || v === null ? null : String(v);
};

/** XML text with entities decoded (S3 and Azure listings). */
const xmlText = (s: string): string =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_m, e: string) =>
    e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'apos' ? "'" : String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)),
  );
const xmlTag = (xml: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? xmlText(m[1]) : null;
};
const xmlAll = (xml: string, tag: string): string[] => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);

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

/** Fetches and reads external sources; holds what the application registered (files, credentials). */
export class ExternalRegistry {
  /** @param plugins Formats from plugins (ADR 0012). */
  constructor(readonly plugins: PluginRegistry = new PluginRegistry()) {}

  readonly files = new Map<string, FileSource>();
  readonly credentials = new Map<string, CredentialProvider>();
  /** Transport for http(s), S3 and Azure requests (default: the global `fetch`). */
  fetchFn: FetchFn | null = null;
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

  /**
   * Fetch and parse one source. A pattern reads every matching file (8 at a time) and merges them by
   * column name; `key=value` directories add partition columns, and files the planner's partition
   * filters exclude are not read at all.
   */
  async read(source: ExternalSource, signal?: AbortSignal): Promise<ExternalData> {
    const fmt = formatOf(source.location, source.options, source.label, this.plugins);
    const place0 = this.placeOf(source);
    // In a URL, `?` starts the query: only wildcards in the path count (and HTTP cannot be listed).
    if (place0.kind === 'http' && /[*[{]/.test(new URL(place0.url).pathname)) {
      throw externalError(source, 'wildcards need a source that can be listed (S3, Azure, local paths or registered files), not an HTTP URL');
    }
    const glob = place0.kind !== 'http' && isGlob(source.location);
    const hive = truthyOption(source.options.hive_partitioning, glob);
    if (!glob) {
      const place = this.placeOf(source);
      const parts = hive ? hivePartitions(source.location) : [];
      const fileCols = source.columns?.filter((c) => !parts.some(([k]) => k.toLowerCase() === c.name.toLowerCase()));
      const { parsed, validator } = await this.readFile(source, place, fmt, fileCols, signal);
      return { ...this.merge(source, [{ parsed, partitions: parts }]), validator };
    }
    const files = await this.list(source, signal);
    if (files.length === 0) throw externalError(source, `no files match ${source.location}`);
    const validator = await this.combinedValidator(source, files, signal);
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
      const { parsed: p } = await this.readFile({ ...source, label: `${source.label} (${f.path})` }, f.place, fmt, fileCols, signal);
      return { parsed: p, partitions: hive ? hivePartitions(f.path) : [] };
    });
    return { ...this.merge(source, parsed, [...partitionNames]), validator };
  }

  /** One file's rows (a plugin format reads what it needs; CSV / JSON: the whole file). */
  private async readFile(
    source: ExternalSource,
    place: Place,
    fmt: FormatChoice,
    columns: ExternalColumn[] | undefined,
    signal?: AbortSignal,
  ): Promise<{ parsed: Omit<ExternalData, 'validator'>; validator: string | null }> {
    if (fmt.reader) return this.readWithPlugin(source, place, fmt.reader, columns, signal);
    const { bytes, validator } = await this.fetchFile(source, place, signal, false);
    return { parsed: this.parse(source, bytes, fmt as { format: 'csv' | 'json'; delimiter?: string }, columns), validator };
  }

  /**
   * A file read by a plugin's format reader: random access (ranged reads: HTTP Range requests,
   * Blob slices, file reads) or the whole file. Declared columns are matched by name.
   */
  private async readWithPlugin(source: ExternalSource, place: Place, reader: FormatReader, columns: ExternalColumn[] | undefined, signal?: AbortSignal): Promise<{ parsed: Omit<ExternalData, 'validator'>; validator: string | null }> {
    const request = { label: source.label, options: source.options, columns, projection: source.projection, blockFilters: source.rowGroupPrune, schemaOnly: !!source.schemaOnly };
    let result: { columns: ExternalColumn[]; rows: SqlValue[][] };
    let validator: string | null;
    try {
      if (reader.access === 'random') {
        try {
          const file = await this.openRandom(source, place, signal);
          validator = file.validator;
          try {
            result = await reader.read(file.file, request);
          } finally {
            await file.close();
          }
        } catch (e) {
          // A remote server whose ranges do not match the file it serves (a size or encoding it
          // misreports) can make a ranged read fail: read the whole file once instead. Local and
          // registered files have an exact size, and SmaltErrors (HTTP errors, interrupts) are final.
          // Only when the reader says the bytes look inconsistent (`wholeFileMayHelp`, e.g. no Parquet
          // footer where the size says it is): a missing codec or a corrupt chunk would fail again.
          if (e instanceof SmaltError || place.kind === 'file' || place.kind === 'node' || !(e as { wholeFileMayHelp?: boolean })?.wholeFileMayHelp) throw e;
          const f = await this.fetchFile(source, place, signal, false);
          validator = f.validator;
          result = await reader.read({ byteLength: f.bytes.byteLength, slice: (s, end) => f.bytes.slice(s, end).buffer as ArrayBuffer }, request);
        }
      } else {
        const f = await this.fetchFile(source, place, signal, false);
        validator = f.validator;
        result = await reader.read(f.bytes, request);
      }
    } catch (e) {
      if (e instanceof SmaltError) throw e;
      throw externalError(source, (e as Error).message);
    }
    return { parsed: { columns: typed(result.columns, result.rows), rows: result.rows }, validator };
  }

  /** Random access to a file: its size and byte ranges (HTTP Range requests for remote ones). */
  private async openRandom(source: ExternalSource, place: Place, signal?: AbortSignal): Promise<{ file: RandomAccessFile; validator: string | null; close(): Promise<void> }> {
    const none = async (): Promise<void> => undefined;
    const fromBytes = (b: Uint8Array): RandomAccessFile => ({ byteLength: b.byteLength, slice: (s, e) => b.slice(s, e).buffer as ArrayBuffer });
    if (place.kind === 'file') {
      const f = this.files.get(place.name);
      if (f === undefined) throw externalError(source, `no file is registered as '${place.name}' (registerFile)`);
      if (typeof f === 'string' || f instanceof Uint8Array || f instanceof ArrayBuffer) return { file: fromBytes((await fileBytes(f)).bytes), validator: null, close: none };
      const blob = 'getFile' in f ? await f.getFile() : f;
      const lm = (blob as { lastModified?: number }).lastModified;
      return { file: { byteLength: blob.size, slice: (s, e) => blob.slice(s, e).arrayBuffer() }, validator: typeof lm === 'number' ? `${lm}:${blob.size}` : null, close: none };
    }
    if (place.kind === 'node') {
      const fs = await nodeFs();
      try {
        const h = await fs.open(place.path, 'r');
        const st = await h.stat();
        return {
          file: {
            byteLength: st.size,
            slice: async (s, e = st.size) => {
              const b = new Uint8Array(e - s);
              await h.read(b, 0, b.length, s);
              return b.buffer;
            },
          },
          validator: `${st.mtimeMs}:${st.size}`,
          close: () => h.close(),
        };
      } catch (e) {
        throw externalError(source, (e as Error).message);
      }
    }
    const url = place.kind === 'http' ? place.url : this.objectUrl(place, place.key);
    // The size comes from a 1-byte range probe, not HEAD: on hosts that compress responses (GitHub
    // Pages, CDNs), HEAD's Content-Length is the compressed size while ranges address the
    // uncompressed bytes. Browsers request range responses with `identity` encoding.
    const probe = await this.request(source, place, url, 'GET', signal, { range: 'bytes=0-0' }, [416]);
    let validator = probe.headers.get('etag') ?? probe.headers.get('last-modified');
    const body = new Uint8Array(await probe.arrayBuffer());
    // 200: the server ignored the range and sent the whole file.
    if (probe.status === 200) return { file: fromBytes(body), validator, close: none };
    // 416: no byte 0, an empty file; read it as one (the format then reports what is wrong with it).
    if (probe.status === 416) {
      const f = await this.fetchFile(source, place, signal, false);
      return { file: fromBytes(f.bytes), validator: validator ?? f.validator, close: none };
    }
    const total = /^bytes\s+\d+-\d+\/(\d+)\s*$/i.exec(probe.headers.get('content-range') ?? '');
    const size = total ? Number(total[1]) : NaN;
    if (!Number.isSafeInteger(size)) {
      // No total size (`*`, or Content-Range not exposed to the page by CORS): read the whole file once.
      const f = await this.fetchFile(source, place, signal, false);
      validator ??= f.validator;
      return { file: fromBytes(f.bytes), validator, close: none };
    }
    let whole: Promise<Uint8Array> | null = null;
    return {
      file: {
        byteLength: size,
        slice: async (s, e = size) => {
          if (whole) return (await whole).slice(s, e).buffer as ArrayBuffer;
          const res = await this.request(source, place, url, 'GET', signal, { range: `bytes=${s}-${e - 1}` });
          if (res.status === 206) return res.arrayBuffer();
          // The server ignored the range: keep the whole body for the other slices.
          whole = res.arrayBuffer().then((b) => new Uint8Array(b));
          return (await whole).slice(s, e).buffer as ArrayBuffer;
        },
      },
      validator,
      close: none,
    };
  }

  private parse(source: ExternalSource, bytes: Uint8Array, fmt: { format: 'csv' | 'json'; delimiter?: string }, columns: ExternalColumn[] | undefined): Omit<ExternalData, 'validator'> {
    const encoding = source.options.encoding === undefined || source.options.encoding === null ? 'utf-8' : String(source.options.encoding);
    let text: string;
    try {
      text = new TextDecoder(encoding, { fatal: false }).decode(bytes);
    } catch {
      throw externalError(source, `unsupported encoding '${encoding}'`);
    }
    const s = { ...source, columns };
    return fmt.format === 'csv' ? readCsv(text, s, fmt.delimiter) : readJson(text, s);
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
      return { ...c, declType: jsonType(values) };
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
    const place = this.placeOf(source);
    if (place.kind === 'http' || !isGlob(source.location)) return (await this.fetchFile(source, place, signal, true)).validator;
    return this.combinedValidator(source, await this.list(source, signal), signal);
  }

  private async combinedValidator(source: ExternalSource, files: FileRef[], signal?: AbortSignal): Promise<string | null> {
    const parts: string[] = [];
    for (const f of files) {
      const v = f.validator !== undefined ? f.validator : (await this.fetchFile(source, f.place, signal, true)).validator;
      if (v === null) return null;
      parts.push(`${f.path}\u0000${v}`);
    }
    return 'files:' + (await sha256Hex(parts.sort().join('\n')));
  }

  // ---------------------------------------------------------------- locations

  /** Where `source.location` lives (relative locations resolve against the connection). */
  private placeOf(source: ExternalSource, location = source.location): Place {
    const conn = source.connection;
    const type = conn ? String(conn.options.type ?? 'http').toLowerCase() : null;
    const o = conn?.options;
    if (/^file:/i.test(location)) return { kind: 'file', name: location.slice(5) };
    if (/^https?:/i.test(location)) return { kind: 'http', url: location };
    const s3 = /^s3:\/\/([^/]+)\/?(.*)$/i.exec(location);
    if (s3) return this.s3Place(source, s3[1], s3[2]);
    const az = /^(?:az|azure):\/\/([^/]+)\/?(.*)$/i.exec(location);
    if (az) return this.azurePlace(source, az[1], az[2]);
    if (SCHEME.test(location) && !/^[a-z]:[\\/]/i.test(location)) {
      throw externalError(source, `unsupported location '${location}' (http(s), s3://, az://, file:<name>, or a path in Node)`);
    }
    if (type === 's3') {
      const bucket = opt(o, 'bucket');
      if (!bucket) throw externalError(source, `connection ${conn!.name} has no bucket: use s3://bucket/key`);
      return this.s3Place(source, bucket, location);
    }
    if (type === 'azure') {
      const container = opt(o, 'container');
      if (!container) throw externalError(source, `connection ${conn!.name} has no container: use az://container/path`);
      return this.azurePlace(source, container, location);
    }
    const base = opt(o, 'url');
    if (base !== null) return { kind: 'http', url: new URL(location, base.endsWith('/') ? base : `${base}/`).href };
    if (!isNode()) throw externalError(source, `'${location}' is a local path: in a browser, register the file (registerFile) and use file:<name>`);
    return { kind: 'node', path: location };
  }

  private s3Place(source: ExternalSource, bucket: string, key: string): Place {
    const o = source.connection?.options;
    const type = source.connection ? String(o?.type ?? 'http').toLowerCase() : 's3';
    if (type !== 's3') throw externalError(source, `s3:// locations need an s3 connection (connection ${source.connection!.name} is ${type})`);
    const endpoint = opt(o, 'endpoint');
    const style = opt(o, 'url_style');
    return { kind: 's3', bucket, key, region: opt(o, 'region') ?? 'us-east-1', endpoint: endpoint && endpoint.replace(/\/+$/, ''), pathStyle: style ? style.toLowerCase() === 'path' : endpoint !== null };
  }

  private azurePlace(source: ExternalSource, container: string, key: string): Place {
    const o = source.connection?.options;
    const type = source.connection ? String(o?.type ?? 'http').toLowerCase() : null;
    if (type !== 'azure') throw externalError(source, 'az:// locations need an azure connection (it names the storage account)');
    const account = opt(o, 'account');
    const endpoint = opt(o, 'endpoint');
    if (!account) throw externalError(source, `connection ${source.connection!.name} has no account`);
    return { kind: 'azure', account, container, key, base: (endpoint ?? `https://${account}.blob.core.windows.net`).replace(/\/+$/, '') };
  }

  /** The URL of an object (key) in an S3 bucket or Azure container. */
  private objectUrl(place: Extract<Place, { kind: 's3' | 'azure' }>, key: string): string {
    if (place.kind === 'azure') return `${place.base}/${place.container}/${encodeKey(key)}`;
    if (place.pathStyle) return `${place.endpoint ?? `https://s3.${place.region}.amazonaws.com`}/${place.bucket}/${encodeKey(key)}`;
    if (place.endpoint) {
      const u = new URL(place.endpoint);
      return `${u.protocol}//${place.bucket}.${u.host}/${encodeKey(key)}`;
    }
    return `https://${place.bucket}.s3.${place.region}.amazonaws.com/${encodeKey(key)}`;
  }

  /** The files a pattern matches. */
  private async list(source: ExternalSource, signal?: AbortSignal): Promise<FileRef[]> {
    const place = this.placeOf(source);
    if (place.kind === 'http') throw externalError(source, 'wildcards need a source that can be listed (S3, Azure, local paths or registered files), not an HTTP URL');
    if (place.kind === 'file') {
      const re = globRegExp(place.name);
      return [...this.files.keys()]
        .filter((n) => re.test(n))
        .sort()
        .map((n) => ({ place: { kind: 'file', name: n } as Place, path: n }));
    }
    if (place.kind === 'node') return this.listNode(source, place.path);
    const re = globRegExp(place.key);
    const prefix = globPrefix(place.key);
    const out: FileRef[] = [];
    let token: string | null = null;
    do {
      const listUrl =
        place.kind === 's3'
          ? `${this.objectUrl(place, '').replace(/\/$/, '')}${place.pathStyle ? '' : '/'}?list-type=2&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`
          : `${place.base}/${place.container}?restype=container&comp=list&prefix=${encodeURIComponent(prefix)}${token ? `&marker=${encodeURIComponent(token)}` : ''}`;
      const res = await this.request(source, place, listUrl, 'GET', signal);
      const xml = new TextDecoder().decode(await res.arrayBuffer());
      if (place.kind === 's3') {
        for (const c of xmlAll(xml, 'Contents')) {
          const key = xmlTag(c, 'Key')!;
          if (re.test(key)) out.push({ place: { ...place, key }, path: key, validator: xmlTag(c, 'ETag') ?? xmlTag(c, 'LastModified') });
        }
        token = xmlTag(xml, 'IsTruncated') === 'true' ? xmlTag(xml, 'NextContinuationToken') : null;
      } else {
        for (const b of xmlAll(xml, 'Blob')) {
          const key = xmlTag(b, 'Name')!;
          if (re.test(key)) out.push({ place: { ...place, key }, path: key, validator: xmlTag(b, 'Etag') ?? xmlTag(b, 'Last-Modified') });
        }
        token = xmlTag(xml, 'NextMarker') || null;
      }
    } while (token);
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  private async listNode(source: ExternalSource, pattern: string): Promise<FileRef[]> {
    const fs = await nodeFs();
    const prefix = globPrefix(pattern);
    const dir = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/') + 1) : './';
    const re = globRegExp(pattern);
    let names: string[];
    try {
      names = (await fs.readdir(dir, { recursive: true })) as string[];
    } catch (e) {
      throw externalError(source, (e as Error).message);
    }
    const out: FileRef[] = [];
    for (const n of names.sort()) {
      const path = (dir === './' && !pattern.startsWith('./') ? '' : dir) + n.replace(/\\/g, '/');
      if (!re.test(path)) continue;
      const st = await fs.stat(path);
      if (st.isFile()) out.push({ place: { kind: 'node', path }, path, validator: `${st.mtimeMs}:${st.size}` });
    }
    return out;
  }

  // ---------------------------------------------------------------- fetching

  /** One file's bytes (or, with `head`, only its validator). */
  private async fetchFile(source: ExternalSource, place: Place, signal: AbortSignal | undefined, head: boolean): Promise<{ bytes: Uint8Array; validator: string | null }> {
    if (place.kind === 'file') {
      const f = this.files.get(place.name);
      if (f === undefined) throw externalError(source, `no file is registered as '${place.name}' (registerFile)`);
      return fileBytes(f, head);
    }
    if (place.kind === 'node') {
      const fs = await nodeFs();
      try {
        const [bytes, st] = await Promise.all([head ? new Uint8Array(0) : fs.readFile(place.path), fs.stat(place.path)]);
        return { bytes, validator: `${st.mtimeMs}:${st.size}` };
      } catch (e) {
        throw externalError(source, (e as Error).message);
      }
    }
    const url = place.kind === 'http' ? place.url : this.objectUrl(place, place.key);
    const res = await this.request(source, place, url, head ? 'HEAD' : 'GET', signal);
    const bytes = head ? new Uint8Array(0) : new Uint8Array(await res.arrayBuffer());
    return { bytes, validator: res.headers.get('etag') ?? res.headers.get('last-modified') };
  }

  /**
   * One HTTP request: with the connection's credentials (only for URLs under the provider's
   * endpoint), signed for S3 (SigV4) or Azure (SAS, Shared Key, bearer), or to a presigned URL.
   */
  private async request(source: ExternalSource, place: Place, url: string, method: 'GET' | 'HEAD', signal?: AbortSignal, extra: Record<string, string> = {}, accept: number[] = []): Promise<Awaited<ReturnType<FetchFn>>> {
    let headers: Record<string, string> = { ...extra };
    let target = url;
    const credName = source.connection?.options.credentials;
    if (credName !== undefined && credName !== null) {
      const p = this.credentials.get(String(credName));
      if (!p) throw externalError(source, `connection ${source.connection!.name}: no credentials are registered as '${credName}' (registerCredentials)`);
      if (!url.startsWith(p.endpoint)) throw externalError(source, `credentials '${credName}' are bound to ${p.endpoint}; refusing to send them to ${url}`);
      let m: CredentialMaterial;
      try {
        m = await materialOf(p, url, method);
      } catch (e) {
        throw externalError(source, (e as Error).message); // a provider that failed or refused
      }
      headers = { ...m.headers, ...extra };
      if (m.url) target = m.url;
      else if (m.aws && place.kind === 's3') headers = await signV4({ method, url, headers }, m.aws, place.region, 's3');
      else if (m.azure && place.kind === 'azure') {
        const a = m.azure;
        if ('sasToken' in a) target = `${url}${url.includes('?') ? '&' : '?'}${a.sasToken.replace(/^\?/, '')}`;
        else if ('accountKey' in a) headers = await signAzureSharedKey({ method, url, headers }, place.account, a.accountKey);
        else headers = { ...headers, authorization: `Bearer ${a.bearerToken}`, 'x-ms-version': AZURE_VERSION };
      } else if (m.aws || m.azure) throw externalError(source, `credentials '${credName}' hold ${m.aws ? 'AWS' : 'Azure'} keys, but ${url} is not on a ${m.aws ? 's3' : 'azure'} connection`);
    } else if (place.kind === 'azure') headers['x-ms-version'] = AZURE_VERSION;
    const fetchFn = this.fetchFn ?? (globalThis.fetch as unknown as FetchFn | undefined);
    if (!fetchFn) throw externalError(source, 'no fetch available in this environment');
    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await fetchFn(target, method === 'HEAD' ? { method, headers, signal } : { headers, signal });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new SmaltError('SMALT_INTERRUPT', 'interrupted');
      throw externalError(source, `fetching ${url} failed: ${(e as Error).message} (a network error, or a CORS error: the server must allow this origin)`);
    }
    if (!res.ok && !accept.includes(res.status)) {
      let detail = '';
      if (method !== 'HEAD') {
        // S3 and Azure explain errors in an XML body (<Code>AccessDenied</Code>, <Message>…</Message>).
        const body = new TextDecoder().decode(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
        const code = xmlTag(body, 'Code');
        if (code) detail = ` (${code}${xmlTag(body, 'Message') ? `: ${xmlTag(body, 'Message')}` : ''})`;
      }
      throw externalError(source, `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} for ${url}${detail}`);
    }
    return res;
  }
}

type NodeFs = {
  readFile(p: string): Promise<Uint8Array>;
  stat(p: string): Promise<{ mtimeMs: number; size: number; isFile(): boolean }>;
  readdir(p: string, o: { recursive: boolean }): Promise<string[]>;
  open(
    p: string,
    flags: string,
  ): Promise<{ stat(): Promise<{ mtimeMs: number; size: number }>; read(b: Uint8Array, off: number, len: number, pos: number): Promise<unknown>; close(): Promise<void> }>;
};

/** Node's fs (loaded on first use; never bundled for browsers). */
async function nodeFs(): Promise<NodeFs> {
  const name = 'node:fs/promises';
  return (await import(/* @vite-ignore */ name)) as NodeFs;
}

/** A registered file's bytes and validator (a File's lastModified and size; none for Blobs and bytes). */
async function fileBytes(f: FileSource, head = false): Promise<{ bytes: Uint8Array; validator: string | null }> {
  if (typeof f === 'string') return { bytes: new TextEncoder().encode(f), validator: null };
  if (f instanceof Uint8Array) return { bytes: f, validator: null };
  if (f instanceof ArrayBuffer) return { bytes: new Uint8Array(f), validator: null };
  const blob = 'getFile' in f ? await f.getFile() : f;
  const lastModified = (blob as { lastModified?: number }).lastModified;
  const validator = typeof lastModified === 'number' ? `${lastModified}:${blob.size}` : null;
  return { bytes: head ? new Uint8Array(0) : new Uint8Array(await blob.arrayBuffer()), validator };
}
