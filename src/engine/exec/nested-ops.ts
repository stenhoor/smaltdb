/**
 * The list and struct operations (ADR 0020, section 4): building, the `list_*` operations, `struct_field`, the
 * `implode` aggregate, and lists and structs as JSON text. A value is a blob of index-key components (see
 * `src/shared/nested.ts`); an operation decodes what it needs and encodes what it gives.
 */
import { SmaltError } from '../errors.js';
import { decodeKey, encodeKey } from '../storage/key-codec.js';
import { Collation, type SqlValue, compareValues } from '../values.js';
import { type NestedTypeName, isNested, parseNested } from '../../shared/nested-types.js';
import { isTemporal, temporalText } from '../../shared/temporal.js';
import { type StaticType, toText } from './convert.js';
import type { AggregateFunction, AggregateState, CompiledArg, ScalarFunction } from './functions.js';

const mismatch = (message: string): SmaltError => new SmaltError('SMALT_MISMATCH', message);

/** The element type of list type `t`, or an error naming `fn`. */
function listOf(fn: string, t: StaticType): string {
  if (t === 'null') return 'null';
  const n = isNested(t) ? parseNested(t) : null;
  if (!n || n.kind !== 'list') throw mismatch(`${fn} takes a list, not ${t}`);
  return n.of;
}

function bytesOf(v: SqlValue, fn: string): Uint8Array {
  if (v instanceof Uint8Array) return v;
  throw mismatch(`${fn} takes a list or struct value, not ${typeof v === 'string' ? 'text' : typeof v}`);
}

/**
 * The elements of `bytes`, remembered for the last list decoded. `explode` reads one list's length and its elements
 * position by position, the same bytes each time: without this, a list of n elements costs n decodes of n elements.
 * Callers must not change the array.
 */
let lastBytes: Uint8Array | null = null;
let lastValues: readonly SqlValue[] = [];
function elements(bytes: Uint8Array): readonly SqlValue[] {
  if (bytes !== lastBytes) {
    lastValues = decodeKey(bytes);
    lastBytes = bytes;
  }
  return lastValues;
}

function op(
  name: string,
  min: number,
  max: number,
  result: (args: readonly Pick<CompiledArg, 'type'>[]) => StaticType,
  make: (args: CompiledArg[]) => (vals: SqlValue[]) => SqlValue,
): [string, ScalarFunction] {
  return [
    name,
    {
      minArgs: min,
      maxArgs: max,
      deterministic: true,
      resultType: (args) => result(args),
      compile(args) {
        const impl = make(args);
        const fns = args.map((a) => a.fn);
        const n = fns.length;
        const buf: SqlValue[] = new Array(n).fill(null);
        return {
          type: result(args),
          fn: (r) => {
            for (let i = 0; i < n; i++) buf[i] = fns[i]!(r);
            return impl(buf);
          },
        };
      },
    },
  ];
}

/** The type of a list of `ts`: their common type, or `any` when they differ (a NULL takes the others' type). */
function common(ts: readonly StaticType[]): string {
  const known = ts.filter((t) => t !== 'null');
  if (known.length === 0) return 'null';
  return known.every((t) => t === known[0]) ? known[0]! : 'any';
}

const sameAsFirst = (args: readonly Pick<CompiledArg, 'type'>[]): StaticType => args[0]!.type;
const elementOf = (fn: string) => (args: readonly Pick<CompiledArg, 'type'>[]): StaticType => listOf(fn, args[0]!.type) as StaticType;

/** A whole number argument, or an error. */
function intArg(v: SqlValue, fn: string, what: string): number {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  throw mismatch(`${fn}: ${what} must be an integer`);
}

const numberOf = (v: SqlValue): number | null => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null);

/** Reduce the non-null numbers of a list. */
function reduce(name: string, f: (xs: number[], vals: SqlValue[]) => SqlValue, type: (el: string) => StaticType): [string, ScalarFunction] {
  return op(name, 1, 1, (a) => type(listOf(name, a[0]!.type)), ([a]) => {
    listOf(name, a!.type);
    return ([v]) => {
      if (v === null) return null;
      const vals = decodeKey(bytesOf(v, name)).filter((x) => x !== null);
      const xs: number[] = [];
      for (const x of vals) {
        const n = numberOf(x);
        if (n === null) throw mismatch(`${name} takes a list of numbers, not of ${typeof x === 'string' ? 'text' : 'blobs'}`);
        xs.push(n);
      }
      return f(xs, vals);
    };
  });
}

const sumType = (el: string): StaticType => (el === 'int' || el === 'bool' ? 'int' : el === 'real' ? 'real' : 'num');

const LIST_OPS: [string, ScalarFunction][] = [
  op('list_of', 0, -1, (a) => `list<${common(a.map((x) => x.type)) === 'null' ? 'any' : common(a.map((x) => x.type))}>` as StaticType, () => (v) => encodeKey(v)),
  op('struct_of', 1, -1, (a) => `struct<${a.map((x, i) => `f${i} ${x.type === 'null' ? 'any' : x.type}`).join(', ')}>` as StaticType, () => (v) => encodeKey(v)),
  op('list_len', 1, 1, () => 'int', ([a]) => {
    listOf('list_len', a!.type);
    return ([v]) => (v === null ? null : elements(bytesOf(v, 'list_len')).length);
  }),
  op('list_get', 2, 2, elementOf('list_get'), ([a]) => {
    listOf('list_get', a!.type);
    return ([v, i]) => {
      if (v === null || i === null) return null;
      const vals = elements(bytesOf(v, 'list_get'));
      const k = intArg(i, 'list_get', 'the index');
      const at = k < 0 ? vals.length + k : k;
      return at >= 0 && at < vals.length ? vals[at]! : null;
    };
  }),
  op('list_contains', 2, 2, () => 'bool', ([a]) => {
    listOf('list_contains', a!.type);
    return ([v, x]) => {
      if (v === null) return null;
      const vals = decodeKey(bytesOf(v, 'list_contains'));
      if (x === null) return vals.includes(null) ? 1 : 0;
      return vals.some((e) => e !== null && compareValues(e, x, Collation.Binary) === 0) ? 1 : 0;
    };
  }),
  op('list_slice', 2, 3, sameAsFirst, ([a]) => {
    listOf('list_slice', a!.type);
    return ([v, off, len]) => {
      if (v === null || off === null) return null;
      const vals = decodeKey(bytesOf(v, 'list_slice'));
      const o = intArg(off, 'list_slice', 'the offset');
      const start = Math.max(0, o < 0 ? vals.length + o : o);
      const end = len === undefined || len === null ? vals.length : start + Math.max(0, intArg(len, 'list_slice', 'the length'));
      return encodeKey(vals.slice(start, end));
    };
  }),
  // The encoding is the elements one after another, so concatenation is of the bytes.
  op('list_concat', 2, 2, sameAsFirst, ([a, b]) => {
    listOf('list_concat', a!.type);
    listOf('list_concat', b!.type);
    return ([x, y]) => {
      if (x === null || y === null) return null;
      const bx = bytesOf(x, 'list_concat');
      const by = bytesOf(y, 'list_concat');
      const out = new Uint8Array(bx.length + by.length);
      out.set(bx);
      out.set(by, bx.length);
      return out;
    };
  }),
  op('list_join', 2, 2, () => 'text', ([a]) => {
    const el = listOf('list_join', a!.type);
    return ([v, sep]) => {
      if (v === null || sep === null) return null;
      const vals = decodeKey(bytesOf(v, 'list_join')).filter((x) => x !== null);
      return vals.map((x) => (isTemporal(el) ? (temporalText(el, x) as string) : toText(x, el === 'real')!)).join(toText(sep)!);
    };
  }),
  op('list_sort', 1, 2, sameAsFirst, ([a]) => {
    listOf('list_sort', a!.type);
    return ([v, desc]) => {
      if (v === null) return null;
      const d = desc !== undefined && desc !== null && desc !== 0;
      // NULLs first, as in a sort ascending; descending reverses the non-null values only.
      const vals = decodeKey(bytesOf(v, 'list_sort'));
      const nulls = vals.filter((x) => x === null);
      const rest = vals.filter((x) => x !== null).sort((x, y) => compareValues(x, y, Collation.Binary) * (d ? -1 : 1));
      return encodeKey([...nulls, ...rest]);
    };
  }),
  op('list_unique', 1, 1, sameAsFirst, ([a]) => {
    listOf('list_unique', a!.type);
    return ([v]) => {
      if (v === null) return null;
      // The first of equal values, in the list's order.
      const out: SqlValue[] = [];
      for (const x of decodeKey(bytesOf(v, 'list_unique'))) if (!out.some((y) => (x === null ? y === null : y !== null && compareValues(x, y, Collation.Binary) === 0))) out.push(x);
      return encodeKey(out);
    };
  }),
  op('list_reverse', 1, 1, sameAsFirst, ([a]) => {
    listOf('list_reverse', a!.type);
    return ([v]) => (v === null ? null : encodeKey(decodeKey(bytesOf(v, 'list_reverse')).reverse()));
  }),
  reduce('list_sum', (xs, vals) => (vals.some((x) => typeof x === 'bigint') ? vals.reduce<bigint>((s, x) => s + BigInt(x as number | bigint), 0n) : xs.reduce((s, x) => s + x, 0)), sumType),
  reduce('list_mean', (xs) => (xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length), () => 'real'),
  reduce('list_min', (_xs, vals) => (vals.length === 0 ? null : vals.reduce((m, x) => (compareValues(x, m, Collation.Binary) < 0 ? x : m))), (el) => el as StaticType),
  reduce('list_max', (_xs, vals) => (vals.length === 0 ? null : vals.reduce((m, x) => (compareValues(x, m, Collation.Binary) > 0 ? x : m))), (el) => el as StaticType),
  op(
    'struct_field',
    2,
    2,
    (a) => {
      const t = a[0]!.type;
      const n = isNested(t) ? parseNested(t) : null;
      // The field's type needs the index, which only a constant gives: the language declares it on the call.
      return n && n.kind === 'struct' && n.fields.length === 1 ? (n.fields[0]!.type as StaticType) : 'any';
    },
    ([a]) => {
      const t = a!.type;
      const n = t === 'null' ? null : isNested(t) ? parseNested(t) : null;
      if (t !== 'null' && (!n || n.kind !== 'struct')) throw mismatch(`struct_field takes a struct, not ${t}`);
      const width = n && n.kind === 'struct' ? n.fields.length : 0;
      return ([v, i]) => {
        if (v === null || i === null) return null;
        const k = intArg(i, 'struct_field', 'the field index');
        if (k < 0 || k >= width) throw new SmaltError('SMALT_RANGE', `struct_field: ${t} has no field ${k}`);
        return decodeKey(bytesOf(v, 'struct_field'))[k] ?? null;
      };
    },
  ),
];

/** The list and struct operations, for the scalar function registry. */
export const NESTED_FUNCTIONS: readonly [string, ScalarFunction][] = LIST_OPS;

// ------------------------------------------------------------------ implode

class ImplodeState implements AggregateState {
  private vals: SqlValue[] = [];
  step(args: SqlValue[]): void {
    this.vals.push(args[0] ?? null);
  }
  step1(v: SqlValue): void {
    this.vals.push(v);
  }
  final(): SqlValue {
    return encodeKey(this.vals);
  }
}

/** `implode`: a group's values as a list, in the group's order, NULLs included (ADR 0020). */
export const IMPLODE: AggregateFunction = {
  minArgs: 1,
  maxArgs: 1,
  resultType: (t) => `list<${t[0] === 'null' ? 'any' : t[0]}>` as StaticType,
  create: () => new ImplodeState(),
};

// ------------------------------------------------------------------ JSON text

function jsonOf(t: string, v: SqlValue): string {
  if (v === null) return 'null';
  if (t === 'bool') return v !== 0 && v !== 0n ? 'true' : 'false';
  if (isTemporal(t)) return JSON.stringify(temporalText(t, v));
  if (isNested(t) && v instanceof Uint8Array) return nestedJson(t, v);
  if (typeof v === 'bigint') return v.toString();
  // An integer beyond 2^53 that a double holds exactly (2^60) prints all its digits.
  if (typeof v === 'number') return !Number.isFinite(v) ? 'null' : Number.isInteger(v) && !Number.isSafeInteger(v) ? BigInt(v).toString() : String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  return JSON.stringify(Array.from(v as Uint8Array, (b) => b.toString(16).padStart(2, '0')).join(''));
}

/** The JSON text of a list or struct value: `[1,2]`, `{"x":1,"y":"a"}`; integers beyond 2^53 exact, blobs as hex. */
export function nestedJson(t: NestedTypeName, bytes: Uint8Array): string {
  const n = parseNested(t);
  if (!n) return JSON.stringify(Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
  const vals = decodeKey(bytes);
  if (n.kind === 'list') return `[${vals.map((v) => jsonOf(n.of, v)).join(',')}]`;
  return `{${n.fields.map((f, i) => `${JSON.stringify(f.name)}:${jsonOf(f.type, vals[i] ?? null)}`).join(',')}}`;
}
