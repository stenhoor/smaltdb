/**
 * Floating-point to decimal text, ported from SQLite 3.54 (sqlite3FpDecode() and its helpers in
 * util.c, and the %f/%e/%g rendering of sqlite3_str_vappendf() in printf.c), so that REAL values
 * render exactly as SQLite renders them: in printf() and when a REAL is converted to text.
 */

import { SmaltError } from '../errors.js';

const M64 = (1n << 64n) - 1n;
const M32 = 0xffffffffn;
const BIT63 = 1n << 63n;

/* eslint-disable prettier/prettier */
const A_BASE = [
  0x8000000000000000n, 0xa000000000000000n, 0xc800000000000000n, 0xfa00000000000000n, 0x9c40000000000000n, 0xc350000000000000n, 0xf424000000000000n,
  0x9896800000000000n, 0xbebc200000000000n, 0xee6b280000000000n, 0x9502f90000000000n, 0xba43b74000000000n, 0xe8d4a51000000000n, 0x9184e72a00000000n,
  0xb5e620f480000000n, 0xe35fa931a0000000n, 0x8e1bc9bf04000000n, 0xb1a2bc2ec5000000n, 0xde0b6b3a76400000n, 0x8ac7230489e80000n, 0xad78ebc5ac620000n,
  0xd8d726b7177a8000n, 0x878678326eac9000n, 0xa968163f0a57b400n, 0xd3c21bcecceda100n, 0x84595161401484a0n, 0xa56fa5b99019a5c8n,
];
const A_SCALE = [
  0x8049a4ac0c5811aen, 0xcf42894a5dce35ean, 0xa76c582338ed2621n, 0x873e4f75e2224e68n, 0xda7f5bf590966848n, 0xb080392cc4349decn, 0x8e938662882af53en,
  0xe65829b3046b0afan, 0xba121a4650e4ddebn, 0x964e858c91ba2655n, 0xf2d56790ab41c2a2n, 0xc428d05aa4751e4cn, 0x9e74d1b791e07e48n, 0xccccccccccccccccn,
  0xcecb8f27f4200f3an, 0xa70c3c40a64e6c51n, 0x86f0ac99b4e8dafdn, 0xda01ee641a708de9n, 0xb01ae745b101e9e4n, 0x8e41ade9fbebc27dn, 0xe5d3ef282a242e81n,
  0xb9a74a0637ce2ee1n, 0x95f83d0a1fb69cd9n, 0xf24a01a73cf2dccfn, 0xc3b8358109e84f07n, 0x9e19db92b4e31ba9n,
];
const A_SCALE_LO = [
  0x205b896dn, 0x52064cadn, 0xaf2af2b8n, 0x5a7744a7n, 0xaf39a475n, 0xbd8d794en, 0x547eb47bn, 0x0cb4a5a3n, 0x92f34d62n, 0x3a6a07f9n, 0xfae27299n,
  0xaa97e14cn, 0x775ea265n, 0xccccccccn, 0x00000000n, 0x999090b6n, 0x69a028bbn, 0xe80e6f48n, 0x5ec05dd0n, 0x14588f14n, 0x8f1668c9n, 0x6d953e2cn,
  0x4abdaf10n, 0xbc633b39n, 0x0a862f81n, 0x6c07a2c2n,
];
/* eslint-enable prettier/prettier */

/** 64x64 -> 128-bit product: [high 64 bits, low 64 bits]. */
function mul128(a: bigint, b: bigint): [bigint, bigint] {
  const r = a * b;
  return [r >> 64n, r & M64];
}

/** sqlite3Multiply160(), portable version (the one the WASM build uses): [high 64, middle 32]. */
function mul160(a: bigint, aLo: bigint, b: bigint): [bigint, bigint] {
  const x2 = a >> 32n;
  const x1 = a & M32;
  const x0 = aLo;
  const y1 = b >> 32n;
  const y0 = b & M32;
  const x2y1 = x2 * y1;
  const r4 = x2y1 >> 32n;
  const x2y0 = x2 * y0;
  const x1y1 = x1 * y1;
  let r3 = (x2y1 & M32) + (x2y0 >> 32n) + (x1y1 >> 32n);
  const x1y0 = x1 * y0;
  const x0y1 = x0 * y1;
  let r2 = (x2y0 & M32) + (x1y1 & M32) + (x1y0 >> 32n) + (x0y1 >> 32n);
  const x0y0 = x0 * y0;
  const r1 = (x1y0 & M32) + (x0y1 & M32) + (x0y0 >> 32n);
  r2 += r1 >> 32n;
  r3 += r2 >> 32n;
  return [((r4 << 32n) + r3) & M64, r2 & M32];
}

/** C integer division and remainder (truncating toward zero). */
const cdiv = (a: number, b: number): number => Math.trunc(a / b);

/** powerOfTen(): the top 64 bits of 10^p, and the next 32 bits. */
function powerOfTen(p: number): [bigint, bigint] {
  let g: number;
  let n: number;
  if (p < 0) {
    if (p === -1) return [A_SCALE[13], A_SCALE_LO[13]];
    g = cdiv(p, 27);
    n = p % 27;
    if (n) {
      g--;
      n += 27;
    }
  } else if (p < 27) {
    return [A_BASE[p], 0n];
  } else {
    g = cdiv(p, 27);
    n = p % 27;
  }
  const s = A_SCALE[g + 13];
  if (n === 0) return [s, A_SCALE_LO[g + 13]];
  let [x, lo] = mul160(s, A_SCALE_LO[g + 13], A_BASE[n]);
  if ((BIT63 & x) === 0n) {
    x = ((x << 1n) | ((lo >> 31n) & 1n)) & M64;
    lo = ((lo << 1n) | 1n) & M32;
  }
  return [x, lo];
}

const pwr10to2 = (p: number): number => (p * 108853) >> 15;
const pwr2to10 = (p: number): number => (p * 78913) >> 18;

function clz64(m: bigint): number {
  let n = 0;
  while (n < 64 && (m & (BIT63 >> BigInt(n))) === 0n) n++;
  return n;
}

/** sqlite3Fp2Convert10(): m * 2^e ~= d * 10^p with at least n significant digits. */
function fp2Convert10(m: bigint, e: number, n: number): [bigint, number] {
  const p = n - 1 - pwr2to10(e + 63);
  const [h0] = mul128(m, powerOfTen(p)[0]);
  let h = h0;
  if (n === 18) {
    h >>= BigInt(-(e + pwr10to2(p) + 2));
    return [(h + ((h << 1n) & 2n)) >> 1n, -p];
  }
  return [h >> BigInt(-(e + pwr10to2(p) + 1)), -p];
}

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);

/** sqlite3Fp10Convert2(): the double nearest d * 10^p. */
function fp10Convert2(d: bigint, p: number): number {
  if (p < -348) return 0;
  if (p > 347) return Infinity;
  const b = 64 - clz64(d);
  const lp = pwr10to2(p);
  let e = 53 - b - lp;
  if (e > 1074) {
    if (e >= 1130) return 0;
    e = 1074;
  }
  const s = BigInt(-(e - (64 - b) + lp + 3));
  let [pwr10h, pwr10l] = powerOfTen(p);
  if (pwr10l !== 0n) {
    pwr10h = (pwr10h + 1n) & M64;
    pwr10l = ~pwr10l & M32;
  }
  const x = (d << BigInt(64 - b)) & M64;
  const prod = mul128(x, pwr10h);
  let hi = prod[0];
  const lo = prod[1];
  const mid1 = lo >> 32n;
  let sticky = 1n;
  if ((hi & ((1n << s) - 1n)) === 0n) {
    const mid2 = (mul128(x, pwr10l << 32n)[0] >> 32n) & M32;
    sticky = ((mid1 - mid2) & M32) > 1n ? 1n : 0n;
    if (mid1 < mid2) hi = (hi - 1n) & M64;
  }
  let u = (hi >> s) | sticky;
  if (u >= (1n << 55n) - 2n) {
    u = (u >> 1n) | (u & 1n);
    e -= 1;
  }
  let mm = (u + 1n + ((u >> 2n) & 1n)) >> 2n;
  if (e <= -972) return Infinity;
  if ((mm & (1n << 52n)) !== 0n) mm = (mm & ~(1n << 52n)) | (BigInt(1075 - e) << 52n);
  u64[0] = mm & M64;
  return f64[0];
}

interface FpDecode {
  sign: '+' | '-';
  /** 0 = finite, 1 = infinity, 2 = NaN. */
  special: 0 | 1 | 2;
  /** Significant digits (no trailing zeros). */
  z: string;
  /** Position of the decimal point relative to z. */
  iDP: number;
}

/** sqlite3FpDecode(). */
export function fpDecode(r: number, iRound: number, mxRound: number): FpDecode {
  let sign: '+' | '-' = '+';
  if (r < 0) {
    sign = '-';
    r = -r;
  } else if (r === 0) {
    return { sign, special: 0, z: '0', iDP: 1 };
  }
  f64[0] = r;
  let v = u64[0];
  let e = Number((v >> 52n) & 0x7ffn);
  if (e === 0x7ff) return { sign, special: v !== 0x7ff0000000000000n ? 2 : 1, z: '', iDP: 0 };
  v &= 0x000fffffffffffffn;
  if (e === 0) {
    const nn = clz64(v);
    v = (v << BigInt(nn)) & M64;
    e = -1074 - nn;
  } else {
    v = ((v << 11n) | BIT63) & M64;
    e -= 1086;
  }
  const [d, exp] = fp2Convert10(v, e, iRound <= 0 || iRound >= 18 ? 18 : iRound + 1);
  let zs = d.toString();
  let n = zs.length;
  let iDP = n + exp;
  if (iRound <= 0) {
    iRound = iDP - iRound;
    if (iRound === 0 && zs[0] >= '5') {
      iRound = 1;
      zs = '0' + zs;
      n++;
      iDP++;
    }
  }
  const z = zs.split('').map((c) => c.charCodeAt(0));
  let z0 = 0; // index of the first digit in z (may become -1 on carry)
  if (iRound > 0 && (iRound < n || n > mxRound)) {
    if (iRound > mxRound) iRound = mxRound;
    if (iRound === 17) {
      // Try a shorter rendering that still round-trips (only reachable with the "!" flag).
      const dig = (k: number): number => z[k] - 48;
      if (z[15] === 57 && z[14] === 57) {
        let jj = 14;
        while (jj > 0 && z[jj - 1] === 57) jj--;
        let v2: bigint;
        if (jj === 0) v2 = 1n;
        else {
          v2 = BigInt(dig(0));
          for (let kk = 1; kk < jj; kk++) v2 = v2 * 10n + BigInt(dig(kk));
          v2++;
        }
        if (r === fp10Convert2(v2, exp + n - jj)) iRound = jj + 1;
      } else if (iDP >= n || (z[15] === 48 && z[14] === 48 && z[13] === 48)) {
        let jj = 13;
        while (z[jj - 1] === 48) jj--;
        let v2 = BigInt(dig(0));
        for (let kk = 1; kk < jj; kk++) v2 = v2 * 10n + BigInt(dig(kk));
        if (r === fp10Convert2(v2, exp + n - jj)) iRound = jj + 1;
      }
    }
    n = iRound;
    if (z[iRound] >= 53) {
      let j = iRound - 1;
      for (;;) {
        z[j]++;
        if (z[j] <= 57) break;
        z[j] = 48;
        if (j === 0) {
          z.unshift(49);
          z0 = 0;
          n++;
          iDP++;
          break;
        }
        j--;
      }
    }
  }
  while (z[z0 + n - 1] === 48) n--;
  return { sign, special: 0, z: String.fromCharCode(...z.slice(z0, z0 + n)), iDP };
}


/** Space-pad a rendered field to `width` (the generic path at the end of sqlite3_str_vappendf). */
function padField(s: string, width: number, leftJustify: boolean): string {
  if (s.length >= width) return s;
  return leftJustify ? s + ' '.repeat(width - s.length) : ' '.repeat(width - s.length) + s;
}

export type FloatConv = 'f' | 'e' | 'E' | 'g' | 'G';

export interface FloatFlags {
  leftJustify: boolean;
  /** '+', ' ' or ''. */
  flagPrefix: string;
  thousand: boolean;
  alternateForm: boolean;
  altForm2: boolean;
  zeroPad: boolean;
}

const enum X {
  FLOAT,
  EXP,
  GENERIC,
}

/** The %f / %e / %E / %g / %G conversion of SQLite's printf, including field width. */
export function renderFloat(realvalue: number, conv: FloatConv, precision: number, width: number, flags: FloatFlags): string {
  const { leftJustify, flagPrefix, thousand, alternateForm, altForm2, zeroPad } = flags;
  let xtype = conv === 'f' ? X.FLOAT : conv === 'g' || conv === 'G' ? X.GENERIC : X.EXP;
  const eChar = conv === 'E' || conv === 'G' ? 'E' : 'e';
  if (precision < 0) precision = 6;
  if (precision > 100000000) precision = 100000000;
  let iRound: number;
  if (xtype === X.FLOAT) iRound = -precision;
  else if (xtype === X.GENERIC) {
    if (precision === 0) precision = 1;
    iRound = precision;
  } else iRound = precision + 1;
  const s = fpDecode(realvalue, iRound, altForm2 ? 20 : 16);
  let prefix: string;
  if (s.special) {
    if (s.special === 2) {
      return padField(zeroPad ? 'null' : 'NaN', width, leftJustify);
    } else if (zeroPad) {
      s.z = '9';
      s.iDP = 1000;
    } else {
      return padField(s.sign === '-' ? '-Inf' : flagPrefix ? flagPrefix + 'Inf' : 'Inf', width, leftJustify);
    }
  }
  if (s.sign === '-') prefix = alternateForm && !flagPrefix && xtype === X.FLOAT && s.iDP <= iRound ? '' : '-';
  else prefix = flagPrefix;
  let exp = s.iDP - 1;
  let rtz: boolean;
  if (xtype === X.GENERIC) {
    precision--;
    rtz = !alternateForm;
    if (exp < -4 || exp > precision) xtype = X.EXP;
    else {
      precision = precision - exp;
      xtype = X.FLOAT;
    }
  } else rtz = altForm2;
  let e2 = xtype === X.EXP ? 0 : s.iDP - 1;
  if (Math.max(e2, 0) + precision + width + 10 > 1_000_000_000) throw new SmaltError('SMALT_TOOBIG', 'string or blob too big');
  const dp = precision > 0 || alternateForm || altForm2;
  let o = prefix;
  let j = 0;
  const sn = s.z.length;
  if (e2 < 0) o += '0';
  else if (thousand) {
    for (; e2 >= 0; e2--) {
      o += j < sn ? s.z[j++] : '0';
      if (e2 % 3 === 0 && e2 > 1) o += ',';
    }
  } else {
    j = Math.min(e2 + 1, sn);
    o += s.z.slice(0, j);
    e2 -= j;
    if (e2 >= 0) {
      o += '0'.repeat(e2 + 1);
      e2 = -1;
    }
  }
  if (dp) o += '.';
  if (e2 < -1 && precision > 0) {
    const nn = Math.min(-1 - e2, precision);
    o += '0'.repeat(nn);
    precision -= nn;
  }
  if (precision > 0) {
    const nn = Math.min(sn - j, precision);
    if (nn > 0) {
      o += s.z.slice(j, j + nn);
      precision -= nn;
    }
    if (precision > 0 && !rtz) o += '0'.repeat(precision);
  }
  if (rtz && dp) {
    let k = o.length;
    while (o[k - 1] === '0') k--;
    o = o.slice(0, k);
    if (o[k - 1] === '.') o = altForm2 ? o + '0' : o.slice(0, k - 1);
  }
  if (xtype === X.EXP) {
    exp = s.iDP - 1;
    o += eChar;
    if (exp < 0) {
      o += '-';
      exp = -exp;
    } else o += '+';
    if (exp >= 100) {
      o += String.fromCharCode(Math.floor(exp / 100) + 48);
      exp %= 100;
    }
    o += String.fromCharCode(Math.floor(exp / 10) + 48) + String.fromCharCode((exp % 10) + 48);
  }
  if (o.length < width) {
    const nPad = width - o.length;
    if (leftJustify) o += ' '.repeat(nPad);
    else if (!zeroPad) o = ' '.repeat(nPad) + o;
    else {
      const adj = prefix ? 1 : 0;
      o = o.slice(0, adj) + '0'.repeat(nPad) + o.slice(adj);
    }
  }
  return o;
}

const REAL_FLAGS: FloatFlags = { leftJustify: false, flagPrefix: '', thousand: false, alternateForm: false, altForm2: true, zeroPad: false };

/** SQLite's text form of a REAL (`%!.17g`): CAST(x AS TEXT), x || '', and so on. */
export function realToText(x: number): string {
  return renderFloat(x, 'g', 17, 0, REAL_FLAGS);
}
