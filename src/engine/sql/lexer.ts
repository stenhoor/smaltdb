/**
 * SQL tokenizer (SQLite dialect).
 *
 * The whole input is scanned once, up front, into parallel arrays (struct-of-arrays). The scanner
 * works on `charCodeAt` with a small character-class table; no regular expressions are used.
 *
 * Lexical errors (unterminated strings, bad blobs, stray characters, ...) do not throw here: they
 * become `TK_ILLEGAL` tokens whose value is the error message, and the parser reports them when
 * it reaches them, so earlier syntax errors are reported first.
 */

export const TK_EOF = 0;
/** Unquoted identifier that is not a keyword. `val` is the text as written. */
export const TK_ID = 1;
/** Reserved keyword; can never be used as an unquoted identifier. */
export const TK_KW = 2;
/** Non-reserved ("fallback") keyword; usable as an identifier where unambiguous. `val` is the text as written. */
export const TK_NKW = 3;
/** Quoted identifier (`"x"`, `[x]`, `` `x` ``). `val` is the unquoted name. */
export const TK_QID = 4;
/** String literal; `val` is the unescaped string. */
export const TK_STRING = 5;
/** Blob literal; `val` is a Uint8Array. */
export const TK_BLOB = 6;
/**
 * Integer literal. `val` is a number when within ±(2^53-1), otherwise a bigint which may exceed the
 * int64 range (the parser turns those into REAL after applying any unary minus).
 */
export const TK_INT = 7;
/** Real literal; `val` is a number. */
export const TK_FLOAT = 8;
/** Parameter (`?`, `?NNN`, `:a`, `@a`, `$a`); `val` is the source text. */
export const TK_PARAM = 9;
/** Operator or punctuation; `val` is the canonical operator (`==` -> `=`, `<>` -> `!=`). */
export const TK_OP = 10;
/** Unrecognized token; `val` is the error message. */
export const TK_ILLEGAL = 11;

export type TokenValue = string | number | bigint | Uint8Array | null;

export interface Tokens {
  /** Number of tokens, including the trailing EOF token. */
  count: number;
  kinds: number[];
  /** Source offset of each token's first character. */
  starts: number[];
  /** Source offset just past each token. */
  ends: number[];
  vals: TokenValue[];
  /** Canonical upper-case keyword for TK_KW/TK_NKW tokens, '' for all others. */
  kws: string[];
}

/** Keywords that cannot be used as unquoted identifiers (close to SQLite's non-fallback set). */
const RESERVED_KEYWORDS = [
  'ADD', 'ALL', 'ALTER', 'AND', 'AS', 'AUTOINCREMENT', 'BETWEEN', 'CASE', 'CAST', 'CHECK', 'COLLATE',
  'COMMIT', 'CONSTRAINT', 'CREATE', 'CROSS', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP',
  'DEFAULT', 'DEFERRABLE', 'DELETE', 'DISTINCT', 'DROP', 'ELSE', 'ESCAPE', 'EXCEPT', 'EXISTS', 'FALSE',
  'FOREIGN', 'FROM', 'FULL', 'GLOB', 'GROUP', 'HAVING', 'IN', 'INDEX', 'INDEXED', 'INNER', 'INSERT',
  'INTERSECT', 'INTO', 'IS', 'ISNULL', 'JOIN', 'LEFT', 'LIKE', 'LIMIT', 'NATURAL', 'NOT', 'NOTNULL',
  'NULL', 'ON', 'OR', 'ORDER', 'OUTER', 'PRIMARY', 'REFERENCES', 'RETURNING', 'RIGHT', 'SELECT', 'SET',
  'TABLE', 'THEN', 'TO', 'TRANSACTION', 'TRUE', 'UNION', 'UNIQUE', 'UPDATE', 'USING', 'VALUES', 'WHEN',
  'WHERE',
];

/** Keywords that may also be used as identifiers (SQLite "fallback" keywords plus smaltdb additions). */
const NONRESERVED_KEYWORDS = [
  'ABORT', 'ACTION', 'AFTER', 'ALWAYS', 'ANALYZE', 'ASC', 'ATTACH', 'BEFORE', 'BEGIN', 'BY', 'CASCADE',
  'COLUMN', 'CONCURRENTLY', 'CONFLICT', 'CURRENT', 'DATA', 'DATABASE', 'DEFERRED', 'DESC', 'DETACH', 'DO', 'EACH',
  'END', 'EXCLUDE', 'EXCLUSIVE', 'EXPLAIN', 'FAIL', 'FILTER', 'FIRST', 'FOLLOWING', 'FOR', 'GENERATED',
  'GROUPS', 'IF', 'IGNORE', 'IMMEDIATE', 'INCLUDE', 'INITIALLY', 'INSTEAD', 'KEY', 'LAST', 'LOOSE',
  'MATCH', 'MATERIALIZED', 'NO', 'NOTHING', 'NULLS', 'OF', 'OFFSET', 'OTHERS', 'OVER', 'PARTITION',
  'PLAN', 'PRAGMA', 'PRECEDING', 'QUERY', 'RAISE', 'RANGE', 'RECURSIVE', 'REFRESH', 'REGEXP', 'REINDEX',
  'RELEASE', 'RENAME', 'REPLACE', 'RESTRICT', 'ROLLBACK', 'ROW', 'ROWS', 'SAVEPOINT', 'STORED', 'STRICT',
  'TEMP', 'TEMPORARY', 'TIES', 'TRIGGER', 'UNBOUNDED', 'VACUUM', 'VIEW', 'VIRTUAL', 'WINDOW', 'WITH',
  'WITHOUT',
];

/** Upper-case keyword -> canonical (interned) keyword string. */
const KEYWORDS = new Map<string, string>();
const RESERVED = new Set<string>();
for (const k of RESERVED_KEYWORDS) {
  KEYWORDS.set(k, k);
  RESERVED.add(k);
}
for (const k of NONRESERVED_KEYWORDS) KEYWORDS.set(k, k);
const MAX_KEYWORD_LEN = 17; // CURRENT_TIMESTAMP

/** True if `word` (any case) is a reserved keyword, i.e. must be quoted to be used as an identifier. */
export function isReservedKeyword(word: string): boolean {
  return RESERVED.has(word.toUpperCase());
}

// Character classes for ASCII; every code unit >= 0x80 counts as an identifier character, as in SQLite.
const CC_ID_START = 1;
const CC_ID = 2;
const CC_DIGIT = 4;
const CC_HEX = 8;
const CC_SPACE = 16;
const CC = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  let f = 0;
  if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f) f |= CC_ID_START | CC_ID;
  if (c >= 0x30 && c <= 0x39) f |= CC_ID | CC_DIGIT | CC_HEX;
  if ((c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)) f |= CC_HEX;
  if (c === 0x24) f |= CC_ID; // `$` may appear inside identifiers
  if (c === 0x20 || (c >= 0x09 && c <= 0x0d)) f |= CC_SPACE;
  CC[c] = f;
}

function isIdChar(c: number): boolean {
  return c >= 0x80 || (c >= 0 && (CC[c] & CC_ID) !== 0);
}
function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}
function isHex(c: number): boolean {
  return c < 0x80 && c >= 0 && (CC[c] & CC_HEX) !== 0;
}
function hexVal(c: number): number {
  return c <= 0x39 ? c - 0x30 : (c | 0x20) - 0x57;
}

const BIG_MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const BIG_U64_MAX = (1n << 64n) - 1n;

/** Tokenize `src`. Always returns a stream ending with a TK_EOF token at `src.length`. */
export function tokenize(src: string): Tokens {
  const n = src.length;
  const kinds: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const vals: TokenValue[] = [];
  const kws: string[] = [];
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c < 0x80 && (CC[c] & CC_SPACE) !== 0) {
      i++;
      continue;
    }
    const start = i;
    let kind = TK_OP;
    let val: TokenValue = null;
    let kw = '';

    if (c >= 0x80 || (CC[c] & CC_ID_START) !== 0) {
      if ((c === 0x58 || c === 0x78) && src.charCodeAt(i + 1) === 0x27) {
        // Blob literal X'..'
        const close = src.indexOf("'", i + 2);
        if (close < 0) {
          i = n;
          kind = TK_ILLEGAL;
          val = `unrecognized token: "${src.slice(start, n)}"`;
        } else {
          i = close + 1;
          const len = close - (start + 2);
          let ok = (len & 1) === 0;
          for (let j = start + 2; ok && j < close; j++) ok = isHex(src.charCodeAt(j));
          if (!ok) {
            kind = TK_ILLEGAL;
            val = `unrecognized token: "${src.slice(start, i)}"`;
          } else {
            const bytes = new Uint8Array(len >> 1);
            for (let j = 0, k = start + 2; j < bytes.length; j++, k += 2) {
              bytes[j] = (hexVal(src.charCodeAt(k)) << 4) | hexVal(src.charCodeAt(k + 1));
            }
            kind = TK_BLOB;
            val = bytes;
          }
        }
      } else {
        let j = i + 1;
        while (j < n && isIdChar(src.charCodeAt(j))) j++;
        const text = src.slice(i, j);
        i = j;
        val = text;
        kind = TK_ID;
        const len = j - start;
        if (len >= 2 && len <= MAX_KEYWORD_LEN) {
          const canon = KEYWORDS.get(text.toUpperCase());
          if (canon !== undefined) {
            kw = canon;
            kind = RESERVED.has(canon) ? TK_KW : TK_NKW;
          }
        }
      }
    } else if (isDigit(c) || (c === 0x2e && isDigit(src.charCodeAt(i + 1)))) {
      i = scanNumber(src, i);
      kind = numKind;
      val = numVal;
    } else {
      switch (c) {
        case 0x27: {
          // 'string'
          let j = i + 1;
          let escaped = false;
          let close: number;
          for (;;) {
            close = src.indexOf("'", j);
            if (close < 0 || src.charCodeAt(close + 1) !== 0x27) break;
            escaped = true;
            j = close + 2;
          }
          if (close < 0) {
            i = n;
            kind = TK_ILLEGAL;
            val = `unrecognized token: "${src.slice(start, n)}"`;
          } else {
            const body = src.slice(start + 1, close);
            val = escaped ? body.replaceAll("''", "'") : body;
            kind = TK_STRING;
            i = close + 1;
          }
          break;
        }
        case 0x22: // "id"
        case 0x60: {
          // `id`
          const q = c === 0x22 ? '"' : '`';
          let j = i + 1;
          let escaped = false;
          let close: number;
          for (;;) {
            close = src.indexOf(q, j);
            if (close < 0 || src.charCodeAt(close + 1) !== c) break;
            escaped = true;
            j = close + 2;
          }
          if (close < 0) {
            i = n;
            kind = TK_ILLEGAL;
            val = `unrecognized token: "${src.slice(start, n)}"`;
          } else {
            const body = src.slice(start + 1, close);
            val = escaped ? body.replaceAll(q + q, q) : body;
            kind = TK_QID;
            i = close + 1;
          }
          break;
        }
        case 0x5b: {
          // [id]
          const close = src.indexOf(']', i + 1);
          if (close < 0) {
            i = n;
            kind = TK_ILLEGAL;
            val = `unrecognized token: "${src.slice(start, n)}"`;
          } else {
            val = src.slice(start + 1, close);
            kind = TK_QID;
            i = close + 1;
          }
          break;
        }
        case 0x2d: {
          // - -- -> ->>
          const d = src.charCodeAt(i + 1);
          if (d === 0x2d) {
            const nl = src.indexOf('\n', i + 2);
            i = nl < 0 ? n : nl + 1;
            continue;
          }
          if (d === 0x3e) {
            if (src.charCodeAt(i + 2) === 0x3e) {
              val = '->>';
              i += 3;
            } else {
              val = '->';
              i += 2;
            }
          } else {
            val = '-';
            i++;
          }
          break;
        }
        case 0x2f: {
          // / or /* comment */
          if (src.charCodeAt(i + 1) === 0x2a) {
            const close = src.indexOf('*/', i + 2);
            i = close < 0 ? n : close + 2;
            continue;
          }
          val = '/';
          i++;
          break;
        }
        case 0x7c: // | ||
          if (src.charCodeAt(i + 1) === 0x7c) {
            val = '||';
            i += 2;
          } else {
            val = '|';
            i++;
          }
          break;
        case 0x3c: {
          // < <= <> <<
          const d = src.charCodeAt(i + 1);
          if (d === 0x3d) val = '<=';
          else if (d === 0x3e) val = '!=';
          else if (d === 0x3c) val = '<<';
          else val = '<';
          i += val.length === 1 ? 1 : 2;
          break;
        }
        case 0x3e: {
          // > >= >>
          const d = src.charCodeAt(i + 1);
          if (d === 0x3d) val = '>=';
          else if (d === 0x3e) val = '>>';
          else val = '>';
          i += val.length;
          break;
        }
        case 0x3d: // = == =>
          if (src.charCodeAt(i + 1) === 0x3e) {
            val = '=>'; // named argument of a table-valued function
            i += 2;
            break;
          }
          val = '=';
          i += src.charCodeAt(i + 1) === 0x3d ? 2 : 1;
          break;
        case 0x21: // !=
          if (src.charCodeAt(i + 1) === 0x3d) {
            val = '!=';
            i += 2;
          } else {
            kind = TK_ILLEGAL;
            val = `unrecognized token: "!"`;
            i++;
          }
          break;
        case 0x28:
          val = '(';
          i++;
          break;
        case 0x29:
          val = ')';
          i++;
          break;
        case 0x2c:
          val = ',';
          i++;
          break;
        case 0x3b:
          val = ';';
          i++;
          break;
        case 0x2e:
          val = '.';
          i++;
          break;
        case 0x2a:
          val = '*';
          i++;
          break;
        case 0x2b:
          val = '+';
          i++;
          break;
        case 0x25:
          val = '%';
          i++;
          break;
        case 0x26:
          val = '&';
          i++;
          break;
        case 0x7e:
          val = '~';
          i++;
          break;
        case 0x3f: {
          // ?NNN
          let j = i + 1;
          while (j < n && isDigit(src.charCodeAt(j))) j++;
          kind = TK_PARAM;
          val = src.slice(i, j);
          i = j;
          break;
        }
        case 0x3a: // :name
        case 0x40: // @name
        case 0x24: {
          // $name
          let j = i + 1;
          while (j < n && isIdChar(src.charCodeAt(j))) j++;
          if (j === i + 1) {
            kind = TK_ILLEGAL;
            val = `unrecognized token: "${src[i]}"`;
            i++;
          } else {
            kind = TK_PARAM;
            val = src.slice(i, j);
            i = j;
          }
          break;
        }
        default:
          kind = TK_ILLEGAL;
          val = `unrecognized token: "${src[i]}"`;
          i++;
      }
    }
    kinds.push(kind);
    starts.push(start);
    ends.push(i);
    vals.push(val);
    kws.push(kw);
  }
  kinds.push(TK_EOF);
  starts.push(n);
  ends.push(n);
  vals.push(null);
  kws.push('');
  return { count: kinds.length, kinds, starts, ends, vals, kws };
}

// scanNumber results (module-level to avoid allocating a result object per number).
let numKind = TK_INT;
let numVal: TokenValue = 0;

/** Scan a numeric literal starting at `i`; sets numKind/numVal and returns the end offset. */
function scanNumber(src: string, i: number): number {
  const n = src.length;
  const start = i;
  const c = src.charCodeAt(i);
  if (c === 0x30 && (src.charCodeAt(i + 1) | 0x20) === 0x78 && isHex(src.charCodeAt(i + 2))) {
    // Hex integer: 64-bit two's complement, like SQLite.
    let j = i + 2;
    while (j < n && isHex(src.charCodeAt(j))) j++;
    if (j < n && isIdChar(src.charCodeAt(j))) return illegalNumber(src, start, j);
    const v = BigInt(src.slice(start, j));
    if (v > BIG_U64_MAX) {
      numKind = TK_ILLEGAL;
      numVal = `hex literal too big: ${src.slice(start, j)}`;
      return j;
    }
    const s = BigInt.asIntN(64, v);
    numKind = TK_INT;
    numVal = s >= -BIG_MAX_SAFE && s <= BIG_MAX_SAFE ? Number(s) : s;
    return j;
  }
  let j = i;
  while (j < n && isDigit(src.charCodeAt(j))) j++;
  let real = false;
  if (src.charCodeAt(j) === 0x2e) {
    real = true;
    j++;
    while (j < n && isDigit(src.charCodeAt(j))) j++;
  }
  const e = src.charCodeAt(j);
  if (e === 0x65 || e === 0x45) {
    let k = j + 1;
    const sign = src.charCodeAt(k);
    if (sign === 0x2b || sign === 0x2d) k++;
    if (!isDigit(src.charCodeAt(k))) return illegalNumber(src, start, k);
    while (k < n && isDigit(src.charCodeAt(k))) k++;
    j = k;
    real = true;
  }
  if (j < n && isIdChar(src.charCodeAt(j))) return illegalNumber(src, start, j);
  if (real) {
    numKind = TK_FLOAT;
    numVal = parseFloat(src.slice(start, j));
  } else if (j - start <= 15) {
    let v = 0;
    for (let k = start; k < j; k++) v = v * 10 + (src.charCodeAt(k) - 0x30);
    numKind = TK_INT;
    numVal = v;
  } else {
    const v = BigInt(src.slice(start, j));
    numKind = TK_INT;
    numVal = v <= BIG_MAX_SAFE ? Number(v) : v;
  }
  return j;
}

function illegalNumber(src: string, start: number, j: number): number {
  const n = src.length;
  while (j < n && isIdChar(src.charCodeAt(j))) j++;
  numKind = TK_ILLEGAL;
  numVal = `unrecognized token: "${src.slice(start, j)}"`;
  return j;
}
