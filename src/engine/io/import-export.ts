/**
 * CSV and JSON / NDJSON import and export (docs/API.md). Runs inside the engine (worker), so rows
 * never cross the message boundary one by one: imports go through one prepared INSERT in a single
 * transaction (all constraints, conversions and foreign keys apply), exports format query results.
 */
import type { Database, Statement } from '../database.js';
import { SmaltError } from '../errors.js';
import { formatReal } from '../exec/functions.js';
import type { SqlValue } from '../values.js';

export interface CsvImportOptions {
  /** First record names the columns (default true). Without it, fields map to table columns in order. */
  header?: boolean;
  delimiter?: string;
  quote?: string;
  /** Target columns (overrides the header). */
  columns?: string[];
  /** Create the table if it does not exist, inferring INTEGER / REAL / TEXT per column. */
  create?: boolean;
  /** Unquoted empty fields become NULL (default true); quoted `""` is always an empty string. */
  emptyAsNull?: boolean;
}

export interface JsonImportOptions {
  /** Create the table if it does not exist, inferring column types from the values. */
  create?: boolean;
  /** Target columns for arrays-of-arrays input (default: the table's columns in order). */
  columns?: string[];
}

export interface CsvExportOptions {
  header?: boolean;
  delimiter?: string;
  /** Text written for NULL (default empty). */
  nullString?: string;
  /** Use CRLF line endings (default LF). */
  crlf?: boolean;
}

export interface JsonExportOptions {
  /** 'array' (default): one JSON array of objects; 'ndjson': one object per line. */
  format?: 'array' | 'ndjson';
}

const q = (name: string): string => '"' + name.replace(/"/g, '""') + '"';

// ------------------------------------------------------------------ CSV parsing (RFC 4180)

/** A parsed field: its text, and whether it was quoted (distinguishes "" from an empty field). */
export interface Field {
  text: string;
  quoted: boolean;
}

export function* csvRecords(text: string, delim: string, quote: string): Generator<{ fields: Field[]; line: number }> {
  let i = 0;
  const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM
  let line = 1;
  while (i < n) {
    const startLine = line;
    const fields: Field[] = [];
    for (;;) {
      let value = '';
      let quoted = false;
      if (text[i] === quote) {
        quoted = true;
        i++;
        for (;;) {
          if (i >= n) throw new SmaltError('SMALT_ERROR', `CSV line ${startLine}: unterminated quoted field`);
          const ch = text[i];
          if (ch === quote) {
            if (text[i + 1] === quote) {
              value += quote;
              i += 2;
              continue;
            }
            i++;
            break;
          }
          if (ch === '\n') line++;
          value += ch;
          i++;
        }
        // Anything between the closing quote and the delimiter is kept (lenient, like SQLite's .import).
        while (i < n && text[i] !== delim && text[i] !== '\n' && text[i] !== '\r') value += text[i++];
      } else {
        const start = i;
        while (i < n && text[i] !== delim && text[i] !== '\n' && text[i] !== '\r') i++;
        value = text.slice(start, i);
      }
      fields.push({ text: value, quoted });
      if (i < n && text[i] === delim) {
        i++;
        continue;
      }
      // End of record.
      if (text[i] === '\r') i++;
      if (text[i] === '\n') i++;
      line++;
      break;
    }
    // Skip blank lines.
    if (fields.length === 1 && fields[0].text === '' && !fields[0].quoted) continue;
    yield { fields, line: startLine };
  }
}

const INT_RE = /^[+-]?\d+$/;
const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Infer a column type from sample values (INTEGER, REAL, TEXT). */
export function inferType(values: SqlValue[]): string {
  let type = 'INTEGER';
  let any = false;
  for (const v of values) {
    if (v === null) continue;
    any = true;
    if (typeof v === 'number' || typeof v === 'bigint') {
      if (typeof v === 'number' && !Number.isInteger(v)) type = 'REAL';
      continue;
    }
    if (typeof v !== 'string') return 'ANY';
    const s = v.trim();
    if (INT_RE.test(s)) continue;
    if (NUM_RE.test(s)) {
      type = 'REAL';
      continue;
    }
    return 'TEXT';
  }
  return any ? type : 'TEXT';
}

/** Text that looks numeric becomes a number (for ANY / NUMERIC target columns). */
export function numericOrText(s: string): SqlValue {
  const t = s.trim();
  if (INT_RE.test(t)) {
    const b = BigInt(t);
    return b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b;
  }
  if (NUM_RE.test(t)) return Number(t);
  return s;
}

/** Insert rows (values per target column) into `table` in one transaction. */
function load(db: Database, table: string, columns: string[], rows: Iterable<{ values: SqlValue[]; where: string; present?: boolean[] }>, create: boolean, sample: SqlValue[][]): number {
  let t = db.getTable(table);
  if (!t) {
    if (!create) throw new SmaltError('SMALT_ERROR', `no such table: ${table}`);
    const defs = columns.map((c, i) => `${q(c)} ${inferType(sample.map((r) => r[i] ?? null))}`);
    db.exec(`CREATE TABLE ${q(table)}(${defs.join(', ')})`);
    t = db.getTable(table)!;
  }
  const idx = columns.map((c) => {
    const i = t!.columns.findIndex((x) => x.name.toLowerCase() === c.toLowerCase());
    if (i < 0) throw new SmaltError('SMALT_ERROR', `table ${t!.name} has no column named ${c}`);
    return i;
  });
  // ANY / NUMERIC columns get numbers for numeric-looking text (typed columns convert on their own).
  const loose = idx.map((i) => t!.columns[i].type === 'ANY' || t!.columns[i].type === 'NUMERIC');
  // One INSERT per set of present columns (absent JSON keys take the column DEFAULT, not NULL).
  const statements = new Map<string, ReturnType<Database['prepare']>>();
  const stmtFor = (present: boolean[] | undefined): { st: ReturnType<Database['prepare']>; pick: number[] } => {
    const pick = present ? idx.flatMap((_, k) => (present[k] ? [k] : [])) : idx.map((_, k) => k);
    const key = pick.join(',');
    let st = statements.get(key);
    if (!st) {
      const cols = pick.map((k) => q(t!.columns[idx[k]].name));
      st = db.prepare(cols.length ? `INSERT INTO ${q(t!.name)}(${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})` : `INSERT INTO ${q(t!.name)} DEFAULT VALUES`);
      statements.set(key, st);
    }
    return { st, pick };
  };
  const own = !db.inTransaction;
  if (own) db.exec('BEGIN');
  let n = 0;
  try {
    for (const r of rows) {
      const vals = r.values.map((v, i) => (loose[i] && typeof v === 'string' ? numericOrText(v) : v));
      const { st, pick } = stmtFor(r.present);
      try {
        st.run(pick.map((k) => vals[k]));
      } catch (e) {
        const err = e as SmaltError;
        throw new SmaltError(err.code ?? 'SMALT_ERROR', `${r.where}: ${err.message}`);
      }
      n++;
    }
    if (own) db.exec('COMMIT');
  } catch (e) {
    if (own && db.inTransaction) db.exec('ROLLBACK');
    throw e;
  }
  return n;
}

export function importCSV(db: Database, table: string, text: string, opts: CsvImportOptions = {}): { rows: number } {
  const delim = opts.delimiter ?? ',';
  const quote = opts.quote ?? '"';
  if (delim.length !== 1 || quote.length !== 1) throw new SmaltError('SMALT_RANGE', 'CSV delimiter and quote must be single characters');
  const emptyAsNull = opts.emptyAsNull ?? true;
  const it = csvRecords(text, delim, quote);
  let columns = opts.columns;
  const first = it.next();
  if (first.done) return { rows: 0 };
  const records: { fields: Field[]; line: number }[] = [];
  if (opts.header ?? true) {
    columns ??= first.value.fields.map((f) => f.text.trim());
  } else records.push(first.value);
  if (!columns) {
    const t = db.getTable(table);
    if (!t) throw new SmaltError('SMALT_ERROR', `no such table: ${table} (give a header or columns to create it)`);
    columns = t.columns.map((c) => c.name);
  }
  const width = columns.length;
  const toValues = (r: { fields: Field[]; line: number }): { values: SqlValue[]; where: string } => {
    if (r.fields.length !== width) throw new SmaltError('SMALT_ERROR', `CSV line ${r.line}: expected ${width} fields but found ${r.fields.length}`);
    return { values: r.fields.map((f) => (!f.quoted && f.text === '' && emptyAsNull ? null : f.text)), where: `CSV line ${r.line}` };
  };
  // Creating the table needs the values first (type inference); otherwise rows stream.
  const needSample = !db.getTable(table) && opts.create;
  if (needSample) {
    for (const r of it) records.push(r);
    const rows = records.map(toValues);
    return { rows: load(db, table, columns, rows, true, rows.map((r) => r.values)) };
  }
  function* all(): Generator<{ values: SqlValue[]; where: string }> {
    for (const r of records) yield toValues(r);
    for (const r of it) yield toValues(r);
  }
  return { rows: load(db, table, columns, all(), false, []) };
}

/** JSON value -> SQL value: booleans 1/0, nested arrays/objects as JSON text. */
export function jsonValue(v: unknown): SqlValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string') return v;
  return JSON.stringify(v);
}

export function importJSON(db: Database, table: string, text: string, opts: JsonImportOptions = {}): { rows: number } {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const trimmed = body.trimStart();
  let items: { value: unknown; where: string }[];
  if (trimmed.startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(body);
    } catch (e) {
      throw new SmaltError('SMALT_ERROR', `invalid JSON: ${(e as Error).message}`);
    }
    if (!Array.isArray(arr)) throw new SmaltError('SMALT_ERROR', 'JSON import expects an array or NDJSON');
    items = arr.map((value, i) => ({ value, where: `JSON item ${i + 1}` }));
  } else {
    items = [];
    body.split(/\r?\n/).forEach((l, i) => {
      if (l.trim() === '') return;
      try {
        items.push({ value: JSON.parse(l), where: `NDJSON line ${i + 1}` });
      } catch (e) {
        throw new SmaltError('SMALT_ERROR', `NDJSON line ${i + 1}: ${(e as Error).message}`);
      }
    });
  }
  if (items.length === 0) return { rows: 0 };
  const objects = items.every((x) => x.value !== null && typeof x.value === 'object' && !Array.isArray(x.value));
  let columns: string[];
  if (objects) {
    // Union of keys in first-seen order; a row's missing keys take the column's DEFAULT.
    const seen = new Map<string, string>();
    for (const x of items) for (const k of Object.keys(x.value as object)) if (!seen.has(k.toLowerCase())) seen.set(k.toLowerCase(), k);
    columns = [...seen.values()];
  } else {
    if (!items.every((x) => Array.isArray(x.value))) throw new SmaltError('SMALT_ERROR', 'JSON import expects objects or arrays (not a mix)');
    const t = db.getTable(table);
    columns = opts.columns ?? t?.columns.map((c) => c.name) ?? [];
    if (!columns.length) throw new SmaltError('SMALT_ERROR', `no such table: ${table} (give columns to create it)`);
  }
  const rows = items.map((x) => {
    if (objects) {
      const o = x.value as Record<string, unknown>;
      const byLower = new Map(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
      return { values: columns.map((c) => jsonValue(byLower.get(c.toLowerCase()))), where: x.where, present: columns.map((c) => byLower.has(c.toLowerCase())) };
    }
    const a = x.value as unknown[];
    if (a.length !== columns.length) throw new SmaltError('SMALT_ERROR', `${x.where}: expected ${columns.length} values but found ${a.length}`);
    return { values: a.map(jsonValue), where: x.where };
  });
  return { rows: load(db, table, columns, rows, !!opts.create, rows.map((r) => r.values)) };
}

// ------------------------------------------------------------------ export

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

/** Text of a value; `real` marks a REAL-typed result column (integral values print as 2.0, like SQLite). */
function textOf(v: SqlValue, real = false): string {
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 2 ** 53 && !real ? String(v) : formatReal(v);
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return hex(v);
  return String(v);
}

/** A result with its columns' static types (REAL values print as reals, `2.0`). */
interface TypedResult {
  columns: string[];
  rows: SqlValue[][];
  real: boolean[];
}

function typedResult(st: Statement, params?: SqlValue[] | Record<string, SqlValue>): TypedResult {
  const rows = st.all(params as never);
  return { columns: st.columns, rows, real: st.columnTypes.map((t) => t === 'real') };
}

export function exportCSV(db: Database, sql: string, params?: SqlValue[] | Record<string, SqlValue>, opts: CsvExportOptions = {}): string {
  return formatCSV(typedResult(db.prepare(sql), params), opts);
}

/** `exportCSV` for queries that may read external data (M8): their sources are fetched first. */
export async function exportCSVAsync(db: Database, sql: string, params?: SqlValue[] | Record<string, SqlValue>, opts: CsvExportOptions = {}, signal?: AbortSignal): Promise<string> {
  const st = db.prepare(sql);
  return formatCSV(await db.withExternal(signal, st, () => typedResult(st, params)), opts);
}

/** `exportJSON` for queries that may read external data (M8). */
export async function exportJSONAsync(db: Database, sql: string, params?: SqlValue[] | Record<string, SqlValue>, opts: JsonExportOptions = {}, signal?: AbortSignal): Promise<string> {
  const st = db.prepare(sql);
  return formatJSON(await db.withExternal(signal, st, () => typedResult(st, params)), opts);
}

function formatCSV(res: TypedResult, opts: CsvExportOptions): string {
  const delim = opts.delimiter ?? ',';
  const nl = opts.crlf ? '\r\n' : '\n';
  const nullString = opts.nullString ?? '';
  const real = res.real;
  const field = (s: string): string => (s.includes(delim) || s.includes('"') || s.includes('\n') || s.includes('\r') || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  const out: string[] = [];
  if (opts.header ?? true) out.push(res.columns.map(field).join(delim));
  for (const row of res.rows) out.push(row.map((v, i) => (v === null ? nullString : field(textOf(v, real[i])))).join(delim));
  return out.length ? out.join(nl) + nl : '';
}

function jsonOf(v: SqlValue, real = false): string {
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? (Number.isInteger(v) && Math.abs(v) < 2 ** 53 && !real ? String(v) : formatReal(v)) : 'null';
  if (typeof v === 'bigint') return v.toString(); // exact digits (JSON numbers have no size limit)
  if (v instanceof Uint8Array) return JSON.stringify(hex(v));
  return JSON.stringify(v);
}

export function exportJSON(db: Database, sql: string, params?: SqlValue[] | Record<string, SqlValue>, opts: JsonExportOptions = {}): string {
  return formatJSON(typedResult(db.prepare(sql), params), opts);
}

function formatJSON(res: TypedResult, opts: JsonExportOptions): string {
  const { rows, real } = res;
  const keys = res.columns.map((c) => JSON.stringify(c));
  const objects = rows.map((row) => '{' + row.map((v, i) => `${keys[i]}:${jsonOf(v, real[i])}`).join(',') + '}');
  if (opts.format === 'ndjson') return objects.length ? objects.join('\n') + '\n' : '';
  return '[' + objects.join(',') + ']';
}
