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
  format: 'csv' | 'json';
  /** Reader options (header, delimiter, quote, null, skip, encoding). */
  options: Record<string, SqlValue>;
  connection?: ConnectionInfo;
  /** Declared columns; undefined: inferred from the data. */
  columns?: ExternalColumn[];
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

/**
 * Credentials for a connection, registered at runtime (never stored in SQL or the database file).
 * They are only sent to URLs that start with `endpoint`, so a database file from elsewhere cannot
 * point a connection at another host and collect them.
 */
export interface CredentialProvider {
  endpoint: string;
  headers: Record<string, string> | ((url: string) => Record<string, string> | Promise<Record<string, string>>);
}

/** The subset of `fetch` the sources use (injectable for tests and custom transports). */
export type FetchFn = (url: string, init: { method?: 'GET' | 'HEAD'; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

const FORMATS: Record<string, { format: 'csv' | 'json'; delimiter?: string }> = {
  csv: { format: 'csv' },
  tsv: { format: 'csv', delimiter: '\t' },
  txt: { format: 'csv' },
  json: { format: 'json' },
  ndjson: { format: 'json' },
  jsonl: { format: 'json' },
};

/** Format of `location` from the `format` option or the file extension. */
export function formatOf(location: string, options: Record<string, SqlValue>, label: string): { format: 'csv' | 'json'; delimiter?: string } {
  const given = options.format;
  if (given !== undefined && given !== null) {
    const f = FORMATS[String(given).toLowerCase()];
    if (!f || String(given).toLowerCase() === 'txt') throw externalError({ label }, `unsupported format '${given}' (csv, tsv, json, ndjson)`);
    return f;
  }
  const path = location.replace(/[?#].*$/, '');
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  const f = ext ? FORMATS[ext] : undefined;
  if (!f) throw externalError({ label }, `cannot tell the format of '${location}': add format = 'csv' or 'json'`);
  return f;
}

const READER_OPTIONS = new Set(['header', 'delimiter', 'quote', 'null', 'skip', 'encoding', 'format']);

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
  const width = source.columns?.length ?? names?.length ?? records[0]?.fields.length ?? 0;
  if (names && source.columns && names.length !== width) throw externalError(source, `the header has ${names.length} fields but ${width} columns are declared`);
  const raw: (string | null)[][] = records.map((r) => {
    if (r.fields.length !== width) throw externalError(source, `CSV line ${r.line}: expected ${width} fields but found ${r.fields.length}`);
    return r.fields.map((f) => (f.quoted ? f.text : f.text === '' || f.text === nullText ? null : f.text));
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
function jsonType(values: SqlValue[]): string {
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

/** Fetches and reads external sources; holds what the application registered (files, credentials). */
export class ExternalRegistry {
  readonly files = new Map<string, FileSource>();
  readonly credentials = new Map<string, CredentialProvider>();
  /** Transport for http(s) locations (default: the global `fetch`). */
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

  /** Fetch and parse one source. */
  async read(source: ExternalSource, signal?: AbortSignal): Promise<ExternalData> {
    const fmt = formatOf(source.location, source.options, source.label);
    const { bytes, validator } = await this.fetchBytes(source, signal);
    const encoding = source.options.encoding === undefined || source.options.encoding === null ? 'utf-8' : String(source.options.encoding);
    let text: string;
    try {
      text = new TextDecoder(encoding, { fatal: false }).decode(bytes);
    } catch {
      throw externalError(source, `unsupported encoding '${encoding}'`);
    }
    const parsed = fmt.format === 'csv' ? readCsv(text, source, fmt.delimiter) : readJson(text, source);
    return { ...parsed, validator };
  }

  /** The URL an http(s) location resolves to (relative locations against the connection's url). */
  private url(source: ExternalSource): string | null {
    const loc = source.location;
    const base = source.connection?.options.url;
    if (/^https?:/i.test(loc)) return loc;
    if (base !== undefined && base !== null && !SCHEME.test(loc)) {
      const b = String(base);
      return new URL(loc, b.endsWith('/') ? b : `${b}/`).href;
    }
    return null;
  }

  /**
   * The source's current validator (ETag or Last-Modified, a file's mtime and size, a registered
   * File's lastModified and size) without reading it: a HEAD request or a stat. null when the source
   * has none (a registered Blob or bytes): it then counts as changed.
   */
  async currentValidator(source: ExternalSource, signal?: AbortSignal): Promise<string | null> {
    return (await this.fetchBytes(source, signal, true)).validator;
  }

  /** `head`: only the validator (no body). */
  private async fetchBytes(source: ExternalSource, signal?: AbortSignal, head = false): Promise<{ bytes: Uint8Array; validator: string | null }> {
    const conn = source.connection;
    const type = conn ? String(conn.options.type ?? 'http').toLowerCase() : null;
    if (type !== null && type !== 'http' && type !== 'https') {
      throw externalError(source, `connection ${conn!.name}: type '${type}' is not supported yet (M8.1 supports http)`);
    }
    const loc = source.location;
    if (/^file:/i.test(loc)) {
      const name = loc.slice(5);
      const f = this.files.get(name);
      if (f === undefined) throw externalError(source, `no file is registered as '${name}' (registerFile)`);
      return fileBytes(f, head);
    }
    const url = this.url(source);
    if (url !== null) return this.fetchUrl(source, url, signal, head);
    if (SCHEME.test(loc) && !/^[a-z]:[\\/]/i.test(loc)) throw externalError(source, `unsupported location '${loc}' (http(s) URLs, file:<name>, or a path in Node)`);
    if (!isNode()) throw externalError(source, `'${loc}' is a local path: in a browser, register the file (registerFile) and use file:<name>`);
    const fsName = 'node:fs/promises';
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFile(p: string): Promise<Uint8Array>; stat(p: string): Promise<{ mtimeMs: number; size: number }> };
    try {
      const [bytes, st] = await Promise.all([head ? new Uint8Array(0) : fs.readFile(loc), fs.stat(loc)]);
      return { bytes, validator: `${st.mtimeMs}:${st.size}` };
    } catch (e) {
      throw externalError(source, (e as Error).message);
    }
  }

  private async fetchUrl(source: ExternalSource, url: string, signal?: AbortSignal, head = false): Promise<{ bytes: Uint8Array; validator: string | null }> {
    const headers: Record<string, string> = {};
    const credName = source.connection?.options.credentials;
    if (credName !== undefined && credName !== null) {
      const p = this.credentials.get(String(credName));
      if (!p) throw externalError(source, `connection ${source.connection!.name}: no credentials are registered as '${credName}' (registerCredentials)`);
      if (!url.startsWith(p.endpoint)) {
        throw externalError(source, `credentials '${credName}' are bound to ${p.endpoint}; refusing to send them to ${url}`);
      }
      try {
        Object.assign(headers, typeof p.headers === 'function' ? await p.headers(url) : p.headers);
      } catch (e) {
        throw externalError(source, (e as Error).message); // a provider that failed or refused
      }
    }
    const fetchFn = this.fetchFn ?? (globalThis.fetch as unknown as FetchFn | undefined);
    if (!fetchFn) throw externalError(source, 'no fetch available in this environment');
    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await fetchFn(url, head ? { method: 'HEAD', headers, signal } : { headers, signal });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new SmaltError('SMALT_INTERRUPT', 'interrupted');
      throw externalError(source, `fetching ${url} failed: ${(e as Error).message} (a network error, or a CORS error: the server must allow this origin)`);
    }
    if (!res.ok) throw externalError(source, `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} for ${url}`);
    const bytes = head ? new Uint8Array(0) : new Uint8Array(await res.arrayBuffer());
    return { bytes, validator: res.headers.get('etag') ?? res.headers.get('last-modified') };
  }
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
