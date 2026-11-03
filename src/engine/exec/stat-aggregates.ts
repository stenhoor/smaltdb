/**
 * Statistical aggregate functions.
 *
 * SQLite's percentile functions (ext/misc/percentile.c, built into SQLite 3.51+): median, percentile,
 * percentile_cont, percentile_disc, with its rules:
 * - NULL inputs are skipped; any other non-number (text, blob) is an error, and so is an infinity;
 * - the fraction must be a number in range (0–100 for percentile, 0–1 for the others) and the same on every row;
 * - the result is REAL: percentile_cont interpolates at p·(n−1), percentile_disc takes the value at floor(p·(n−1)).
 *
 * The SQL-standard moments (PostgreSQL's names): var_samp/variance, var_pop, stddev_samp/stddev, stddev_pop,
 * covar_samp, covar_pop, corr; and skewness, skewness_pop, kurtosis, kurtosis_pop (DuckDB's names: the plain names
 * are the sample statistics with bias correction, `_pop` the population ones, which pandas and Polars give with
 * bias=True). Inputs convert to numbers like sum() and avg() do; NULLs (for two-argument functions, rows where either
 * is NULL) are skipped. They are computed in one pass with Welford's updates, extended to the third and fourth
 * moments (Terriberry) and to co-moments, which stay accurate when values are large and close together, where the
 * textbook sum-of-squares formulas cancel. A statistic that is undefined (too few rows, zero variance for skewness,
 * kurtosis and corr) is NULL.
 */
import { SmaltError } from '../errors.js';
import type { SqlValue } from '../values.js';
import { type StaticType, applyNumericAffinity, toNumeric } from './convert.js';
import type { AggregateFunction, AggregateState } from './functions.js';

// ------------------------------------------------------------------ moments

/** A value as sum() and avg() use it: NULL is skipped (undefined), text and blobs by their numeric prefix. */
function momentArg(v: SqlValue): number | undefined {
  if (typeof v === 'number') return v;
  if (v === null) return undefined;
  if (typeof v === 'bigint') return Number(v);
  return Number(toNumeric(v) ?? 0);
}

/** A REAL result: NaN (from infinite inputs) is NULL. */
const real = (x: number): SqlValue => (x === x ? x : null);

type MomentKind = 'var_samp' | 'var_pop' | 'stddev_samp' | 'stddev_pop' | 'skewness' | 'skewness_pop' | 'kurtosis' | 'kurtosis_pop';

/** Count, mean and the central moment sums M2 (and M3, M4 for skewness and kurtosis) of one column. */
class MomentState implements AggregateState {
  protected n = 0;
  protected mean = 0;
  protected m2 = 0;
  private m3 = 0;
  private m4 = 0;
  private readonly higher: boolean;

  constructor(private readonly kind: MomentKind) {
    this.higher = kind.startsWith('skewness') || kind.startsWith('kurtosis');
  }

  step(args: SqlValue[]): void {
    this.step1(args[0]);
  }

  step1(v: SqlValue): void {
    const x = typeof v === 'number' ? v : momentArg(v);
    if (x === undefined) return;
    const n1 = this.n;
    const n = n1 + 1;
    this.n = n;
    const delta = x - this.mean;
    const dn = delta / n;
    const term1 = delta * dn * n1;
    this.mean += dn;
    if (this.higher) {
      const dn2 = dn * dn;
      this.m4 += term1 * dn2 * (n * n - 3 * n + 3) + 6 * dn2 * this.m2 - 4 * dn * this.m3;
      this.m3 += term1 * dn * (n - 2) - 3 * dn * this.m2;
    }
    this.m2 += term1;
  }

  final(): SqlValue {
    const { n, m2 } = this;
    switch (this.kind) {
      case 'var_pop':
        return n < 1 ? null : real(m2 / n);
      case 'var_samp':
        return n < 2 ? null : real(m2 / (n - 1));
      case 'stddev_pop':
        return n < 1 ? null : real(Math.sqrt(m2 / n));
      case 'stddev_samp':
        return n < 2 ? null : real(Math.sqrt(m2 / (n - 1)));
    }
    if (!(m2 > 0)) return null; // no spread (or no rows): skewness and kurtosis are undefined
    if (this.kind === 'skewness_pop' || this.kind === 'skewness') {
      const g1 = (Math.sqrt(n) * this.m3) / (m2 * Math.sqrt(m2));
      if (this.kind === 'skewness_pop') return real(g1);
      return n < 3 ? null : real((g1 * Math.sqrt(n * (n - 1))) / (n - 2));
    }
    const g2 = (n * this.m4) / (m2 * m2) - 3;
    if (this.kind === 'kurtosis_pop') return real(g2);
    return n < 4 ? null : real(((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * g2 + 6));
  }
}

/**
 * Variance and standard deviation, which can also remove a value (sliding window frames): Welford's update run
 * backwards. Skewness and kurtosis cannot be undone accurately, so their frames are recomputed (MomentState).
 *
 * Removing values leaves their rounding behind: after a frame of values near 1e9 slides on to values near 1, the
 * running M2 can be off by more than the remaining variance. So the state bounds its accumulated rounding error,
 * about (updates) x epsilon x (largest |x| added)^2, and reports itself untrustworthy once M2 is not at least 1e9
 * times that bound; the window then rebuilds it from the frame's rows. On well-conditioned data that is rare.
 */
class VarianceState extends MomentState {
  private maxSq = 0;
  private updates = 0;

  override step1(v: SqlValue): void {
    const x = typeof v === 'number' ? v : momentArg(v);
    if (x === undefined) return;
    const sq = x * x;
    if (sq > this.maxSq) this.maxSq = sq;
    this.updates++;
    super.step1(x);
  }

  override step(args: SqlValue[]): void {
    this.step1(args[0]);
  }

  inverse(args: SqlValue[]): boolean {
    const x = momentArg(args[0]);
    if (x === undefined) return true;
    const n = this.n - 1;
    if (n === 0) {
      // Empty again: start from exact zeros rather than carry rounding forward.
      this.n = 0;
      this.mean = 0;
      this.m2 = 0;
      this.maxSq = 0;
      this.updates = 0;
      return true;
    }
    const delta = x - this.mean;
    this.n = n;
    this.mean -= delta / n;
    const m2 = this.m2 - delta * (x - this.mean);
    this.m2 = m2 > 0 ? m2 : 0; // rounding can take a zero spread just below 0
    this.updates++;
    return this.m2 > 1e9 * this.updates * Number.EPSILON * this.maxSq;
  }
}

type CovarKind = 'covar_samp' | 'covar_pop' | 'corr';

/** Co-moment of two columns (and their M2s for corr), over rows where both are non-NULL. */
class CovarState implements AggregateState {
  private n = 0;
  private meanY = 0;
  private meanX = 0;
  private c = 0;
  private m2y = 0;
  private m2x = 0;

  constructor(private readonly kind: CovarKind) {}

  step(args: SqlValue[]): void {
    this.step2(args[0], args[1]);
  }

  step2(yv: SqlValue, xv: SqlValue): void {
    const y = typeof yv === 'number' ? yv : momentArg(yv);
    const x = typeof xv === 'number' ? xv : momentArg(xv);
    if (y === undefined || x === undefined) return;
    const n = ++this.n;
    const dy = y - this.meanY;
    const dx = x - this.meanX;
    this.meanY += dy / n;
    this.meanX += dx / n;
    const dy2 = y - this.meanY;
    const dx2 = x - this.meanX;
    this.c += dy * dx2;
    this.m2y += dy * dy2;
    this.m2x += dx * dx2;
  }

  final(): SqlValue {
    const n = this.n;
    switch (this.kind) {
      case 'covar_pop':
        return n < 1 ? null : real(this.c / n);
      case 'covar_samp':
        return n < 2 ? null : real(this.c / (n - 1));
      default: {
        if (!(this.m2x > 0) || !(this.m2y > 0)) return null;
        // Rounding can put |r| a hair above 1; clamp to the defined range.
        const r = this.c / Math.sqrt(this.m2x * this.m2y);
        return real(r > 1 ? 1 : r < -1 ? -1 : r);
      }
    }
  }
}

// ------------------------------------------------------------------ percentiles (SQLite)

type PercentKind = 'median' | 'percentile' | 'percentile_cont' | 'percentile_disc';

/**
 * Put the k-th smallest of a[lo..hi] at a[k], smaller-or-equal values before it and greater-or-equal after
 * (introselect: quickselect with a median-of-three pivot, sorting the range instead if it stops shrinking fast).
 * Sorting a million values takes V8 over 100 ms; this takes a few.
 */
export function select(a: Float64Array, k: number, lo = 0, hi = a.length - 1): void {
  let budget = 2 * Math.ceil(Math.log2(hi - lo + 2)) + 8;
  while (hi > lo) {
    if (hi - lo < 16 || budget-- === 0) {
      a.subarray(lo, hi + 1).sort();
      return;
    }
    // Median of three as the pivot, moved to a[lo].
    const mid = (lo + hi) >>> 1;
    if (a[mid] < a[lo]) swap(a, mid, lo);
    if (a[hi] < a[lo]) swap(a, hi, lo);
    if (a[hi] < a[mid]) swap(a, hi, mid);
    swap(a, lo, mid);
    const pivot = a[lo];
    // Hoare partition: a[lo..j] <= pivot <= a[j+1..hi].
    let i = lo;
    let j = hi + 1;
    for (;;) {
      do i++;
      while (i <= hi && a[i] < pivot);
      do j--;
      while (a[j] > pivot);
      if (i >= j) break;
      swap(a, i, j);
    }
    swap(a, lo, j);
    if (j === k) return;
    if (j < k) lo = j + 1;
    else hi = j - 1;
  }
}

function swap(a: Float64Array, i: number, j: number): void {
  const t = a[i];
  a[i] = a[j];
  a[j] = t;
}

/** Collects the non-NULL values; selects the one or two it needs at the end. */
class PercentileState implements AggregateState {
  private values = new Float64Array(16);
  private n = 0;
  /**
   * Set once a value has been removed (a sliding window frame): from then on the values are kept sorted, so a
   * removal is a binary search and the result an index, instead of a selection per frame.
   */
  private sorted = false;
  /** The fraction (0–1); median's is fixed. */
  private frac: number | undefined;
  private readonly max: number;

  constructor(private readonly kind: PercentKind) {
    this.max = kind === 'percentile' ? 100 : 1;
    if (kind === 'median') this.frac = 0.5;
  }

  step(args: SqlValue[]): void {
    if (this.kind !== 'median') this.fraction(args[1]);
    this.add(args[0]);
  }

  step2(v: SqlValue, p: SqlValue): void {
    if (p !== this.lastP) this.fraction(p); // the same constant fraction on every row is checked once
    this.add(v);
  }

  step1(v: SqlValue): void {
    this.add(v);
  }

  /** The last fraction argument checked (a number; step2 skips checking an identical one again). */
  private lastP: SqlValue = undefined as unknown as SqlValue;

  /** The fraction argument, checked on every row as SQLite does (also on rows whose value is NULL). */
  private fraction(p: SqlValue): void {
    const n = typeof p === 'number' ? p : typeof p === 'bigint' ? Number(p) : typeof p === 'string' ? numericText(p) : undefined;
    if (n === undefined || !(n >= 0 && n <= this.max)) {
      throw new SmaltError('SMALT_ERROR', `the fraction argument to ${this.kind}() is not between 0.0 and ${this.max.toFixed(1)}`);
    }
    const f = n / this.max;
    if (this.frac === undefined) this.frac = f;
    else if (f !== this.frac) throw new SmaltError('SMALT_ERROR', `the fraction argument to ${this.kind}() is not the same for all input rows`);
    if (typeof p === 'number') this.lastP = p;
  }

  private add(v: SqlValue): void {
    if (v === null) return;
    let x: number;
    if (typeof v === 'number') x = v;
    else if (typeof v === 'bigint') x = Number(v);
    else throw new SmaltError('SMALT_ERROR', `input to ${this.kind}() is not numeric`);
    if (x === Infinity || x === -Infinity) throw new SmaltError('SMALT_ERROR', `Inf input to ${this.kind}()`);
    if (this.n === this.values.length) {
      const grown = new Float64Array(this.n * 2);
      grown.set(this.values);
      this.values = grown;
    }
    if (!this.sorted) {
      this.values[this.n++] = x;
      return;
    }
    const at = this.lowerBound(x);
    this.values.copyWithin(at + 1, at, this.n);
    this.values[at] = x;
    this.n++;
  }

  inverse(args: SqlValue[]): boolean {
    const v = args[0];
    if (v === null) return true;
    const x = typeof v === 'number' ? v : Number(v as bigint); // it was accepted by step
    if (!this.sorted) {
      this.values.subarray(0, this.n).sort();
      this.sorted = true;
    }
    const at = this.lowerBound(x);
    this.values.copyWithin(at, at + 1, this.n);
    this.n--;
    return true; // exact
  }

  /** The first index whose value is not below x (sorted mode). */
  private lowerBound(x: number): number {
    let lo = 0;
    let hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.values[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  final(): SqlValue {
    const n = this.n;
    if (n === 0 || this.frac === undefined) return null;
    const a = this.values.subarray(0, n);
    const ix = this.frac * (n - 1);
    const i1 = Math.floor(ix);
    if (this.sorted) {
      if (this.kind === 'percentile_disc' || ix === i1 || i1 === n - 1) return a[i1];
      return a[i1] + (a[i1 + 1] - a[i1]) * (ix - i1);
    }
    select(a, i1);
    const lo = a[i1];
    if (this.kind === 'percentile_disc' || ix === i1 || i1 === n - 1) return lo;
    // The next value up: the smallest of those after a[i1], which are all >= it.
    let hi = a[i1 + 1];
    for (let i = i1 + 2; i < n; i++) if (a[i] < hi) hi = a[i];
    return lo + (hi - lo) * (ix - i1);
  }
}

/** Text that SQLite's numeric affinity makes a number, as a double; undefined otherwise. */
function numericText(s: string): number | undefined {
  const v = applyNumericAffinity(s);
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : undefined;
}

// ------------------------------------------------------------------ registry

const realResult = (): StaticType => 'real';

const moment = (kind: MomentKind): AggregateFunction => ({
  minArgs: 1,
  maxArgs: 1,
  resultType: realResult,
  create: () => (kind.startsWith('skewness') || kind.startsWith('kurtosis') ? new MomentState(kind) : new VarianceState(kind)),
});
const covar = (kind: CovarKind): AggregateFunction => ({ minArgs: 2, maxArgs: 2, resultType: realResult, create: () => new CovarState(kind) });
const percent = (kind: PercentKind): AggregateFunction => ({
  minArgs: kind === 'median' ? 1 : 2,
  maxArgs: kind === 'median' ? 1 : 2,
  resultType: realResult,
  create: () => new PercentileState(kind),
});

/** The statistical aggregates, by name (registered in functions.ts). */
export const STAT_AGGREGATES: ReadonlyMap<string, AggregateFunction> = new Map([
  ['var_samp', moment('var_samp')],
  ['variance', moment('var_samp')],
  ['var_pop', moment('var_pop')],
  ['stddev_samp', moment('stddev_samp')],
  ['stddev', moment('stddev_samp')],
  ['stddev_pop', moment('stddev_pop')],
  ['skewness', moment('skewness')],
  ['skewness_pop', moment('skewness_pop')],
  ['kurtosis', moment('kurtosis')],
  ['kurtosis_pop', moment('kurtosis_pop')],
  ['covar_samp', covar('covar_samp')],
  ['covar_pop', covar('covar_pop')],
  ['corr', covar('corr')],
  ['median', percent('median')],
  ['percentile', percent('percentile')],
  ['percentile_cont', percent('percentile_cont')],
  ['percentile_disc', percent('percentile_disc')],
]);
