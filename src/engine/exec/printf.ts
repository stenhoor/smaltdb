/**
 * printf() / format(): a port of SQLite's sqlite3_str_vappendf() (printf.c, SQL-function mode)
 * and of the floating-point decoder it uses (sqlite3FpDecode() in util.c), so that output matches
 * SQLite byte for byte. Widths and precisions count UTF-8 bytes unless the `!` flag is given, as
 * in SQLite; text is handled internally as "byte strings" (one char per UTF-8 byte).
 */
import { SmaltError } from '../errors.js';
import type { SqlValue } from '../values.js';
import { toNumeric, toText } from './convert.js';
import { type FloatConv, renderFloat } from '../util/fp.js';

/** SQLITE_LIMIT_LENGTH default: longer results raise "string or blob too big". */
const MAX_LENGTH = 1_000_000_000;

const I64_MAX = (1n << 63n) - 1n;
const I64_MIN = -(1n << 63n);

const enum T {
  RADIX,
  FLOAT,
  EXP,
  GENERIC,
  SIZE,
  STRING,
  PERCENT,
  CHARX,
  ESCAPE_q,
  ESCAPE_Q,
  ESCAPE_w,
  POINTER,
  ORDINAL,
  DECIMAL,
  ESCAPE_j,
  ESCAPE_J,
  INTERNAL,
}

interface Info {
  base: number;
  signed: boolean;
  type: T;
  charset: number;
  prefix: number;
}

const DIGITS = '0123456789ABCDEF0123456789abcdef';
const HEX = '0123456789abcdef';
const PREFIX = '-x0\u0000X0';
const info = (base: number, signed: boolean, type: T, charset = 0, prefix = 0): Info => ({ base, signed, type, charset, prefix });
const FMTINFO: Record<string, Info> = {
  d: info(10, true, T.DECIMAL),
  e: info(0, true, T.EXP, 30),
  f: info(0, true, T.FLOAT),
  g: info(0, true, T.GENERIC, 30),
  j: info(0, false, T.ESCAPE_j),
  i: info(10, true, T.DECIMAL),
  Q: info(0, false, T.ESCAPE_Q),
  p: info(16, false, T.POINTER, 0, 1),
  S: info(0, false, T.INTERNAL),
  T: info(0, false, T.INTERNAL),
  n: info(0, false, T.SIZE),
  o: info(8, false, T.RADIX, 0, 2),
  '%': info(0, false, T.PERCENT),
  q: info(0, false, T.ESCAPE_q),
  r: info(10, true, T.ORDINAL),
  s: info(0, false, T.STRING),
  X: info(16, false, T.RADIX, 0, 4),
  u: info(10, false, T.DECIMAL),
  w: info(0, false, T.ESCAPE_w),
  E: info(0, true, T.EXP, 14),
  x: info(16, false, T.RADIX, 16, 1),
  G: info(0, true, T.GENERIC, 14),
  z: info(0, false, T.STRING),
  J: info(0, false, T.ESCAPE_J),
  c: info(0, false, T.CHARX),
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** UTF-8 encode into a byte string. */
function bytes(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\u0000-\u007f]/.test(s)) return s;
  const b = encoder.encode(s);
  let out = '';
  for (let i = 0; i < b.length; i++) out += String.fromCharCode(b[i]);
  return out;
}

function blobBytes(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += String.fromCharCode(b[i]);
  return out;
}

/** Decode a byte string as UTF-8. */
function unbytes(s: string): string {
  if (!/[\u0080-ÿ]/.test(s)) return s;
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return decoder.decode(b);
}

/** A C string: everything before the first NUL. */
function cstr(s: string): string {
  const i = s.indexOf('\u0000');
  return i < 0 ? s : s.slice(0, i);
}

const isSpace = (c: string): boolean => c === ' ' || (c >= '\t' && c <= '\r');

/** sqlite3Atoi64(): optional sign and leading digits, saturating at the int64 range. */
function atoi64(s: string): bigint {
  let i = 0;
  while (i < s.length && isSpace(s[i])) i++;
  let neg = false;
  if (s[i] === '-') {
    neg = true;
    i++;
  } else if (s[i] === '+') i++;
  const start = i;
  while (i < s.length && s[i] >= '0' && s[i] <= '9') i++;
  if (i === start) return 0n;
  const u = BigInt(s.slice(start, i));
  if (neg) return u > -I64_MIN ? I64_MIN : -u;
  return u > I64_MAX ? I64_MAX : u;
}

/** sqlite3RealToI64(). */
function realToI64(r: number): bigint {
  if (r < -9223372036854774784) return I64_MIN;
  if (r > 9223372036854774784) return I64_MAX;
  if (Number.isNaN(r)) return 0n;
  return BigInt(Math.trunc(r));
}

/** sqlite3_value_int64(): NULL is 0, REALs truncate (saturating), text and blobs use their leading integer. */
export function valueInt64(v: SqlValue): bigint {
  if (v === null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? BigInt(v) : realToI64(v);
  return atoi64(typeof v === 'string' ? v : decoder.decode(v));
}

/** The SQL arguments, consumed left to right (PrintfArguments). */
class Args {
  private used = 0;
  constructor(
    private readonly vals: readonly SqlValue[],
    private readonly real: readonly boolean[],
  ) {}
  private next(): number {
    return this.used < this.vals.length ? this.used++ : -1;
  }
  int(): bigint {
    const i = this.next();
    return i < 0 ? 0n : valueInt64(this.vals[i]);
  }
  double(): number {
    const i = this.next();
    if (i < 0) return 0;
    const v = this.vals[i];
    if (v === null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return Number(v);
    return Number(toNumeric(v));
  }
  /** Text of the next argument as a byte string, or null for NULL / no argument. */
  text(): string | null {
    const i = this.next();
    if (i < 0) return null;
    const v = this.vals[i];
    if (v === null) return null;
    if (v instanceof Uint8Array) return cstr(blobBytes(v));
    return cstr(bytes(toText(v, this.real[i])!));
  }
}

// ------------------------------------------------------------------ sqlite3_str_vappendf

function tooBig(n: number): void {
  if (n > MAX_LENGTH) throw new SmaltError('SMALT_TOOBIG', 'string or blob too big');
}

/** Characters in a byte string that are UTF-8 continuation bytes. */
function continuationBytes(s: string): number {
  let k = 0;
  for (let i = 0; i < s.length; i++) if ((s.charCodeAt(i) & 0xc0) === 0x80) k++;
  return k;
}

/** printf(FORMAT, ...): `real[i]` tells whether argument i is statically REAL (for its text form). */
export function sqlPrintf(format: SqlValue, vals: readonly SqlValue[], real: readonly boolean[]): SqlValue {
  if (format === null) return null;
  const fmt = format instanceof Uint8Array ? cstr(blobBytes(format)) : cstr(bytes(toText(format, real[0] ?? false)!));
  const args = new Args(vals.slice(1), real.slice(1));
  let out = '';
  const at = (k: number): string => (k < fmt.length ? fmt[k] : '');
  let i = 0;
  for (; i < fmt.length; i++) {
    let c = fmt[i];
    if (c !== '%') {
      const k = fmt.indexOf('%', i);
      out += fmt.slice(i, k < 0 ? fmt.length : k);
      if (k < 0) break;
      i = k;
    }
    c = at(++i);
    if (c === '') {
      out += '%';
      break;
    }
    let leftJustify = false;
    let flagPrefix = '';
    let thousand = false;
    let alternateForm = false;
    let altForm2 = false;
    let zeroPad = false;
    let done = false;
    let width = 0;
    let precision = -1;
    do {
      switch (c) {
        case '-':
          leftJustify = true;
          break;
        case '+':
          flagPrefix = '+';
          break;
        case ' ':
          flagPrefix = ' ';
          break;
        case '#':
          alternateForm = true;
          break;
        case '!':
          altForm2 = true;
          break;
        case '0':
          zeroPad = true;
          break;
        case ',':
          thousand = true;
          break;
        case 'l':
          c = at(++i);
          if (c === 'l') c = at(++i);
          done = true;
          break;
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
        case '7':
        case '8':
        case '9': {
          let wx = c.charCodeAt(0) - 48;
          while ((c = at(++i)) >= '0' && c <= '9') wx = (wx * 10 + c.charCodeAt(0) - 48) >>> 0;
          width = wx & 0x7fffffff;
          if (c !== '.' && c !== 'l') done = true;
          else i--;
          break;
        }
        case '*': {
          width = Number(BigInt.asIntN(32, args.int()));
          if (width < 0) {
            leftJustify = true;
            width = width >= -2147483647 ? -width : 0;
          }
          if ((c = at(i + 1)) !== '.' && c !== 'l') {
            c = at(++i);
            done = true;
          }
          break;
        }
        case '.': {
          c = at(++i);
          if (c === '*') {
            precision = Number(BigInt.asIntN(32, args.int()));
            if (precision < 0) precision = precision >= -2147483647 ? -precision : -1;
            c = at(++i);
          } else {
            let px = 0;
            while (c >= '0' && c <= '9') {
              px = (px * 10 + c.charCodeAt(0) - 48) >>> 0;
              c = at(++i);
            }
            precision = px & 0x7fffffff;
          }
          if (c === 'l') i--;
          else done = true;
          break;
        }
        default:
          done = true;
      }
    } while (!done && (c = at(++i)) !== '');

    const inf = FMTINFO[c];
    if (inf === undefined || inf.type === T.INTERNAL) break; // etINVALID / internal-only: stop rendering
    let bufpt = '';
    let length: number;
    let xtype = inf.type;
    switch (xtype) {
      case T.POINTER:
      case T.ORDINAL:
      case T.RADIX:
      case T.DECIMAL: {
        if (xtype !== T.DECIMAL) thousand = false;
        let longvalue: bigint;
        let prefix = '';
        if (inf.signed) {
          const v = args.int();
          if (v < 0n) {
            longvalue = -v;
            prefix = '-';
          } else {
            longvalue = v;
            prefix = flagPrefix;
          }
        } else longvalue = BigInt.asUintN(64, args.int());
        if (longvalue === 0n) alternateForm = false;
        if (zeroPad && precision < width - (prefix ? 1 : 0)) precision = width - (prefix ? 1 : 0);
        tooBig(precision);
        let digits = '';
        if (xtype === T.ORDINAL) {
          let x = Number(longvalue % 10n);
          if (x >= 4 || (longvalue / 10n) % 10n === 1n) x = 0;
          digits = 'thstndrd'.slice(x * 2, x * 2 + 2);
        }
        const base = BigInt(inf.base);
        let num = '';
        do {
          num = DIGITS[inf.charset + Number(longvalue % base)] + num;
          longvalue /= base;
        } while (longvalue > 0n);
        // The ordinal suffix counts towards the zero-padded length, as in SQLite.
        if (precision > num.length + digits.length) num = '0'.repeat(precision - num.length - digits.length) + num;
        if (thousand) {
          let s = '';
          const len = num.length;
          for (let k = 0; k < len; k++) {
            s += num[k];
            const rest = len - 1 - k;
            if (rest > 0 && rest % 3 === 0) s += ',';
          }
          num = s;
        }
        bufpt = num + digits;
        if (prefix) bufpt = prefix + bufpt;
        if (alternateForm && inf.prefix) {
          let pre = '';
          for (let k = inf.prefix; PREFIX[k] !== '\u0000' && k < PREFIX.length; k++) pre = PREFIX[k] + pre;
          bufpt = pre + bufpt;
        }
        length = bufpt.length;
        break;
      }
      case T.FLOAT:
      case T.EXP:
      case T.GENERIC: {
        const o = renderFloat(args.double(), c as FloatConv, precision, width, { leftJustify, flagPrefix, thousand, alternateForm, altForm2, zeroPad });
        tooBig(o.length);
        out += o;
        continue;
      }
      case T.SIZE:
        length = width = 0;
        break;
      case T.PERCENT:
        bufpt = '%';
        length = 1;
        break;
      case T.CHARX: {
        const t = args.text();
        let ch: string;
        if (t !== null && t.length > 0) {
          ch = t[0];
          let k = 1;
          if ((t.charCodeAt(0) & 0xc0) === 0xc0) while (ch.length < 4 && k < t.length && (t.charCodeAt(k) & 0xc0) === 0x80) ch += t[k++];
        } else ch = '\u0000';
        if (precision > 1) {
          width -= precision - 1;
          if (width > 1 && !leftJustify) {
            tooBig(width - 1);
            out += ' '.repeat(width - 1);
            width = 0;
          }
          tooBig((precision - 1) * ch.length);
          out += ch.repeat(precision - 1);
        }
        bufpt = ch;
        length = ch.length;
        if (width > 0) width += continuationBytes(bufpt);
        break;
      }
      case T.STRING: {
        const t = args.text() ?? '';
        if (precision >= 0) {
          if (altForm2) {
            let k = 0;
            while (precision-- > 0 && k < t.length) {
              k++;
              while (k < t.length && (t.charCodeAt(k) & 0xc0) === 0x80) k++;
            }
            bufpt = t.slice(0, k);
          } else bufpt = t.slice(0, precision);
        } else bufpt = t;
        length = bufpt.length;
        if (altForm2 && width > 0) width += continuationBytes(bufpt);
        break;
      }
      case T.ESCAPE_j:
      case T.ESCAPE_J: {
        const escarg = args.text();
        const start = out.length;
        if (escarg === null) {
          if (xtype === T.ESCAPE_J) out += 'null';
        } else {
          if (xtype === T.ESCAPE_J) out += '"';
          let px = precision;
          if (px < 0) px = 0x7fffffff;
          else if (altForm2) {
            let k = 0;
            for (; k < px && k < escarg.length; k++) if ((escarg.charCodeAt(k) & 0xc0) === 0x80) px++;
            if (k === px) while (px < escarg.length && (escarg.charCodeAt(px) & 0xc0) === 0x80) px++;
          }
          for (let k = 0; k < px && k < escarg.length; k++) {
            const code = escarg.charCodeAt(k);
            if (code <= 0x1f || code === 0x22 || code === 0x5c) {
              out += '\\';
              if (code > 0x1f) out += escarg[k];
              else if (((1 << code) & 0x3700) !== 0) out += 'btn?fr'[code - 8];
              else out += 'u00' + HEX[code >> 4] + HEX[code & 0xf];
            } else out += escarg[k];
          }
          if (xtype === T.ESCAPE_J) out += '"';
        }
        if (width > 0) {
          const n = out.length - start;
          const len = altForm2 && n > 0 ? n - continuationBytes(out.slice(start)) : n;
          if (width > len) {
            const sp = width - len;
            tooBig(sp);
            if (!leftJustify && n > 0) out = out.slice(0, start) + ' '.repeat(sp) + out.slice(start);
            else out += ' '.repeat(sp);
          }
        }
        continue;
      }
      case T.ESCAPE_q:
      case T.ESCAPE_Q:
      case T.ESCAPE_w: {
        let escarg = args.text();
        let needQuote = 0;
        if (escarg === null) escarg = xtype === T.ESCAPE_Q ? 'NULL' : '(NULL)';
        else if (xtype === T.ESCAPE_Q) needQuote = 1;
        let q: string;
        if (xtype === T.ESCAPE_w) {
          q = '"';
          alternateForm = false;
        } else q = "'";
        // Bytes of the argument to use: `precision` bytes (characters with "!").
        let k = precision;
        let n = 0;
        for (; k !== 0 && n < escarg.length; n++, k--) {
          if (altForm2 && (escarg.charCodeAt(n) & 0xc0) === 0xc0) while (n + 1 < escarg.length && (escarg.charCodeAt(n + 1) & 0xc0) === 0x80) n++;
        }
        const src = escarg.slice(0, n);
        if (alternateForm) {
          let nCtrl = 0;
          for (let m = 0; m < src.length; m++) if (src.charCodeAt(m) <= 0x1f && src[m] !== '\\') nCtrl++;
          if (nCtrl || xtype === T.ESCAPE_q) {
            if (xtype === T.ESCAPE_Q) needQuote = 2;
          } else alternateForm = false;
        }
        let o = needQuote === 2 ? "unistr('" : needQuote ? "'" : '';
        for (let m = 0; m < src.length; m++) {
          const ch = src[m];
          const code = src.charCodeAt(m);
          if (alternateForm && ch !== q && ch !== '\\' && code <= 0x1f) o += '\\u00' + (code >= 0x10 ? '1' : '0') + HEX[code & 0xf];
          else {
            o += ch;
            if (ch === q) o += ch;
            else if (alternateForm && ch === '\\') o += '\\';
          }
        }
        if (needQuote) o += needQuote === 2 ? "')" : "'";
        bufpt = o;
        length = o.length;
        if (altForm2 && width > 0) width += continuationBytes(bufpt);
        break;
      }
      default:
        throw new SmaltError('SMALT_INTERNAL', 'printf: unhandled conversion');
    }
    width -= length;
    if (width > 0) {
      tooBig(width);
      out += leftJustify ? bufpt + ' '.repeat(width) : ' '.repeat(width) + bufpt;
    } else out += bufpt;
    tooBig(out.length);
  }
  tooBig(out.length);
  return unbytes(out);
}
