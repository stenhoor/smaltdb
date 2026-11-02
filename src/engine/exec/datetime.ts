/**
 * SQLite's date and time functions: date, time, datetime, julianday, unixepoch, strftime and
 * timediff. This is a close port of SQLite's date.c (3.54): the same parsing, modifiers, rounding
 * and NULL-on-error behaviour. Instants are kept as a julian day number times 86400000 (`iJD`,
 * milliseconds), exactly as SQLite does.
 *
 * 'now' comes from FunctionContext.now() (fixed for one statement execution); 'localtime' and 'utc'
 * use the host time zone through JS Date, as SQLite uses the OS zone through localtime_r().
 */
import { SmaltError } from '../errors.js';
import type { SqlValue } from '../values.js';
import { asciiLower, toText } from './convert.js';

/** Engine hooks the date functions need. */
export interface DateTimeContext {
  /** Current time in Unix milliseconds, stable for one statement execution. */
  now(): number;
  /**
   * Set when evaluating an index expression ('an index') or a CHECK constraint ('a CHECK
   * constraint'): there, 'now', 'subsec', no time value, and the 'localtime' and 'utc' modifiers
   * raise "non-deterministic use of F() in ..." (SQLite's sqlite3NotPureFunc()).
   */
  pureContext?: string;
}

/** The context and SQL function name of the call being evaluated (for notPure()). */
let curCtx: DateTimeContext | undefined;
let curFn = '';

/** SQLite's sqlite3NotPureFunc(): fail when the current call must be deterministic. */
function notPure(): void {
  const where = curCtx?.pureContext;
  if (where) throw new SmaltError('SMALT_ERROR', `non-deterministic use of ${curFn}() in ${where}`);
}

/** Julian day of 1970-01-01 00:00:00 times 86400000. */
const UNIX_EPOCH_JD_MS = 210866760000000;
/** Largest valid iJD (9999-12-31 23:59:59.999). */
const MAX_JD_MS = 464269060799999;

class DateTime {
  iJD = 0;
  Y = 0;
  M = 0;
  D = 0;
  h = 0;
  m = 0;
  tz = 0;
  s = 0;
  validJD = false;
  validYMD = false;
  validHMS = false;
  nFloor = 0;
  rawS = false;
  isError = false;
  useSubsec = false;
  isUtc = false;
  isLocal = false;

  reset(): void {
    Object.assign(this, BLANK);
  }

  clone(): DateTime {
    return Object.assign(new DateTime(), this);
  }
}

const BLANK = new DateTime();

// ------------------------------------------------------------------ small helpers

const trunc = Math.trunc;

function code(z: string, i: number): number {
  const c = z.charCodeAt(i);
  return c !== c ? 0 : c; // NaN (past the end) reads as the C string terminator
}

function isDigitAt(z: string, i: number): boolean {
  const c = code(z, i);
  return c >= 48 && c <= 57;
}

function isSpaceAt(z: string, i: number): boolean {
  const c = code(z, i);
  return c === 32 || (c >= 9 && c <= 13);
}

function ieq(a: string, b: string): boolean {
  return a.length === b.length && asciiLower(a) === b;
}

/** C strings end at the first NUL. */
function cstr(s: string): string {
  const k = s.indexOf('\0');
  return k < 0 ? s : s.slice(0, k);
}

const ATOF = /^[ \t\n\v\f\r]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\v\f\r]*$/;

/** sqlite3AtoF(...) > 0: the whole string is a number. Returns its value, or null. */
function atof(z: string): number | null {
  return ATOF.test(z) ? Number(z) : null;
}

/** Maximum values by the 3rd character of a getDigits field spec: a..f. */
const DIGIT_MAX = [12, 14, 24, 31, 59, 14712];

/**
 * SQLite's getDigits(): fields "NmX" + separator, e.g. "40f-21a-21d". Returns the values parsed
 * before the first failure (callers compare the count).
 */
function getDigits(z: string, i: number, fmt: string): number[] {
  const out: number[] = [];
  let f = 0;
  for (;;) {
    let n = fmt.charCodeAt(f) - 48;
    const min = fmt.charCodeAt(f + 1) - 48;
    const max = DIGIT_MAX[fmt.charCodeAt(f + 2) - 97];
    const nextC = f + 3 < fmt.length ? fmt.charCodeAt(f + 3) : 0;
    let val = 0;
    while (n--) {
      if (!isDigitAt(z, i)) return out;
      val = val * 10 + code(z, i) - 48;
      i++;
    }
    if (val < min || val > max || (nextC !== 0 && nextC !== code(z, i))) return out;
    out.push(val);
    i++;
    f += 4;
    if (nextC === 0) return out;
  }
}

// ------------------------------------------------------------------ parsing

/** Trailing "[+-]HH:MM" or "Z" (with optional spaces). Returns true on error. */
function parseTimezone(z: string, i: number, p: DateTime): boolean {
  while (isSpaceAt(z, i)) i++;
  p.tz = 0;
  const c = code(z, i);
  let sgn: number;
  if (c === 45) sgn = -1;
  else if (c === 43) sgn = 1;
  else if (c === 90 || c === 122) {
    i++;
    p.isLocal = false;
    p.isUtc = true;
    while (isSpaceAt(z, i)) i++;
    return code(z, i) !== 0;
  } else return c !== 0;
  i++;
  const d = getDigits(z, i, '20b:20e');
  if (d.length !== 2) return true;
  i += 5;
  p.tz = sgn * (d[1] + d[0] * 60);
  while (isSpaceAt(z, i)) i++;
  return code(z, i) !== 0;
}

/** "HH:MM[:SS[.SSS]]" plus optional time zone. Returns true on error. 24:00 means end of day. */
function parseHhMmSs(z: string, i: number, p: DateTime): boolean {
  const hm = getDigits(z, i, '20c:20e');
  if (hm.length !== 2) return true;
  const [h, m] = hm;
  let s: number;
  let ms = 0;
  i += 5;
  if (code(z, i) === 58) {
    i++;
    const sd = getDigits(z, i, '20e');
    if (sd.length !== 1) return true;
    s = sd[0];
    i += 2;
    if (code(z, i) === 46 && isDigitAt(z, i + 1)) {
      let rScale = 1.0;
      i++;
      while (isDigitAt(z, i)) {
        ms = ms * 10.0 + code(z, i) - 48;
        rScale *= 10.0;
        i++;
      }
      ms /= rScale;
      if (ms > 0.999) ms = 0.999;
    }
  } else {
    s = 0;
  }
  if (h === 24 && (m !== 0 || s !== 0 || ms !== 0)) return true;
  p.validJD = false;
  p.rawS = false;
  p.validHMS = true;
  p.h = h;
  p.m = m;
  p.s = s + ms;
  return parseTimezone(z, i, p);
}

/**
 * "YYYY-MM-DD 24:00" is the start of the next day: roll the date over at parse time (before any
 * time zone is applied; 9999-12-31 24:00 becomes year 10000, which later fails as out of range).
 */
function rollOver24(p: DateTime): void {
  if (!p.validHMS || p.h !== 24) return;
  const t = new DateTime();
  t.Y = p.Y;
  t.M = p.M;
  t.D = p.D;
  t.validYMD = true;
  computeJD(t);
  ymdFromJD(t, t.iJD + 86400000);
  p.Y = t.Y;
  p.M = t.M;
  p.D = t.D;
  p.h = 0;
  p.nFloor = 0;
}

function computeFloor(p: DateTime): void {
  if (p.D <= 28) p.nFloor = 0;
  else if ((1 << p.M) & 0x15aa) p.nFloor = 0;
  else if (p.M !== 2) p.nFloor = p.D === 31 ? 1 : 0;
  else if (p.Y % 4 !== 0 || (p.Y % 100 === 0 && p.Y % 400 !== 0)) p.nFloor = p.D - 28;
  else p.nFloor = p.D - 29;
}

/** "[-]YYYY-MM-DD" followed by an optional time. Returns true on error. */
function parseYyyyMmDd(z: string, p: DateTime): boolean {
  let i = 0;
  let neg = false;
  if (code(z, 0) === 45) {
    i = 1;
    neg = true;
  }
  const d = getDigits(z, i, '40f-21a-21d');
  if (d.length !== 3) return true;
  i += 10;
  while (isSpaceAt(z, i) || code(z, i) === 84) i++;
  if (!parseHhMmSs(z, i, p)) {
    // got the time
  } else if (code(z, i) === 0) {
    p.validHMS = false;
  } else {
    return true;
  }
  p.validJD = false;
  p.validYMD = true;
  p.Y = neg ? -d[0] : d[0];
  p.M = d[1];
  p.D = d[2];
  computeFloor(p);
  rollOver24(p);
  if (p.tz) computeJD(p);
  return false;
}

function setDateTimeToCurrent(ctx: DateTimeContext, p: DateTime): boolean {
  p.iJD = ctx.now() + UNIX_EPOCH_JD_MS;
  if (p.iJD > 0) {
    p.validJD = true;
    p.isUtc = true;
    p.isLocal = false;
    clearYMD_HMS_TZ(p);
    return false;
  }
  return true;
}

function setRawDateNumber(p: DateTime, r: number): void {
  p.s = r;
  p.rawS = true;
  if (r >= 0.0 && r < 5373484.5) {
    p.iJD = trunc(r * 86400000.0 + 0.5);
    p.validJD = true;
  }
}

/** A time value string. Returns true on error. */
function parseDateOrTime(ctx: DateTimeContext, z: string, p: DateTime): boolean {
  if (!parseYyyyMmDd(z, p)) return false;
  if (!parseHhMmSs(z, 0, p)) return false;
  if (ieq(z, 'now')) {
    notPure();
    return setDateTimeToCurrent(ctx, p);
  }
  const r = atof(z);
  if (r !== null) {
    setRawDateNumber(p, r);
    return false;
  }
  if (ieq(z, 'subsec') || ieq(z, 'subsecond')) {
    notPure();
    p.useSubsec = true;
    return setDateTimeToCurrent(ctx, p);
  }
  return true;
}

const validJulianDay = (iJD: number): boolean => iJD >= 0 && iJD <= MAX_JD_MS;

function datetimeError(p: DateTime): void {
  p.reset();
  p.isError = true;
}

function computeJD(p: DateTime): void {
  if (p.validJD) return;
  let Y: number;
  let M: number;
  let D: number;
  if (p.validYMD) {
    Y = p.Y;
    M = p.M;
    D = p.D;
  } else {
    Y = 2000;
    M = 1;
    D = 1;
  }
  if (Y < -4713 || Y > 9999 || p.rawS) {
    datetimeError(p);
    return;
  }
  if (M <= 2) {
    Y--;
    M += 12;
  }
  // Floor division (SQLite 3.54 offsets Y by 4800 so that negative years round down).
  const A = Math.floor(Y / 100);
  const B = 2 - A + Math.floor(A / 4);
  const X1 = trunc((36525 * (Y + 4716)) / 100);
  const X2 = trunc((306001 * (M + 1)) / 10000);
  p.iJD = trunc((X1 + X2 + D + B - 1524.5) * 86400000);
  p.validJD = true;
  if (p.validHMS) {
    p.iJD += p.h * 3600000 + p.m * 60000 + trunc(p.s * 1000 + 0.5);
    if (p.tz) {
      p.iJD -= p.tz * 60000;
      p.validYMD = false;
      p.validHMS = false;
      p.tz = 0;
      p.isUtc = true;
      p.isLocal = false;
    } else if (p.h === 24) {
      // A bare "24:00" (no date) stays raw until a julian day is needed: then it is 00:00 of the next day.
      p.validYMD = false;
      p.validHMS = false;
    }
  }
}

function computeYMD(p: DateTime): void {
  if (p.validYMD) return;
  if (!p.validJD) {
    p.Y = 2000;
    p.M = 1;
    p.D = 1;
  } else if (!validJulianDay(p.iJD)) {
    datetimeError(p);
    return;
  } else {
    ymdFromJD(p, p.iJD);
  }
  p.validYMD = true;
}

/** The calendar date of a julian day (no range check). */
function ymdFromJD(p: DateTime, iJD: number): void {
  const Z = trunc((iJD + 43200000) / 86400000);
  const alpha = trunc((Z + 32044.75) / 36524.25) - 52;
  const A = Z + 1 + alpha - trunc((alpha + 100) / 4) + 25;
  const B = A + 1524;
  const C = trunc((B - 122.1) / 365.25);
  const D = trunc((36525 * (C & 32767)) / 100);
  const E = trunc((B - D) / 30.6001);
  const X1 = trunc(30.6001 * E);
  p.D = B - D - X1;
  p.M = E < 14 ? E - 1 : E - 13;
  p.Y = p.M > 2 ? C - 4716 : C - 4715;
}

function computeHMS(p: DateTime): void {
  if (p.validHMS) return;
  computeJD(p);
  const dayMs = (p.iJD + 43200000) % 86400000;
  p.s = (dayMs % 60000) / 1000.0;
  const dayMin = trunc(dayMs / 60000);
  p.m = dayMin % 60;
  p.h = trunc(dayMin / 60);
  p.rawS = false;
  p.validHMS = true;
}

function computeYMD_HMS(p: DateTime): void {
  computeYMD(p);
  computeHMS(p);
}

function clearYMD_HMS_TZ(p: DateTime): void {
  p.validYMD = false;
  p.validHMS = false;
  p.tz = 0;
}

/** Convert UTC to local time using the host time zone (SQLite's toLocaltime()). */
function toLocaltime(p: DateTime): void {
  computeJD(p);
  let iYearDiff: number;
  let t: number;
  if (p.iJD < 2108667600 * 100000 || p.iJD > 2130141456 * 100000) {
    // Outside 1970..2037: map to an equivalent year (same leap-ness) and back.
    const x = p.clone();
    computeYMD_HMS(x);
    iYearDiff = 2000 + (x.Y % 4) - x.Y;
    x.Y += iYearDiff;
    x.validJD = false;
    computeJD(x);
    t = trunc(x.iJD / 1000) - 21086676 * 10000;
  } else {
    iYearDiff = 0;
    t = trunc(p.iJD / 1000) - 21086676 * 10000;
  }
  const d = new Date(t * 1000);
  p.Y = d.getFullYear() - iYearDiff;
  p.M = d.getMonth() + 1;
  p.D = d.getDate();
  p.h = d.getHours();
  p.m = d.getMinutes();
  p.s = d.getSeconds() + (p.iJD % 1000) * 0.001;
  p.validYMD = true;
  p.validHMS = true;
  p.validJD = false;
  p.rawS = false;
  p.tz = 0;
  p.isError = false;
}

/** "+NNN unit" transforms: name, limit (C float), seconds per unit. */
const XFORMS: { name: string; limit: number; xform: number }[] = [
  { name: 'second', limit: Math.fround(4.6427e14), xform: 1.0 },
  { name: 'minute', limit: Math.fround(7.7379e12), xform: 60.0 },
  { name: 'hour', limit: Math.fround(1.2897e11), xform: 3600.0 },
  { name: 'day', limit: Math.fround(5373485.0), xform: 86400.0 },
  { name: 'month', limit: Math.fround(176546.0), xform: 2592000.0 },
  { name: 'year', limit: Math.fround(14713.0), xform: 31536000.0 },
];

/** Normalize month overflow/underflow into the year. */
function carryMonths(p: DateTime): void {
  const x = p.M > 0 ? trunc((p.M - 1) / 12) : trunc((p.M - 12) / 12);
  p.Y += x;
  p.M -= x * 12;
}

/** Apply one modifier. Returns true on error. `idx` is the argument index (1 = first modifier). */
function parseModifier(z: string, p: DateTime, idx: number): boolean {
  let rc = true;
  switch (asciiLower(z.charAt(0))) {
    case 'a':
      if (ieq(z, 'auto')) {
        if (idx > 1) return true;
        if (!p.rawS || p.validJD) {
          rc = false;
          p.rawS = false;
        } else if (p.s >= -21086676 * 10000 && p.s <= 25340230 * 10000 + 799) {
          const r = p.s * 1000.0 + 210866760000000.0;
          clearYMD_HMS_TZ(p);
          p.iJD = trunc(r + 0.5);
          p.validJD = true;
          p.rawS = false;
          rc = false;
        } else {
          // Out of range: accepted, but the raw number stays and fails later (SQLite 3.54).
          rc = false;
        }
      }
      break;
    case 'c':
      if (ieq(z, 'ceiling')) {
        computeJD(p);
        clearYMD_HMS_TZ(p);
        rc = false;
        p.nFloor = 0;
      }
      break;
    case 'f':
      if (ieq(z, 'floor')) {
        computeJD(p);
        p.iJD -= p.nFloor * 86400000;
        clearYMD_HMS_TZ(p);
        rc = false;
      }
      break;
    case 'j':
      if (ieq(z, 'julianday')) {
        if (idx > 1) return true;
        if (p.validJD && p.rawS) {
          rc = false;
          p.rawS = false;
        }
      }
      break;
    case 'l':
      if (ieq(z, 'localtime')) {
        notPure();
        if (!p.isLocal) toLocaltime(p);
        rc = false;
        p.isUtc = false;
        p.isLocal = true;
      }
      break;
    case 'u':
      if (ieq(z, 'unixepoch') && p.rawS) {
        if (idx > 1) return true;
        const r = p.s * 1000.0 + 210866760000000.0;
        if (r >= 0.0 && r < 464269060800000.0) {
          clearYMD_HMS_TZ(p);
          p.iJD = trunc(r + 0.5);
          p.validJD = true;
          p.rawS = false;
          rc = false;
        }
      } else if (ieq(z, 'utc')) {
        notPure();
        if (!p.isUtc) {
          computeJD(p);
          const iOrigJD = p.iJD;
          let iGuess = iOrigJD;
          let iErr = 0;
          let cnt = 0;
          do {
            const nw = new DateTime();
            iGuess -= iErr;
            nw.iJD = iGuess;
            nw.validJD = true;
            toLocaltime(nw);
            computeJD(nw);
            iErr = nw.iJD - iOrigJD;
          } while (iErr && cnt++ < 3);
          p.reset();
          p.iJD = iGuess;
          p.validJD = true;
          p.isUtc = true;
          p.isLocal = false;
        }
        rc = false;
      }
      break;
    case 'w':
      // "weekday N" moves forward to weekday N; "weekday -N" moves back to it (SQLite 3.54).
      if (z.length >= 8 && ieq(z.slice(0, 8), 'weekday ')) {
        const rest = z.slice(8);
        const r = atof(rest);
        if (r !== null && r > -7.0 && r < 7.0 && trunc(r) === r) {
          const back = /^[ \t\n\v\f\r]*-/.test(rest);
          const n = Math.abs(r);
          computeYMD_HMS(p);
          p.tz = 0;
          p.validJD = false;
          computeJD(p);
          let Z = trunc((p.iJD + 129600000) / 86400000) % 7;
          if (back) {
            if (Z < n) Z += 7;
            p.iJD -= (Z - n) * 86400000;
          } else {
            if (Z > n) Z -= 7;
            p.iJD += (n - Z) * 86400000;
          }
          clearYMD_HMS_TZ(p);
          rc = false;
        }
      }
      break;
    case 's':
      if (!(z.length >= 9 && ieq(z.slice(0, 9), 'start of '))) {
        if (ieq(z, 'subsec') || ieq(z, 'subsecond')) {
          p.useSubsec = true;
          rc = false;
        }
        break;
      }
      if (!p.validJD && !p.validYMD && !p.validHMS) break;
      computeYMD(p);
      p.validHMS = true;
      p.h = p.m = 0;
      p.s = 0.0;
      p.rawS = false;
      p.tz = 0;
      p.validJD = false;
      {
        const unit = z.slice(9);
        if (ieq(unit, 'month')) {
          p.D = 1;
          rc = false;
        } else if (ieq(unit, 'year')) {
          p.M = 1;
          p.D = 1;
          rc = false;
        } else if (ieq(unit, 'day')) {
          rc = false;
        }
      }
      break;
    case '+':
    case '-':
    case '0':
    case '1':
    case '2':
    case '3':
    case '4':
    case '5':
    case '6':
    case '7':
    case '8':
    case '9':
      rc = parseNumericModifier(z, p);
      break;
    default:
      break;
  }
  return rc;
}

/** "±NNN unit", "±HH:MM[:SS[.SSS]]" and "±YYYY-MM-DD[ HH:MM[:SS[.SSS]]]". Returns true on error. */
function parseNumericModifier(zIn: string, p: DateTime): boolean {
  let z = zIn;
  let z2 = 0; // offset into zIn of the HH:MM part
  const z0 = z.charCodeAt(0);
  let n = 1;
  for (; code(z, n) !== 0; n++) {
    const c = code(z, n);
    if (c === 58) break;
    if (isSpaceAt(z, n)) break;
    if (c === 45) {
      if (n === 5 && getDigits(z, 1, '40f').length === 1) break;
      if (n === 6 && getDigits(z, 1, '50f').length === 1) break;
    }
  }
  const r0 = atof(z.slice(0, n));
  if (r0 === null) return true;
  let r = r0;
  if (code(z, n) === 45) {
    // (+|-)YYYY-MM-DD: add or subtract years, months (0-11) and days (0-30).
    if (z0 !== 43 && z0 !== 45) return true;
    let ymd: number[];
    if (n === 5) {
      ymd = getDigits(z, 1, '40f-20a-20d');
      if (ymd.length !== 3) return true;
    } else {
      ymd = getDigits(z, 1, '50f-20a-20d');
      if (ymd.length !== 3) return true;
      z = z.slice(1);
    }
    const [Y, M] = ymd;
    let D = ymd[2];
    if (M >= 12) return true;
    if (D >= 31) return true;
    computeYMD_HMS(p);
    p.validJD = false;
    if (z0 === 45) {
      p.Y -= Y;
      p.M -= M;
      D = -D;
    } else {
      p.Y += Y;
      p.M += M;
    }
    carryMonths(p);
    computeFloor(p);
    computeJD(p);
    p.validHMS = false;
    p.validYMD = false;
    p.iJD += D * 86400000;
    if (code(z, 11) === 0) return false;
    if (isSpaceAt(z, 11) && getDigits(z, 12, '20c:20e').length === 2) {
      z2 = 12;
      n = 2;
    } else {
      return true;
    }
  }
  if (code(z, z2 + n) === 58) {
    // (+|-)HH:MM[:SS[.SSS]]: add or subtract a time of day.
    let i = z2;
    if (!isDigitAt(z, i)) i++;
    const tx = new DateTime();
    if (parseHhMmSs(z, i, tx)) return true;
    computeJD(tx);
    tx.iJD -= 43200000;
    const day = trunc(tx.iJD / 86400000);
    tx.iJD -= day * 86400000;
    if (z0 === 45) tx.iJD = -tx.iJD;
    computeJD(p);
    clearYMD_HMS_TZ(p);
    p.iJD += tx.iJD;
    return false;
  }
  // "+NNN days" and friends.
  let k = n;
  while (isSpaceAt(z, k)) k++;
  const unit = z.slice(k);
  let len = unit.length;
  if (len < 3 || len > 10) return true;
  if (asciiLower(unit.charAt(len - 1)) === 's') len--;
  computeJD(p);
  let rc = true;
  const rRounder = r < 0 ? -0.5 : +0.5;
  p.nFloor = 0;
  for (let i = 0; i < XFORMS.length; i++) {
    const x = XFORMS[i];
    if (x.name.length === len && asciiLower(unit.slice(0, len)) === x.name && r > -x.limit && r < x.limit) {
      if (i === 4) {
        computeYMD_HMS(p);
        p.M += trunc(r);
        carryMonths(p);
        computeFloor(p);
        p.validJD = false;
        r -= trunc(r);
      } else if (i === 5) {
        computeYMD_HMS(p);
        p.Y += trunc(r);
        computeFloor(p);
        p.validJD = false;
        r -= trunc(r);
      }
      computeJD(p);
      p.iJD += trunc(r * 1000.0 * x.xform + rRounder);
      rc = false;
      break;
    }
  }
  clearYMD_HMS_TZ(p);
  return rc;
}

/** Text of a modifier / time value argument (NUL-terminated as SQLite sees it). */
function argText(v: SqlValue): string | null {
  if (v === null) return null;
  return cstr(toText(v)!);
}

/**
 * Parse a time value and its modifiers (SQLite's isDate()). Returns null on any error.
 * `args` excludes the strftime format.
 */
function isDate(ctx: DateTimeContext, args: readonly SqlValue[], start: number): DateTime | null {
  const p = new DateTime();
  const argc = args.length - start;
  curCtx = ctx;
  if (argc === 0) {
    notPure();
    return setDateTimeToCurrent(ctx, p) ? null : p;
  }
  const v0 = args[start];
  if (typeof v0 === 'number' || typeof v0 === 'bigint') {
    setRawDateNumber(p, Number(v0));
  } else {
    const z = argText(v0);
    if (z === null || parseDateOrTime(ctx, z, p)) return null;
  }
  for (let i = 1; i < argc; i++) {
    const z = argText(args[start + i]);
    if (z === null || parseModifier(z, p, i)) return null;
  }
  computeJD(p);
  if (p.isError || !validJulianDay(p.iJD)) return null;
  if (argc === 1 && p.validYMD && p.D > 28) p.validYMD = false;

  return p;
}

// ------------------------------------------------------------------ formatting


/** printf("%0Wd") for possibly negative n. */
function zpad(n: number, w: number): string {
  if (n < 0) return '-' + String(-n).padStart(w - 1, '0');
  return String(n).padStart(w, '0');
}

/** printf("%Wd"). */
const spad = (n: number, w: number): string => String(n).padStart(w, ' ');

/** printf("%06.3f") for a non-negative seconds value. */
const secFrac = (s: number): string => s.toFixed(3).padStart(6, '0');

/** printf("%.16g"). */
function fmtG16(x: number): string {
  if (x === 0) return '0';
  const ex = x.toExponential(15);
  const ePos = ex.indexOf('e');
  const neg = ex.startsWith('-');
  const digits = ex.slice(neg ? 1 : 0, ePos).replace('.', '');
  const e = Number(ex.slice(ePos + 1));
  let out: string;
  if (e < -4 || e >= 16) {
    let mant = digits[0] + '.' + digits.slice(1);
    mant = mant.replace(/0+$/, '').replace(/\.$/, '');
    out = mant + 'e' + (e < 0 ? '-' : '+') + String(Math.abs(e)).padStart(2, '0');
  } else if (e < 0) {
    out = ('0.' + '0'.repeat(-e - 1) + digits).replace(/0+$/, '');
  } else {
    const ip = digits.slice(0, e + 1);
    const fp = digits.slice(e + 1).replace(/0+$/, '');
    out = fp ? ip + '.' + fp : ip;
  }
  return neg ? '-' + out : out;
}

/** One output digit as SQLite writes it: '0' + v % 10 (C semantics, so odd values give odd chars). */
const dig = (v: number): string => String.fromCharCode(48 + (v % 10));
const two = (v: number): string => dig(trunc(v / 10)) + dig(v);

function ymdText(x: DateTime): string {
  const Y = Math.abs(x.Y);
  const s = dig(trunc(Y / 1000)) + dig(trunc(Y / 100)) + two(Y) + '-' + two(x.M) + '-' + two(x.D);
  return x.Y < 0 ? '-' + s : s;
}

function hmsText(x: DateTime): string {
  const hm = two(x.h) + ':' + two(x.m) + ':';
  if (x.useSubsec) {
    const s = trunc(1000.0 * x.s + 0.5);
    return hm + dig(trunc(s / 10000)) + dig(trunc(s / 1000)) + '.' + dig(trunc(s / 100)) + two(s);
  }
  return hm + two(trunc(x.s));
}

function daysAfterJan01(x: DateTime): number {
  const jan01 = x.clone();
  jan01.validJD = false;
  jan01.M = 1;
  jan01.D = 1;
  computeJD(jan01);
  return trunc((x.iJD - jan01.iJD + 43200000) / 86400000);
}

const daysAfterMonday = (x: DateTime): number => trunc((x.iJD + 43200000) / 86400000) % 7;
const daysAfterSunday = (x: DateTime): number => trunc((x.iJD + 129600000) / 86400000) % 7;

/** The Thursday of x's ISO week. */
function isoThursday(x: DateTime): DateTime {
  const y = x.clone();
  y.iJD += (3 - daysAfterMonday(x)) * 86400000;
  y.validYMD = false;
  computeYMD(y);
  return y;
}

function strftime(fmt: string, x: DateTime): string | null {
  computeJD(x);
  computeYMD_HMS(x);
  let out = '';
  let j = 0;
  let i = 0;
  for (; i < fmt.length; i++) {
    if (fmt.charCodeAt(i) !== 37) continue;
    if (j < i) out += fmt.slice(j, i);
    i++;
    j = i + 1;
    const cf = fmt.charAt(i);
    switch (cf) {
      case 'd':
        out += zpad(x.D, 2);
        break;
      case 'e':
        out += spad(x.D, 2);
        break;
      case 'f':
        out += secFrac(x.s > 59.999 ? 59.999 : x.s);
        break;
      case 'F':
        out += zpad(x.Y, 4) + '-' + zpad(x.M, 2) + '-' + zpad(x.D, 2);
        break;
      case 'G':
        out += zpad(isoThursday(x).Y, 4);
        break;
      case 'g':
        out += zpad(isoThursday(x).Y % 100, 2);
        break;
      case 'H':
        out += zpad(x.h, 2);
        break;
      case 'k':
        out += spad(x.h, 2);
        break;
      case 'I':
      case 'l': {
        let h = x.h;
        if (h > 12) h -= 12;
        if (h === 0) h = 12;
        out += cf === 'I' ? zpad(h, 2) : spad(h, 2);
        break;
      }
      case 'j':
        out += zpad(daysAfterJan01(x) + 1, 3);
        break;
      case 'J':
        out += fmtG16(x.iJD / 86400000.0);
        break;
      case 'm':
        out += zpad(x.M, 2);
        break;
      case 'M':
        out += zpad(x.m, 2);
        break;
      case 'p':
        out += x.h >= 12 ? 'PM' : 'AM';
        break;
      case 'P':
        out += x.h >= 12 ? 'pm' : 'am';
        break;
      case 'R':
        out += zpad(x.h, 2) + ':' + zpad(x.m, 2);
        break;
      case 's':
        out += x.useSubsec ? ((x.iJD - UNIX_EPOCH_JD_MS) / 1000.0).toFixed(3) : String(trunc(x.iJD / 1000) - 21086676 * 10000);
        break;
      case 'S':
        out += zpad(trunc(x.s), 2);
        break;
      case 'T':
        out += zpad(x.h, 2) + ':' + zpad(x.m, 2) + ':' + zpad(trunc(x.s), 2);
        break;
      case 'u':
      case 'w': {
        const c = daysAfterSunday(x);
        out += c === 0 && cf === 'u' ? '7' : String(c);
        break;
      }
      case 'U':
        out += zpad(trunc((daysAfterJan01(x) - daysAfterSunday(x) + 7) / 7), 2);
        break;
      case 'V': {
        const y = isoThursday(x);
        out += zpad(trunc(daysAfterJan01(y) / 7) + 1, 2);
        break;
      }
      case 'W':
        out += zpad(trunc((daysAfterJan01(x) - daysAfterMonday(x) + 7) / 7), 2);
        break;
      case 'Y':
        out += zpad(x.Y, 4);
        break;
      case '%':
        out += '%';
        break;
      default:
        return null;
    }
  }
  if (j < i) out += fmt.slice(j, i);
  return out;
}

function timediff(ctx: DateTimeContext, a: SqlValue, b: SqlValue): string | null {
  const d1 = isDate(ctx, [a], 0);
  if (d1 === null) return null;
  const d2x = isDate(ctx, [b], 0);
  if (d2x === null) return null;
  computeYMD_HMS(d1);
  computeYMD_HMS(d2x);
  let sign: string;
  let Y: number;
  let M: number;
  if (d1.iJD >= d2x.iJD) {
    sign = '+';
    Y = d1.Y - d2x.Y;
    if (Y) {
      d2x.Y = d1.Y;
      d2x.validJD = false;
      computeJD(d2x);
    }
    M = d1.M - d2x.M;
    if (M < 0) {
      Y--;
      M += 12;
    }
    if (M !== 0) {
      d2x.M = d1.M;
      d2x.validJD = false;
      computeJD(d2x);
    }
    while (d1.iJD < d2x.iJD) {
      M--;
      if (M < 0) {
        M = 11;
        Y--;
      }
      d2x.M--;
      if (d2x.M < 1) {
        d2x.M = 12;
        d2x.Y--;
      }
      d2x.validJD = false;
      computeJD(d2x);
    }
    d1.iJD -= d2x.iJD;
  } else {
    sign = '-';
    Y = d2x.Y - d1.Y;
    if (Y) {
      d2x.Y = d1.Y;
      d2x.validJD = false;
      computeJD(d2x);
    }
    M = d2x.M - d1.M;
    if (M < 0) {
      Y--;
      M += 12;
    }
    if (M !== 0) {
      d2x.M = d1.M;
      d2x.validJD = false;
      computeJD(d2x);
    }
    while (d1.iJD > d2x.iJD) {
      M--;
      if (M < 0) {
        M = 11;
        Y--;
      }
      d2x.M++;
      if (d2x.M > 12) {
        d2x.M = 1;
        d2x.Y++;
      }
      d2x.validJD = false;
      computeJD(d2x);
    }
    d1.iJD = d2x.iJD - d1.iJD;
  }
  d1.iJD += 1486995408 * 100000;
  clearYMD_HMS_TZ(d1);
  computeYMD_HMS(d1);
  return sign + zpad(Y, 4) + '-' + zpad(M, 2) + '-' + zpad(d1.D - 1, 2) + ' ' + zpad(d1.h, 2) + ':' + zpad(d1.m, 2) + ':' + secFrac(d1.s);
}

// ------------------------------------------------------------------ SQL functions

export function dateFn(args: readonly SqlValue[], ctx: DateTimeContext): SqlValue {
  curFn = 'date';
  const x = isDate(ctx, args, 0);
  if (x === null) return null;
  computeYMD(x);
  return ymdText(x);
}

export function timeFn(args: readonly SqlValue[], ctx: DateTimeContext): SqlValue {
  curFn = 'time';
  const x = isDate(ctx, args, 0);
  if (x === null) return null;
  computeHMS(x);
  return hmsText(x);
}

export function datetimeFn(args: readonly SqlValue[], ctx: DateTimeContext): SqlValue {
  curFn = 'datetime';
  const x = isDate(ctx, args, 0);
  if (x === null) return null;
  computeYMD_HMS(x);
  return ymdText(x) + ' ' + hmsText(x);
}

export function juliandayFn(args: readonly SqlValue[], ctx: DateTimeContext): SqlValue {
  curFn = 'julianday';
  const x = isDate(ctx, args, 0);
  if (x === null) return null;
  computeJD(x);
  return x.iJD / 86400000.0;
}

export function unixepochFn(args: readonly SqlValue[], ctx: DateTimeContext): SqlValue {
  curFn = 'unixepoch';
  const x = isDate(ctx, args, 0);
  if (x === null) return null;
  computeJD(x);
  if (x.useSubsec) return (x.iJD - UNIX_EPOCH_JD_MS) / 1000.0;
  return trunc(x.iJD / 1000) - 21086676 * 10000;
}

export function strftimeFn(args: readonly SqlValue[], ctx: DateTimeContext): SqlValue {
  curFn = 'strftime';
  if (args.length === 0) return null;
  const fmt = argText(args[0]);
  if (fmt === null) return null;
  const x = isDate(ctx, args, 1);
  if (x === null) return null;
  return strftime(fmt, x);
}

export function timediffFn(args: readonly SqlValue[], ctx: DateTimeContext): SqlValue {
  curFn = 'timediff';
  return timediff(ctx, args[0], args[1]);
}

/** CURRENT_DATE / CURRENT_TIME / CURRENT_TIMESTAMP for a Unix-millisecond instant. */
export function currentTimeText(kind: 'current_date' | 'current_time' | 'current_timestamp', nowMs: number): string {
  const iso = new Date(nowMs).toISOString();
  return kind === 'current_date' ? iso.slice(0, 10) : kind === 'current_time' ? iso.slice(11, 19) : iso.slice(0, 10) + ' ' + iso.slice(11, 19);
}
