/**
 * What the planner and code generation know about an operation (ADR 0016 section 1): its traits, declared by the
 * function where it is defined. Access paths, zone maps, equi-joins, selectivity, range estimates and inline code
 * generation read traits, never function names, so an operation gets the same optimizations whatever it is called
 * and whichever language uses it.
 */
import { scalarFunctions } from './functions.js';
import { SQL_FUNCTIONS } from './sql-functions.js';

/** A comparison operator. */
export type CompareOp = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'IS' | 'IS NOT';

/** What generated code can emit for a call inline (an emitter of exec/codegen.ts). */
export type InlineForm = '+' | '-' | '*' | '/' | '%' | 'neg' | '=' | '!=' | '<' | '<=' | '>' | '>=';

export interface FnTraits {
  /**
   * A comparison of its two arguments in SQLite's value order (storage class, then value, under the call's
   * collation), so index and rowid probes, zone maps and join methods may use it. `=` comparisons are equi-joins.
   */
  readonly compare?: CompareOp;
  /** The form code generation emits inline over numbers (and, for comparisons, text under BINARY). */
  readonly inline?: InlineForm;
  /** A constant offset of its first argument by its second (`x + k`: 1, `x - k`: -1), for range estimates. */
  readonly offset?: 1 | -1;
  /** The negation of a number, for range estimates. */
  readonly negation?: true;
  /** Membership of its first argument in the others. */
  readonly inList?: true;
  /** A pattern match (for selectivity). */
  readonly pattern?: true;
  /**
   * A conversion that only prepares an operand for a comparison (SQL's affinity conversions): probes, joins and
   * zone maps match the operand beneath it, and apply the conversion to their keys.
   */
  readonly comparisonConversion?: true;
}

const NONE: FnTraits = {};

/** The traits of the function `fn` (none for a function that declares none, or an unknown name). */
export function traitsOf(fn: string): FnTraits {
  return SQL_FUNCTIONS.get(fn)?.traits ?? scalarFunctions.get(fn)?.traits ?? NONE;
}

/** `x` without the comparison-only conversion around it, if it has one. */
export function withoutComparisonConversion<E extends { k: string; fn?: string; args?: readonly unknown[] }>(x: E): E {
  return x.k === 'call' && traitsOf(x.fn!).comparisonConversion ? (x.args![0] as E) : x;
}
