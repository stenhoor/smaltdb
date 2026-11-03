/**
 * @smaltdb/parquet: the Parquet format for smaltdb external tables and `read_parquet()` (ADR 0012).
 *
 * Reads only what a statement needs: the footer first (the last 16 KB, more if the metadata is
 * longer), then only the column chunks of the columns the statement uses, in the row groups whose
 * statistics do not rule them out. Files under 64 KB are read in one request.
 *
 * Decoding is done by hyparquet; codecs other than Snappy and uncompressed need
 * hyparquet-compressors, loaded on first use.
 */
import type * as Hyparquet from 'hyparquet';
import type { FormatColumn, FormatRequest, FormatResult, RandomAccessFile, SmaltPlugin, SqlValue, Zone } from 'smaltdb/engine';

declare const __PLUGIN_VERSION__: string | undefined;
const VERSION = typeof __PLUGIN_VERSION__ === 'string' ? __PLUGIN_VERSION__ : '0.0.0';

const parquet: SmaltPlugin = {
  name: '@smaltdb/parquet',
  version: VERSION,
  apiVersion: 1,
  setup(host) {
    host.addFormat({ name: 'parquet', aliases: ['pq'], extensions: ['parquet', 'pq'], access: 'random', pushdown: true, read: readParquet });
    host.addTableFunction('read_parquet', { format: 'parquet' });
  },
};
export default parquet;

let compressorsModule: Promise<{ compressors: Hyparquet.Compressors }> | null = null;

/** hyparquet-compressors (gzip, zstd, brotli, lz4), loaded only for files that need it. */
async function compressors(): Promise<Hyparquet.Compressors> {
  compressorsModule ??= import('hyparquet-compressors');
  try {
    return (await compressorsModule).compressors;
  } catch {
    compressorsModule = null;
    throw new Error('this file uses a codec that needs the hyparquet-compressors package (npm install hyparquet-compressors)');
  }
}

async function readParquet(file: RandomAccessFile, req: FormatRequest): Promise<FormatResult> {
  const pq = await import('hyparquet');
  // Files under 64 KB are read in one request (fewer round trips); larger ones by ranges.
  const buffer = pq.cachedAsyncBuffer(file as Hyparquet.AsyncBuffer, { minSize: 1 << 16 });
  let meta: Hyparquet.FileMetaData;
  try {
    // The footer is usually a few KB: start with 16 KB from the end (hyparquet fetches more when
    // the metadata is longer), not its default 512 KB, which is all of a small file.
    meta = await pq.parquetMetadataAsync(buffer, { parsers: PARQUET_PARSERS, initialFetchSize: 1 << 14 } as Hyparquet.MetadataOptions);
  } catch (e) {
    // No footer where the size puts it: maybe the size is wrong (a host that reported a compressed
    // size), so the engine may retry with the whole file.
    throw Object.assign(new Error(`not a readable Parquet file: ${(e as Error).message}`), { wholeFileMayHelp: true });
  }
  const schema = pq.parquetSchema(meta).children;
  const fileCols: FormatColumn[] = schema.map((c) => ({ name: c.element.name, declType: parquetDeclType(c) }));
  if (req.schemaOnly) return { columns: fileCols, rows: [] };
  const out = req.columns ?? fileCols;
  const actual = new Map(fileCols.map((c) => [c.name.toLowerCase(), c.name]));
  // Columns to read: the projection's (or all), that exist in this file.
  const want = out.filter((c) => actual.has(c.name.toLowerCase()) && (req.projection === undefined || req.projection.has(c.name.toLowerCase())));
  const at = new Map(want.map((c, i) => [c.name.toLowerCase(), i]));
  const pos = out.map((c) => at.get(c.name.toLowerCase()) ?? -1);
  // Row groups whose statistics cannot rule them out, as row ranges.
  const ranges: [number, number][] = [];
  let start = 0;
  for (const rg of meta.row_groups) {
    const n = Number(rg.num_rows);
    const keep = !req.blockFilters?.length || req.blockFilters.every((p) => p(rowGroupZones(rg), n) !== false);
    if (keep && n > 0) {
      const last = ranges[ranges.length - 1];
      if (last && last[1] === start) last[1] = start + n;
      else ranges.push([start, start + n]);
    }
    start += n;
  }
  const codecs = new Set(meta.row_groups.flatMap((rg) => rg.columns.map((c) => c.meta_data?.codec)));
  const extra = [...codecs].some((c) => c && c !== 'UNCOMPRESSED' && c !== 'SNAPPY') ? await compressors() : undefined;
  const rows: SqlValue[][] = [];
  for (const [rowStart, rowEnd] of ranges) {
    if (want.length === 0) {
      // No column is read (count(*)): only the number of rows matters.
      for (let i = rowStart; i < rowEnd; i++) rows.push(out.map(() => null));
      continue;
    }
    let chunk: unknown[][] = [];
    try {
      await pq.parquetRead({
        file: buffer,
        metadata: meta,
        columns: want.map((c) => actual.get(c.name.toLowerCase())!),
        rowStart,
        rowEnd,
        rowFormat: 'array',
        utf8: false,
        parsers: PARQUET_PARSERS,
        compressors: extra,
        onComplete: (r) => (chunk = r),
      });
    } catch (e) {
      throw new Error(`Parquet: ${(e as Error).message}`);
    }
    for (const r of chunk) rows.push(pos.map((i) => (i < 0 ? null : parquetValue(r[i]))));
  }
  return { columns: out, rows };
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** `YYYY-MM-DD HH:MM:SS[.fraction]` (UTC) for `seconds` since the epoch plus a fraction of `digits` digits. */
function timestampText(seconds: bigint, fraction: bigint, digits: number): string {
  const d = new Date(Number(seconds) * 1000);
  let text = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (fraction > 0n) text += '.' + fraction.toString().padStart(digits, '0').replace(/0+$/, '');
  return text;
}

/** Split `v` units of 10^-digits seconds into whole seconds and the (non-negative) fraction. */
function splitTime(v: bigint, digits: number): string {
  const unit = 10n ** BigInt(digits);
  let s = v / unit;
  let f = v % unit;
  if (f < 0n) {
    s -= 1n;
    f += unit;
  }
  return timestampText(s, f, digits);
}

/** Dates and timestamps as text, in SQLite's format (ordered like the values; zone maps compare them). */
const PARQUET_PARSERS: Partial<Hyparquet.ParquetParsers> = {
  dateFromDays: (days: number) => {
    const d = new Date(days * 86_400_000);
    return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  },
  timestampFromMilliseconds: (ms: bigint) => splitTime(BigInt(ms), 3),
  timestampFromMicroseconds: (us: bigint) => splitTime(BigInt(us), 6),
  timestampFromNanoseconds: (ns: bigint) => splitTime(BigInt(ns), 9),
} as unknown as Partial<Hyparquet.ParquetParsers>;

/** The declared type of a top-level Parquet column (nested ones are JSON text). */
function parquetDeclType(c: Hyparquet.SchemaTree): string {
  const e = c.element;
  if (c.children.length > 0) return 'TEXT';
  const ct = e.converted_type;
  const lt = e.logical_type?.type;
  if (ct === 'DECIMAL' || lt === 'DECIMAL' || lt === 'FLOAT16') return 'REAL';
  if (ct === 'DATE' || lt === 'DATE' || ct === 'TIMESTAMP_MILLIS' || ct === 'TIMESTAMP_MICROS' || lt === 'TIMESTAMP' || e.type === 'INT96') return 'TEXT';
  if (ct === 'UTF8' || ct === 'ENUM' || ct === 'JSON' || lt === 'STRING' || lt === 'ENUM' || lt === 'JSON' || lt === 'UUID') return 'TEXT';
  switch (e.type) {
    case 'BOOLEAN':
    case 'INT32':
    case 'INT64':
      return 'INTEGER';
    case 'FLOAT':
    case 'DOUBLE':
      return 'REAL';
    default:
      return 'BLOB';
  }
}

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** A value hyparquet decoded, as a SQL value (nested values as JSON text). */
function parquetValue(v: unknown): SqlValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  if (typeof v === 'bigint') return v >= MIN_SAFE && v <= MAX_SAFE ? Number(v) : v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' || v instanceof Uint8Array) return v;
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? (x >= MIN_SAFE && x <= MAX_SAFE ? Number(x) : x.toString()) : x instanceof Uint8Array ? Array.from(x) : x));
}

/** Zone maps of a row group's top-level columns from their statistics (lower-cased names). */
function rowGroupZones(rg: Hyparquet.RowGroup): Map<string, Zone> {
  const zones = new Map<string, Zone>();
  for (const c of rg.columns) {
    const md = c.meta_data;
    if (!md || md.path_in_schema.length !== 1 || !md.statistics) continue;
    const st = md.statistics;
    const z: Zone = { nulls: st.null_count === undefined ? -1 : Number(st.null_count) };
    // min_value / max_value are ordered correctly for every type; the deprecated min / max only for numbers.
    const num = (x: unknown): number | undefined =>
      typeof x === 'number' && !Number.isNaN(x) ? x : typeof x === 'bigint' && x >= MIN_SAFE && x <= MAX_SAFE ? Number(x) : typeof x === 'boolean' ? (x ? 1 : 0) : undefined;
    const lo = st.min_value ?? (md.type === 'BYTE_ARRAY' || md.type === 'FIXED_LEN_BYTE_ARRAY' ? undefined : st.min);
    const hi = st.max_value ?? (md.type === 'BYTE_ARRAY' || md.type === 'FIXED_LEN_BYTE_ARRAY' ? undefined : st.max);
    const nlo = num(lo);
    const nhi = num(hi);
    if (nlo !== undefined && nhi !== undefined) {
      z.numMin = nlo;
      z.numMax = nhi;
    } else if (typeof lo === 'string' && typeof hi === 'string') {
      z.textMin = lo;
      z.textMax = hi;
    }
    zones.set(md.path_in_schema[0].toLowerCase(), z);
  }
  return zones;
}
