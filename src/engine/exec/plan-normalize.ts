/**
 * Plans from outside a language (ADR 0015 step 8: `Database.preparePlan`) in the layering the physical planner reads.
 * The planner plans a query block as SQL builds one: LIMIT, ORDER BY, DISTINCT, the projection, windows, HAVING, the
 * aggregate, WHERE, then a left-deep tree of FROM items (exec/planner.ts `flatShape`), with VALUES and compounds
 * under ORDER BY and LIMIT. A builder may write any valid plan: a sort straight over an aggregate, a filter or a scan
 * as the whole plan. Each block is filled in with identity projections where a layer is missing, and any other
 * operation becomes a nested FROM item, as SQL's FROM subqueries are. The result has the same rows and columns.
 *
 * SQL's plans have this layering already and are not normalized.
 */
import { eachParts, lit, mapEach, type PlanExpr, typeOf } from '../plan/expr.js';
import type { AggCall, PlanOp, SortKey, WindowCall } from '../plan/ops.js';
import { SmaltError } from '../errors.js';
import { planWidth } from './planner.js';
import { parseNested } from '../../shared/nested-types.js';
import type { PlanType } from '../plan/types.js';

type Op<K extends PlanOp['op']> = Extract<PlanOp, { op: K }>;

/** `op` as a query block the planner reads. */
export function normalizePlan(op: PlanOp): PlanOp {
  return block(rewrite(op));
}

/**
 * `op` with the operations the planner does not plan itself rewritten into ones it does: semi and anti joins
 * (`semiJoin`), and the orders asked for with `ordered` (`orderedJoin`, `orderedGroups`). Plans are plain data, so this
 * walks every field (inputs, and plans nested in any expression) and copies only what changes: a plan without such
 * operations comes back as it was.
 */
function rewrite(op: PlanOp): PlanOp {
  return rewriteAll(op) as PlanOp;
}

function rewriteAll(x: unknown): unknown {
  if (x === null || typeof x !== 'object' || ArrayBuffer.isView(x)) return x; // data (values' columns, blobs) holds no plans
  if (Array.isArray(x)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < x.length; i++) {
      const r = rewriteAll(x[i]);
      if (r !== x[i]) (out ??= x.slice())[i] = r;
    }
    return out ?? x;
  }
  const o = x as Record<string, unknown>;
  if (o.k === 'native') return x;
  let out: Record<string, unknown> | undefined;
  for (const key in o) {
    if (key === 'origin') continue; // a caller's data, whatever its shape
    const r = rewriteAll(o[key]);
    if (r !== o[key]) (out ??= { ...o })[key] = r;
  }
  const op = (out ?? o) as unknown as PlanOp;
  switch (op.op) {
    case 'join':
      if (op.kind === 'asof') return rewriteAll(asofJoin(op));
      return op.kind === 'semi' || op.kind === 'anti' ? semiJoin(op) : op.ordered ? orderedJoin(op) : op;
    case 'aggregate': {
      const positioned = firstLast(op);
      return positioned.ordered ? orderedGroups(positioned) : positioned;
    }
    case 'distinct':
      return op.on || op.keep ? keptRows(op) : op.ordered ? orderedGroups(distinctGroups(op)) : op;
    case 'limit':
      return op.fromEnd ? fromEnd(op) : op;
    case 'sample':
      // Its rewrite holds windows and, with replacement, an ordered join: rewritten in turn.
      return rewriteAll(sampleRows(op));
    case 'pivot':
      // Its rewrite is an aggregate, which may be ordered: rewritten in turn.
      return rewriteAll(pivotGroups(op));
    case 'unpivot':
      // Its rewrite is an ordered join: rewritten in turn.
      return rewriteAll(unpivotRows(op));
    case 'explode':
      // Its rewrite is an ordered join: rewritten in turn.
      return rewriteAll(explodeRows(op));
    default:
      return op;
  }
}

/**
 * `semi(L, R, on)` is L where some row of R matches (`exists`), `anti` where none does. A filter keeps L's order (ADR
 * 0016 section 4), and the planner decorrelates the subquery into a hash semi-join where it can.
 */
function semiJoin(op: Op<'join'>): PlanOp {
  const [left, right] = op.inputs;
  // In the layering the planner reads: a write's input is not normalized past its own operation.
  const inner = block(op.on ? { op: 'filter', input: right, pred: correlated(op.on, 0) } : right);
  const exists: PlanExpr = { k: 'subquery', mode: 'exists', plan: inner, type: 'int', collation: 'binary' };
  const pred: PlanExpr = op.kind === 'semi' ? exists : { k: 'not', arg: exists };
  return { op: 'filter', input: left, pred, ...(op.origin !== undefined ? { origin: op.origin } : {}) };
}

const ROW_NUMBER: WindowCall = { fn: 'row_number', args: [], star: false, collation: 'binary', type: 'int' };
const WHOLE: Op<'window'>['frame'] = { unit: 'ROWS', start: { kind: 'unboundedPreceding' }, end: { kind: 'currentRow' }, exclude: 'NO OTHERS' };

/** `input` with each row's position appended (1, 2, …): a window without its own order keeps its input's order. */
function numbered(input: PlanOp): PlanOp {
  return { op: 'window', input, partition: [], order: [], frame: WHOLE, calls: [ROW_NUMBER] };
}

const column = (index: number, type: 'int' | 'text' | 'any' = 'any'): PlanExpr => ({ k: 'col', input: 0, index, depth: 0, type, collation: 'binary' });
const range = (from: number, to: number): PlanExpr[] => Array.from({ length: to - from }, (_, i) => column(from + i));
/** `op` without its `ordered` flag. */
function unordered<T extends { ordered?: unknown }>(op: T): T {
  const { ordered: _, ...rest } = op;
  return rest as T;
}

/**
 * A join that keeps the left input's order, and for each left row its matches in the right input's order: both inputs
 * numbered, joined, then sorted by the numbers (stable, so rows without a left number, a right or full join's unmatched
 * right rows, come last in the right input's order), and the numbers dropped.
 */
function orderedJoin(op: Op<'join'>): PlanOp {
  const [left, right] = op.inputs;
  // A lateral source (a table function whose arguments read the left row, as `explode`'s `list_elements`) is joined
  // after the left input and run once per left row, so its rows already come in the left order, then its own:
  // numbering it would put a window between it and the row its arguments read.
  if ((op.kind === 'inner' || op.kind === 'left' || op.kind === 'cross') && right.op === 'source' && right.args.some(readsInput)) return unordered(op);
  const l = planWidth(left);
  const r = planWidth(right);
  const joined: PlanOp = { ...unordered(op), inputs: [numbered(left), numbered(right)] };
  const keys: SortKey[] = [
    { expr: column(l, 'int'), desc: false, nullsFirst: false, collation: 'binary' },
    { expr: column(l + 1 + r, 'int'), desc: false, nullsFirst: true, collation: 'binary' },
  ];
  return { op: 'project', input: { op: 'sort', input: joined, keys }, exprs: [...range(0, l), ...range(l + 1, l + 1 + r)] };
}

/** Whether `e` reads a column of the operation's own input (depth 0), outside any nested plan. */
function readsInput(e: PlanExpr): boolean {
  switch (e.k) {
    case 'col':
      return e.depth === 0;
    case 'call':
      return e.args.some(readsInput);
    case 'cast':
    case 'not':
    case 'isNull':
      return readsInput(e.arg);
    case 'and':
    case 'or':
      return e.args.some(readsInput);
    case 'case':
      return e.whens.some((w) => readsInput(w.when) || readsInput(w.then)) || readsInput(e.else);
    case 'each':
      return eachParts(e).some(readsInput);
    default:
      return false;
  }
}

const call = (fn: string, args: PlanExpr[] = [], star = false): WindowCall => ({ fn, args, star, collation: 'binary', type: 'int' });
const cmp = (fn: string, a: PlanExpr, b: PlanExpr): PlanExpr => ({ k: 'call', fn, args: [a, b], type: 'int' });
const minus = (a: PlanExpr, b: PlanExpr): PlanExpr => ({ k: 'call', fn: 'sub', args: [a, b], type: 'int' });
const EVERY_ROW: Op<'window'>['frame'] = { ...WHOLE, end: { kind: 'unboundedFollowing' } };

/** `first` and `last` calls by input order: the input numbered, and each call given the row's number as its last key. */
function firstLast(op: Op<'aggregate'>): Op<'aggregate'> {
  if (!op.aggs.some((a) => a.fn === 'first' || a.fn === 'last')) return op;
  const pos = column(planWidth(op.input), 'int');
  const aggs = op.aggs.map((a) => (a.fn === 'first' || a.fn === 'last' ? { ...a, args: [...a.args, pos] } : a));
  return { ...op, input: numbered(op.input), aggs };
}

/** The last `count` rows before the last `offset`: the input numbered and counted, and the rows in that range kept. */
function fromEnd(op: Op<'limit'>): PlanOp {
  const w = planWidth(op.input);
  const pos = column(w, 'int');
  const end = minus(column(w + 1, 'int'), op.offset ?? { k: 'lit', value: 0, type: 'int' });
  // A negative count, as in a limit from the start, takes every row.
  const after: PlanExpr = { k: 'or', args: [cmp('cmp_lt', op.count, { k: 'lit', value: 0, type: 'int' }), cmp('cmp_gt', pos, minus(end, op.count))] };
  const counted: PlanOp = { op: 'window', input: op.input, partition: [], order: [], frame: EVERY_ROW, calls: [ROW_NUMBER, call('count', [], true)] };
  const kept: PlanOp = { op: 'filter', input: counted, pred: { k: 'and', args: [cmp('cmp_le', pos, end), after] } };
  return { op: 'project', input: kept, exprs: range(0, w) };
}

/**
 * A distinct that keeps one row of each set of duplicates, by the columns `on`: the input numbered, each set's first
 * and last numbers taken over its rows, and the row with the one asked for kept (the first without `keep`). The kept
 * rows come in input order, or with `ordered: 'first'` in the order of each set's first row.
 */
function keptRows(op: Op<'distinct'>): PlanOp {
  const w = planWidth(op.input);
  const on = op.on ?? op.collations.map((_c, i) => i);
  const partition = on.map((i) => ({ expr: column(i), collation: op.collations[i] }));
  const pos = column(w, 'int');
  const sets: PlanOp = { op: 'window', input: numbered(op.input), partition, order: [], frame: EVERY_ROW, calls: [call('min', [pos]), call('max', [pos])] };
  let kept: PlanOp = { op: 'filter', input: sets, pred: cmp('cmp_eq', pos, column(op.keep === 'last' ? w + 2 : w + 1, 'int')) };
  if (op.ordered) kept = { op: 'sort', input: kept, keys: [{ expr: column(w + 1, 'int'), desc: false, nullsFirst: false, collation: 'binary' }] };
  return { op: 'project', input: kept, exprs: range(0, w) };
}

/** Ids for the `iterate` operations rewrites make (above any a plan is likely to use). */
let rewriteIterates = 2 ** 30;

/**
 * A sample. Without replacement: the input numbered and counted, ranked by a value fixed by the seed and each row's
 * position (`random_at`), the first `count` (or `fraction` × the count) kept, and the input order restored. With it:
 * that many draws (an `iterate` counting them), each the row at a position fixed by the seed and the draw's number,
 * joined in the order drawn.
 */
function sampleRows(op: Op<'sample'>): PlanOp {
  const w = planWidth(op.input);
  const at = (e: PlanExpr): PlanExpr => ({ k: 'call', fn: 'random_at', args: [{ k: 'lit', value: op.seed, type: 'int' }, e], type: 'real' });
  const mul = (a: PlanExpr, b: PlanExpr): PlanExpr => ({ k: 'call', fn: 'mul', args: [a, b], type: 'any' });
  const add1 = (e: PlanExpr): PlanExpr => ({ k: 'call', fn: 'add', args: [e, { k: 'lit', value: 1, type: 'int' }], type: 'any' });
  const pos = column(w, 'int');
  if (!op.replace) {
    const counted: PlanOp = { op: 'window', input: op.input, partition: [], order: [], frame: EVERY_ROW, calls: [ROW_NUMBER, call('count', [], true)] };
    const ranked: PlanOp = { op: 'window', input: counted, partition: [], order: [{ expr: at(pos), desc: false, nullsFirst: false, collation: 'binary' }], frame: WHOLE, calls: [ROW_NUMBER] };
    const n = op.count ?? mul(op.fraction!, column(w + 1, 'int'));
    const kept: PlanOp = { op: 'filter', input: ranked, pred: cmp('cmp_le', column(w + 2, 'int'), n) };
    const inOrder: PlanOp = { op: 'sort', input: kept, keys: [{ expr: pos, desc: false, nullsFirst: false, collation: 'binary' }] };
    return { op: 'project', input: inOrder, exprs: range(0, w), ...(op.origin !== undefined ? { origin: op.origin } : {}) };
  }
  const total: PlanExpr = { k: 'subquery', mode: 'scalar', plan: { op: 'aggregate', input: op.input, keys: [], aggs: [{ fn: 'count', args: [], star: true, distinct: false, collation: 'binary', type: 'int' }], carry: [] }, type: 'int', collation: 'binary' };
  const n = op.count ?? mul(op.fraction!, total);
  const id = rewriteIterates++;
  const zero: PlanExpr = { k: 'lit', value: 0, type: 'int' };
  const draws: PlanOp = {
    op: 'iterate',
    id,
    name: 'sample',
    init: { op: 'filter', input: { op: 'values', rows: [[zero]], types: ['int'] }, pred: cmp('cmp_lt', zero, n) },
    steps: [{ op: 'filter', input: { op: 'project', input: { op: 'working', id, types: ['int'] }, exprs: [add1(column(0, 'int'))] }, pred: cmp('cmp_lt', column(0, 'int'), n) }],
    distinct: false,
    collations: ['binary'],
  };
  // Each draw: its number, and the position of the row it takes (1 … the count).
  const targets: PlanOp = { op: 'project', input: draws, exprs: [column(0, 'int'), add1({ k: 'call', fn: 'floor', args: [mul(at(column(0, 'int')), total)], type: 'any' })] };
  const on = cmp('cmp_eq', column(1, 'int'), { k: 'col', input: 1, index: w, depth: 0, type: 'int', collation: 'binary' });
  const joined: PlanOp = { op: 'join', kind: 'inner', inputs: [targets, numbered(op.input)], on, ordered: true };
  return { op: 'project', input: joined, exprs: range(2, 2 + w), ...(op.origin !== undefined ? { origin: op.origin } : {}) };
}

/** A pivot as an aggregate whose calls each read the rows of one value of `on` (a filter beside the call's own). */
function pivotGroups(op: Op<'pivot'>): PlanOp {
  const aggs = op.values.flatMap((v) => {
    const match: PlanExpr = v === null ? { k: 'isNull', arg: op.on, not: false } : { k: 'call', fn: 'cmp_eq', args: [op.on, lit(v)], type: 'int', collation: op.collation };
    return op.aggs.map((a) => ({ ...a, filter: a.filter ? { k: 'and' as const, args: [a.filter, match] } : match }));
  });
  return { op: 'aggregate', input: op.input, keys: op.keys, aggs, carry: [], ...(op.ordered ? { ordered: op.ordered } : {}), ...(op.origin !== undefined ? { origin: op.origin } : {}) };
}

/**
 * An unpivot as the input crossed with one row per column (its position and name), in order (an ordered join keeps
 * the input's order, then the columns'), each output row taking its column's value.
 */
function unpivotRows(op: Op<'unpivot'>): PlanOp {
  const w = planWidth(op.input);
  const which: PlanOp = { op: 'values', rows: op.names.map((n, k) => [{ k: 'lit', value: k, type: 'int' }, { k: 'lit', value: n, type: 'text' }]), types: ['int', 'text'] };
  const crossed: PlanOp = { op: 'join', kind: 'cross', inputs: [op.input, which], ordered: true };
  const value: PlanExpr = {
    k: 'case',
    whens: op.columns.map((c, k) => ({ when: cmp('cmp_eq', column(w, 'int'), { k: 'lit', value: k, type: 'int' }), then: column(c) })),
    else: { k: 'lit', value: null, type: 'any' },
    type: op.type,
  };
  return { op: 'project', input: crossed, exprs: [...op.keep.map((i) => column(i)), column(w + 1, 'text'), value], ...(op.origin !== undefined ? { origin: op.origin } : {}) };
}

/**
 * `explode` (ADR 0020 step 3) as a lateral join of its input with `list_elements` of the list column (ADR 0031, section
 * 2): each input row, then its elements in order, the element in the list's place. The join is ordered, so rows keep
 * the input's order and then the list's; `list_elements` gives the empty and NULL lists' rows the options keep. One
 * decode per list, no sort.
 */
function explodeRows(op: Op<'explode'>): PlanOp {
  const w = planWidth(op.input);
  const n = parseNested(op.type);
  const element = (n && n.kind === 'list' ? n.of : 'any') as PlanType;
  const column = (index: number, type: PlanType): PlanExpr => ({ k: 'col', input: 0, index, depth: 0, type, collation: 'binary' });
  const also = op.also ?? [];
  // Lists zipped with it: the source reads its list once their lengths are checked, and each row reads their element
  // at the source's position.
  // The check's errors name where the explode came from, as its other errors do.
  const list: PlanExpr = also.length
    ? { k: 'call', fn: 'list_same_lengths', args: [column(op.column, op.type), ...also.map((a) => column(a.column, a.type))], type: op.type, ...(op.origin !== undefined ? { origin: op.origin } : {}) }
    : column(op.column, op.type);
  const flag = (on: boolean): PlanExpr => ({ k: 'lit', value: on ? 1 : 0, type: 'int' });
  const elements: PlanOp = { op: 'source', kind: 'function', name: 'list_elements', args: [list, flag(!!op.emptyAsNull), flag(op.keepNulls !== false)], types: [element, 'int'] };
  const joined: PlanOp = { op: 'join', kind: 'inner', inputs: [op.input, elements], ordered: true };
  const zipped = new Map(also.map((a) => [a.column, a.type]));
  const exprs = range(0, w).map((e, i): PlanExpr => {
    if (i === op.column) return column(w, element);
    const t = zipped.get(i);
    if (t === undefined) return e;
    const m = parseNested(t);
    return { k: 'call', fn: 'list_get', args: [column(i, t), column(w + 1, 'int')], type: (m && m.kind === 'list' ? m.of : 'any') as PlanType };
  });
  if (op.position) exprs.push({ k: 'col', input: 0, index: w + 1, depth: 0, type: 'int', collation: 'binary' });
  return { op: 'project', input: joined, exprs, ...(op.origin !== undefined ? { origin: op.origin } : {}) };
}

/**
 * An as-of join as the left input (numbered) left-joined to the right rows its match allows, the best of them per left
 * row ranked by a window (closest key first), the left order restored, and the numbers dropped.
 */
function asofJoin(op: Op<'join'>): PlanOp {
  const m = op.asof!;
  const [left, right] = op.inputs;
  const l = planWidth(left);
  const r = planWidth(right);
  const lk = m.left;
  const rk = m.right;
  const conds: PlanExpr[] = [];
  if (op.on) conds.push(op.on);
  const distance = (a: PlanExpr, b: PlanExpr): PlanExpr => minus(a, b);
  if (m.direction === 'backward') conds.push(cmp('cmp_le', rk, lk));
  if (m.direction === 'forward') conds.push(cmp('cmp_ge', rk, lk));
  if (m.direction === 'nearest') conds.push({ k: 'isNull', arg: minus(lk, rk), not: true });
  if (m.tolerance) {
    const gap: PlanExpr = m.direction === 'backward' ? distance(lk, rk) : m.direction === 'forward' ? distance(rk, lk) : { k: 'call', fn: 'abs', args: [minus(lk, rk)], type: 'any' };
    conds.push(cmp('cmp_le', gap, m.tolerance));
  }
  // The joined row: the left columns, its number (at l), then the right columns (from l + 1).
  const joined: PlanOp = { op: 'join', kind: 'left', inputs: [numbered(left), right], on: conds.length === 1 ? conds[0] : { k: 'and', args: conds } };
  const shiftRight = (e: PlanExpr): PlanExpr => joinedColumns(e, l + 1);
  const lkJ = joinedColumns(lk, l + 1);
  const rkJ = shiftRight(rk);
  const order: SortKey[] =
    m.direction === 'backward'
      ? [{ expr: rkJ, desc: true, nullsFirst: false, collation: 'binary' }]
      : m.direction === 'forward'
        ? [{ expr: rkJ, desc: false, nullsFirst: false, collation: 'binary' }]
        : [
            { expr: { k: 'call', fn: 'abs', args: [minus(lkJ, rkJ)], type: 'any' }, desc: false, nullsFirst: false, collation: 'binary' },
            { expr: rkJ, desc: false, nullsFirst: false, collation: 'binary' },
          ];
  const width = l + 1 + r;
  const ranked: PlanOp = { op: 'window', input: joined, partition: [{ expr: column(l, 'int'), collation: 'binary' }], order, frame: WHOLE, calls: [ROW_NUMBER] };
  const best: PlanOp = { op: 'filter', input: ranked, pred: cmp('cmp_eq', column(width, 'int'), { k: 'lit', value: 1, type: 'int' }) };
  const inOrder: PlanOp = { op: 'sort', input: best, keys: [{ expr: column(l, 'int'), desc: false, nullsFirst: false, collation: 'binary' }] };
  return { op: 'project', input: inOrder, exprs: [...range(0, l), ...range(l + 1, l + 1 + r)], ...(op.origin !== undefined ? { origin: op.origin } : {}) };
}

/** A join expression (input 0 the left, 1 the right) over the joined row: the right's columns from `at`. */
function joinedColumns(e: PlanExpr, at: number): PlanExpr {
  switch (e.k) {
    case 'col':
      return e.depth === 0 && e.input === 1 ? { ...e, input: 0, index: e.index + at } : e;
    case 'call':
    case 'and':
    case 'or':
      return { ...e, args: e.args.map((a) => joinedColumns(a, at)) };
    case 'cast':
    case 'not':
    case 'isNull':
      return { ...e, arg: joinedColumns(e.arg, at) };
    case 'case':
      return { ...e, whens: e.whens.map((w) => ({ when: joinedColumns(w.when, at), then: joinedColumns(w.then, at) })), else: joinedColumns(e.else, at) };
    case 'subquery':
    case 'inSubquery':
      throw new SmaltError('SMALT_UNSUPPORTED', 'an asof join whose keys hold a subquery is not supported yet');
    case 'each':
      return mapEach(e, (x) => joinedColumns(x, at));
    default:
      return e;
  }
}

/** A distinct as an aggregate grouped by every column, with no aggregate calls. */
function distinctGroups(op: Op<'distinct'>): Op<'aggregate'> {
  const keys = op.collations.map((collation, i) => ({ expr: column(i), collation }));
  return { op: 'aggregate', input: op.input, keys, aggs: [], carry: [], ordered: 'first' };
}

/**
 * Groups in the order of their first row: the input numbered, each group's first number taken with the group, the
 * groups sorted by it, and it dropped. With carried columns the number is an extra key, computed over each group's rows
 * by a window, since one more aggregate call would change which row they are carried from.
 */
function orderedGroups(op: Op<'aggregate'>): PlanOp {
  const plain = unordered(op);
  if (op.keys.length === 0) return plain;
  const w = planWidth(op.input);
  const k = op.keys.length;
  const a = op.aggs.length;
  const first = column(w, 'int');
  let grouped: PlanOp;
  let at: number;
  if (op.carry.length === 0) {
    const min: AggCall = { fn: 'min', args: [first], star: false, distinct: false, collation: 'binary', type: 'int' };
    grouped = { ...plain, input: numbered(op.input), aggs: [...op.aggs, min] };
    at = k + a;
  } else {
    const minOver: WindowCall = { fn: 'min', args: [first], star: false, collation: 'binary', type: 'int' };
    const input: PlanOp = { op: 'window', input: numbered(op.input), partition: op.keys, order: [], frame: { ...WHOLE, end: { kind: 'unboundedFollowing' } }, calls: [minOver] };
    grouped = { ...plain, input, keys: [...op.keys, { expr: column(w + 1, 'int'), collation: 'binary' }] };
    at = k;
  }
  const width = k + a + op.carry.length + 1;
  const keys: SortKey[] = [{ expr: column(at, 'int'), desc: false, nullsFirst: false, collation: 'binary' }];
  return { op: 'project', input: { op: 'sort', input: grouped, keys }, exprs: [...range(0, at), ...range(at + 1, width)] };
}

/**
 * A join condition read from inside a subquery over the join's right input: the left input's columns one evaluation
 * out, the right input's the subquery's own, and references further out one further.
 */
function correlated(e: PlanExpr, depth: number): PlanExpr {
  switch (e.k) {
    case 'col':
      if (e.depth > depth) return { ...e, depth: e.depth + 1 };
      if (e.depth < depth) return e;
      return e.input === 0 ? { ...e, depth: e.depth + 1 } : { ...e, input: 0 };
    case 'call':
    case 'and':
    case 'or':
      return { ...e, args: e.args.map((a) => correlated(a, depth)) };
    case 'cast':
    case 'not':
    case 'isNull':
      return { ...e, arg: correlated(e.arg, depth) };
    case 'case':
      return { ...e, whens: e.whens.map((w) => ({ when: correlated(w.when, depth), then: correlated(w.then, depth) })), else: correlated(e.else, depth) };
    case 'subquery':
    case 'inSubquery':
      throw new SmaltError('SMALT_UNSUPPORTED', 'a semi or anti join whose condition holds a subquery is not supported yet');
    case 'each':
      return mapEach(e, (x) => correlated(x, depth));
    default:
      return e;
  }
}

/** A write's plan with its input normalized (an `append`'s rows; `update` and `delete` read their targets as given). */
export function normalizeWrite(plan: PlanOp): PlanOp {
  const op = rewrite(plan);
  return op.op === 'append' && op.input ? { ...op, input: block(op.input) } : op;
}

/** LIMIT? ORDER BY? then a compound, VALUES, or DISTINCT? over a projected core. */
function block(op: PlanOp): PlanOp {
  if (op.op === 'limit') return { ...op, count: expr(op.count), ...(op.offset ? { offset: expr(op.offset) } : {}), input: sorted(op.input) };
  return sorted(op);
}

function sorted(op: PlanOp): PlanOp {
  if (op.op === 'project' && op.input.op === 'sort') return projectedSort(op, op.input);
  if (op.op === 'sort') {
    const inner = op.input;
    // A sort over a compound or VALUES stays; over anything else it needs a projection under it (or a DISTINCT over one).
    const below = inner.op === 'setop' || inner.op === 'values' ? body(inner) : distinctProjected(inner);
    return { ...op, keys: op.keys.map((k) => ({ ...k, expr: expr(k.expr) })), input: below };
  }
  return body(op);
}

function body(op: PlanOp): PlanOp {
  if (op.op === 'setop') return { ...op, inputs: [block(op.inputs[0]), block(op.inputs[1])] };
  if (op.op === 'values') return { ...op, rows: op.rows.map((r) => r.map(expr)) };
  return distinctProjected(op);
}

function distinctProjected(op: PlanOp): PlanOp {
  if (op.op === 'distinct') return { ...op, input: projected(op.input) };
  return projected(op);
}

function projected(op: PlanOp): PlanOp {
  if (op.op === 'project') return { ...op, exprs: op.exprs.map(expr), input: core(op.input) };
  return { op: 'project', exprs: identity(op), input: core(op) };
}

/**
 * A projection of sorted rows keeps their order. As SQL plans ORDER BY on expressions that are not results: project
 * the results and the sorted input's columns, sort on those columns, then keep the results.
 */
function projectedSort(op: Op<'project'>, s: Op<'sort'>): PlanOp {
  const m = op.exprs.length;
  // Sort keys with subqueries would need their correlated columns moved too: plan those as a nested block.
  if (s.keys.some((k) => hasSubquery(k.expr))) return body(op);
  const all: PlanExpr[] = [...op.exprs, ...identity(s.input)];
  const keys = s.keys.map((k) => ({ ...k, expr: expr(shift(k.expr, m)) }));
  const results = op.exprs.map((e, i): PlanExpr => ({ k: 'col', input: 0, index: i, depth: 0, type: typeOf(e), collation: 'binary' }));
  return { op: 'project', exprs: results, input: { ...s, keys, input: distinctProjected({ op: 'project', exprs: all, input: s.input }) } };
}

/** `e` reading column `i + by` where it read column `i` of its own input. */
function shift(e: PlanExpr, by: number): PlanExpr {
  switch (e.k) {
    case 'col':
      return e.depth === 0 && e.input === 0 ? { ...e, index: e.index + by } : e;
    case 'call':
    case 'and':
    case 'or':
      return { ...e, args: e.args.map((a) => shift(a, by)) };
    case 'cast':
    case 'not':
    case 'isNull':
      return { ...e, arg: shift(e.arg, by) };
    case 'case':
      return { ...e, whens: e.whens.map((w) => ({ when: shift(w.when, by), then: shift(w.then, by) })), else: shift(e.else, by) };
    case 'each':
      return mapEach(e, (x) => shift(x, by));
    default:
      return e;
  }
}

/** Whether a window's expressions read a column at `width` or past it: one its input window computes. */
function readsWindowResult(op: Op<'window'>, width: number): boolean {
  const es = [...op.partition.map((p) => p.expr), ...op.order.map((k) => k.expr), ...op.calls.flatMap((c) => (c.filter ? [...c.args, c.filter] : c.args))];
  return es.some((e) => readsFrom(e, width));
}

function readsFrom(e: PlanExpr, width: number): boolean {
  switch (e.k) {
    case 'col':
      return e.depth === 0 && e.input === 0 && e.index >= width;
    case 'call':
    case 'and':
    case 'or':
      return e.args.some((a) => readsFrom(a, width));
    case 'cast':
    case 'not':
    case 'isNull':
      return readsFrom(e.arg, width);
    case 'case':
      return e.whens.some((w) => readsFrom(w.when, width) || readsFrom(w.then, width)) || readsFrom(e.else, width);
    case 'each':
      return eachParts(e).some((x) => readsFrom(x, width));
    default:
      return false;
  }
}

function hasSubquery(e: PlanExpr): boolean {
  switch (e.k) {
    case 'subquery':
    case 'inSubquery':
      return true;
    case 'call':
    case 'and':
    case 'or':
      return e.args.some(hasSubquery);
    case 'cast':
    case 'not':
    case 'isNull':
      return hasSubquery(e.arg);
    case 'case':
      return e.whens.some((w) => hasSubquery(w.when) || hasSubquery(w.then)) || hasSubquery(e.else);
    case 'each':
      return eachParts(e).some(hasSubquery);
    default:
      return false;
  }
}

/** Windows, HAVING over an aggregate, the aggregate, WHERE, then the FROM items. */
function core(op: PlanOp): PlanOp {
  if (op.op === 'window') {
    return {
      ...op,
      partition: op.partition.map((p) => ({ ...p, expr: expr(p.expr) })),
      order: op.order.map((k) => ({ ...k, expr: expr(k.expr) })),
      calls: op.calls.map((c) => ({ ...c, args: c.args.map(expr), ...(c.filter ? { filter: expr(c.filter) } : {}) })),
      // Windows of one block read the row below them all: one that reads an inner window's result reads it as a nested block.
      input: op.input.op === 'window' && readsWindowResult(op, planWidth(op.input.input)) ? from(op.input) : core(op.input),
    };
  }
  if (op.op === 'filter' && op.input.op === 'aggregate') return { ...op, pred: expr(op.pred), input: aggregated(op.input) };
  if (op.op === 'aggregate') return aggregated(op);
  return where(op);
}

function aggregated(op: Op<'aggregate'>): PlanOp {
  return {
    ...op,
    keys: op.keys.map((k) => ({ ...k, expr: expr(k.expr) })),
    aggs: op.aggs.map((a) => ({ ...a, args: a.args.map(expr), ...(a.filter ? { filter: expr(a.filter) } : {}) })),
    carry: op.carry.map(expr),
    input: where(op.input),
  };
}

function where(op: PlanOp): PlanOp {
  if (op.op === 'filter') return { ...op, pred: expr(op.pred), input: from(op.input) };
  return from(op);
}

/** A left-deep join tree of FROM items; any other operation is a nested block. */
function from(op: PlanOp): PlanOp {
  switch (op.op) {
    case 'join': {
      const [l, r] = op.inputs;
      // Joins nest to the left: a join on the right is a nested block.
      return { ...op, inputs: [from(l), r.op === 'join' ? block(r) : from(r)], ...(op.on ? { on: expr(op.on) } : {}) };
    }
    case 'scan':
    case 'working':
      return op;
    case 'source':
      return { ...op, args: op.args.map(expr), ...(op.named ? { named: Object.fromEntries(Object.entries(op.named).map(([k, v]) => [k, expr(v)])) } : {}) };
    case 'iterate':
      return { ...op, init: block(op.init), steps: op.steps.map(block), ...(op.limit ? { limit: expr(op.limit) } : {}), ...(op.offset ? { offset: expr(op.offset) } : {}) };
    case 'values':
      // A single empty row is SQL's FROM-less SELECT; other VALUES are blocks of their own.
      return op.rows.length === 1 && op.rows[0].length === 0 ? op : block(op);
    default:
      return block(op);
  }
}

/** The columns of `op`, passed through. */
function identity(op: PlanOp): PlanExpr[] {
  return Array.from({ length: planWidth(op) }, (_, i): PlanExpr => ({ k: 'col', input: 0, index: i, depth: 0, type: 'any', collation: 'binary' }));
}

/** Nested plans inside an expression (subqueries), normalized. */
function expr(e: PlanExpr): PlanExpr {
  switch (e.k) {
    case 'subquery':
      return { ...e, plan: block(e.plan) };
    case 'inSubquery':
      return { ...e, probe: expr(e.probe), plan: block(e.plan) };
    case 'call':
      return { ...e, args: e.args.map(expr) };
    case 'and':
    case 'or':
      return { ...e, args: e.args.map(expr) };
    case 'cast':
    case 'not':
    case 'isNull':
      return { ...e, arg: expr(e.arg) };
    case 'case':
      return { ...e, whens: e.whens.map((w) => ({ when: expr(w.when), then: expr(w.then) })), else: expr(e.else) };
    case 'each':
      return mapEach(e, expr);
    default:
      return e;
  }
}

