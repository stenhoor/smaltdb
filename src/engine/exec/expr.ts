import { SmaltError } from '../errors.js';
import { storageTypeFor } from '../catalog/schema.js';
import type { CallExpr, ColumnExpr, Expr, SelectStmt } from '../sql/ast.js';
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
import { ARITHMETIC_FUNCTIONS, BITWISE_FUNCTIONS, COMPARISON_FUNCTIONS, arithImpl, negate, sqlFunction } from './sql-functions.js';
import { type CompiledArg, type Fn, type FunctionContext, aggregateFunctions, scalarFunctions } from './functions.js';
import { type CodegenHelpers, codegenEnabled, generate, isCodegenRoot } from './codegen.js';
import { WINDOW_ARITY } from './window.js';
import { decodeTagged, decodeUtf8, readInt64 } from '../storage/record.js';
import { readRowidKey } from '../storage/key-codec.js';

export type { Fn };

/** Where a compiled expression's collation came from (SQLite precedence: explicit > column > none). */
export const enum CollSrc {
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

export interface ColumnBinding {
  reg: number;
  type: StaticType;
  collation: Collation;
  affinity: Affinity;
  /** The name resolved to a select-list alias: use this compiled expression instead of a register. */
  compiled?: Compiled;
}

/** Name resolution and planner callbacks used while compiling expressions. */
export interface CompileScope {
  resolveColumn(e: ColumnExpr): ColumnBinding;
  /** Post-aggregation context: maps an aggregate call (or GROUP BY expression) to its register. */
  aggregateRef?(call: CallExpr): ColumnBinding;
  groupRef?(e: Expr): ColumnBinding | undefined;
  /** Result-column context of a query with window functions: maps an `f(...) OVER (...)` call to its register. */
  windowRef?(call: CallExpr): ColumnBinding;
  scalarSubquery(select: SelectStmt): Compiled;
  existsSubquery(select: SelectStmt): Fn;
  /** Returns membership test: 1, 0, or NULL (SQL IN semantics) for a probe value. */
  inSubquery(select: SelectStmt, probe: Compiled): Fn;
  funcCtx: FunctionContext;
}

const NO_REGS: SqlValue[] = [];

function konst(v: SqlValue, type: StaticType, affinity: Affinity = 'NONE'): Compiled {
  return { fn: () => v, type, collation: Collation.Binary, collSrc: CollSrc.None, affinity, constant: true };
}

function literalType(v: SqlValue, isReal: boolean | undefined): StaticType {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'number':
      return isReal || !Number.isSafeInteger(v) ? 'real' : 'int';
    case 'bigint':
      return 'int';
    case 'string':
      return 'text';
    default:
      return 'blob';
  }
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

function isNumericType(t: StaticType): boolean {
  return t === 'int' || t === 'real' || t === 'num';
}

/**
 * Compile an expression. Arithmetic / comparison / logic roots are compiled to generated
 * JavaScript when allowed (see codegen.ts); everything else uses the closure compiler.
 */
export function compileExpr(e: Expr, scope: CompileScope): Compiled {
  if (e.kind === 'call' && codegenEnabled() && isCodegenRoot(e)) {
    // A math call: keep the closure compiler's result when it is constant (folded) or a register read.
    const c = compileNode(e, scope);
    if (c.constant || c.reg !== undefined) return c;
  }
  if (codegenEnabled() && isCodegenRoot(e) && hasRuntimeInputs(e) && !scope.groupRef?.(e)) {
    const g = generate(
      e,
      CODEGEN_HELPERS,
      (x) => compileNode(x, scope),
      (x) => {
        const b = scope.groupRef?.(x);
        return b ? { reg: b.reg, type: b.type } : undefined;
      },
    );
    return { fn: g.fn, type: g.type, collation: Collation.Binary, collSrc: CollSrc.None, affinity: 'NONE', constant: false };
  }
  return compileNode(e, scope);
}

/** True if the expression reads registers (columns, parameters, aggregates, subqueries). */
function hasRuntimeInputs(e: Expr): boolean {
  let found = false;
  const visit = (x: Expr): void => {
    if (found) return;
    switch (x.kind) {
      case 'column':
      case 'param':
      case 'call':
      case 'subquery':
      case 'exists':
      case 'inSelect':
        found = true;
        return;
      case 'binary':
        visit(x.left);
        visit(x.right);
        return;
      case 'unary':
        visit(x.operand);
        return;
      default:
        found = true; // anything else: let the generator decide via fallback
    }
  };
  visit(e);
  return found;
}

const CODEGEN_HELPERS: CodegenHelpers = {
  arith: Object.fromEntries(['+', '-', '*', '/', '%'].flatMap((op) => [[op, arithImpl(op, false)], [op + 'R', arithImpl(op, true)]])),
  negate: (v) => negate(v),
};

/** The closure compiler (defines expression semantics). */
export function compileNode(e: Expr, scope: CompileScope): Compiled {
  if (scope.groupRef) {
    const g = scope.groupRef(e);
    if (g) return { fn: regReader(g.reg), type: g.type, collation: g.collation, collSrc: g.collation ? CollSrc.Column : CollSrc.None, affinity: g.affinity, constant: false, reg: g.reg };
  }
  switch (e.kind) {
    case 'literal':
      return konst(e.value, literalType(e.value, e.isReal));
    case 'param': {
      const reg = e.index - 1;
      return { fn: (r) => r[reg], type: 'any', collation: Collation.Binary, collSrc: CollSrc.None, affinity: 'NONE', constant: false, reg };
    }
    case 'column': {
      const b = scope.resolveColumn(e);
      if (b.compiled) return b.compiled;
      return {
        fn: regReader(b.reg),
        type: b.type,
        collation: b.collation,
        collSrc: CollSrc.Column,
        affinity: b.affinity,
        constant: false,
        reg: b.reg,
      };
    }
    case 'collate': {
      const inner = compileNode(e.expr, scope);
      const c = collationByName(e.collation);
      if (c === undefined) throw new SmaltError('SMALT_ERROR', `no such collation sequence: ${e.collation}`);
      return { ...inner, collation: c, collSrc: CollSrc.Explicit };
    }
    case 'unary':
      return compileUnary(e.op, compileNode(e.operand, scope));
    case 'binary':
      return compileBinary(e.op, e.left, e.right, scope);
    case 'between': {
      const x = compileNode(e.expr, scope);
      const lo = compileNode(e.low, scope);
      const hi = compileNode(e.high, scope);
      const ge = comparison('>=', x, lo);
      const le = comparison('<=', x, hi);
      const both = and(ge, le);
      return e.not ? compileUnary('NOT', both) : both;
    }
    case 'isNull': {
      const x = compileNode(e.expr, scope);
      const f = x.fn;
      const not = e.not;
      return fold({ fn: (r) => ((f(r) === null) !== not ? 1 : 0), type: 'int', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: x.constant });
    }
    case 'inList':
      return compileInList(e.not, compileNode(e.expr, scope), e.list.map((x) => compileNode(x, scope)));
    case 'inSelect': {
      const probe = compileNode(e.expr, scope);
      const test = scope.inSubquery(e.select, probe);
      const fn: Fn = e.not
        ? (r) => {
            const v = test(r);
            return v === null ? null : v === 1 ? 0 : 1;
          }
        : test;
      return { fn, type: 'int', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: false };
    }
    case 'exists': {
      const f = scope.existsSubquery(e.select);
      const fn: Fn = e.not ? (r) => (f(r) === 1 ? 0 : 1) : f;
      return { fn, type: 'int', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: false };
    }
    case 'subquery':
      return scope.scalarSubquery(e.select);
    case 'like':
      return compileLike(e.op, e.not, compileNode(e.expr, scope), compileNode(e.pattern, scope), e.escape ? compileNode(e.escape, scope) : undefined);
    case 'case':
      return compileCase(e, scope);
    case 'cast':
      return compileCast(compileNode(e.expr, scope), e.type);
    case 'call':
      return compileCall(e, scope);
  }
}

function regReader(reg: number): Fn {
  return (r) => r[reg];
}

// ------------------------------------------------------------------ unary / logic

function compileUnary(op: string, x: Compiled): Compiled {
  const name = op === 'NOT' ? 'sql.not' : op === '-' ? 'sql.neg' : op === '~' ? 'sql.bitnot' : null;
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

function compileBinary(op: string, le: Expr, re: Expr, scope: CompileScope): Compiled {
  const a = compileNode(le, scope);
  const b = compileNode(re, scope);
  switch (op) {
    case 'AND':
      return and(a, b);
    case 'OR':
      return or(a, b);
    case '=':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=':
    case 'IS':
    case 'IS NOT':
      return comparison(op, a, b);
    case '+':
    case '-':
    case '*':
    case '/':
    case '%':
      return arithmetic(op, a, b);
    case '||':
      return call2('sql.concat', a, b);
    case '&':
    case '|':
    case '<<':
    case '>>':
      return call2(BITWISE_FUNCTIONS[op], a, b);
    default:
      throw new SmaltError('SMALT_UNSUPPORTED', `operator ${op} is not supported yet`);
  }
}

/** Collation for a comparison: explicit COLLATE wins, then column collation, left before right. */
export function comparisonCollation(a: Compiled, b: Compiled): Collation {
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
export function comparisonConverters(a: Compiled, b: Compiled): [((v: SqlValue) => SqlValue) | null, ((v: SqlValue) => SqlValue) | null] {
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

/** A two-argument `sql.*` function with no front-end options; the result has no affinity or collation. */
function call2(name: string, a: Compiled, b: Compiled): Compiled {
  const { fn, type } = sqlFunction(name).compile([a, b], {});
  return fold({ fn, type, collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: a.constant && b.constant });
}

/** A comparison: SQLite's collation and affinity rules pick the options of `sql.eq` and the others. */
function comparison(op: string, a: Compiled, b: Compiled): Compiled {
  const coll = comparisonCollation(a, b);
  const [ca, cb] = comparisonConverters(a, b);
  const { fn } = sqlFunction(COMPARISON_FUNCTIONS[op]).compile([{ fn: a.fn, type: a.type, convert: ca }, { fn: b.fn, type: b.type, convert: cb }], { collation: coll });
  return fold({ fn, type: 'int', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: a.constant && b.constant });
}

function arithmetic(op: string, a: Compiled, b: Compiled): Compiled {
  return call2(ARITHMETIC_FUNCTIONS[op], a, b);
}

// ------------------------------------------------------------------ IN, LIKE, CASE, CAST

function compileInList(not: boolean, x: Compiled, list: Compiled[]): Compiled {
  const base = { type: 'int' as StaticType, collation: 0 as Collation, collSrc: CollSrc.None, affinity: 'NONE' as Affinity };
  if (list.length === 0) return konst(not ? 1 : 0, 'int');
  const f = sqlFunction('sql.in_list');
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

function compileLike(op: string, not: boolean, x: Compiled, pat: Compiled, escape?: Compiled): Compiled {
  if (op !== 'LIKE' && op !== 'GLOB') throw new SmaltError('SMALT_ERROR', `no such function: ${op.toLowerCase()}`);
  const { fn } = sqlFunction(op === 'GLOB' ? 'sql.glob' : 'sql.like').compile(escape ? [x, pat, escape] : [x, pat], { negated: not });
  return fold({
    fn,
    type: 'int',
    collation: 0,
    collSrc: CollSrc.None,
    affinity: 'NONE',
    constant: x.constant && pat.constant && (escape?.constant ?? true),
  });
}

function compileCase(e: Extract<Expr, { kind: 'case' }>, scope: CompileScope): Compiled {
  const base = e.base ? compileNode(e.base, scope) : undefined;
  const whens = e.whens.map((w) => {
    const when = compileNode(w.when, scope);
    const test = base ? comparison('=', base, when).fn : when.fn;
    return { test, then: compileNode(w.then, scope) };
  });
  const els = e.else ? compileNode(e.else, scope) : konst(null, 'null');
  const thens = whens.map((w) => w.then.fn);
  const tests = whens.map((w) => w.test);
  const elseFn = els.fn;
  const types = [...whens.map((w) => w.then.type), els.type].filter((t) => t !== 'null');
  let type: StaticType = types.length === 0 ? 'null' : types[0];
  for (const t of types) if (t !== type) type = isNumericType(t) && isNumericType(type) ? 'num' : 'any';
  const n = tests.length;
  return fold({
    fn: (r) => {
      for (let i = 0; i < n; i++) {
        const v = tests[i](r);
        if (v !== null && truthy(v)) return thens[i](r);
      }
      return elseFn(r);
    },
    type,
    collation: 0,
    collSrc: CollSrc.None,
    affinity: 'NONE',
    constant: false,
  });
}

const CAST_FUNCTIONS: Record<string, string> = { INTEGER: 'sql.cast_integer', REAL: 'sql.cast_real', TEXT: 'sql.cast_text', BLOB: 'sql.cast_blob' };

function compileCast(x: Compiled, typeName: string): Compiled {
  const st = storageTypeFor(typeName);
  const { fn } = sqlFunction(CAST_FUNCTIONS[st] ?? 'sql.cast_numeric').compile([x], {});
  const affinity = st === 'ANY' ? 'NUMERIC' : affinityOfStorage(st);
  const type = st === 'ANY' || st === 'NUMERIC' ? 'num' : staticTypeOfStorage(st);
  return fold({ fn, type, collation: x.collation, collSrc: x.collSrc, affinity, constant: x.constant });
}

function compileCall(e: CallExpr, scope: CompileScope): Compiled {
  if (e.over !== undefined) {
    if (!scope.windowRef) throw new SmaltError('SMALT_ERROR', `misuse of window function ${e.name}()`);
    const b = scope.windowRef(e);
    return { fn: regReader(b.reg), type: b.type, collation: b.collation, collSrc: CollSrc.None, affinity: 'NONE', constant: false, reg: b.reg };
  }
  const name = e.name;
  const isAgg = aggregateFunctions.has(name) && !((name === 'min' || name === 'max') && e.args.length > 1);
  if (isAgg) {
    if (!scope.aggregateRef) throw new SmaltError('SMALT_ERROR', `misuse of aggregate function ${name}()`);
    const b = scope.aggregateRef(e);
    return { fn: regReader(b.reg), type: b.type, collation: b.collation, collSrc: CollSrc.None, affinity: 'NONE', constant: false, reg: b.reg };
  }
  if (e.distinct || e.star || e.filter) throw new SmaltError('SMALT_ERROR', `DISTINCT/FILTER/* is only valid with aggregate functions`);
  if (name === 'current_time' || name === 'current_date' || name === 'current_timestamp') {
    const ctx = scope.funcCtx;
    return { fn: () => currentTimeText(name, ctx.now()), type: 'text', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: false };
  }
  const def = scalarFunctions.get(name);
  if (!def) {
    if (Object.hasOwn(WINDOW_ARITY, name)) {
      // A window-only function without OVER (SQLite checks the argument count first).
      const [lo, hi] = WINDOW_ARITY[name];
      if (e.args.length < lo || e.args.length > hi) throw new SmaltError('SMALT_ERROR', `wrong number of arguments to function ${name}()`);
      throw new SmaltError('SMALT_ERROR', `misuse of window function ${name}()`);
    }
    throw new SmaltError('SMALT_ERROR', `no such function: ${name}`);
  }
  const n = e.args.length;
  if (n < def.minArgs || (def.maxArgs >= 0 && n > def.maxArgs)) throw new SmaltError('SMALT_ERROR', `wrong number of arguments to function ${name}()`);
  if (name === 'likelihood') {
    // SQLite: the probability must be a REAL literal (not an integer, not negated) from 0.0 to 1.0.
    const p = e.args[1];
    if (p.kind !== 'literal' || !p.isReal || typeof p.value !== 'number' || Object.is(p.value, -0) || !(p.value >= 0 && p.value <= 1))
      throw new SmaltError('SMALT_ERROR', 'second argument to likelihood() must be a constant between 0.0 and 1.0');
  }
  const args = e.args.map((a) => compileNode(a, scope));
  const compiledArgs: CompiledArg[] = args.map((a) => ({ fn: a.fn, type: a.type, collation: a.collation }));
  const { fn, type } = def.compile(compiledArgs, scope.funcCtx);
  // Collation of a function result: from its first argument when that argument carries one.
  const collSrc = args[0]?.collSrc === CollSrc.Explicit ? CollSrc.Explicit : CollSrc.None;
  return fold({ fn, type, collation: collSrc ? args[0].collation : 0, collSrc, affinity: 'NONE', constant: def.deterministic && args.every((a) => a.constant) });
}

/** Split a predicate into AND-ed conjuncts. */
export function conjuncts(e: Expr | undefined, out: Expr[] = []): Expr[] {
  if (!e) return out;
  if (e.kind === 'binary' && e.op === 'AND') {
    conjuncts(e.left, out);
    conjuncts(e.right, out);
  } else out.push(e);
  return out;
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
  readInt64,
  utf8: decodeUtf8,
  tagged: decodeTagged,
  rowid: readRowidKey,
};
