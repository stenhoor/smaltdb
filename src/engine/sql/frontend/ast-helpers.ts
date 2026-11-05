/**
 * Helpers over SQL syntax trees (sql/ast.ts) that the SQL front end uses: structural equality, walking expressions,
 * finding aggregate and window calls, and whether a SELECT reads a table.
 */
import { aggregateFunctions } from '../../exec/functions.js';
import type { CallExpr, Expr, FromItem, SelectCore, SelectStmt } from '../ast.js';

export function sameName(a: string, b: string): boolean {
  return a.length === b.length && a.toLowerCase() === b.toLowerCase();
}

/** Structural AST equality ignoring source positions. */
export function exprEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    if (typeof a === 'string' && typeof b === 'string') return a === b;
    return false;
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((x, i) => x === b[i]);
  }
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => exprEquals(x, b[i]));
  const ka = Object.keys(a).filter((k) => k !== 'pos' && k !== 'end' && (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => k !== 'pos' && k !== 'end' && (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const va = (a as Record<string, unknown>)[k];
    const vb = (b as Record<string, unknown>)[k];
    // Identifiers compare case-insensitively.
    if ((k === 'name' || k === 'table') && typeof va === 'string' && typeof vb === 'string') {
      if (!sameName(va, vb)) return false;
    } else if (!exprEquals(va, vb)) return false;
  }
  return true;
}

/** Visit an expression tree; `visit` returns false to skip children. Does not enter subqueries. */
export function walk(e: Expr, visit: (e: Expr) => boolean | void): void {
  if (visit(e) === false) return;
  switch (e.kind) {
    case 'unary':
      walk(e.operand, visit);
      break;
    case 'binary':
      walk(e.left, visit);
      walk(e.right, visit);
      break;
    case 'between':
      walk(e.expr, visit);
      walk(e.low, visit);
      walk(e.high, visit);
      break;
    case 'inList':
      walk(e.expr, visit);
      e.list.forEach((x) => walk(x, visit));
      break;
    case 'inSelect':
      walk(e.expr, visit);
      break;
    case 'like':
      walk(e.expr, visit);
      walk(e.pattern, visit);
      if (e.escape) walk(e.escape, visit);
      break;
    case 'isNull':
    case 'collate':
    case 'cast':
      walk(e.expr, visit);
      break;
    case 'case':
      if (e.base) walk(e.base, visit);
      for (const w of e.whens) {
        walk(w.when, visit);
        walk(w.then, visit);
      }
      if (e.else) walk(e.else, visit);
      break;
    case 'call':
      e.args.forEach((x) => walk(x, visit));
      if (e.filter) walk(e.filter, visit);
      break;
    default:
      break;
  }
}

/** A call that is an aggregate (not a window function, not scalar min/max of several arguments). */
export function isAggregateCall(e: Expr): e is CallExpr {
  return e.kind === 'call' && aggregateFunctions.has(e.name) && !((e.name === 'min' || e.name === 'max') && e.args.length > 1) && e.over === undefined;
}

export function containsAggregate(e: Expr | undefined): boolean {
  if (!e || e.kind === 'column' || e.kind === 'literal' || e.kind === 'param') return false;
  let found = false;
  walk(e, (x) => {
    if (isAggregateCall(x)) {
      found = true;
      return false;
    }
  });
  return found;
}

/** Whether a FROM tree (or a nested FROM subquery) names `name` as a table. */
function fromReferences(f: FromItem | undefined, name: string): boolean {
  if (!f) return false;
  switch (f.kind) {
    case 'table':
      return !f.schema && sameName(f.name, name);
    case 'join':
      return fromReferences(f.left, name) || fromReferences(f.right, name);
    case 'subquery':
      return selectReferences(f.select, name);
    default:
      return false;
  }
}

export function coreReferences(core: SelectCore, name: string): boolean {
  return core.kind === 'select' && fromReferences(core.from, name);
}

/** Whether a SELECT reads table `name` in one of its FROM clauses (the recursion of a CTE). */
export function selectReferences(s: SelectStmt, name: string): boolean {
  if (s.with?.ctes.some((c) => sameName(c.name, name))) return false; // shadowed
  return coreReferences(s.core, name) || s.compound.some((c) => coreReferences(c.core, name));
}

/** The first window function call (`f(...) OVER ...`) in `e`, if any. */
export function firstWindowCall(e: Expr): CallExpr | undefined {
  let found: CallExpr | undefined;
  walk(e, (x) => {
    if (found) return false;
    if (x.kind === 'call' && x.over !== undefined) {
      found = x;
      return false;
    }
  });
  return found;
}

/** The first aggregate call in `e`, if any. */
export function firstAggregateCall(e: Expr): CallExpr | undefined {
  let found: CallExpr | undefined;
  walk(e, (x) => {
    if (found) return false;
    if (isAggregateCall(x)) {
      found = x as CallExpr;
      return false;
    }
  });
  return found;
}

export function containsWindow(e: Expr | undefined): boolean {
  if (!e || e.kind === 'column' || e.kind === 'literal' || e.kind === 'param') return false;
  let found = false;
  walk(e, (x) => {
    if (x.kind === 'call' && x.over !== undefined) {
      found = true;
      return false;
    }
  });
  return found;
}
