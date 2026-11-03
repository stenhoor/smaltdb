/**
 * Types shared by the plan layer (ADR 0014): the engine's own description of a query, which every language's front
 * end produces and the optimizer and physical planner read. The format is experimental until smaltdf has proven it
 * (ADR 0014, section 4), and is versioned on its own.
 */
import type { StaticType } from '../exec/convert.js';

/** Version of the plan format; 0 while it is experimental. */
export const PLAN_FORMAT_VERSION = 0;

/** A value's static type. Today's `StaticType`: `num` is INTEGER or REAL, `any` is not known until run time. */
export type PlanType = StaticType;

/** How text compares and sorts: an explicit attribute of comparisons, sorts, groupings and joins. */
export type CollationName = 'binary' | 'nocase' | 'rtrim';

/** One column of an operation's output. */
export interface Field {
  readonly name: string;
  readonly type: PlanType;
  readonly collation: CollationName;
}

export type Schema = readonly Field[];
