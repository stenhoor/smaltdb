/**
 * The conversion table (ADR 0027, decision 3): how a value of one plan type becomes a value of another, and whether
 * that is lossless. It is decided by the two types alone, never by the values a database holds, so every language
 * gets the same answer for the same change: an interface view (ADR 0027) accepts a change of a column's type only when
 * it is lossless, and a language that rebuilds a table (smaltts) converts each column with the operation named here.
 *
 * A storage type's plan type is `planTypeOfStorage` (plan/catalog.ts): NUMERIC and ANY columns are both `any`.
 */
import { parseNested, isNested } from '../../shared/nested-types.js';
import type { PlanType } from './types.js';

/** How a value of one plan type becomes one of another. */
export interface Conversion {
  /** `none`: exact for every value of the old type. `possible`: some values change, or fail to convert. */
  readonly loss: 'none' | 'possible';
  /** The operation that converts, applied as a call (`call(fn, [value], to)`); absent: the value is kept as it is. */
  readonly fn?: string;
}

const KEEP: Conversion = { loss: 'none' };
const lossless = (fn: string): Conversion => ({ loss: 'none', fn });
const lossy = (fn: string): Conversion => ({ loss: 'possible', fn });
const TEXT = lossless('cast_text');

/** Conversions between simple types, by old type, then new type. A pair that is not here has no conversion. */
const TABLE: Readonly<Record<string, Readonly<Record<string, Conversion>>>> = {
  int: { num: KEEP, any: KEEP, text: TEXT, real: lossy('cast_real') },
  real: { num: KEEP, any: KEEP, text: TEXT, int: lossy('cast_integer_strict') },
  num: { any: KEEP, text: TEXT, int: lossy('cast_integer_strict'), real: lossy('cast_real_strict') },
  bool: { int: KEEP, num: KEEP, any: KEEP, real: lossless('cast_real'), text: TEXT },
  text: {
    any: KEEP,
    blob: lossless('cast_blob'),
    num: lossy('cast_numeric'),
    int: lossy('cast_integer_strict'),
    real: lossy('cast_real_strict'),
    date: lossy('cast_date'),
    datetime: lossy('cast_datetime'),
    time: lossy('cast_time'),
  },
  blob: { any: KEEP },
  // A temporal value is an integer underneath (ADR 0019): kept as it is under `any`, it would read as that integer.
  date: { datetime: lossless('cast_datetime'), text: TEXT, any: TEXT },
  datetime: { text: TEXT, any: TEXT, date: lossy('cast_date'), time: lossy('cast_time') },
  time: { text: TEXT, any: TEXT },
  duration: { text: TEXT, any: TEXT },
  any: { text: lossy('cast_text'), num: lossy('cast_numeric'), blob: lossy('cast_blob') },
};

/**
 * How a value of plan type `from` becomes one of plan type `to`, or undefined when there is no conversion. The same
 * type keeps its values; NULL converts to anything. A list or struct becomes TEXT (its JSON text) and ANY the same way;
 * a list becomes another list, and a struct a struct with the same field names in order, when each element or field
 * is kept as it is (no operation converts a list's elements).
 */
export function conversion(from: PlanType, to: PlanType): Conversion | undefined {
  if (from === to || from === 'null') return KEEP;
  if (isNested(from)) {
    if (to === 'text' || to === 'any') return TEXT;
    return isNested(to) ? nestedConversion(from, to) : undefined;
  }
  return TABLE[from]?.[to];
}

/** A list or struct as another: kept as it is when every element or field is, losslessly or not. */
function nestedConversion(from: string, to: string): Conversion | undefined {
  const a = parseNested(from);
  const b = parseNested(to);
  if (!a || !b || a.kind !== b.kind) return undefined;
  const pairs: [string, string][] = [];
  if (a.kind === 'list' && b.kind === 'list') pairs.push([a.of, b.of]);
  else if (a.kind === 'struct' && b.kind === 'struct') {
    if (a.fields.length !== b.fields.length) return undefined;
    for (let i = 0; i < a.fields.length; i++) {
      if (a.fields[i]!.name !== b.fields[i]!.name) return undefined;
      pairs.push([a.fields[i]!.type, b.fields[i]!.type]);
    }
  }
  let loss: Conversion['loss'] = 'none';
  for (const [x, y] of pairs) {
    const c = conversion(x as PlanType, y as PlanType);
    if (!c || c.fn !== undefined) return undefined;
    if (c.loss === 'possible') loss = 'possible';
  }
  return loss === 'none' ? KEEP : { loss };
}

/** Whether every value of type `from` is exactly a value of type `to` (ADR 0027): a conversion with no loss. */
export const isLossless = (from: PlanType, to: PlanType): boolean => conversion(from, to)?.loss === 'none';
