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

/** Per-row data for one window definition. */
interface RowData {
  part: SqlValue[];
  order: SqlValue[];
  /** Argument values per call (navigation/aggregate), evaluated in the row's context. */
  args: SqlValue[][];
  filter: boolean[];
}

function cmpKeys(a: SqlValue[], b: SqlValue[], colls: readonly Collation[], dirs?: readonly { desc: boolean; nullsFirst: boolean }[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === null || y === null) {
      if (x === y) continue;
      const nullsFirst = dirs ? dirs[i].nullsFirst : true;
      return (x === null) === nullsFirst ? -1 : 1;
    }
    const c = compareValues(x, y, colls[i]);
    if (c !== 0) return dirs?.[i].desc ? -c : c;
  }
  return 0;
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
  private snaps: SqlValue[][] = [];
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
    const snaps: SqlValue[][] = [];
    const data: RowData[][] = this.defs.map(() => []);
    const c = this.child;
    c.open(r);
    try {
      while (c.next()) {
        snaps.push(this.snapRegs.map((g) => r[g]));
        this.defs.forEach((d, k) => {
          data[k].push({
            part: d.partition.map((f) => f(r)),
            order: d.order.map((o) => o.fn(r)),
            args: d.calls.map((call) => call.args.map((f) => f(r))),
            filter: d.calls.map((call) => (call.filter ? truthy(call.filter(r)) === true : true)),
          });
        });
      }
    } finally {
      c.close();
    }
    this.snaps = snaps;
    this.results = [];
    this.defs.forEach((d, k) => {
      for (const res of this.evaluate(d, data[k])) this.results.push(res);
    });
  }

  next(): boolean {
    if (this.i >= this.snaps.length) return false;
    const i = this.i++;
    const r = this.r;
    const snap = this.snaps[i];
    for (let j = 0; j < this.snapRegs.length; j++) r[this.snapRegs[j]] = snap[j];
    for (let j = 0; j < this.outRegs.length; j++) r[this.outRegs[j]] = this.results[j][i];
    return true;
  }

  close(): void {
    // Children consumed in open() are closed here too, so an error part-way releases their pages.
    this.child.close();
    this.snaps = [];
    this.results = [];
  }

  /** Compute every call of one window; returns results[call][inputRow]. */
  private evaluate(d: WindowDef, rows: RowData[]): SqlValue[][] {
    const n = rows.length;
    const out = d.calls.map(() => new Array<SqlValue>(n).fill(null));
    if (n === 0) return out;
    const orderColls = d.order.map((o) => o.collation);
    const idx = Array.from({ length: n }, (_, i) => i);
    idx.sort((a, b) => cmpKeys(rows[a].part, rows[b].part, d.partitionColls) || cmpKeys(rows[a].order, rows[b].order, orderColls, d.order) || a - b);
    const frame = d.frame;
    const startOff = frame.start.offset ? offsetValue(frame.start.offset, this.r, 'starting', frame.unit) : 0;
    const endOff = frame.end.offset ? offsetValue(frame.end.offset, this.r, 'ending', frame.unit) : 0;
    const rangeOffset = frame.unit === 'RANGE' && (frame.start.offset || frame.end.offset);
    let ps = 0;
    while (ps < n) {
      let pe = ps + 1;
      while (pe < n && cmpKeys(rows[idx[pe]].part, rows[idx[ps]].part, d.partitionColls) === 0) pe++;
      // Peer groups: [gStart[g], gStart[g+1]); groupOf[i] for sorted position i.
      const gStart: number[] = [];
      const groupOf = new Int32Array(pe - ps);
      for (let i = ps; i < pe; i++) {
        if (i === ps || cmpKeys(rows[idx[i]].order, rows[idx[i - 1]].order, orderColls) !== 0) gStart.push(i);
        groupOf[i - ps] = gStart.length - 1;
      }
      gStart.push(pe);
      const size = pe - ps;
      const frameOf = (i: number): [number, number] => {
        const g = groupOf[i - ps];
        let fs: number;
        let fe: number;
        if (frame.unit === 'ROWS') {
          fs = bound(frame.start.kind, true, i, startOff, ps, pe);
          fe = bound(frame.end.kind, false, i, endOff, ps, pe);
        } else if (frame.unit === 'GROUPS' || !rangeOffset) {
          // GROUPS, or RANGE with only UNBOUNDED / CURRENT ROW bounds (peer groups).
          const ng = gStart.length - 1;
          const gb = (kind: BoundKind, off: number, isStart: boolean): number => {
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
          };
          fs = gb(frame.start.kind, startOff, true);
          fe = gb(frame.end.kind, endOff, false);
        } else {
          [fs, fe] = rangeFrame(frame, rows, idx, i, ps, pe, startOff, endOff, d.order[0], gStart[g], gStart[g + 1]);
        }
        return [Math.max(ps, fs), Math.min(pe, fe)];
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
            const v = rows[idx[ps]].args[ci][0];
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
            for (let i = ps; i < pe; i++) {
              const a = rows[idx[i]].args[ci];
              const off = a.length > 1 ? toInt(a[1]) : 1;
              if (off === null) {
                res[idx[i]] = null;
                continue;
              }
              const j = call.kind === 'lag' ? i - off : i + off;
              res[idx[i]] = j >= ps && j < pe ? rows[idx[j]].args[ci][0] : a.length > 2 ? a[2] : null;
            }
            return;
          case 'first_value':
          case 'last_value':
          case 'nth_value':
            for (let i = ps; i < pe; i++) {
              const [fs, fe] = frameOf(i);
              let want = 1;
              if (call.kind === 'nth_value') {
                const nv = rows[idx[i]].args[ci][1];
                const k = toInt(nv);
                if (k === null || k <= 0) throw new SmaltError('SMALT_ERROR', 'second argument to nth_value must be a positive integer');
                want = k;
              }
              let seen = 0;
              let val: SqlValue = null;
              if (call.kind === 'last_value') {
                for (let j = fe - 1; j >= fs; j--) {
                  if (!inFrame(i, j)) continue;
                  val = rows[idx[j]].args[ci][0];
                  break;
                }
              } else {
                for (let j = fs; j < fe; j++) {
                  if (!inFrame(i, j)) continue;
                  if (++seen === want) {
                    val = rows[idx[j]].args[ci][0];
                    break;
                  }
                }
              }
              res[idx[i]] = val;
            }
            return;
          case 'aggregate': {
            const a = call.agg!;
            const step = (j: number, st: { step(args: SqlValue[]): void }): void => {
              const row = rows[idx[j]];
              if (!row.filter[ci]) return;
              st.step(a.star ? [] : row.args[ci]);
            };
            // Frames that only grow (UNBOUNDED PRECEDING start, no exclusion): one running state.
            if (frame.start.kind === 'unboundedPreceding' && frame.exclude === 'NO OTHERS') {
              const st = a.def.create(a.argTypes, a.collation);
              let added = ps;
              for (let i = ps; i < pe; i++) {
                const [, fe] = frameOf(i);
                while (added < fe) step(added++, st);
                res[idx[i]] = st.final();
              }
              return;
            }
            for (let i = ps; i < pe; i++) {
              const [fs, fe] = frameOf(i);
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

/** RANGE frame with numeric offsets: rows whose single ORDER BY key lies within the offsets. */
function rangeFrame(
  frame: FrameSpec,
  rows: RowData[],
  idx: number[],
  i: number,
  ps: number,
  pe: number,
  startOff: number,
  endOff: number,
  key: { desc: boolean },
  peerStart: number,
  peerEnd: number,
): [number, number] {
  const v = rows[idx[i]].order[0];
  const num = (x: SqlValue): number | null => (typeof x === 'number' ? x : typeof x === 'bigint' ? Number(x) : null);
  const cv = num(v);
  // NULL (or non-numeric) keys: the frame is the peer group for offset bounds.
  if (cv === null) {
    const fs = frame.start.kind === 'unboundedPreceding' ? ps : frame.start.kind === 'unboundedFollowing' ? pe : peerStart;
    const fe = frame.end.kind === 'unboundedFollowing' ? pe : frame.end.kind === 'unboundedPreceding' ? ps : peerEnd;
    return [fs, fe];
  }
  const dir = key.desc ? -1 : 1;
  // Rows with NULL keys sit at one end of the partition and are never within an offset of a value.
  let nnS = ps;
  let nnE = pe;
  while (nnS < nnE && num(rows[idx[nnS]].order[0]) === null) nnS++;
  while (nnE > nnS && num(rows[idx[nnE - 1]].order[0]) === null) nnE--;
  // Position of a row's key relative to (cv + delta) in sort direction.
  const lo = (target: number): number => {
    // First position whose key is >= target in sort order (NULLs sort before/after per nulls ordering; treat as out of range).
    for (let j = nnS; j < nnE; j++) {
      const x = num(rows[idx[j]].order[0])!;
      if (dir * (x - target) >= 0) return j;
    }
    return nnE;
  };
  const hi = (target: number): number => {
    // First position whose key is > target in sort order.
    for (let j = nnS; j < nnE; j++) {
      const x = num(rows[idx[j]].order[0])!;
      if (dir * (x - target) > 0) return j;
    }
    return nnE;
  };
  const at = (kind: BoundKind, off: number, isStart: boolean): number => {
    switch (kind) {
      case 'unboundedPreceding':
        return ps;
      case 'unboundedFollowing':
        return pe;
      case 'currentRow':
        return isStart ? peerStart : peerEnd;
      case 'preceding':
        return isStart ? lo(cv - dir * off) : hi(cv - dir * off);
      case 'following':
        return isStart ? lo(cv + dir * off) : hi(cv + dir * off);
    }
  };
  return [at(frame.start.kind, startOff, true), at(frame.end.kind, endOff, false)];
}

function toInt(v: SqlValue): number | null {
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v);
  return null;
}
