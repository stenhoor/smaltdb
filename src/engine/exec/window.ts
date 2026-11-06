/**
 * Window functions (`f(...) OVER (PARTITION BY ... ORDER BY ... frame)`), evaluated like SQLite.
 *
 * The Window operator sits between aggregation/HAVING and the projection. It materializes its input,
 * then for each distinct window definition sorts the rows by (partition, order) keys, finds peer
 * groups and frames, and computes every call over that window into a per-row result. Rows are
 * re-emitted in input order with the registers the projection reads restored.
 */
import { SmaltError } from '../errors.js';
import { type Collation, type SqlValue, compareValues } from '../values.js';
import type { Fn } from './functions.js';
import type { AggregateFunction } from './functions.js';
import type { Operator } from './operators.js';
import { type StaticType, truthy } from './convert.js';
import { valueInt64 } from './printf.js';

export type FrameUnit = 'ROWS' | 'RANGE' | 'GROUPS';
export type BoundKind = 'unboundedPreceding' | 'preceding' | 'currentRow' | 'following' | 'unboundedFollowing';

export interface FrameSpec {
  unit: FrameUnit;
  start: { kind: BoundKind; offset?: Fn };
  end: { kind: BoundKind; offset?: Fn };
  exclude: 'NO OTHERS' | 'CURRENT ROW' | 'GROUP' | 'TIES';
}

export type WindowCallKind = 'row_number' | 'rank' | 'dense_rank' | 'percent_rank' | 'cume_dist' | 'ntile' | 'lag' | 'lead' | 'first_value' | 'last_value' | 'nth_value' | 'aggregate';

export interface WindowCall {
  kind: WindowCallKind;
  name: string;
  args: Fn[];
  filter?: Fn;
  outReg: number;
  /** Aggregate functions over the frame. */
  agg?: { def: AggregateFunction; argTypes: StaticType[]; collation: Collation; star: boolean };
  /** Navigation functions: count only rows whose value is not NULL. */
  ignoreNulls?: boolean;
}

export interface WindowDef {
  partition: Fn[];
  partitionColls: Collation[];
  order: { fn: Fn; desc: boolean; nullsFirst: boolean; collation: Collation }[];
  frame: FrameSpec;
  calls: WindowCall[];
}

export const RANKING = new Set(['row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile']);
export const NAVIGATION = new Set(['lag', 'lead', 'first_value', 'last_value', 'nth_value']);
/** Built-in window function arity (aggregates use their own). */
export const WINDOW_ARITY: Record<string, [number, number]> = {
  row_number: [0, 0],
  rank: [0, 0],
  dense_rank: [0, 0],
  percent_rank: [0, 0],
  cume_dist: [0, 0],
  ntile: [1, 1],
  lag: [1, 3],
  lead: [1, 3],
  first_value: [1, 1],
  last_value: [1, 1],
  nth_value: [2, 2],
};

/**
 * The rows of one window definition, buffered columnwise: flat arrays indexed by input row, rather than an object
 * and several small arrays per row (which made garbage collection most of the cost of a window).
 */
interface Buffered {
  n: number;
  /** Partition key k of row r at part[r * np + k]. */
  part: SqlValue[];
  /** ORDER BY key k of row r at order[r * no + k]. */
  order: SqlValue[];
  /** Per call: argument a of row r at args[c][r * arity + a]. */
  args: SqlValue[][];
  /** Per call: FILTER result per row (1 = the row counts), or null without a FILTER clause. */
  filter: (Uint8Array | null)[];
}

/** Compare two values as window keys: NULLs first unless the direction says otherwise, then by collation. */
function cmpKey(x: SqlValue, y: SqlValue, coll: Collation, dir?: { desc: boolean; nullsFirst: boolean }): number {
  if (x === null || y === null) {
    if (x === y) return 0;
    const nullsFirst = dir ? dir.nullsFirst : true;
    return (x === null) === nullsFirst ? -1 : 1;
  }
  const c = compareValues(x, y, coll);
  return dir?.desc ? -c : c;
}

function offsetValue(fn: Fn | undefined, r: SqlValue[], which: 'starting' | 'ending', unit: FrameUnit): number {
  const v = fn ? fn(r) : 0;
  // ROWS/GROUPS offsets are row/group counts; RANGE offsets are distances in the ORDER BY key.
  const what = unit === 'RANGE' ? 'number' : 'integer';
  const bad = (): never => {
    throw new SmaltError('SMALT_ERROR', `frame ${which} offset must be a non-negative ${what}`);
  };
  if (typeof v === 'bigint') return v < 0n ? bad() : Number(v);
  if (typeof v !== 'number' || !(v >= 0) || (unit !== 'RANGE' && !Number.isInteger(v))) return bad();
  return v;
}

export class Window implements Operator {
  readonly children: Operator[];
  private r!: SqlValue[];
  /** Snapshot register j of input row i at snaps[i * snapRegs.length + j]. */
  private snaps: SqlValue[] = [];
  private rowCount = 0;
  /** results[c][row] for every call of every window, in definition order. */
  private results: SqlValue[][] = [];
  private outRegs: number[];
  private i = 0;

  constructor(
    readonly child: Operator,
    private readonly snapRegs: number[],
    private readonly defs: WindowDef[],
  ) {
    this.children = [child];
    this.outRegs = defs.flatMap((d) => d.calls.map((c) => c.outReg));
  }

  get detail(): string {
    return '';
  }

  open(r: SqlValue[]): void {
    this.r = r;
    this.i = 0;
    const snaps: SqlValue[] = [];
    const snapRegs = this.snapRegs;
    const bufs: Buffered[] = this.defs.map((d) => ({
      n: 0,
      part: [],
      order: [],
      args: d.calls.map(() => []),
      filter: d.calls.map(() => null),
    }));
    // FILTER flags grow with the input; collected in plain arrays, then packed.
    const filterFlags: number[][][] = this.defs.map((d) => d.calls.map(() => []));
    let n = 0;
    const c = this.child;
    c.open(r);
    try {
      while (c.next()) {
        for (let j = 0; j < snapRegs.length; j++) snaps.push(r[snapRegs[j]]);
        for (let k = 0; k < this.defs.length; k++) {
          const d = this.defs[k];
          const b = bufs[k];
          for (let j = 0; j < d.partition.length; j++) b.part.push(d.partition[j](r));
          for (let j = 0; j < d.order.length; j++) b.order.push(d.order[j].fn(r));
          for (let ci = 0; ci < d.calls.length; ci++) {
            const call = d.calls[ci];
            const out = b.args[ci];
            for (let a = 0; a < call.args.length; a++) out.push(call.args[a](r));
            if (call.filter) filterFlags[k][ci].push(truthy(call.filter(r)) === true ? 1 : 0);
          }
        }
        n++;
      }
    } finally {
      c.close();
    }
    this.snaps = snaps;
    this.rowCount = n;
    this.results = [];
    this.defs.forEach((d, k) => {
      const b = bufs[k];
      b.n = n;
      d.calls.forEach((call, ci) => {
        if (call.filter) b.filter[ci] = Uint8Array.from(filterFlags[k][ci]);
      });
      for (const res of this.evaluate(d, b)) this.results.push(res);
    });
  }

  next(): boolean {
    if (this.i >= this.rowCount) return false;
    const i = this.i++;
    const r = this.r;
    const ns = this.snapRegs.length;
    const base = i * ns;
    for (let j = 0; j < ns; j++) r[this.snapRegs[j]] = this.snaps[base + j];
    for (let j = 0; j < this.outRegs.length; j++) r[this.outRegs[j]] = this.results[j][i];
    return true;
  }

  close(): void {
    // Children consumed in open() are closed here too, so an error part-way releases their pages.
    this.child.close();
    this.snaps = [];
    this.results = [];
    this.rowCount = 0;
  }

  /**
   * The input rows in window order: by partition keys, then ORDER BY keys, then input order. No sort when the input
   * already arrives in that order (a scan in rowid order under ORDER BY id); a numeric sort over a typed key array for
   * one numeric key; otherwise a comparison sort.
   */
  private sortedOrder(d: WindowDef, b: Buffered): Int32Array {
    const n = b.n;
    const np = d.partition.length;
    const no = d.order.length;
    const idx = new Int32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    if (np + no === 0 || n < 2) return idx;
    const P = b.part;
    const O = b.order;
    const pColl = d.partitionColls;
    const keyCmp = (a: number, c: number): number => {
      for (let k = 0; k < np; k++) {
        const x = cmpKey(P[a * np + k], P[c * np + k], pColl[k]);
        if (x !== 0) return x;
      }
      for (let k = 0; k < no; k++) {
        const o = d.order[k];
        const x = cmpKey(O[a * no + k], O[c * no + k], o.collation, o);
        if (x !== 0) return x;
      }
      return 0;
    };
    let sorted = true;
    for (let i = 1; i < n && sorted; i++) if (keyCmp(i - 1, i) > 0) sorted = false;
    if (sorted) return idx;
    // One key, all numbers (no NULLs, text or bigints): sort by a typed array of keys.
    if (np + no === 1) {
      const src = np === 1 ? P : O;
      const desc = np === 0 && d.order[0].desc;
      const keys = new Float64Array(n);
      let numeric = true;
      for (let i = 0; i < n; i++) {
        const v = src[i];
        if (typeof v !== 'number') {
          numeric = false;
          break;
        }
        keys[i] = desc ? -v : v;
      }
      if (numeric) return idx.sort((a, c) => keys[a] - keys[c] || a - c);
    }
    return idx.sort((a, c) => keyCmp(a, c) || a - c);
  }

  /** Compute every call of one window; returns results[call][inputRow]. */
  private evaluate(d: WindowDef, b: Buffered): SqlValue[][] {
    const n = b.n;
    const out = d.calls.map(() => new Array<SqlValue>(n).fill(null));
    if (n === 0) return out;
    const np = d.partition.length;
    const no = d.order.length;
    const P = b.part;
    const O = b.order;
    const idx = this.sortedOrder(d, b);
    const samePartition = (x: number, y: number): boolean => {
      for (let k = 0; k < np; k++) if (cmpKey(P[x * np + k], P[y * np + k], d.partitionColls[k]) !== 0) return false;
      return true;
    };
    const sameOrder = (x: number, y: number): boolean => {
      for (let k = 0; k < no; k++) if (cmpKey(O[x * no + k], O[y * no + k], d.order[k].collation) !== 0) return false;
      return true;
    };
    const frame = d.frame;
    const startOff = frame.start.offset ? offsetValue(frame.start.offset, this.r, 'starting', frame.unit) : 0;
    const endOff = frame.end.offset ? offsetValue(frame.end.offset, this.r, 'ending', frame.unit) : 0;
    const rangeOffset = frame.unit === 'RANGE' && (frame.start.offset || frame.end.offset);
    const noExclusion = frame.exclude === 'NO OTHERS';
    // The first ORDER BY key of sorted position j, as a number (RANGE offsets); null when not a number.
    const keyNum = (j: number): number | null => {
      const x = O[idx[j] * no];
      return typeof x === 'number' ? x : typeof x === 'bigint' ? Number(x) : null;
    };
    let ps = 0;
    while (ps < n) {
      let pe = ps + 1;
      if (np > 0) while (pe < n && samePartition(idx[pe], idx[ps])) pe++;
      else pe = n;
      // Peer groups: [gStart[g], gStart[g+1]); groupOf[i] for sorted position i.
      const gStart: number[] = [];
      const groupOf = new Int32Array(pe - ps);
      for (let i = ps; i < pe; i++) {
        if (i === ps || !sameOrder(idx[i], idx[i - 1])) gStart.push(i);
        groupOf[i - ps] = gStart.length - 1;
      }
      gStart.push(pe);
      const size = pe - ps;
      // RANGE with offsets: the rows with numeric keys are [nnS, nnE) (NULL and other keys sort at the ends).
      let nnS = ps;
      let nnE = pe;
      if (rangeOffset) {
        while (nnS < nnE && keyNum(nnS) === null) nnS++;
        while (nnE > nnS && keyNum(nnE - 1) === null) nnE--;
      }
      // frameAt(i) sets FS and FE: the frame of sorted position i is [FS, FE).
      let FS = 0;
      let FE = 0;
      const frameAt = (i: number): void => {
        const g = groupOf[i - ps];
        let fs: number;
        let fe: number;
        if (frame.unit === 'ROWS') {
          fs = bound(frame.start.kind, true, i, startOff, ps, pe);
          fe = bound(frame.end.kind, false, i, endOff, ps, pe);
        } else if (frame.unit === 'GROUPS' || !rangeOffset) {
          // GROUPS, or RANGE with only UNBOUNDED / CURRENT ROW bounds (peer groups).
          fs = groupBound(frame.start.kind, startOff, true, g, gStart, ps, pe);
          fe = groupBound(frame.end.kind, endOff, false, g, gStart, ps, pe);
        } else {
          const cv = keyNum(i);
          if (cv === null) {
            // NULL (or non-numeric) keys: the frame is the peer group for offset bounds.
            fs = frame.start.kind === 'unboundedPreceding' ? ps : frame.start.kind === 'unboundedFollowing' ? pe : gStart[g];
            fe = frame.end.kind === 'unboundedFollowing' ? pe : frame.end.kind === 'unboundedPreceding' ? ps : gStart[g + 1];
          } else {
            const dir = d.order[0].desc ? -1 : 1;
            fs = rangeBound(frame.start.kind, startOff, true, cv, dir, keyNum, nnS, nnE, ps, pe, gStart[g], gStart[g + 1]);
            fe = rangeBound(frame.end.kind, endOff, false, cv, dir, keyNum, nnS, nnE, ps, pe, gStart[g], gStart[g + 1]);
          }
        }
        FS = Math.max(ps, fs);
        FE = Math.min(pe, fe);
      };
      const inFrame = (i: number, j: number): boolean => {
        switch (frame.exclude) {
          case 'CURRENT ROW':
            return j !== i;
          case 'GROUP':
            return groupOf[j - ps] !== groupOf[i - ps];
          case 'TIES':
            return j === i || groupOf[j - ps] !== groupOf[i - ps];
          default:
            return true;
        }
      };
      d.calls.forEach((call, ci) => {
        const res = out[ci];
        const A = b.args[ci];
        const arity = call.args.length;
        const F = b.filter[ci];
        /** Argument a of the row at sorted position j. */
        const arg = (j: number, a: number): SqlValue => A[idx[j] * arity + a];
        switch (call.kind) {
          case 'row_number':
            for (let i = ps; i < pe; i++) res[idx[i]] = i - ps + 1;
            return;
          case 'rank':
            for (let i = ps; i < pe; i++) res[idx[i]] = gStart[groupOf[i - ps]] - ps + 1;
            return;
          case 'dense_rank':
            for (let i = ps; i < pe; i++) res[idx[i]] = groupOf[i - ps] + 1;
            return;
          case 'percent_rank':
            for (let i = ps; i < pe; i++) res[idx[i]] = size > 1 ? (gStart[groupOf[i - ps]] - ps) / (size - 1) : 0;
            return;
          case 'cume_dist':
            for (let i = ps; i < pe; i++) res[idx[i]] = (gStart[groupOf[i - ps] + 1] - ps) / size;
            return;
          case 'ntile': {
            const v = arg(ps, 0);
            // As sqlite3_value_int64(): REALs truncate, text and blobs use their leading integer, NULL is 0.
            const buckets = Number(valueInt64(v));
            if (!(buckets > 0)) throw new SmaltError('SMALT_ERROR', 'argument of ntile must be a positive integer');
            const per = Math.floor(size / buckets);
            const big = size % buckets; // the first `big` buckets get one extra row
            for (let i = ps; i < pe; i++) {
              const k = i - ps;
              res[idx[i]] = per === 0 ? k + 1 : k < big * (per + 1) ? Math.floor(k / (per + 1)) + 1 : big + Math.floor((k - big * (per + 1)) / per) + 1;
            }
            return;
          }
          case 'lag':
          case 'lead':
            if (call.ignoreNulls) {
              // The sorted positions of the partition's non-NULL values, and how many come before each row.
              const present: number[] = [];
              const before = new Int32Array(pe - ps + 1);
              for (let i = ps; i < pe; i++) {
                before[i - ps] = present.length;
                if (arg(i, 0) !== null) present.push(i);
              }
              for (let i = ps; i < pe; i++) {
                const off = arity > 1 ? toInt(arg(i, 1)) : 1;
                if (off === null) {
                  res[idx[i]] = null;
                  continue;
                }
                // lag: the off-th non-NULL value before row i; lead: the off-th after it (the row itself excluded).
                const after = before[i - ps] + (arg(i, 0) !== null ? 1 : 0);
                const k = call.kind === 'lag' ? before[i - ps] - off : after + off - 1;
                res[idx[i]] = off > 0 && k >= 0 && k < present.length ? arg(present[k], 0) : off === 0 ? arg(i, 0) : arity > 2 ? arg(i, 2) : null;
              }
              return;
            }
            for (let i = ps; i < pe; i++) {
              const off = arity > 1 ? toInt(arg(i, 1)) : 1;
              if (off === null) {
                res[idx[i]] = null;
                continue;
              }
              const j = call.kind === 'lag' ? i - off : i + off;
              res[idx[i]] = j >= ps && j < pe ? arg(j, 0) : arity > 2 ? arg(i, 2) : null;
            }
            return;
          case 'first_value':
          case 'last_value':
          case 'nth_value':
            for (let i = ps; i < pe; i++) {
              frameAt(i);
              const fs = FS;
              const fe = FE;
              let want = 1;
              if (call.kind === 'nth_value') {
                const k = toInt(arg(i, 1));
                if (k === null || k <= 0) throw new SmaltError('SMALT_ERROR', 'second argument to nth_value must be a positive integer');
                want = k;
              }
              let val: SqlValue = null;
              const counts = (j: number): boolean => (noExclusion || inFrame(i, j)) && (!call.ignoreNulls || arg(j, 0) !== null);
              if (call.ignoreNulls) {
                if (call.kind === 'last_value') {
                  for (let j = fe - 1; j >= fs; j--) {
                    if (!counts(j)) continue;
                    val = arg(j, 0);
                    break;
                  }
                } else {
                  let seen = 0;
                  for (let j = fs; j < fe; j++) {
                    if (counts(j) && ++seen === want) {
                      val = arg(j, 0);
                      break;
                    }
                  }
                }
              } else if (noExclusion) {
                // Every row of [fs, fe) is in the frame: the value is at a known position.
                if (call.kind === 'last_value') val = fe > fs ? arg(fe - 1, 0) : null;
                else val = fs + want - 1 < fe ? arg(fs + want - 1, 0) : null;
              } else if (call.kind === 'last_value') {
                for (let j = fe - 1; j >= fs; j--) {
                  if (!inFrame(i, j)) continue;
                  val = arg(j, 0);
                  break;
                }
              } else {
                let seen = 0;
                for (let j = fs; j < fe; j++) {
                  if (!inFrame(i, j)) continue;
                  if (++seen === want) {
                    val = arg(j, 0);
                    break;
                  }
                }
              }
              res[idx[i]] = val;
            }
            return;
          case 'aggregate': {
            const a = call.agg!;
            const counts = (j: number): boolean => F === null || F[idx[j]] === 1;
            // Arguments of sorted position j as an array for step/inverse; one buffer, refilled per row (states do not
            // keep it).
            const buf: SqlValue[] = new Array(arity).fill(null);
            const argsOf = (j: number): SqlValue[] => {
              if (a.star) return EMPTY;
              const base = idx[j] * arity;
              for (let k = 0; k < arity; k++) buf[k] = A[base + k];
              return buf;
            };
            const step = (j: number, st: { step(args: SqlValue[]): void; step1?(v: SqlValue): void }): void => {
              if (!counts(j)) return;
              if (arity === 1 && st.step1) st.step1(A[idx[j]]);
              else st.step(argsOf(j));
            };
            // Frames that only grow (UNBOUNDED PRECEDING start, no exclusion): one running state.
            if (frame.start.kind === 'unboundedPreceding' && noExclusion) {
              const st = a.def.create(a.argTypes, a.collation);
              let added = ps;
              for (let i = ps; i < pe; i++) {
                frameAt(i);
                while (added < FE) step(added++, st);
                res[idx[i]] = st.final();
              }
              return;
            }
            // Sliding min and max: a monotonic deque of candidates, O(1) per row on average.
            if ((call.name === 'min' || call.name === 'max') && arity === 1 && noExclusion) {
              const sign = call.name === 'max' ? 1 : -1;
              const dq = new Int32Array(size);
              let head = 0;
              let tail = 0;
              let hi = ps;
              for (let i = ps; i < pe; i++) {
                frameAt(i);
                if (FS >= hi || FE < hi) {
                  head = tail = 0;
                  hi = FS;
                }
                while (hi < FE) {
                  const j = hi++;
                  const v = arg(j, 0);
                  if (v === null || !counts(j)) continue;
                  // Drop candidates the new value beats; an equal earlier value stays first, as in min()/max().
                  while (tail > head && sign * compareValues(arg(dq[tail - 1], 0), v, a.collation) < 0) tail--;
                  dq[tail++] = j;
                }
                while (head < tail && dq[head] < FS) head++;
                res[idx[i]] = head < tail ? arg(dq[head], 0) : null;
              }
              return;
            }
            // Sliding frames (no exclusion) of an aggregate that can undo a step: one running state that removes the rows
            // leaving the frame and adds the rows entering it. Frame bounds only move forward as i grows; a frame that
            // moves back (it cannot with the frame types SQL has), or does not overlap the last one, gets a fresh state.
            const probe = a.def.create(a.argTypes, a.collation);
            if (probe.inverse && noExclusion) {
              let st = probe;
              let lo = ps;
              let hi = ps;
              for (let i = ps; i < pe; i++) {
                frameAt(i);
                const fs = FS;
                const fe = FE;
                if (fs < lo || fe < hi || fs >= hi) {
                  st = a.def.create(a.argTypes, a.collation);
                  lo = hi = fs;
                }
                // Remove first, so the running state never holds more than the overlap of two frames.
                let exact = true;
                while (lo < fs) {
                  const j = lo++;
                  if (counts(j) && !st.inverse!(argsOf(j))) exact = false;
                }
                while (hi < fe) step(hi++, st);
                if (!exact) {
                  // Rounding left by removed rows: rebuild from the rows of this frame.
                  st = a.def.create(a.argTypes, a.collation);
                  for (let j = fs; j < fe; j++) step(j, st);
                }
                res[idx[i]] = st.final();
              }
              return;
            }
            for (let i = ps; i < pe; i++) {
              frameAt(i);
              const fs = FS;
              const fe = FE;
              const st = a.def.create(a.argTypes, a.collation);
              for (let j = fs; j < fe; j++) if (inFrame(i, j)) step(j, st);
              res[idx[i]] = st.final();
            }
            return;
          }
        }
      });
      ps = pe;
    }
    return out;
  }
}

const EMPTY: SqlValue[] = [];

/** GROUPS bound (and RANGE with only UNBOUNDED / CURRENT ROW bounds): peer group g of [gStart[g], gStart[g+1]). */
function groupBound(kind: BoundKind, off: number, isStart: boolean, g: number, gStart: number[], ps: number, pe: number): number {
  const ng = gStart.length - 1;
  switch (kind) {
    case 'unboundedPreceding':
      return ps;
    case 'unboundedFollowing':
      return pe;
    case 'currentRow':
      return isStart ? gStart[g] : gStart[g + 1];
    case 'preceding': {
      const t = g - off;
      if (isStart) return gStart[Math.max(0, t)];
      return t < 0 ? ps : gStart[t + 1];
    }
    case 'following': {
      const t = g + off;
      if (isStart) return t >= ng ? pe : gStart[t];
      return gStart[Math.min(ng, t + 1)];
    }
  }
}

/**
 * RANGE bound with a numeric offset: the first sorted position (within the numeric keys [nnS, nnE), which are sorted
 * in direction `dir`) whose key is at or past (start) or past (end) the current key cv shifted by the offset. A binary
 * search: the frame of every row is found in O(log n).
 */
function rangeBound(
  kind: BoundKind,
  off: number,
  isStart: boolean,
  cv: number,
  dir: number,
  keyNum: (j: number) => number | null,
  nnS: number,
  nnE: number,
  ps: number,
  pe: number,
  peerStart: number,
  peerEnd: number,
): number {
  switch (kind) {
    case 'unboundedPreceding':
      return ps;
    case 'unboundedFollowing':
      return pe;
    case 'currentRow':
      return isStart ? peerStart : peerEnd;
  }
  const target = kind === 'preceding' ? cv - dir * off : cv + dir * off;
  // First position whose key is >= target (start) or > target (end), in sort direction.
  let lo = nnS;
  let hi = nnE;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const t = dir * (keyNum(mid)! - target);
    if (isStart ? t >= 0 : t > 0) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** ROWS bound for sorted position i: start bounds are inclusive, end bounds exclusive. */
function bound(kind: BoundKind, isStart: boolean, i: number, off: number, ps: number, pe: number): number {
  switch (kind) {
    case 'unboundedPreceding':
      return ps;
    case 'unboundedFollowing':
      return pe;
    case 'currentRow':
      return isStart ? i : i + 1;
    case 'preceding':
      return isStart ? i - off : i - off + 1;
    case 'following':
      return isStart ? i + off : i + off + 1;
  }
}

function toInt(v: SqlValue): number | null {
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v);
  return null;
}
