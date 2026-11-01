/**
 * Small AST helpers shared by the planner, flattening, morsel analysis and MV matching.
 */
import type { Expr } from './ast.js';

const NO_POS = { pos: 0, end: 0 };

/**
 * Structural key of an expression: equal keys mean equal expressions, positions ignored. Object
 * keys are sorted (nodes built in code and by the parser compare equal) and `undefined` fields are
 * skipped.
 * - `foldNames`: identifier names compare case-insensitively.
 * - `ignoreQualifiers`: `t.a` and `a` compare equal (drops `table` / `schema`).
 */
export function exprKey(e: unknown, opts: { foldNames?: boolean; ignoreQualifiers?: boolean } = {}): string {
  const canon = (v: unknown, key: string): unknown => {
    if (typeof v === 'bigint') return `${v}n`;
    if (v instanceof Uint8Array) return { bytes: [...v] };
    if (Array.isArray(v)) return v.map((x) => canon(x, ''));
    if (typeof v === 'string') return opts.foldNames && key === 'name' ? v.toLowerCase() : v;
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (k === 'pos' || k === 'end' || x === undefined) continue;
        if (opts.ignoreQualifiers && (k === 'table' || k === 'schema')) continue;
        out[k] = canon(x, k);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(canon(e, ''));
}

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
