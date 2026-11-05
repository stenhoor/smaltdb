/**
 * Small AST helpers shared by the planner, flattening, morsel analysis and MV matching.
 */
import { aggregateFunctions } from '../exec/functions.js';
import type { Expr } from './ast.js';

const NO_POS = { pos: 0, end: 0 };

const isNode = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !(x instanceof Uint8Array) && Object.getPrototypeOf(x) === Object.prototype;

/**
 * Whether any node in `x` (an AST, or an array of them) satisfies `pred`. `enterSubqueries`
 * false: does not look inside nested SELECT statements.
 */
export function anyNode(x: unknown, pred: (node: Record<string, unknown>) => boolean, enterSubqueries = true): boolean {
  if (Array.isArray(x)) return x.some((y) => anyNode(y, pred, enterSubqueries));
  if (!isNode(x)) return false;
  if (pred(x)) return true;
  if (!enterSubqueries && x.kind === 'select' && 'core' in x) return false;
  for (const k of Object.keys(x)) if (anyNode(x[k], pred, enterSubqueries)) return true;
  return false;
}

/** `a AND b`, either side optional. */
export function and(a: Expr | undefined, b: Expr | undefined): Expr | undefined {
  if (!a) return b;
  if (!b) return a;
  return { kind: 'binary', op: 'AND', left: a, right: b, pos: a.pos, end: a.end } as Expr;
}

/** The conjunction of `list` (undefined when empty). */
export function andAll(list: Expr[]): Expr | undefined {
  return list.reduce<Expr | undefined>((acc, e) => (acc ? ({ kind: 'binary', op: 'AND', left: acc, right: e, ...NO_POS } as Expr) : e), undefined);
}

/** Name of an aggregate function called by `e` (outside nested SELECTs), if any. */
export function aggregateCallName(e: Expr): string | undefined {
  let hit: string | undefined;
  const go = (x: unknown): void => {
    if (hit || x === null || typeof x !== 'object') return;
    if (Array.isArray(x)) return x.forEach(go);
    if (Object.getPrototypeOf(x) !== Object.prototype) return;
    const o = x as Record<string, unknown>;
    if (o.kind === 'select' && 'core' in o) return;
    if (o.kind === 'call' && aggregateFunctions.has(String(o.name)) && o.over === undefined && !((o.name === 'min' || o.name === 'max') && (o.args as unknown[]).length > 1)) {
      hit = String(o.name);
      return;
    }
    for (const k of Object.keys(o)) go(o[k]);
  };
  go(e);
  return hit;
}
