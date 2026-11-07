import { SmaltError, withDetails } from '../errors.js';
import { storageTypeFor } from '../catalog/schema.js';
import { Collation, type SqlValue, collationByName } from '../values.js';
import {
  type Affinity,
  type StaticType,
  affinityOfStorage,
  applyNumericAffinity,
  applyTextAffinity,
  staticTypeOfStorage,
  truthy,
} from './convert.js';
import { currentTimeText } from './datetime.js';
import { ARITHMETIC_FUNCTIONS, BITWISE_FUNCTIONS, COMPARISON_FUNCTIONS, arithImpl, isEngineOperation, negate, sqlFunction } from './sql-functions.js';
import { type CompiledArg, type Fn, type FunctionContext, aggregateFunctions, scalarFunctions } from './functions.js';
import { type CodegenHelpers, type FallbackNode, codegenEnabled, generate, generatedType, isCodegenRoot } from './codegen.js';
import { daysAsUs } from './temporal-ops.js';
import { WINDOW_ARITY } from './window.js';
import { type SqlMeta, getMeta, setMeta } from './sql-meta.js';
import { type BoundExpr, type ExprMeaning, call, lit, param, typeOf } from '../plan/expr.js';
import type { CollationName } from '../plan/types.js';
import type { PlanOp } from '../plan/ops.js';
import { decodeTagged, decodeUtf8, readInt64 } from '../storage/record.js';
import { readRowidKey } from '../storage/key-codec.js';

export type { Fn };

/** Where a compiled expression's collation came from (SQLite precedence: explicit > column > none). */
export enum CollSrc {
  None = 0,
  Column = 1,
  Explicit = 2,
}

export interface Compiled {
  fn: Fn;
  type: StaticType;
  collation: Collation;
  collSrc: CollSrc;
  affinity: Affinity;
  /** Value does not depend on registers (literal or folded). */
  constant: boolean;
  /** Set when the value is a plain register read (lets generated code inline it). */
  reg?: number;
}

const NO_REGS: SqlValue[] = [];

function konst(v: SqlValue, type: StaticType, affinity: Affinity = 'NONE'): Compiled {
  return { fn: () => v, type, collation: Collation.Binary, collSrc: CollSrc.None, affinity, constant: true };
}

/**
 * Fold a node whose inputs are all constant (and deterministic). A node whose evaluation raises
 * is left unfolded (and no longer constant), so the error is raised only if it runs: it may sit in
 * a branch that never does, e.g. `CASE WHEN 1 THEN 1 ELSE abs(-9223372036854775808) END`.
 */
function fold(c: Compiled): Compiled {
  if (!c.constant) return c;
  let v: SqlValue;
  try {
    v = c.fn(NO_REGS);
  } catch {
    return { ...c, constant: false };
  }
  return { ...c, fn: () => v };
}

/** Compile a bound expression: generated code for arithmetic / comparison / logic roots, otherwise closures. */
export function compileBoundExpr(b: BoundExpr, ctx: FunctionContext): Compiled {
  if (!codegenEnabled() || !isCodegenRoot(b)) return compilePlanExpr(b, ctx);
  if (b.k === 'call' && !isEngineOperation(b.fn)) {
    // A math call: keep the closure compiler's result when it is constant (folded) or a register read.
    const c = compilePlanExpr(b, ctx);
    if (c.constant || c.reg !== undefined) return c;
  }
  const g = generate(b, CODEGEN_HELPERS, (x) => compilePlanExpr(x, ctx));
  // Generated code compiles the nodes it does not inline with compilePlanExpr, which gives their origins; the root's
  // is given here.
  const fn = b.origin === undefined ? g.fn : guarded(g.fn, { origin: b.origin });
  return { fn, type: g.type, collation: Collation.Binary, collSrc: CollSrc.None, affinity: 'NONE', constant: false };
}

/** `f`, giving `details` to the errors it raises that have none of their own. */
function guarded(f: Fn, details: { origin: unknown }): Fn {
  return (r) => {
    try {
      return f(r);
    } catch (err) {
      throw withDetails(err, details);
    }
  };
}

/**
 * The static metadata `compileBoundExpr` gives a bound expression (type, collation, affinity), without generating
 * code: the SQL front end (ADR 0014, step 5) derives its result columns' metadata exactly as the planner does.
 */
export function boundMetadata(b: BoundExpr, ctx: FunctionContext): Pick<Compiled, 'type' | 'collation' | 'collSrc' | 'affinity'> {
  if (!codegenEnabled() || !isCodegenRoot(b)) return compilePlanExpr(b, ctx);
  if (b.k === 'call' && !isEngineOperation(b.fn)) {
    const c = compilePlanExpr(b, ctx);
    if (c.constant || c.reg !== undefined) return c;
  }
  // Generated code carries no collation or affinity.
  return { type: generatedType(b, (x) => compilePlanExpr(x, ctx)), collation: Collation.Binary, collSrc: CollSrc.None, affinity: 'NONE' };
}

/** How fused pipelines compile a node of a bound expression with the closure compiler. */
export function pipelineCompiler(ctx: FunctionContext): (e: BoundExpr) => FallbackNode {
  return (e) => compilePlanExpr(e, ctx);
}

/** True if a bound expression runs a subquery (fused pipelines leave those to the operators). */
export function planHasSubquery(e: BoundExpr): boolean {
  switch (e.k) {
    case 'native':
      return e.subquery === true;
    case 'call':
    case 'and':
    case 'or':
      return e.args.some(planHasSubquery);
    case 'cast':
    case 'not':
    case 'isNull':
      return planHasSubquery(e.arg);
    case 'case':
      return e.whens.some((w) => planHasSubquery(w.when) || planHasSubquery(w.then)) || planHasSubquery(e.else);
    case 'subquery':
    case 'inSubquery':
      return true;
    default:
      return false;
  }
}

const CODEGEN_HELPERS: CodegenHelpers = {
  arith: Object.fromEntries(['+', '-', '*', '/', '%'].flatMap((op) => [[op, arithImpl(op, false)], [op + 'R', arithImpl(op, true)]])),
  negate: (v) => negate(v),
  daysAsUs,
};

// ------------------------------------------------------------------ SQL metadata and compiling

export const NO_META: SqlMeta = { collation: Collation.Binary, collSrc: CollSrc.None, affinity: 'NONE' };


const COLLATION_NAMES: readonly CollationName[] = ['binary', 'nocase', 'rtrim'];
export const collationName = (c: Collation): CollationName => COLLATION_NAMES[c];
const collationId = (n: CollationName | undefined): Collation => (n === 'nocase' ? Collation.NoCase : n === 'rtrim' ? Collation.RTrim : Collation.Binary);

export function withMeta<T extends BoundExpr>(e: T, m: SqlMeta): T {
  if (m.collation !== Collation.Binary || m.collSrc !== CollSrc.None || m.affinity !== 'NONE' || m.opaque) setMeta(e, m);
  return e;
}

export const metaOf = (e: BoundExpr): SqlMeta => getMeta(e) ?? NO_META;

const AFFINITY_CALLS = new Set(['affinity_numeric', 'affinity_text']);

/**
 * Compile a bound expression to a closure, with its SQL metadata. A node with an `origin` gives it to the errors that
 * arise in it, while it is compiled and when it runs, unless a node inside it gave its own (ADR 0016 section 10).
 */
export function compilePlanExpr(e: BoundExpr, ctx: FunctionContext): Compiled {
  if (e.origin !== undefined) return withOrigin(e, ctx);
  return compileWithMeta(e, ctx);
}

function withOrigin(e: BoundExpr, ctx: FunctionContext): Compiled {
  const details = { origin: e.origin };
  let c: Compiled;
  try {
    c = compileWithMeta(e, ctx);
  } catch (err) {
    throw withDetails(err, details);
  }
  // A constant or a register read raises nothing when it runs.
  if (c.constant || c.reg !== undefined) return c;
  return { ...c, fn: guarded(c.fn, details) };
}

function compileWithMeta(e: BoundExpr, ctx: FunctionContext): Compiled {
  const c = compileBound(e, ctx);
  const m = getMeta(e);
  if (m === undefined) return c;
  // A compiled alias or subquery is shared: copy it. Everything else was built just now for this node.
  if (e.k === 'native') return { ...c, ...m };
  c.collation = m.collation;
  c.collSrc = m.collSrc;
  c.affinity = m.affinity;
  return c;
}

function compileBound(e: BoundExpr, ctx: FunctionContext): Compiled {
  const sub = (x: BoundExpr): Compiled => compilePlanExpr(x, ctx);
  switch (e.k) {
    case 'lit':
      return konst(e.value, e.type);
    case 'param': {
      const reg = e.index;
      return { fn: (r) => r[reg], type: 'any', collation: Collation.Binary, collSrc: CollSrc.None, affinity: 'NONE', constant: false, reg };
    }
    case 'slot':
      e.use?.();
      return { fn: regReader(e.reg), type: e.type, collation: Collation.Binary, collSrc: CollSrc.None, affinity: 'NONE', constant: false, reg: e.reg };
    case 'native':
      return e.compiled as Compiled;
    case 'not': {
      const a = e.arg;
      // NOT LIKE, NOT GLOB and NOT IN compile to one closure, as their own forms.
      if (a.k === 'call' && ['like', 'glob', 'in_list'].includes(a.fn)) return compileSqlCall(a, ctx, true);
      return compileUnary('NOT', sub(a));
    }
    case 'and':
      return and(sub(e.args[0]), sub(e.args[1]));
    case 'or':
      return or(sub(e.args[0]), sub(e.args[1]));
    case 'isNull': {
      const x = sub(e.arg);
      const f = x.fn;
      const not = e.not;
      return fold({ fn: (r) => ((f(r) === null) !== not ? 1 : 0), type: 'int', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: x.constant });
    }
    case 'case':
      return compileCase(e, ctx);
    case 'cast': {
      const x = sub(e.arg);
      const { fn } = sqlFunction(e.fn).compile([x], {});
      return fold({ fn, type: e.to, collation: x.collation, collSrc: x.collSrc, affinity: 'NONE', constant: x.constant });
    }
    case 'call':
      return isEngineOperation(e.fn) ? compileSqlCall(e, ctx, false) : compileScalarCall(e, ctx);
    case 'subquery':
    case 'inSubquery': {
      // Plans from the SQL front end are not executed yet (ADR 0014, step 6): compiling one gives its static
      // metadata, which the front end compares with the current planner's, and a closure that refuses to run.
      const fn: Fn = () => {
        throw new SmaltError('SMALT_INTERNAL', 'a plan from the SQL front end cannot run yet');
      };
      return { fn, type: typeOf(e), collation: Collation.Binary, collSrc: CollSrc.None, affinity: 'NONE', constant: false };
    }
    case 'col':
      throw new SmaltError('SMALT_INTERNAL', `plan expression ${e.k} cannot be compiled yet`);
  }
}

/** A call of an `sql.*` function: the closure the SQL rules always built for that operator. */
function compileSqlCall(e: Extract<BoundExpr, { k: 'call' }>, ctx: FunctionContext, negated: boolean): Compiled {
  const sub = (x: BoundExpr): Compiled => compilePlanExpr(x, ctx);
  const args = e.args;
  const name = e.fn;
  switch (name) {
    case 'in_list':
      return compileInList(negated, sub(args[0]), args.slice(1).map(sub));
    case 'like':
    case 'glob': {
      const [x, pat, esc] = args.map(sub);
      const { fn } = sqlFunction(e.fn).compile(esc ? [x, pat, esc] : [x, pat], { negated });
      return fold({ fn, type: 'int', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: x.constant && pat.constant && (esc?.constant ?? true) });
    }
    case 'current_date':
    case 'current_time':
    case 'current_timestamp': {
      const kind = name;
      return { fn: () => currentTimeText(kind, ctx.now()), type: 'text', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: false };
    }
    case 'neg':
      return compileUnary('-', sub(args[0]));
    case 'bit_not':
      return compileUnary('~', sub(args[0]));
    default:
      if (e.collation !== undefined) {
        // A comparison: its operands' affinity conversions run inside its closure, after the NULL checks.
        const ops = args.map((x) => {
          if (x.k === 'call' && AFFINITY_CALLS.has(x.fn)) {
            const inner = sub(x.args[0]);
            const real = inner.type === 'real';
            const convert = x.fn === 'affinity_numeric' ? applyNumericAffinity : (v: SqlValue) => applyTextAffinity(v, real);
            return { c: inner, arg: { fn: inner.fn, type: inner.type, convert } };
          }
          const c = sub(x);
          return { c, arg: { fn: c.fn, type: c.type, convert: null } };
        });
        const { fn } = sqlFunction(e.fn).compile(
          ops.map((o) => o.arg),
          { collation: collationId(e.collation) },
        );
        return fold({ fn, type: 'int', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: ops.every((o) => o.c.constant) });
      }
      // Any other operation, with however many arguments it takes (a one-argument operation used to read a second).
      return callN(e.fn, args.map(sub));
  }
}

function callN(name: string, cs: Compiled[]): Compiled {
  const { fn, type } = sqlFunction(name).compile(cs, {});
  return fold({ fn, type, collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: cs.every((c) => c.constant) });
}

function compileScalarCall(e: Extract<BoundExpr, { k: 'call' }>, ctx: FunctionContext): Compiled {
  const def = scalarFunctions.get(e.fn)!;
  const args = e.args.map((a) => compilePlanExpr(a, ctx));
  const compiledArgs: CompiledArg[] = args.map((a) => ({ fn: a.fn, type: a.type, collation: a.collation }));
  const { fn, type } = def.compile(compiledArgs, ctx);
  return fold({ fn, type, collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: def.deterministic && args.every((a) => a.constant) });
}

function regReader(reg: number): Fn {
  return (r) => r[reg];
}

// ------------------------------------------------------------------ unary / logic

function compileUnary(op: string, x: Compiled): Compiled {
  const name = op === 'NOT' ? 'truth_not' : op === '-' ? 'neg' : op === '~' ? 'bit_not' : null;
  if (op === '+') {
    // Unary plus is a no-op that strips affinity and collation (SQLite).
    return fold({ ...x, affinity: 'NONE', collSrc: CollSrc.None, collation: Collation.Binary });
  }
  if (name === null) throw new SmaltError('SMALT_ERROR', `unknown unary operator ${op}`);
  const { fn, type } = sqlFunction(name).compile([x], {});
  return fold({ fn, type, collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: x.constant });
}

function and(a: Compiled, b: Compiled): Compiled {
  const fa = a.fn;
  const fb = b.fn;
  return fold({
    fn: (r) => {
      const x = truthy(fa(r));
      if (x === false) return 0;
      const y = truthy(fb(r));
      if (y === false) return 0;
      return x === null || y === null ? null : 1;
    },
    type: 'int',
    collation: 0,
    collSrc: CollSrc.None,
    affinity: 'NONE',
    constant: a.constant && b.constant,
  });
}

function or(a: Compiled, b: Compiled): Compiled {
  const fa = a.fn;
  const fb = b.fn;
  return fold({
    fn: (r) => {
      const x = truthy(fa(r));
      if (x === true) return 1;
      const y = truthy(fb(r));
      if (y === true) return 1;
      return x === null || y === null ? null : 0;
    },
    type: 'int',
    collation: 0,
    collSrc: CollSrc.None,
    affinity: 'NONE',
    constant: a.constant && b.constant,
  });
}

// ------------------------------------------------------------------ binary operators

/** What the SQL comparison rules read of an operand. */
export type SqlOperand = Pick<Compiled, 'type' | 'affinity' | 'collation' | 'collSrc'>;

/** Collation for a comparison: explicit COLLATE wins, then column collation, left before right. */
export function comparisonCollation(a: SqlOperand, b: SqlOperand): Collation {
  if (a.collSrc === CollSrc.Explicit) return a.collation;
  if (b.collSrc === CollSrc.Explicit) return b.collation;
  if (a.collSrc === CollSrc.Column) return a.collation;
  if (b.collSrc === CollSrc.Column) return b.collation;
  return Collation.Binary;
}

function isNumAff(a: Affinity): boolean {
  return a === 'INTEGER' || a === 'REAL' || a === 'NUMERIC';
}

/**
 * Affinity conversions applied before comparing (SQLite §4.2): numeric affinity is applied to the
 * other operand if it has TEXT/BLOB/no affinity; TEXT affinity to an operand with no affinity.
 */
export function comparisonConverters(a: SqlOperand, b: SqlOperand): [((v: SqlValue) => SqlValue) | null, ((v: SqlValue) => SqlValue) | null] {
  let ca: ((v: SqlValue) => SqlValue) | null = null;
  let cb: ((v: SqlValue) => SqlValue) | null = null;
  if (isNumAff(a.affinity) && !isNumAff(b.affinity)) cb = applyNumericAffinity;
  else if (isNumAff(b.affinity) && !isNumAff(a.affinity)) ca = applyNumericAffinity;
  else if (a.affinity === 'TEXT' && b.affinity === 'NONE') {
    const real = b.type === 'real';
    cb = (v) => applyTextAffinity(v, real);
  } else if (b.affinity === 'TEXT' && a.affinity === 'NONE') {
    const real = a.type === 'real';
    ca = (v) => applyTextAffinity(v, real);
  }
  return [ca, cb];
}

/** An operand of a comparison, in plan terms: its type and its meaning fields (plan/expr.ts `ExprMeaning`). */
export interface ComparisonOperand {
  readonly type: StaticType;
  readonly carries?: ExprMeaning['carries'];
  readonly affinity?: ExprMeaning['affinity'];
}

/**
 * How the engine compares `a` with `b` when they carry these meaning fields (SQLite's rules, which `affinity` and
 * `carries` describe): the collation the comparison uses (an explicit one first, then a column's, the left operand
 * before the right), and the conversion to apply to each side first (`affinity_numeric` or `affinity_text`), or null.
 * A language that writes `affinity` and `carries` builds its comparisons with this, as the engine reads them.
 */
export function comparisonRule(a: ComparisonOperand, b: ComparisonOperand): { collation: CollationName; left: 'affinity_numeric' | 'affinity_text' | null; right: 'affinity_numeric' | 'affinity_text' | null } {
  const operand = (x: ComparisonOperand): SqlOperand => ({
    type: x.type,
    collation: x.carries ? collationId(x.carries.collation) : Collation.Binary,
    collSrc: x.carries ? (x.carries.from === 'explicit' ? CollSrc.Explicit : CollSrc.Column) : CollSrc.None,
    affinity: x.affinity ?? 'NONE',
  });
  const oa = operand(a);
  const ob = operand(b);
  const [ca, cb] = comparisonConverters(oa, ob);
  const name = (c: ((v: SqlValue) => SqlValue) | null): 'affinity_numeric' | 'affinity_text' | null => (c === null ? null : c === applyNumericAffinity ? 'affinity_numeric' : 'affinity_text');
  return { collation: collationName(comparisonCollation(oa, ob)), left: name(ca), right: name(cb) };
}

/** A two-argument `sql.*` function with no front-end options; the result has no affinity or collation. */
function call2(name: string, a: Compiled, b: Compiled): Compiled {
  const { fn, type } = sqlFunction(name).compile([a, b], {});
  return fold({ fn, type, collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: a.constant && b.constant });
}

/** A comparison: SQLite's collation and affinity rules pick the options of `cmp_eq` and the others. */
function comparison(op: string, a: Compiled, b: Compiled): Compiled {
  const coll = comparisonCollation(a, b);
  const [ca, cb] = comparisonConverters(a, b);
  const { fn } = sqlFunction(COMPARISON_FUNCTIONS[op]).compile([{ fn: a.fn, type: a.type, convert: ca }, { fn: b.fn, type: b.type, convert: cb }], { collation: coll });
  return fold({ fn, type: 'int', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: a.constant && b.constant });
}

// ------------------------------------------------------------------ IN, LIKE, CASE, CAST

function compileInList(not: boolean, x: Compiled, list: Compiled[]): Compiled {
  const base = { type: 'int' as StaticType, collation: 0 as Collation, collSrc: CollSrc.None, affinity: 'NONE' as Affinity };
  if (list.length === 0) return konst(not ? 1 : 0, 'int');
  const f = sqlFunction('in_list');
  // All-constant list: hash lookup with the probe's affinity and collation applied up front.
  if (list.every((c) => c.constant)) {
    const collation = x.collSrc !== CollSrc.None ? x.collation : Collation.Binary;
    const probeAffinity = isNumAff(x.affinity) ? 'NUMERIC' : x.affinity === 'TEXT' ? 'TEXT' : 'NONE';
    const { fn } = f.compile([x, ...list], { collation, probeAffinity, negated: not });
    return fold({ ...base, constant: x.constant, fn });
  }
  // Otherwise the probe is compared with each element by `=`.
  const tests = list.map((c) => ({ fn: comparison('=', x, c).fn, type: 'int' as StaticType, constant: false }));
  const { fn } = f.compile([x, ...tests], { negated: not });
  return { ...base, constant: false, fn };
}

function compileCase(e: Extract<BoundExpr, { k: 'case' }>, ctx: FunctionContext): Compiled {
  const whens = e.whens.map((w) => ({ test: compilePlanExpr(w.when, ctx).fn, then: compilePlanExpr(w.then, ctx) }));
  const els = compilePlanExpr(e.else, ctx);
  const thens = whens.map((w) => w.then.fn);
  const tests = whens.map((w) => w.test);
  const elseFn = els.fn;
  const n = tests.length;
  return fold({
    fn: (r) => {
      for (let i = 0; i < n; i++) {
        const v = tests[i](r);
        if (v !== null && truthy(v)) return thens[i](r);
      }
      return elseFn(r);
    },
    type: e.type,
    collation: 0,
    collSrc: CollSrc.None,
    affinity: 'NONE',
    constant: false,
  });
}

/** Evaluate a predicate result as a WHERE condition (NULL and 0 are false). */
export function isTrue(v: SqlValue): boolean {
  if (v === null) return false;
  if (typeof v === 'number') return v !== 0;
  return truthy(v) === true;
}

/** Expression helpers plus row-decoding helpers, for fused pipelines. */
export const CODEGEN_HELPERS_FOR_FUSION = {
  get arith() {
    return CODEGEN_HELPERS.arith;
  },
  negate: (v: SqlValue) => negate(v),
  daysAsUs,
  readInt64,
  utf8: decodeUtf8,
  tagged: decodeTagged,
  rowid: readRowidKey,
};
