/** Text form of plan expressions, for tests, debugging and (later) EXPLAIN. */
import type { SqlValue } from '../values.js';
import type { PlanExpr } from './expr.js';

function literal(v: SqlValue): string {
  if (v === null) return 'NULL';
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  if (v instanceof Uint8Array) return `X'${Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()}'`;
  return String(v);
}

/**
 * `#input.index` for a column (with `^depth` when it reads an enclosing operation), `$n` for a parameter, and
 * `fn(args)` for calls, with `[collation]` when one is set.
 */
export function printExpr(e: PlanExpr): string {
  switch (e.k) {
    case 'col':
      return `#${e.input}.${e.index}${e.depth ? `^${e.depth}` : ''}`;
    case 'lit':
      return literal(e.value);
    case 'param':
      return `$${e.index}`;
    case 'call':
      return `${e.fn}(${e.args.map(printExpr).join(', ')})${e.collation && e.collation !== 'binary' ? `[${e.collation}]` : ''}`;
    case 'cast':
      return `${e.fn}(${printExpr(e.arg)})`;
    case 'and':
    case 'or':
      return `(${e.args.map(printExpr).join(` ${e.k} `)})`;
    case 'not':
      return `not ${printExpr(e.arg)}`;
    case 'isNull':
      return `${printExpr(e.arg)} is${e.not ? ' not' : ''} null`;
    case 'case':
      return `case ${e.whens.map((w) => `when ${printExpr(w.when)} then ${printExpr(w.then)}`).join(' ')} else ${printExpr(e.else)} end`;
    case 'subquery':
      return `${e.mode}(<${e.plan.op}>)`;
    case 'inSubquery':
      return `${printExpr(e.probe)} in (<${e.plan.op}>)`;
    case 'slot':
      return `r${e.reg}`;
    case 'native':
      return '<compiled>';
  }
}
