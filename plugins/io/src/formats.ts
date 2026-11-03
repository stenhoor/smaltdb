/**
 * The CSV, TSV and JSON / NDJSON formats for external tables and `read_csv` / `read_json`. Errors are
 * plain Errors: the engine reports them as SMALT_EXTERNAL with the source's label in front.
 */
import type { FormatColumn, FormatRequest, FormatResult, SqlValue } from 'smaltdb/engine';
import { type Field, convertText, csvRecords, inferType, jsonValue } from './text.js';

const truthyOption = (v: SqlValue | undefined, dflt: boolean): boolean => {
  if (v === undefined || v === null) return dflt;
  if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
  return Number(v) !== 0;
};

/** The file's bytes as text, in the `encoding` option (default UTF-8). */
export function decode(bytes: Uint8Array, options: Record<string, SqlValue>): string {
  const encoding = options.encoding === undefined || options.encoding === null ? 'utf-8' : String(options.encoding);
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    throw new Error(`unsupported encoding '${encoding}'`);
  }
}

/** CSV / TSV text -> rows. Columns are declared (by position) or named by the header and inferred. */
export function readCsv(text: string, request: Pick<FormatRequest, 'options' | 'columns'>, delimiter = ','): FormatResult {
  const o = request.options;
  const delim = o.delimiter !== undefined && o.delimiter !== null ? String(o.delimiter) : delimiter;
  const quote = o.quote !== undefined && o.quote !== null ? String(o.quote) : '"';
  if (delim.length !== 1 || quote.length !== 1) throw new Error('delimiter and quote must be single characters');
  const header = truthyOption(o.header, true);
  const nullText = o.null === undefined || o.null === null ? null : String(o.null);
  let skip = Number(o.skip ?? 0);
  if (!Number.isInteger(skip) || skip < 0) throw new Error('skip must be a non-negative integer');
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
    throw new Error((e as Error).message);
  }
  let names: string[] | undefined;
  if (header && records.length > 0) names = records.shift()!.fields.map((f) => f.text.trim());
  // Declared columns match a header by name when every one is in it (files may order columns
  // differently); otherwise by position.
  let pick: number[] | null = null;
  if (names && request.columns) {
    const at = new Map(names.map((n, i) => [n.toLowerCase(), i]));
    if (request.columns.every((c) => at.has(c.name.toLowerCase()))) pick = request.columns.map((c) => at.get(c.name.toLowerCase())!);
    else if (names.length !== request.columns.length) throw new Error(`the header has ${names.length} fields but ${request.columns.length} columns are declared`);
  }
  const width = names?.length ?? request.columns?.length ?? records[0]?.fields.length ?? 0;
  const raw: (string | null)[][] = records.map((r) => {
    if (r.fields.length !== width) throw new Error(`CSV line ${r.line}: expected ${width} fields but found ${r.fields.length}`);
    const vals = r.fields.map((f) => (f.quoted ? f.text : f.text === '' || f.text === nullText ? null : f.text));
    return pick ? pick.map((i) => vals[i]) : vals;
  });
  let columns: FormatColumn[];
  if (request.columns) columns = request.columns;
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
  return { columns, rows };
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
export function readJson(text: string, request: Pick<FormatRequest, 'options' | 'columns'>): FormatResult {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let items: unknown[];
  if (body.trimStart().startsWith('[')) {
    try {
      const v = JSON.parse(body);
      if (!Array.isArray(v)) throw new Error('expected an array');
      items = v;
    } catch (e) {
      throw new Error(`invalid JSON: ${(e as Error).message}`);
    }
  } else {
    items = [];
    body.split(/\r?\n/).forEach((l, i) => {
      if (l.trim() === '') return;
      try {
        items.push(JSON.parse(l));
      } catch (e) {
        throw new Error(`NDJSON line ${i + 1}: ${(e as Error).message}`);
      }
    });
  }
  const objects = items.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x));
  let names: string[];
  if (request.columns) names = request.columns.map((c) => c.name);
  else if (objects) {
    const seen = new Map<string, string>();
    for (const x of items) for (const k of Object.keys(x as object)) if (!seen.has(k.toLowerCase())) seen.set(k.toLowerCase(), k);
    names = [...seen.values()];
  } else if (items.every(Array.isArray)) {
    names = Array.from({ length: Math.max(0, ...items.map((x) => (x as unknown[]).length)) }, (_, i) => `column${i + 1}`);
  } else throw new Error('expected JSON objects or arrays (not a mix)');
  const rows: SqlValue[][] = items.map((x, n) => {
    if (objects) {
      const byLower = new Map(Object.entries(x as object).map(([k, v]) => [k.toLowerCase(), v]));
      return names.map((c) => jsonValue(byLower.get(c.toLowerCase())));
    }
    if (!Array.isArray(x)) throw new Error(`item ${n + 1}: expected an array`);
    if (request.columns && x.length !== names.length) throw new Error(`item ${n + 1}: expected ${names.length} values but found ${x.length}`);
    return names.map((_, i) => jsonValue(x[i]));
  });
  const columns: FormatColumn[] = request.columns ?? names.map((name, i) => ({ name, declType: jsonType(rows.map((r) => r[i])) }));
  if (request.columns) {
    // Declared types convert numeric-looking text and vice versa where the affinity says so.
    for (const r of rows) for (let i = 0; i < r.length; i++) if (typeof r[i] === 'string') r[i] = convertText(r[i] as string, columns[i].declType);
  }
  return { columns, rows };
}
