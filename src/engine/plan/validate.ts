/**
 * The plan validator (ADR 0015 sections 4 and 9): the engine checks every plan before planning it, because a plan's
 * builder is not trusted (a language, a plan received from another worker, later a client). One walk over the plan
 * checks:
 *
 * - operation and expression kinds, and the fields each needs;
 * - column references: a `col` names an input the expression has (`input`), an enclosing expression's scope that
 *   exists (`depth`), and a column of that input (`index` below its width);
 * - tables and their column indexes (`scan`, writes), the width of `setop` inputs and `iterate` steps, `working`
 *   inside its `iterate`;
 * - types and collations, positional parameters;
 * - functions: a registered scalar (`sql.*` or a named function), aggregate or window function, with an arity it
 *   accepts;
 * - nesting depth (operations and expressions together).
 *
 * A failure throws SMALT_PLAN with where in the plan it is (`project.exprs[1].args[0]`). Errors a language reports
 * in its own terms (no such table, ambiguous names) come from the language before it builds a plan.
 */
import { isNested, isPlanTypeName, parseNested } from '../../shared/nested-types.js';
import { SmaltError } from '../errors.js';
import { aggregateFunctions, scalarFunctions } from '../exec/functions.js';
import { SQL_FUNCTIONS, isEngineOperation } from '../exec/sql-functions.js';
import { NAVIGATION, RANKING, WINDOW_ARITY } from '../exec/window.js';
import type { ExprMeaning, PlanExpr } from './expr.js';
import type { PlanOp } from './ops.js';

/** What the validator asks of the catalog. */
export interface ValidateCatalog {
  /** A table's column count (rowid not included), or undefined. */
  tableColumns(name: string, db?: 'main' | 'temp'): number | undefined;
  /**
   * A source's column count (a table-valued function or a virtual table): `'data'` when its columns come from the data
   * it reads (external tables and functions), undefined when the catalog doesn't know the source (the planner reports
   * it in its own words).
   */
  sourceColumns?(kind: 'function' | 'virtual' | 'external', name: string, schema: string | undefined): number | 'data' | undefined;
}

/** Deeper plans are refused (SQLite's expression depth limit is 1000). */
export const MAX_PLAN_DEPTH = 1000;

/** Plan types: the simple ones, and list and struct types (ADR 0020), checked by `isPlanTypeName`. */
const TYPES = { has: (t: string): boolean => isPlanTypeName(t) };
const COLLATIONS = new Set(['binary', 'nocase', 'rtrim']);
const AFFINITIES = new Set(['INTEGER', 'REAL', 'NUMERIC', 'TEXT', 'BLOB']);

/** The input widths an expression may read at one scope (`input` indexes this). */
type Scope = readonly number[];

class Invalid extends SmaltError {
  constructor(path: string, message: string) {
    super('SMALT_PLAN', `invalid plan at ${path}: ${message}`);
  }
}

/** Throws SMALT_PLAN when `plan` is not a valid plan over `catalog`; returns its output width. */
export function validatePlan(plan: PlanOp, catalog: ValidateCatalog): number {
  return new Validator(catalog).op(plan, [], 0, null);
}

/**
 * The walk. Where it is in the plan is a stack of path segments, joined only when a check fails, so a valid plan
 * builds no strings.
 */
class Validator {
  /** Open `iterate` operations: id → output width. */
  private readonly iterates = new Map<number, number>();
  /** The path: segments `at[0..top)` of the shared array (validation does not re-enter itself). */
  private readonly at = PATH;
  private top = 1;

  constructor(private readonly catalog: ValidateCatalog) {}

  /** A `values` operation's columns: one per type, all of one length, with values and null bitmaps that are such. */
  private valueColumns(cs: unknown, width: number, rows: number, types?: readonly unknown[]): void {
    const l = this.list(cs, 'columns');
    if (rows > 0) this.fail('expected no rows beside columns', 'rows');
    if (l.length !== width) this.fail(`expected ${width} columns, one per type`, 'columns');
    let length: number | undefined;
    for (let i = 0; i < l.length; i++) {
      const c = l[i] as { data?: unknown; nulls?: unknown } | undefined;
      const wrapped = c !== null && typeof c === 'object' && !Array.isArray(c) && !ArrayBuffer.isView(c);
      const data = wrapped ? c.data : c;
      let n: number;
      if (ArrayBuffer.isView(data) && !(data instanceof DataView) && !(data instanceof BigUint64Array) && !(data instanceof Uint8ClampedArray)) {
        n = (data as unknown as ArrayLike<unknown>).length;
      } else if (Array.isArray(data)) {
        n = data.length;
        for (let j = 0; j < n; j++) {
          const v = data[j];
          // A JS boolean is a value of a bool column (ADR 0018), a JS Date one of a datetime column (ADR 0019), a JS
          // array or object one of a list or struct column (ADR 0020).
          if (!(v === null || typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string' || typeof v === 'boolean' || v instanceof Uint8Array || v instanceof Date)) {
            if (!(typeof v === 'object' && typeof types?.[i] === 'string' && isNested(types[i] as string))) this.fail(`expected a value at ${j}`, 'columns', i);
          }
        }
      } else this.fail('expected a typed array, an array of values, or { data, nulls }', 'columns', i);
      if (wrapped) {
        const nulls = c.nulls;
        if (!(nulls instanceof Uint8Array) || nulls.length < (n + 7) >>> 3) this.fail(`expected a null bitmap of at least ${(n + 7) >>> 3} bytes`, 'columns', i);
      }
      if (length === undefined) length = n;
      else if (n !== length) this.fail(`expected ${length} values, as the first column has`, 'columns', i);
    }
  }

  private fail(message: string, ...more: (string | number)[]): never {
    const path = ['plan', ...this.at.slice(1, this.top), ...more].map((x) => (typeof x === 'number' ? `[${x}]` : `.${x}`)).join('').slice(1);
    throw new Invalid(path, message);
  }

  private type(t: unknown, field: string): void {
    if (typeof t !== 'string' || !TYPES.has(t)) this.fail(`unknown type ${JSON.stringify(t)}`, field);
  }

  /** A logic node's optional type (ADR 0018): `bool` or `int`, the same 0 / 1 values. */
  private logicType(t: unknown): void {
    if (t !== undefined && t !== 'bool' && t !== 'int') this.fail(`a logic node's type is bool or int, not ${JSON.stringify(t)}`, 'type');
  }

  private collation(c: unknown, field: string): void {
    if (typeof c !== 'string' || !COLLATIONS.has(c)) this.fail(`unknown collation ${JSON.stringify(c)}`, field);
  }

  /** An expression's meaning fields (ADR 0016 section 2): `carries`, `affinity`, `inline`. */
  private meaning(e: ExprMeaning): void {
    if (e.carries !== undefined) {
      if (!e.carries || typeof e.carries !== 'object') this.fail('expected { collation, from }', 'carries');
      this.collation(e.carries.collation, 'carries.collation');
      if (e.carries.from !== 'explicit' && e.carries.from !== 'column') this.fail(`unknown collation source ${JSON.stringify(e.carries.from)}`, 'carries.from');
    }
    if (e.affinity !== undefined && !AFFINITIES.has(e.affinity)) this.fail(`unknown affinity ${JSON.stringify(e.affinity)}`, 'affinity');
    if (e.inline !== undefined && e.inline !== false) this.fail('inline is false or absent', 'inline');
    if (e.origin !== undefined) this.origin(e.origin);
  }

  /** An `origin`: plain data (JSON values), as the codec carries it. */
  private origin(x: unknown): void {
    const plain = (v: unknown, depth: number): boolean => {
      if (depth > 32) return false;
      if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
      if (typeof v === 'number') return Number.isFinite(v);
      if (Array.isArray(v)) return v.every((y) => plain(y, depth + 1));
      if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return Object.values(v as object).every((y) => plain(y, depth + 1));
      return false;
    };
    if (!plain(x, 0)) this.fail('expected plain data: strings, finite numbers, booleans, null, arrays and objects of them', 'origin');
  }

  /** `x` must be an object (an element of a list, a nested structure). */
  private object(x: unknown, field?: string): void {
    if (!x || typeof x !== 'object' || Array.isArray(x)) this.fail('expected an object', ...(field === undefined ? [] : [field]));
  }

  private list(x: unknown, field: string): readonly unknown[] {
    if (!Array.isArray(x)) this.fail('expected a list', field);
    return x;
  }

  private tableWidth(name: unknown, db: unknown): number {
    if (typeof name !== 'string') this.fail('expected a table name', 'table');
    if (db !== undefined && db !== 'main' && db !== 'temp') this.fail(`unknown schema ${JSON.stringify(db)}`, 'db');
    const n = this.catalog.tableColumns(name, db as 'main' | 'temp' | undefined);
    if (n === undefined) this.fail(`no such table: ${name}`, 'table');
    return n;
  }

  /** Expression `e` under path segments `seg`, `seg2` (no closure: this runs for every node). */
  private exprAt(e: PlanExpr, scopes: readonly Scope[], depth: number, seg: string | number, seg2: string | number | undefined): void {
    const n = this.top;
    this.at[this.top++] = seg;
    if (seg2 !== undefined) this.at[this.top++] = seg2;
    this.expr(e, scopes, depth);
    this.top = n;
  }

  /** Validate `x` under path segments `seg` (one or two). */
  private under<T>(seg: string | number, seg2: string | number | undefined, f: () => T): T {
    const n = this.top;
    this.at[this.top++] = seg;
    if (seg2 !== undefined) this.at[this.top++] = seg2;
    const r = f();
    this.top = n;
    return r;
  }


  /**
   * Validate operation `o`; returns its output width. `outer`: the scopes of enclosing expressions (the innermost
   * last). `lateral`: the width a `source`'s arguments may read (the join input before it), else null.
   */
  op(o: PlanOp, outer: readonly Scope[], depth: number, lateral: number | null): number {
    if (depth > MAX_PLAN_DEPTH) this.fail(`nested more than ${MAX_PLAN_DEPTH} deep`);
    if (!o || typeof o !== 'object') this.fail('expected an operation');
    if (o.decorrelate !== undefined && o.decorrelate !== false) this.fail('decorrelate is false or absent', 'decorrelate');
    if (o.origin !== undefined) this.origin(o.origin);
    const d = depth + 1;
    const sub = (x: PlanOp, field: string, i?: number, lat: number | null = null): number => this.under(field, i, () => this.op(x, outer, d, lat));
    /** The scopes of expressions reading inputs of widths `ws`. */
    const reading = (...ws: number[]): readonly Scope[] => [...outer, ws];
    /** A required expression. */
    const ex = (e: PlanExpr | undefined, scopes: readonly Scope[], field: string, i?: number): void => this.exprAt(e as PlanExpr, scopes, d, field, i);
    /** An optional expression: absent is fine. */
    const optEx = (e: PlanExpr | undefined, scopes: readonly Scope[], field: string): void => {
      if (e !== undefined) this.exprAt(e, scopes, d, field, undefined);
    };
    const exprs = (es: unknown, scopes: readonly Scope[], field: string): void => {
      const l = this.list(es, field);
      // Every element of a list is an expression (`ex` skips undefined, for optional fields only).
      for (let i = 0; i < l.length; i++) this.exprAt(l[i] as PlanExpr, scopes, d, field, i);
    };
    const sortKeys = (ks: unknown, scopes: readonly Scope[], field: string): void => {
      const l = this.list(ks, field);
      for (let i = 0; i < l.length; i++) {
        const key = l[i] as { expr: PlanExpr; desc: unknown; nullsFirst: unknown; collation: unknown };
        this.under(field, i, () => {
          this.object(key);
          ex(key.expr, scopes, 'expr');
          if (typeof key.desc !== 'boolean' || typeof key.nullsFirst !== 'boolean') this.fail('expected desc and nullsFirst');
          this.collation(key.collation, 'collation');
        });
      }
    };
    const collations = (cs: unknown, field: string): void => {
      const l = this.list(cs, field);
      for (let i = 0; i < l.length; i++) this.under(field, i, () => this.collation(l[i], 'collation'));
    };
    const types = (ts: unknown, field: string): number => {
      const l = this.list(ts, field);
      for (let i = 0; i < l.length; i++) if (typeof l[i] !== 'string' || !TYPES.has(l[i] as string)) this.fail(`unknown type ${JSON.stringify(l[i])}`, field, i);
      return l.length;
    };
    const columnsOf = (cols: unknown, n: number, table: string, field: string): readonly unknown[] => {
      const l = this.list(cols, field);
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (!Number.isInteger(c) || (c as number) < -1 || (c as number) >= n) this.fail(`table ${table} has no column ${String(c)}`, field, i);
      }
      return l;
    };
    const returning = (r: readonly PlanExpr[] | undefined, n: number): number => {
      if (r === undefined) return 0;
      exprs(r, reading(n + 1), 'returning');
      return r.length;
    };
    const orderedFirst = (v: unknown): void => {
      if (v !== undefined && v !== 'first') this.fail("expected 'first'", 'ordered');
    };
    switch (o.op) {
      case 'scan': {
        const n = this.tableWidth(o.table, o.db);
        const cols = columnsOf(o.columns, n, o.table, 'columns');
        if (o.indexedBy !== undefined && o.indexedBy !== null && typeof o.indexedBy !== 'string') this.fail('expected an index name', 'indexedBy');
        return cols.length;
      }
      case 'source': {
        if (o.kind !== 'function' && o.kind !== 'virtual' && o.kind !== 'external') this.fail(`unknown source kind ${JSON.stringify(o.kind)}`, 'kind');
        if (typeof o.name !== 'string') this.fail('expected a name', 'name');
        const scopes = lateral === null ? reading() : reading(lateral);
        exprs(o.args, scopes, 'args');
        if (o.named) for (const k of Object.keys(o.named)) ex(o.named[k], scopes, 'named', k as never);
        const w = types(o.types, 'types');
        // The planner reads as many columns as the source has, so `types` must describe each of them.
        const n = this.catalog.sourceColumns?.(o.kind, o.name, o.schema);
        if (typeof n === 'number' && n !== w) this.fail(`${o.kind === 'function' ? `${o.name}()` : o.schema ? `${o.schema}.${o.name}` : o.name} has ${n} column(s), but ${w} type(s) are given`, 'types');
        return w;
      }
      case 'values': {
        const w = types(o.types, 'types');
        const rows = this.list(o.rows, 'rows');
        const scopes = reading();
        for (let i = 0; i < rows.length; i++) {
          this.under('rows', i, () => {
            if (this.list(rows[i], 'values').length !== w) this.fail(`expected ${w} values`);
          });
          exprs(rows[i], scopes, `rows[${i}]`);
        }
        if (o.columns !== undefined) this.valueColumns(o.columns, w, rows.length, o.types as readonly unknown[]);
        return w;
      }
      case 'iterate': {
        if (!Number.isInteger(o.id)) this.fail('expected an id', 'id');
        const w = sub(o.init, 'init');
        if (this.iterates.has(o.id)) this.fail(`iterate ${o.id} is already open`, 'id');
        this.iterates.set(o.id, w);
        try {
          const steps = this.list(o.steps, 'steps');
          for (let i = 0; i < steps.length; i++) {
            const sw = sub(steps[i] as PlanOp, 'steps', i);
            if (sw !== w) this.fail(`step has ${sw} columns, the initial rows ${w}`, 'steps', i);
          }
        } finally {
          this.iterates.delete(o.id);
        }
        collations(o.collations, 'collations');
        if (o.order) sortKeys(o.order, reading(w), 'order');
        optEx(o.limit, reading(), 'limit');
        optEx(o.offset, reading(), 'offset');
        return w;
      }
      case 'working': {
        const w = this.iterates.get(o.id);
        if (w === undefined) this.fail(`working ${String(o.id)} outside its iterate`);
        if (types(o.types, 'types') !== w) this.fail(`expected ${w} columns`, 'types');
        return w;
      }
      case 'filter': {
        const w = sub(o.input, 'input');
        ex(o.pred, reading(w), 'pred');
        return w;
      }
      case 'project': {
        const w = sub(o.input, 'input');
        exprs(o.exprs, reading(w), 'exprs');
        return o.exprs.length;
      }
      case 'limit': {
        const w = sub(o.input, 'input');
        const scopes = reading(w);
        ex(o.count, scopes, 'count');
        optEx(o.offset, scopes, 'offset');
        if (o.fromEnd !== undefined && o.fromEnd !== true) this.fail('expected true', 'fromEnd');
        return w;
      }
      case 'join': {
        const ins = this.list(o.inputs, 'inputs');
        if (ins.length !== 2) this.fail('expected two inputs', 'inputs');
        const l = sub(ins[0] as PlanOp, 'inputs', 0);
        const r = sub(ins[1] as PlanOp, 'inputs', 1, l);
        if (!JOIN_KINDS.has(o.kind)) this.fail(`unknown join kind ${JSON.stringify(o.kind)}`, 'kind');
        optEx(o.on, reading(l, r), 'on');
        if (o.ordered !== undefined && o.ordered !== true) this.fail('expected true', 'ordered');
        if ((o.kind === 'asof') !== (o.asof !== undefined)) this.fail(o.kind === 'asof' ? 'an asof join needs its match { left, right, direction }' : 'only an asof join has a match', 'asof');
        if (o.asof) {
          const m = o.asof;
          this.under('asof', undefined, () => {
            if (!m || typeof m !== 'object') this.fail('expected { left, right, direction, tolerance? }');
            ex(m.left, reading(l, r), 'left');
            ex(m.right, reading(l, r), 'right');
            if (m.direction !== 'backward' && m.direction !== 'forward' && m.direction !== 'nearest') this.fail(`unknown direction ${JSON.stringify(m.direction)}`, 'direction');
            optEx(m.tolerance, reading(), 'tolerance');
          });
        }
        return o.kind === 'semi' || o.kind === 'anti' ? l : l + r;
      }
      case 'setop': {
        const ins = this.list(o.inputs, 'inputs');
        if (ins.length !== 2) this.fail('expected two inputs', 'inputs');
        const l = sub(ins[0] as PlanOp, 'inputs', 0);
        const r = sub(ins[1] as PlanOp, 'inputs', 1);
        if (l !== r) this.fail(`inputs have ${l} and ${r} columns`);
        if (!SETOP_KINDS.has(o.kind)) this.fail(`unknown set operation ${JSON.stringify(o.kind)}`, 'kind');
        collations(o.collations, 'collations');
        return l;
      }
      case 'sort': {
        const w = sub(o.input, 'input');
        sortKeys(o.keys, reading(w), 'keys');
        return w;
      }
      case 'aggregate': {
        const w = sub(o.input, 'input');
        const scopes = reading(w);
        const keys = this.list(o.keys, 'keys');
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i] as { expr: PlanExpr; collation: unknown };
          this.under('keys', i, () => {
            if (!k || typeof k !== 'object') this.fail('expected a key');
            this.exprAt(k.expr, scopes, d, 'expr', undefined);
            this.collation(k.collation, 'collation');
          });
        }
        const aggs = this.list(o.aggs, 'aggs');
        for (let i = 0; i < aggs.length; i++) this.under('aggs', i, () => (this.object(aggs[i]), this.aggCall(aggs[i] as never, scopes, d, false)));
        exprs(o.carry, scopes, 'carry');
        orderedFirst(o.ordered);
        return o.keys.length + o.aggs.length + o.carry.length;
      }
      case 'sample': {
        const w = sub(o.input, 'input');
        if ((o.count === undefined) === (o.fraction === undefined)) this.fail('expected a count or a fraction (one of them)');
        optEx(o.count, reading(), 'count');
        optEx(o.fraction, reading(), 'fraction');
        if (typeof o.replace !== 'boolean') this.fail('expected true or false', 'replace');
        if (!Number.isInteger(o.seed)) this.fail('expected an integer seed', 'seed');
        return w;
      }
      case 'pivot': {
        const w = sub(o.input, 'input');
        const scopes = reading(w);
        const keys = this.list(o.keys, 'keys');
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i] as { expr: PlanExpr; collation: unknown };
          this.under('keys', i, () => {
            if (!k || typeof k !== 'object') this.fail('expected a key');
            this.exprAt(k.expr, scopes, d, 'expr', undefined);
            this.collation(k.collation, 'collation');
          });
        }
        ex(o.on, scopes, 'on');
        this.collation(o.collation, 'collation');
        const values = this.list(o.values, 'values');
        if (values.length === 0) this.fail('expected at least one value', 'values');
        for (let i = 0; i < values.length; i++) {
          const v = values[i];
          if (!(v === null || typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string' || v instanceof Uint8Array)) this.fail('expected a value', 'values', i);
        }
        const aggs = this.list(o.aggs, 'aggs');
        if (aggs.length === 0) this.fail('expected at least one aggregate', 'aggs');
        for (let i = 0; i < aggs.length; i++) this.under('aggs', i, () => (this.object(aggs[i]), this.aggCall(aggs[i] as never, scopes, d, false)));
        orderedFirst(o.ordered);
        return keys.length + values.length * aggs.length;
      }
      case 'explode': {
        const w = sub(o.input, 'input');
        if (!Number.isInteger(o.column) || o.column < 0 || o.column >= w) this.fail(`no column ${String(o.column)}`, 'column');
        const n = typeof o.type === 'string' ? parseNested(o.type) : null;
        if (!n || n.kind !== 'list') this.fail(`expected a list type, not ${JSON.stringify(o.type)}`, 'type');
        for (const f of ['position', 'emptyAsNull', 'keepNulls'] as const) if (o[f] !== undefined && typeof o[f] !== 'boolean') this.fail('expected true or false', f);
        return w + (o.position ? 1 : 0);
      }
      case 'unpivot': {
        const w = sub(o.input, 'input');
        const index = (l: readonly unknown[], field: string): void => {
          for (let i = 0; i < l.length; i++) if (!Number.isInteger(l[i]) || (l[i] as number) < 0 || (l[i] as number) >= w) this.fail(`no column ${String(l[i])}`, field, i);
        };
        const keep = this.list(o.keep, 'keep');
        index(keep, 'keep');
        const cols = this.list(o.columns, 'columns');
        if (cols.length === 0) this.fail('expected at least one column', 'columns');
        index(cols, 'columns');
        const names = this.list(o.names, 'names');
        if (names.length !== cols.length) this.fail(`expected ${cols.length} names, one per column`, 'names');
        for (let i = 0; i < names.length; i++) if (typeof names[i] !== 'string') this.fail('expected a name', 'names', i);
        if (!TYPES.has(o.type)) this.fail(`unknown type ${JSON.stringify(o.type)}`, 'type');
        return keep.length + 2;
      }
      case 'distinct': {
        const w = sub(o.input, 'input');
        if (this.list(o.collations, 'collations').length !== w) this.fail(`expected ${w} collations`, 'collations');
        collations(o.collations, 'collations');
        orderedFirst(o.ordered);
        if (o.on !== undefined) {
          const on = this.list(o.on, 'on');
          if (on.length === 0) this.fail('expected at least one column', 'on');
          for (let i = 0; i < on.length; i++) {
            if (!Number.isInteger(on[i]) || (on[i] as number) < 0 || (on[i] as number) >= w) this.fail(`no column ${String(on[i])}`, 'on', i);
            if (on.indexOf(on[i]) !== i) this.fail(`column ${String(on[i])} is listed twice`, 'on', i);
          }
        }
        if (o.keep !== undefined && o.keep !== 'first' && o.keep !== 'last') this.fail("expected 'first' or 'last'", 'keep');
        return w;
      }
      case 'window': {
        const w = sub(o.input, 'input');
        const scopes = reading(w);
        const part = this.list(o.partition, 'partition');
        for (let i = 0; i < part.length; i++) {
          const k = part[i] as { expr: PlanExpr; collation: unknown };
          this.under('partition', i, () => {
            this.object(k);
            ex(k.expr, scopes, 'expr');
            this.collation(k.collation, 'collation');
          });
        }
        sortKeys(o.order, scopes, 'order');
        if (!o.frame || typeof o.frame !== 'object' || !o.frame.start || !o.frame.end) this.fail('expected a frame { unit, start, end, exclude }', 'frame');
        optEx(o.frame.start.offset, reading(), 'frame.start.offset');
        optEx(o.frame.end.offset, reading(), 'frame.end.offset');
        const calls = this.list(o.calls, 'calls');
        for (let i = 0; i < calls.length; i++)
          this.under('calls', i, () => {
            this.object(calls[i]);
            this.aggCall(calls[i] as never, scopes, d, true);
            const c = calls[i] as { fn: string; ignoreNulls?: unknown };
            if (c.ignoreNulls !== undefined) {
              if (typeof c.ignoreNulls !== 'boolean') this.fail('expected true or false', 'ignoreNulls');
              if (c.ignoreNulls && !NAVIGATION_FUNCTIONS.has(c.fn)) this.fail(`${c.fn} does not ignore NULLs (only lag, lead, first_value, last_value and nth_value do)`, 'ignoreNulls');
            }
          });
        return w + o.calls.length;
      }
      case 'delete': {
        const n = this.tableWidth(o.table, o.db);
        const w = sub(o.input, 'input');
        if (!Number.isInteger(o.rowid) || o.rowid < 0 || o.rowid >= w) this.fail(`input has no column ${o.rowid}`, 'rowid');
        return returning(o.returning, n);
      }
      case 'update': {
        const n = this.tableWidth(o.table, o.db);
        if (o.onConflict !== undefined && !CONFLICT_ACTIONS.has(o.onConflict)) this.fail(`unknown conflict action ${JSON.stringify(o.onConflict)}`, 'onConflict');
        const w = sub(o.input, 'input');
        if (!Number.isInteger(o.rowid) || o.rowid < 0 || o.rowid >= w) this.fail(`input has no column ${o.rowid}`, 'rowid');
        const scopes = reading(w);
        const sets = this.list(o.sets, 'sets');
        for (let i = 0; i < sets.length; i++) {
          const set = sets[i] as { column: number; value: PlanExpr };
          this.under('sets', i, () => {
            this.object(set);
            if (!Number.isInteger(set.column) || set.column < -1 || set.column >= n) this.fail(`table ${o.table} has no column ${set.column}`, 'column');
            ex(set.value, scopes, 'value');
          });
        }
        return returning(o.returning, n);
      }
      case 'append': {
        const n = this.tableWidth(o.table, o.db);
        if (o.onConflict !== undefined && !CONFLICT_ACTIONS.has(o.onConflict)) this.fail(`unknown conflict action ${JSON.stringify(o.onConflict)}`, 'onConflict');
        const cols = columnsOf(o.columns, n, o.table, 'columns');
        if (o.input !== null) {
          const w = sub(o.input, 'input');
          if (w !== cols.length) this.fail(`gives ${w} columns for ${cols.length}`, 'input');
        }
        // An upsert's expressions read the existing row (columns, rowid), then the proposed one.
        const scopes = reading(2 * (n + 1));
        const ups = this.list(o.upserts, 'upserts');
        for (let i = 0; i < ups.length; i++) {
          const up = ups[i] as { target?: unknown; update?: { sets: { column: number; value: PlanExpr }[]; where?: PlanExpr } };
          this.under('upserts', i, () => this.object(up));
          if (up.target !== null && !(Number.isInteger(up.target) && (up.target as number) >= -1)) this.under('upserts', i, () => this.fail(`expected a constraint index, -1 or null`, 'target'));
          if (!up.update) continue;
          this.under('upserts', i, () => {
            this.object(up.update, 'update');
            const sets = this.list(up.update!.sets, 'update.sets') as { column: number; value: PlanExpr }[];
            for (let j = 0; j < sets.length; j++) {
              this.under('update.sets', j, () => {
                this.object(sets[j]);
                if (!Number.isInteger(sets[j].column) || sets[j].column < -1 || sets[j].column >= n) this.fail(`table ${o.table} has no column ${sets[j].column}`, 'column');
                ex(sets[j].value, scopes, 'value');
              });
            }
            optEx(up.update!.where, scopes, 'update.where');
          });
        }
        return returning(o.returning, n);
      }
      default:
        return this.fail(`unknown operation ${JSON.stringify((o as { op?: unknown }).op)}`);
    }
  }

  /** An aggregate call (or a window call, `window`): a registered function with an arity it accepts. */
  /** A schema operation (see validateSchemaOp). */
  schemaOp(o: Record<string, unknown>): void {
    this.top = 1;
    if (!o || typeof o !== 'object') this.fail('expected a schema operation');
    if (!SCHEMA_OPS.has(o.op as string)) this.fail(`unknown schema operation ${JSON.stringify(o.op)}`, 'op');
    this.at[this.top++] = o.op as string;
    const str = (x: unknown, field: string, nonEmpty = true): void => {
      if (typeof x !== 'string' || (nonEmpty && x === '')) this.fail(nonEmpty ? 'expected a name' : 'expected text', field);
    };
    const bool = (x: unknown, field: string): void => {
      if (typeof x !== 'boolean') this.fail('expected true or false', field);
    };
    const optBool = (x: unknown, field: string): void => {
      if (x !== undefined) bool(x, field);
    };
    const schema = (x: unknown): void => {
      if (x !== undefined && x !== 'main' && x !== 'temp') this.fail(`unknown schema ${JSON.stringify(x)}`, 'schema');
    };
    const source = (x: unknown): void =>
      this.under('source', undefined, () => {
        if (!x || typeof x !== 'object') this.fail('expected a source { language, text }');
        const src = x as { language?: unknown; text?: unknown };
        str(src.language, 'language');
        str(src.text, 'text', false);
      });
    const conflict = (x: unknown, field: string): void => {
      if (x !== undefined && !CONFLICT_ACTIONS.has(x as string)) this.fail(`unknown conflict action ${JSON.stringify(x)}`, field);
    };
    // Without source text, a definition's expressions must be bound: nothing could bind them later.
    let unbound = false;
    const optSource = (x: unknown): void => {
      if (x === undefined) unbound = true;
      else source(x);
    };
    /** An expression of a definition over `width` columns (and the rowid when `rowid`). */
    const exprDef = (x: unknown, width: number, rowid: boolean, field: string, i?: number): void =>
      this.under(field, i, () => {
        if (!x || typeof x !== 'object') this.fail('expected { text, expr? }');
        const d = x as { text?: unknown; expr?: PlanExpr };
        str(d.text, 'text', false);
        if (d.expr === undefined && unbound) this.fail('a definition without source text needs its bound expression', 'expr');
        if (d.expr !== undefined) this.exprAt(d.expr, [[rowid ? width + 1 : width]], 1, 'expr', undefined);
      });
    const columnIndex = (c: unknown, width: number, field: string, i?: number): void => {
      if (!Number.isInteger(c) || (c as number) < 0 || (c as number) >= width) this.fail(`no column ${String(c)}`, field, ...(i === undefined ? [] : [i]));
    };
    const columnDef = (c: unknown, field: string, i?: number): string =>
      this.under(field, i, () => {
        if (!c || typeof c !== 'object') this.fail('expected a column');
        const d = c as Record<string, unknown>;
        str(d.name, 'name');
        str(d.declaredType, 'declaredType', false);
        if (!STORAGE_TYPES.has(d.type as string)) this.fail(`unknown storage type ${JSON.stringify(d.type)} (one of ${[...STORAGE_TYPES].join(', ')})`, 'type');
        // A LIST or STRUCT column's declared type is its full type (ADR 0020): list<int>, struct<a int, b text>.
        if (d.type === 'LIST' || d.type === 'STRUCT') {
          const n = typeof d.declaredType === 'string' ? parseNested(d.declaredType) : null;
          if (!n || n.kind !== (d.type === 'LIST' ? 'list' : 'struct')) this.fail(`a ${d.type} column's declared type is a ${d.type === 'LIST' ? 'list<…>' : 'struct<…>'} type, not ${JSON.stringify(d.declaredType)}`, 'declaredType');
        }
        bool(d.notNull, 'notNull');
        conflict(d.notNullConflict, 'notNullConflict');
        this.collation(d.collation, 'collation');
        if (d.default !== undefined) {
          exprDef(d.default, 0, false, 'default');
          const v = (d.default as { value?: unknown }).value;
          if (v !== null && !['number', 'bigint', 'string'].includes(typeof v) && !(v instanceof Uint8Array)) this.fail('expected a value', 'default', 'value');
        }
        return d.name as string;
      });
    const checks = (cs: unknown, width: number, field: string): void => {
      const l = this.list(cs, field);
      for (let i = 0; i < l.length; i++) {
        exprDef(l[i], width, true, field, i);
        const of = (l[i] as { ofColumn?: unknown }).ofColumn;
        if (of !== undefined) this.under(field, i, () => columnIndex(of, width, 'ofColumn'));
      }
    };
    const foreignKeys = (fks: unknown, width: number, field: string): void => {
      const l = this.list(fks, field);
      for (let i = 0; i < l.length; i++)
        this.under(field, i, () => {
          const f = l[i] as Record<string, unknown>;
          if (!f || typeof f !== 'object') this.fail('expected a foreign key');
          const cols = this.list(f.columns, 'columns');
          if (cols.length === 0) this.fail('expected at least one column', 'columns');
          for (let j = 0; j < cols.length; j++) columnIndex(cols[j], width, 'columns', j);
          str(f.table, 'table');
          if (f.refColumns !== undefined) {
            const refs = this.list(f.refColumns, 'refColumns');
            if (refs.length !== cols.length) this.fail(`expected ${cols.length} parent column(s)`, 'refColumns');
            for (let j = 0; j < refs.length; j++) this.under('refColumns', j, () => str(refs[j], 'name'));
          }
          if (!FK_ACTIONS.has(f.onDelete as string)) this.fail(`unknown action ${JSON.stringify(f.onDelete)}`, 'onDelete');
          if (!FK_ACTIONS.has(f.onUpdate as string)) this.fail(`unknown action ${JSON.stringify(f.onUpdate)}`, 'onUpdate');
          bool(f.deferrable, 'deferrable');
          bool(f.isDeferrable, 'isDeferrable');
        });
    };
    switch (o.op) {
      case 'createTable': {
        schema(o.schema);
        bool(o.temp, 'temp');
        bool(o.ifNotExists, 'ifNotExists');
        optSource(o.source);
        this.under('table', undefined, () => {
          const t = o.table as Record<string, unknown>;
          if (!t || typeof t !== 'object') this.fail('expected a table definition');
          str(t.name, 'name');
          const cols = this.list(t.columns, 'columns');
          if (cols.length === 0) this.fail('a table needs at least one column', 'columns');
          const seen = new Set<string>();
          for (let i = 0; i < cols.length; i++) {
            const name = columnDef(cols[i], 'columns', i).toLowerCase();
            if (seen.has(name)) this.fail(`duplicate column name ${JSON.stringify((cols[i] as { name: string }).name)}`, 'columns', i);
            seen.add(name);
          }
          const width = cols.length;
          const keys = this.list(t.keys, 'keys');
          let primary = 0;
          for (let i = 0; i < keys.length; i++)
            this.under('keys', i, () => {
              const k = keys[i] as Record<string, unknown>;
              if (!k || typeof k !== 'object') this.fail('expected a key');
              if (k.kind !== 'primaryKey' && k.kind !== 'unique') this.fail(`unknown key kind ${JSON.stringify(k.kind)}`, 'kind');
              if (k.kind === 'primaryKey' && ++primary > 1) this.fail('a table has at most one primary key');
              const kc = this.list(k.columns, 'columns');
              if (kc.length === 0) this.fail('expected at least one column', 'columns');
              for (let j = 0; j < kc.length; j++)
                this.under('columns', j, () => {
                  const c = kc[j] as Record<string, unknown>;
                  columnIndex(c?.column, width, 'column');
                  bool(c.desc, 'desc');
                  this.collation(c.collation, 'collation');
                });
              conflict(k.onConflict, 'onConflict');
              optBool(k.autoincrement, 'autoincrement');
              if (k.ofColumn !== undefined) columnIndex(k.ofColumn, width, 'ofColumn');
            });
          checks(t.checks, width, 'checks');
          foreignKeys(t.foreignKeys, width, 'foreignKeys');
          if (t.storage !== 'row' && t.storage !== 'columnar') this.fail(`unknown storage ${JSON.stringify(t.storage)}`, 'storage');
        });
        return;
      }
      case 'createIndex': {
        schema(o.schema);
        bool(o.ifNotExists, 'ifNotExists');
        optSource(o.source);
        this.under('index', undefined, () => {
          const ix = o.index as Record<string, unknown>;
          if (!ix || typeof ix !== 'object') this.fail('expected an index definition');
          str(ix.name, 'name');
          const width = this.tableWidth(ix.table, o.schema);
          const cols = this.list(ix.columns, 'columns');
          if (cols.length === 0) this.fail('expected at least one column', 'columns');
          for (let i = 0; i < cols.length; i++)
            this.under('columns', i, () => {
              const c = cols[i] as Record<string, unknown>;
              if (!c || typeof c !== 'object') this.fail('expected an index column');
              if (c.column === -1) {
                if (c.expr === undefined) this.fail('an expression column needs its expression', 'expr');
                exprDef(c.expr, width, true, 'expr');
              } else columnIndex(c.column, width, 'column');
              bool(c.desc, 'desc');
              this.collation(c.collation, 'collation');
            });
          bool(ix.unique, 'unique');
          if (ix.where !== undefined) exprDef(ix.where, width, true, 'where');
        });
        return;
      }
      case 'createView': {
        str(o.name, 'name');
        schema(o.schema);
        bool(o.temp, 'temp');
        bool(o.ifNotExists, 'ifNotExists');
        bool(o.materialized, 'materialized');
        optBool(o.withData, 'withData');
        if (o.columns !== undefined) {
          const l = this.list(o.columns, 'columns');
          for (let i = 0; i < l.length; i++) this.under('columns', i, () => str(l[i], 'name'));
        }
        source(o.source);
        return;
      }
      case 'createConnection':
      case 'createExternalTable': {
        str(o.name, 'name');
        bool(o.ifNotExists, 'ifNotExists');
        if (!o.options || typeof o.options !== 'object' || Array.isArray(o.options)) this.fail('expected options', 'options');
        if (o.op === 'createExternalTable') {
          const l = this.list(o.columns, 'columns');
          for (let i = 0; i < l.length; i++)
            this.under('columns', i, () => {
              const c = l[i] as Record<string, unknown>;
              str(c?.name, 'name');
              str(c.declaredType, 'declaredType', false);
              bool(c.constrained, 'constrained');
            });
        }
        optSource(o.source);
        return;
      }
      case 'drop': {
        if (!DROP_OBJECTS.has(o.objectType as string)) this.fail(`unknown object type ${JSON.stringify(o.objectType)}`, 'objectType');
        str(o.name, 'name');
        schema(o.schema);
        bool(o.ifExists, 'ifExists');
        return;
      }
      case 'alterTable': {
        str(o.table, 'table');
        schema(o.schema);
        optSource(o.source);
        const width = this.tableWidth(o.table, o.schema);
        this.under('action', undefined, () => {
          const a = o.action as Record<string, unknown>;
          if (!a || typeof a !== 'object') this.fail('expected an action');
          switch (a.kind) {
            case 'renameTable':
              str(a.newName, 'newName');
              return;
            case 'renameColumn':
              str(a.column, 'column');
              str(a.newName, 'newName');
              return;
            case 'dropColumn':
              str(a.column, 'column');
              return;
            case 'addColumn':
              columnDef(a.column, 'column');
              checks(a.checks, width + 1, 'checks');
              foreignKeys(a.foreignKeys, width + 1, 'foreignKeys');
              str(a.text, 'text', false);
              return;
            default:
              this.fail(`unknown action ${JSON.stringify(a.kind)}`, 'kind');
          }
        });
        return;
      }
    }
  }

  private aggCall(a: { fn: unknown; args: unknown; star: unknown; filter?: PlanExpr; collation: unknown; type: unknown }, scopes: readonly Scope[], depth: number, window: boolean): void {
    if (typeof a.fn !== 'string') this.fail('expected a function name', 'fn');
    const args = this.list(a.args, 'args');
    const n = args.length;
    let arity: readonly [number, number] | undefined;
    if (window && (RANKING.has(a.fn) || NAVIGATION.has(a.fn))) arity = WINDOW_ARITY[a.fn];
    else {
      const f = aggregateFunctions.get(a.fn);
      if (f) arity = [f.minArgs, f.maxArgs];
    }
    if (!arity) this.fail(`no such ${window ? 'window' : 'aggregate'} function: ${a.fn}`, 'fn');
    if (!(a.star === true && n === 0) && (n < arity[0] || (arity[1] >= 0 && n > arity[1]))) this.fail(`wrong number of arguments to ${a.fn}: ${n}`);
    if (n === 0 && a.star !== true && arity[0] === 0 && !window) this.fail(`${a.fn} with no arguments is ${a.fn}(*): set star`, 'star');
    for (let i = 0; i < n; i++) this.exprAt(args[i] as PlanExpr, scopes, depth, 'args', i);
    if (a.filter !== undefined) this.exprAt(a.filter!, scopes, depth, 'filter', undefined);
    this.collation(a.collation, 'collation');
    this.type(a.type, 'type');
  }

  /** Expression `e`, reading `scopes` (the innermost last: depth 0). */
  expr(e: PlanExpr, scopes: readonly Scope[], depth: number): void {
    if (depth > MAX_PLAN_DEPTH) this.fail(`nested more than ${MAX_PLAN_DEPTH} deep`);
    if (!e || typeof e !== 'object') this.fail('expected an expression');
    this.meaning(e);
    const d = depth + 1;
    switch (e.k) {
      case 'col': {
        if (!Number.isInteger(e.depth) || e.depth < 0 || e.depth >= scopes.length) this.fail(`column of enclosing scope ${e.depth}, which does not exist`);
        const scope = scopes[scopes.length - 1 - e.depth];
        if (!Number.isInteger(e.input) || e.input < 0 || e.input >= scope.length) this.fail(`column of input ${e.input}, which does not exist`);
        if (!Number.isInteger(e.index) || e.index < 0 || e.index >= scope[e.input]) this.fail(`column ${e.index} of input ${e.input}, which has ${scope[e.input]}`);
        this.type(e.type, 'type');
        this.collation(e.collation, 'collation');
        return;
      }
      case 'lit': {
        const v = e.value;
        if (!(v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint' || v instanceof Uint8Array)) this.fail('unsupported literal value');
        this.type(e.type, 'type');
        return;
      }
      case 'param':
        if (!Number.isInteger(e.index) || e.index < 0) this.fail(`bad parameter index ${String(e.index)}`);
        this.type(e.type, 'type');
        return;
      case 'call': {
        if (typeof e.fn !== 'string') this.fail('expected a function name', 'fn');
        const args = this.list(e.args, 'args');
        const n = args.length;
        if (isEngineOperation(e.fn)) {
          const f = SQL_FUNCTIONS.get(e.fn);
          if (f) {
            const ar = f.arity;
            if (typeof ar === 'number' ? n !== ar : n < ar[0] || (ar[1] >= 0 && n > ar[1])) this.fail(`wrong number of arguments to ${e.fn}: ${n}`);
          }
        } else {
          const f = scalarFunctions.get(e.fn);
          if (!f) this.fail(`no such function: ${e.fn}`, 'fn');
          if (n < f.minArgs || (f.maxArgs >= 0 && n > f.maxArgs)) this.fail(`wrong number of arguments to ${e.fn}: ${n}`);
        }
        if (e.collation !== undefined) this.collation(e.collation, 'collation');
        this.type(e.type, 'type');
        for (let i = 0; i < n; i++) this.exprAt(args[i] as PlanExpr, scopes, d, 'args', i);
        return;
      }
      case 'cast':
        if (typeof e.fn !== 'string' || !SQL_FUNCTIONS.has(e.fn)) this.fail(`no such conversion: ${String(e.fn)}`, 'fn');
        this.type(e.to, 'to');
        this.exprAt(e.arg, scopes, d, 'arg', undefined);
        return;
      case 'and':
      case 'or': {
        this.logicType(e.type);
        const args = this.list(e.args, 'args');
        for (let i = 0; i < args.length; i++) this.exprAt(args[i] as PlanExpr, scopes, d, 'args', i);
        return;
      }
      case 'not':
        this.logicType(e.type);
        this.exprAt(e.arg, scopes, d, 'arg', undefined);
        return;
      case 'isNull':
        this.logicType(e.type);
        if (typeof e.not !== 'boolean') this.fail('expected a boolean', 'not');
        this.exprAt(e.arg, scopes, d, 'arg', undefined);
        return;
      case 'case': {
        const whens = this.list(e.whens, 'whens');
        for (let i = 0; i < whens.length; i++) {
          const w = whens[i] as { when: PlanExpr; then: PlanExpr };
          this.under('whens', i, () => {
            this.object(w);
            this.exprAt(w.when, scopes, d, 'when', undefined);
            this.exprAt(w.then, scopes, d, 'then', undefined);
          });
        }
        this.exprAt(e.else, scopes, d, 'else', undefined);
        this.type(e.type, 'type');
        return;
      }
      case 'subquery': {
        if (e.mode !== 'scalar' && e.mode !== 'exists') this.fail(`unknown subquery mode ${JSON.stringify(e.mode)}`, 'mode');
        const w = this.under('plan', undefined, () => this.op(e.plan, scopes, d, null));
        if (e.mode === 'scalar' && w < 1) this.fail('a scalar subquery needs a column', 'plan');
        this.type(e.type, 'type');
        this.collation(e.collation, 'collation');
        return;
      }
      case 'inSubquery':
        this.exprAt(e.probe, scopes, d, 'probe', undefined);
        this.under('plan', undefined, () => this.op(e.plan, scopes, d, null));
        this.collation(e.collation, 'collation');
        return;
      default:
        this.fail(`unknown expression ${JSON.stringify((e as { k?: unknown }).k)}`);
    }
  }
}

// ------------------------------------------------------------------ schema operations

const STORAGE_TYPES = new Set(['INTEGER', 'BOOLEAN', 'DATE', 'TIME', 'DATETIME', 'DURATION', 'LIST', 'STRUCT', 'REAL', 'TEXT', 'BLOB', 'ANY', 'NUMERIC']);
const FK_ACTIONS = new Set(['SET NULL', 'SET DEFAULT', 'CASCADE', 'RESTRICT', 'NO ACTION']);
const DROP_OBJECTS = new Set(['table', 'index', 'view', 'materialized view', 'trigger', 'external table', 'connection']);
const SCHEMA_OPS = new Set(['createTable', 'createIndex', 'createView', 'createConnection', 'createExternalTable', 'drop', 'alterTable']);

/**
 * Throws SMALT_PLAN when `op` is not a valid schema operation (ADR 0016 section 9): the fields each operation needs,
 * storage types, collations and conflict actions from their sets, columns that exist and names that are unique, and
 * CHECK, DEFAULT, index and partial-index expressions validated as plan expressions over the row (column `i` of the
 * table, `n` its rowid) or over no columns (DEFAULT). Schema operations a language binds are checked by that language
 * in its own words; this runs for schema operations given as plan data.
 */
export function validateSchemaOp(op: unknown, catalog: ValidateCatalog): void {
  new Validator(catalog).schemaOp(op as Record<string, unknown>);
}

/** Path segments of the validation running (at most two per nesting level). */
const PATH: (string | number)[] = new Array<string | number>(2 * MAX_PLAN_DEPTH + 8).fill('');

const CONFLICT_ACTIONS = new Set(['rollback', 'abort', 'fail', 'ignore', 'replace']);
const NAVIGATION_FUNCTIONS = new Set(['lag', 'lead', 'first_value', 'last_value', 'nth_value']);
const JOIN_KINDS = new Set(['inner', 'left', 'right', 'full', 'semi', 'anti', 'cross', 'asof']);
const SETOP_KINDS = new Set(['union', 'unionAll', 'intersect', 'except']);
