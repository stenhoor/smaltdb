/**
 * Parsing shared by the formats and import: CSV records (RFC 4180), JSON with exact big integers,
 * type inference and the conversion of text for a declared column type.
 */
import type { SqlValue } from 'smaltdb/engine';

/**
 * An error with a smaltdb error code (`SMALT_ERROR`, `SMALT_RANGE`, …). The plugin imports nothing
 * from the engine at run time, so it cannot create a SmaltError itself.
 */
export class IoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SmaltError';
  }
}

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
          if (i >= n) throw new IoError('SMALT_ERROR', `CSV line ${startLine}: unterminated quoted field`);
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

// ------------------------------------------------------------------ types

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
      // Integers come as safe numbers or bigints; other numbers (1.5, 1e20) are REAL.
      if (typeof v === 'number' && !Number.isSafeInteger(v)) type = 'REAL';
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

type StaticType = 'int' | 'real' | 'text' | 'blob' | 'any';

/** Static type of a declared column type (SQLite affinity rules). */
function staticTypeOf(declType: string): StaticType {
  const t = declType.toUpperCase();
  if (t.includes('INT')) return 'int';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'text';
  if (t.includes('BLOB')) return 'blob';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'real';
  return 'any';
}

/** `text` converted for a column of `declType` (affinity: text that does not fit stays text). */
export function convertText(text: string, declType: string): SqlValue {
  const st = staticTypeOf(declType);
  if (st === 'text' || st === 'blob') return text;
  const v = numericOrText(text);
  if (st === 'real' && typeof v === 'number') return v;
  if (st === 'real' && typeof v === 'bigint') return Number(v);
  return v;
}

// ------------------------------------------------------------------ JSON

/** JSON value -> SQL value: booleans 1/0, nested arrays/objects as JSON text. */
export function jsonValue(v: unknown): SqlValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return stringifyExact(v); // holds bigints
  }
}

/** JSON.stringify that writes bigints (from parseJson) as their exact digits. */
function stringifyExact(v: unknown): string {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return '[' + v.map(stringifyExact).join(',') + ']';
  if (v !== null && typeof v === 'object') return '{' + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ':' + stringifyExact(x)).join(',') + '}';
  return JSON.stringify(v);
}

const INT64_MIN = -(BigInt(2) ** BigInt(63));
const INT64_MAX = BigInt(2) ** BigInt(63) - BigInt(1);
/** A 16-digit run: only then can the text hold an integer that JSON.parse would round (2^53 has 16 digits). */
const LONG_DIGITS = /\d{16}/;
const JSON_NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;

/**
 * JSON.parse, except that integers beyond ±(2^53 − 1) keep their exact value as bigints (as
 * SQLite reads them) when they fit in 64 bits; larger ones become REAL numbers, as in SQLite.
 * Text without a 16-digit run takes JSON.parse alone.
 */
export function parseJson(text: string): unknown {
  const value = JSON.parse(text); // validates (and reports errors as JSON.parse does)
  return LONG_DIGITS.test(text) ? parseValidJson(text) : value;
}

/** A parser for text that JSON.parse accepted, reading integers exactly. */
function parseValidJson(text: string): unknown {
  let i = 0;
  const ws = (): void => {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
      else return;
    }
  };
  const str = (): string => {
    const start = i++;
    let escaped = false;
    for (;;) {
      const c = text.charCodeAt(i++);
      if (c === 0x22) break;
      if (c === 0x5c) {
        escaped = true;
        i++;
      }
    }
    return escaped ? (JSON.parse(text.slice(start, i)) as string) : text.slice(start + 1, i - 1);
  };
  const num = (): number | bigint => {
    JSON_NUMBER.lastIndex = i;
    const m = JSON_NUMBER.exec(text)!;
    i += m[0].length;
    if (m[1] !== undefined || m[2] !== undefined) return Number(m[0]);
    const n = Number(m[0]);
    if (Number.isSafeInteger(n)) return n;
    const b = BigInt(m[0]);
    return b >= INT64_MIN && b <= INT64_MAX ? b : n;
  };
  const value = (): unknown => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const o: Record<string, unknown> = {};
      ws();
      if (text[i] === '}') {
        i++;
        return o;
      }
      for (;;) {
        ws();
        const k = str();
        ws();
        i++; // ':'
        // Like JSON.parse: an own property even for "__proto__".
        Object.defineProperty(o, k, { value: value(), writable: true, enumerable: true, configurable: true });
        ws();
        if (text[i++] === '}') return o;
      }
    }
    if (c === '[') {
      i++;
      const a: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return a;
      }
      for (;;) {
        a.push(value());
        ws();
        if (text[i++] === ']') return a;
      }
    }
    if (c === '"') return str();
    if (c === 't') {
      i += 4;
      return true;
    }
    if (c === 'f') {
      i += 5;
      return false;
    }
    if (c === 'n') {
      i += 4;
      return null;
    }
    return num();
  };
  return value();
}
