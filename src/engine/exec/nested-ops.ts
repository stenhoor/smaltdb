/**
 * The list and struct operations (ADR 0020, section 4): building, the `list_*` operations, `struct_field`, the
 * `implode` aggregate, and lists and structs as JSON text. A value is a blob of index-key components (see
 * `src/shared/nested.ts`); an operation decodes what it needs and encodes what it gives.
 */
import { SmaltError } from '../errors.js';
import { compareSameKind, decodeComponent, decodeKey, encodeKey, skipComponent } from '../storage/key-codec.js';
import { Collation, type SqlValue, TypedValue, compareValues, normalizeInt, typedBool } from '../values.js';
import { type NestedTypeName, isNested, parseNested } from '../../shared/nested-types.js';
import { compareCodePoints } from '../../shared/nested.js';
import { isTemporal, temporalText } from '../../shared/temporal.js';
import { type StaticType, hashKey, toText, truthy } from './convert.js';
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
 * The elements of `bytes`, remembered for the last few lists decoded. An `explode` of zipped lists reads each list's
 * elements position by position, the same bytes each time: without this, a list of n elements costs n decodes of n
 * elements. Callers must not change the array.
 */
const CACHED = 4;
const cachedBytes: (Uint8Array | null)[] = new Array(CACHED).fill(null);
const cachedValues: (readonly SqlValue[])[] = new Array(CACHED).fill([]);
let nextSlot = 0;
function elements(bytes: Uint8Array): readonly SqlValue[] {
  const hit = cached(bytes);
  if (hit) return hit;
  const values = decodeKey(bytes);
  cachedBytes[nextSlot] = bytes;
  cachedValues[nextSlot] = values;
  nextSlot = (nextSlot + 1) % CACHED;
  return values;
}

/** The elements of `bytes` if they are among the lists last decoded, else null (nothing is decoded). */
function cached(bytes: Uint8Array): readonly SqlValue[] | null {
  for (let i = 0; i < CACHED; i++) if (cachedBytes[i] === bytes) return cachedValues[i]!;
  return null;
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

/**
 * What a value of static type `t` becomes in an `any` place (ADR 0039): a `bool` or a list, struct or map keeps its
 * type as a typed value; other values need nothing (null).
 */
export function toAny(t: string): ((v: SqlValue) => SqlValue) | null {
  if (t === 'bool') return (v) => (v === null || v instanceof TypedValue ? v : typedBool(v !== 0 && v !== 0n));
  if (isNested(t)) return (v) => (v instanceof Uint8Array && !(v instanceof TypedValue) ? new TypedValue(t, v) : v);
  return null;
}

/** For each argument, what it becomes as an element of type `el`: typed when `el` is `any` (ADR 0039). */
function asElements(args: readonly Pick<CompiledArg, 'type'>[], el: string): (((v: SqlValue) => SqlValue) | null)[] | null {
  if (el !== 'any') return null;
  const w = args.map((a) => toAny(a.type));
  return w.some((f) => f !== null) ? w : null;
}

/** `vals` with each wrapped as `w` says (a fresh array). */
const wrapAll = (vals: readonly SqlValue[], w: readonly (((v: SqlValue) => SqlValue) | null)[]): SqlValue[] => vals.map((v, i) => (w[i] ? w[i]!(v) : v));

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

/** A flag argument: absent or NULL is false. */
const flag = (v: SqlValue | undefined): boolean => v !== undefined && v !== null && truthy(v) === true;

const outOfRange = (fn: string, k: number, n: number): SmaltError => new SmaltError('SMALT_RANGE', `${fn}: index ${k} is out of range for a list of ${n}`);

/** Equal elements for counting and sets: NULL equals NULL, and numbers compare by value (1 = 1.0). */
const keyOf = (x: SqlValue): unknown => (x === null ? NULL_KEY : hashKey(x));
const NULL_KEY = Symbol('null');

/** The distinct elements of `xs` (the first of each, in order), and their keys. */
function distinctOf(xs: readonly SqlValue[]): Map<unknown, SqlValue> {
  const m = new Map<unknown, SqlValue>();
  for (const x of xs) {
    const k = keyOf(x);
    if (!m.has(k)) m.set(k, x);
  }
  return m;
}

/** The non-null numbers of a list, or an error naming `fn`. */
function numbersOf(xs: readonly SqlValue[], fn: string): number[] {
  const out: number[] = [];
  for (const x of xs) {
    if (x === null) continue;
    const n = numberOf(x);
    if (n === null) throw mismatch(`${fn} takes a list of numbers, not of ${typeof x === 'string' ? 'text' : 'blobs'}`);
    out.push(n);
  }
  return out;
}

/** `a - b` for numbers: exact for integers (beyond 2^53 too), else real. */
function minus(a: SqlValue, b: SqlValue): SqlValue {
  if (a === null || b === null) return null;
  const isInt = (x: SqlValue): x is number | bigint => typeof x === 'bigint' || (typeof x === 'number' && Number.isInteger(x));
  if (isInt(a) && isInt(b) && (typeof a === 'bigint' || typeof b === 'bigint' || !Number.isSafeInteger(a - (b as number)))) return normalizeInt(BigInt(a) - BigInt(b));
  return (numberOf(a) as number) - (numberOf(b) as number);
}

/** A sample's random numbers in [0, 1): seeded (mulberry32) or not. */
function randomSource(seed: SqlValue | undefined): () => number {
  if (seed === undefined || seed === null) return Math.random;
  let t = Number(BigInt.asUintN(32, BigInt(intArg(seed, 'list_sample', 'the seed'))));
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** A function of one list value: NULL for a NULL list; `f` gets its elements. */
function unary(name: string, min: number, max: number, result: (el: string, args: readonly Pick<CompiledArg, 'type'>[]) => StaticType, f: (xs: SqlValue[], rest: SqlValue[]) => SqlValue): [string, ScalarFunction] {
  return op(name, min, max, (a) => result(listOf(name, a[0]!.type), a), ([a]) => {
    listOf(name, a!.type);
    return ([v, ...rest]) => (v === null ? null : f(decodeKey(bytesOf(v, name)), rest));
  });
}

/** A set operation of two lists of `name`: each element once, in first-appearance order, left list then right. */
function setOp(name: string, keep: (inA: boolean, inB: boolean) => boolean): [string, ScalarFunction] {
  return op(name, 2, 2, sameAsFirst, ([a, b]) => {
    listOf(name, a!.type);
    listOf(name, b!.type);
    return ([x, y]) => {
      if (x === null || y === null) return null;
      const da = distinctOf(decodeKey(bytesOf(x, name)));
      const db = distinctOf(decodeKey(bytesOf(y, name)));
      const out: SqlValue[] = [];
      for (const [k, v] of da) if (keep(true, db.has(k))) out.push(v);
      for (const [k, v] of db) if (!da.has(k) && keep(false, true)) out.push(v);
      return encodeKey(out);
    };
  });
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The variance of `xs` with `ddof` degrees of freedom taken away (Welford), or NULL when there are too few. */
function variance(xs: number[], ddof: number): number | null {
  if (xs.length - ddof <= 0) return null;
  let mean = 0;
  let m2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = xs[i]! - mean;
    mean += d / (i + 1);
    m2 += d * (xs[i]! - mean);
  }
  return m2 / (xs.length - ddof);
}

/** The position of the least (`sign` 1) or greatest (-1) non-null element, the first of equals, or NULL. */
function argBest(xs: readonly SqlValue[], sign: number): number | null {
  let at = -1;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    if (x !== null && (at < 0 || compareValues(x, xs[at]!, Collation.Binary) * sign < 0)) at = i;
  }
  return at < 0 ? null : at;
}

/** The truth of each non-null element, or an error. */
function truths(xs: readonly SqlValue[], fn: string): boolean[] {
  return xs.flatMap((x) => {
    if (x === null) return [];
    const t = truthy(x);
    if (t === null) throw mismatch(`${fn} takes a list of truth values`);
    return [t];
  });
}

const ddofOf = (v: SqlValue | undefined, fn: string): number => {
  const d = v === undefined || v === null ? 1 : intArg(v, fn, 'ddof');
  if (d < 0) throw new SmaltError('SMALT_RANGE', `${fn}: ddof must not be negative`);
  return d;
};

const diffType = (el: string): StaticType => {
  if (el === 'int' || el === 'bool' || el === 'real' || el === 'num' || el === 'duration' || el === 'any' || el === 'null') return (el === 'bool' ? 'int' : el === 'null' ? 'any' : el) as StaticType;
  throw mismatch(`list_diff takes a list of numbers, not of ${el}`);
};

const MORE_LIST_OPS: [string, ScalarFunction][] = [
  // The first list, when every list has as many elements as it (a NULL list matching only NULL); else an error. An
  // explode of zipped lists checks each row with it.
  op('list_same_lengths', 2, -1, sameAsFirst, (args) => {
    for (const a of args) listOf('list_same_lengths', a.type);
    return (vals) => {
      const size = (v: SqlValue): number | null => (v === null ? null : elements(bytesOf(v, 'list_same_lengths')).length);
      const first = size(vals[0]!);
      for (let i = 1; i < vals.length; i++) {
        const n = size(vals[i]!);
        if (n !== first) throw new SmaltError('SMALT_RANGE', `lists zipped together have different lengths: ${first ?? 'null'} and ${n ?? 'null'}`);
      }
      return vals[0]!;
    };
  }),
  // Statistics: over the non-null numbers, NULL when there are none (or too few).
  unary('list_median', 1, 1, () => 'real', (xs) => median(numbersOf(xs, 'list_median'))),
  unary('list_var', 1, 2, () => 'real', (xs, [d]) => variance(numbersOf(xs, 'list_var'), ddofOf(d, 'list_var'))),
  unary('list_std', 1, 2, () => 'real', (xs, [d]) => {
    const v = variance(numbersOf(xs, 'list_std'), ddofOf(d, 'list_std'));
    return v === null ? null : Math.sqrt(v);
  }),
  // NULL counts as a value, once.
  unary('list_n_unique', 1, 1, () => 'int', (xs) => distinctOf(xs).size),
  unary('list_arg_min', 1, 1, () => 'int', (xs) => argBest(xs, 1)),
  unary('list_arg_max', 1, 1, () => 'int', (xs) => argBest(xs, -1)),
  // Elements equal to the value; a NULL value counts the NULL elements.
  unary('list_count_matches', 2, 2, () => 'int', (xs, [x]) => {
    const k = keyOf(x!);
    let n = 0;
    for (const e of xs) if (keyOf(e) === k) n++;
    return n;
  }),
  // Over the non-null elements: all is true for none, any false.
  unary('list_all', 1, 1, () => 'bool', (xs) => (truths(xs, 'list_all').every((t) => t) ? 1 : 0)),
  unary('list_any', 1, 1, () => 'bool', (xs) => (truths(xs, 'list_any').some((t) => t) ? 1 : 0)),

  // Changing one list.
  unary('list_drop_nulls', 1, 1, (el) => `list<${el}>` as StaticType, (xs) => encodeKey(xs.filter((x) => x !== null))),
  // Moved `n` places later (earlier for negative n), NULLs filling the places left.
  unary('list_shift', 1, 2, (el) => `list<${el}>` as StaticType, (xs, [n]) => {
    if (n === null) return null;
    const k = n === undefined ? 1 : intArg(n, 'list_shift', 'the count');
    const len = xs.length;
    const out: SqlValue[] = new Array(len).fill(null);
    for (let i = 0; i < len; i++) {
      const from = i - k;
      if (from >= 0 && from < len) out[i] = xs[from]!;
    }
    return encodeKey(out);
  }),
  // Each element less the one `n` places before it (NULL for the first n, or where either is NULL).
  unary('list_diff', 1, 2, (el) => `list<${diffType(el)}>` as StaticType, (xs, [n]) => {
    if (n === null) return null;
    const k = n === undefined ? 1 : intArg(n, 'list_diff', 'the count');
    numbersOf(xs, 'list_diff');
    return encodeKey(xs.map((x, i) => (i - k >= 0 && i - k < xs.length ? minus(x, xs[i - k]!) : null)));
  }),
  // The elements at the positions of a list of indexes (negative from the end): NULL out of range, or an error when
  // the third argument is true. A NULL index gives a NULL element.
  op('list_gather', 2, 3, sameAsFirst, ([a, b]) => {
    listOf('list_gather', a!.type);
    listOf('list_gather', b!.type);
    return ([v, is, strict]) => {
      if (v === null || is === null) return null;
      const xs = decodeKey(bytesOf(v, 'list_gather'));
      const out = decodeKey(bytesOf(is, 'list_gather')).map((i) => {
        if (i === null) return null;
        const k = intArg(i, 'list_gather', 'an index');
        const at = k < 0 ? xs.length + k : k;
        if (at >= 0 && at < xs.length) return xs[at]!;
        if (flag(strict)) throw outOfRange('list_gather', k, xs.length);
        return null;
      });
      return encodeKey(out);
    };
  }),
  // Every n-th element from `offset`.
  unary('list_gather_every', 2, 3, (el) => `list<${el}>` as StaticType, (xs, [n, off]) => {
    if (n === null || off === null) return null;
    const k = intArg(n!, 'list_gather_every', 'the step');
    if (k <= 0) throw new SmaltError('SMALT_RANGE', 'list_gather_every: the step must be positive');
    const o = off === undefined ? 0 : intArg(off, 'list_gather_every', 'the offset');
    if (o < 0) throw new SmaltError('SMALT_RANGE', 'list_gather_every: the offset must not be negative');
    const out: SqlValue[] = [];
    for (let i = o; i < xs.length; i += k) out.push(xs[i]!);
    return encodeKey(out);
  }),
  // The one element of a list of one; any other length is an error.
  unary('list_item', 1, 1, (el) => el as StaticType, (xs) => {
    if (xs.length !== 1) throw new SmaltError('SMALT_RANGE', `list_item: the list has ${xs.length} elements, not 1`);
    return xs[0]!;
  }),

  // Sets: each element once (NULL is one value), in first-appearance order, the left list's then the right's.
  setOp('list_union', () => true),
  setOp('list_intersect', (inA, inB) => inA && inB),
  setOp('list_except', (inA, inB) => inA && !inB),
  setOp('list_symmetric_except', (inA, inB) => inA !== inB),
];

/**
 * `list_sample(list, n [, withReplacement [, seed]])`: `n` elements chosen at random, in the list's order (without
 * replacement), or in the order drawn (with). Without replacement, `n` above the list's length is an error. A seed
 * gives the same choice each time.
 */
const LIST_SAMPLE: [string, ScalarFunction] = [
  'list_sample',
  {
    minArgs: 2,
    maxArgs: 4,
    deterministic: false,
    resultType: (args) => args[0]!.type,
    compile(args) {
      listOf('list_sample', args[0]!.type);
      const fns = args.map((a) => a.fn);
      return {
        type: args[0]!.type,
        fn: (r) => {
          const v = fns[0]!(r);
          const n = fns[1]!(r);
          if (v === null || n === null) return null;
          const xs = decodeKey(bytesOf(v, 'list_sample'));
          const k = intArg(n, 'list_sample', 'the count');
          if (k < 0) throw new SmaltError('SMALT_RANGE', 'list_sample: the count must not be negative');
          const replace = fns[2] ? flag(fns[2](r)) : false;
          const rnd = randomSource(fns[3] ? fns[3](r) : undefined);
          if (replace) {
            if (xs.length === 0 && k > 0) throw new SmaltError('SMALT_RANGE', 'list_sample: cannot sample from an empty list');
            return encodeKey(Array.from({ length: k }, () => xs[Math.floor(rnd() * xs.length)]!));
          }
          if (k > xs.length) throw new SmaltError('SMALT_RANGE', `list_sample: cannot take ${k} of ${xs.length} elements without replacement`);
          // A partial Fisher-Yates over the positions, then the chosen ones in order.
          const idx = xs.map((_x, i) => i);
          for (let i = 0; i < k; i++) {
            const j = i + Math.floor(rnd() * (idx.length - i));
            [idx[i], idx[j]] = [idx[j]!, idx[i]!];
          }
          return encodeKey(
            idx
              .slice(0, k)
              .sort((x, y) => x - y)
              .map((i) => xs[i]!),
          );
        },
      };
    },
  },
];

const sumType = (el: string): StaticType => (el === 'int' || el === 'bool' ? 'int' : el === 'real' ? 'real' : 'num');

const LIST_OPS: [string, ScalarFunction][] = [
  op('list_of', 0, -1, (a) => `list<${common(a.map((x) => x.type)) === 'null' ? 'any' : common(a.map((x) => x.type))}>` as StaticType, (args) => {
    const w = asElements(args, common(args.map((x) => x.type)));
    return w ? (v) => encodeKey(wrapAll(v, w)) : (v) => encodeKey(v);
  }),
  op('struct_of', 1, -1, (a) => `struct<${a.map((x, i) => `f${i} ${x.type === 'null' ? 'any' : x.type}`).join(', ')}>` as StaticType, () => (v) => encodeKey(v)),
  op('list_len', 1, 1, () => 'int', ([a]) => {
    listOf('list_len', a!.type);
    return ([v]) => (v === null ? null : elements(bytesOf(v, 'list_len')).length);
  }),
  op('list_get', 2, 3, elementOf('list_get'), ([a]) => {
    listOf('list_get', a!.type);
    return ([v, i, strict]) => {
      if (v === null || i === null) return null;
      const vals = elements(bytesOf(v, 'list_get'));
      const k = intArg(i, 'list_get', 'the index');
      const at = k < 0 ? vals.length + k : k;
      if (at >= 0 && at < vals.length) return vals[at]!;
      if (flag(strict)) throw outOfRange('list_get', k, vals.length);
      return null;
    };
  }),
  op('list_contains', 2, 3, () => 'bool', ([a]) => {
    listOf('list_contains', a!.type);
    return ([v, x, nullsEqual]) => {
      if (v === null) return null;
      const vals = decodeKey(bytesOf(v, 'list_contains'));
      // A NULL value is found among NULL elements, unless the third argument is false: then the answer is NULL.
      if (x === null) return nullsEqual !== undefined && !flag(nullsEqual) ? null : vals.includes(null) ? 1 : 0;
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
  op('list_join', 2, 3, () => 'text', ([a]) => {
    const el = listOf('list_join', a!.type);
    return ([v, sep, keepNulls]) => {
      if (v === null || sep === null) return null;
      const all = decodeKey(bytesOf(v, 'list_join'));
      // Keeping NULLs, a NULL element makes the whole text NULL; otherwise NULL elements are left out.
      if (flag(keepNulls) && all.includes(null)) return null;
      const vals = all.filter((x) => x !== null);
      return vals.map((x) => (isTemporal(el) ? (temporalText(el, x) as string) : toText(x, el === 'real')!)).join(toText(sep)!);
    };
  }),
  op('list_sort', 1, 3, sameAsFirst, ([a]) => {
    listOf('list_sort', a!.type);
    return ([v, desc, nullsLast]) => {
      if (v === null) return null;
      const d = flag(desc);
      // NULLs first unless `nullsLast`; descending reverses the non-null values only.
      const vals = decodeKey(bytesOf(v, 'list_sort'));
      const nulls = vals.filter((x) => x === null);
      const rest = vals.filter((x) => x !== null).sort((x, y) => compareValues(x, y, Collation.Binary) * (d ? -1 : 1));
      return encodeKey(flag(nullsLast) ? [...rest, ...nulls] : [...nulls, ...rest]);
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
        // Skip the fields before it and decode only this one.
        const b = bytesOf(v, 'struct_field');
        let pos = 0;
        for (let j = 0; j < k && pos < b.length; j++) pos = skipComponent(b, pos);
        return pos < b.length ? decodeComponent(b, pos) : null;
      };
    },
  ),
];

// ------------------------------------------------------------------ maps (ADR 0038 step 2)

/** The value type of map type `t`, or an error naming `fn`. */
function mapOf(fn: string, t: StaticType): string {
  if (t === 'null') return 'null';
  const n = isNested(t) ? parseNested(t) : null;
  if (!n || n.kind !== 'map') throw mismatch(`${fn} takes a map, not ${t}`);
  return n.of;
}

/** A map type of values of type `v` (`any` when unknown). */
const mapType = (v: string): StaticType => `map<text, ${v === 'null' ? 'any' : v}>` as StaticType;

/** A key argument: text, or an error. */
function keyArg(v: SqlValue, fn: string): string {
  if (typeof v === 'string') return v;
  throw mismatch(`${fn}: a map's keys are text, not ${v === null ? 'NULL' : typeof v === 'object' ? 'a blob' : typeof v}`);
}

/** The keys and values of a map's bytes, in key order. */
function entriesOf(v: SqlValue, fn: string): { keys: string[]; vals: SqlValue[] } {
  const flat = elements(bytesOf(v, fn));
  const keys: string[] = [];
  const vals: SqlValue[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    keys.push(flat[i] as string);
    vals.push(flat[i + 1]!);
  }
  return { keys, vals };
}

/** A map's bytes from entries in any order: sorted by key, the last of a repeated key kept. */
/**
 * Two maps' bytes merged, `y`'s entry winning where both have a key, without decoding a value. A map is its entries'
 * components, key then value, sorted by key (ADR 0038), and a key's bytes order as the keys do (and are prefix-free):
 * so the two are walked together by key bytes, as sorted lists merge, and each entry is copied as it is.
 */
export function mergeMapBytes(x: Uint8Array, y: Uint8Array): Uint8Array {
  if (x.length === 0) return y;
  if (y.length === 0) return x;
  const out = new Uint8Array(x.length + y.length);
  let o = 0;
  let i = 0;
  let j = 0;
  const copy = (m: Uint8Array, from: number, to: number): void => {
    out.set(m.subarray(from, to), o);
    o += to - from;
  };
  while (i < x.length && j < y.length) {
    const ki = skipComponent(x, i);
    const kj = skipComponent(y, j);
    let c = 0;
    const n = Math.min(ki - i, kj - j);
    for (let d = 0; d < n && c === 0; d++) c = x[i + d]! - y[j + d]!;
    if (c === 0) c = ki - i - (kj - j);
    if (c < 0) {
      const e = skipComponent(x, ki);
      copy(x, i, e);
      i = e;
    } else {
      const e = skipComponent(y, kj);
      copy(y, j, e);
      j = e;
      if (c === 0) i = skipComponent(x, ki);
    }
  }
  copy(x, i, x.length);
  copy(y, j, y.length);
  return out.slice(0, o);
}

function encodeEntries(entries: [string, SqlValue][]): Uint8Array {
  const byKey = new Map<string, SqlValue>();
  for (const [k, v] of entries) byKey.set(k, v);
  const keys = [...byKey.keys()].sort(compareCodePoints);
  const flat: SqlValue[] = [];
  for (const k of keys) flat.push(k, byKey.get(k)!);
  return encodeKey(flat);
}

/**
 * The offset of the value of the key whose component is `key` (a text component, encoded) in the map whose bytes are
 * `m[start, end)`, or -1 when it has none. A map is its entries' components, key then value, sorted by key (ADR 0038),
 * and a key is a text component, whose bytes order as the keys do: so each key's bytes are compared with `key`, the
 * value of a smaller key is skipped without decoding it, and the walk stops at the first greater key. Without offsets
 * in the bytes there is no binary search.
 */
export function findMapKey(m: Uint8Array, start: number, end: number, key: Uint8Array): number {
  const kl = key.length;
  let pos = start;
  while (pos < end) {
    let i = 0;
    while (i < kl && m[pos + i] === key[i]) i++;
    // Components are prefix-free: all of `key` matching is this whole key.
    if (i === kl) return pos + kl;
    if (pos + i < end && m[pos + i]! > key[i]!) return -1;
    pos = skipComponent(m, skipComponent(m, pos));
  }
  return -1;
}

/**
 * The map whose bytes are `m`, with the key whose component is `key` (a text component, encoded) given the value
 * whose component is `value`, or taken away (`value` null): the other entries' bytes are copied as they are, in
 * their order, so no entry is decoded. The key is found as {@link findMapKey} finds it. `m` itself where nothing
 * changes: the key has that value already, or is taken away and was not there.
 */
export function setMapKey(m: Uint8Array, key: Uint8Array, value: Uint8Array | null): Uint8Array {
  const kl = key.length;
  const end = m.length;
  // Where the key's entry starts (or goes), and where the entry after it starts.
  let at = end;
  let after = end;
  let pos = 0;
  while (pos < end) {
    let i = 0;
    while (i < kl && m[pos + i] === key[i]) i++;
    if (i === kl) {
      at = pos;
      after = skipComponent(m, pos + kl);
      break;
    }
    if (m[pos + i]! > key[i]!) {
      at = after = pos;
      break;
    }
    pos = skipComponent(m, skipComponent(m, pos));
  }
  if (value === null) {
    if (at === after) return m;
    const out = new Uint8Array(at + end - after);
    out.set(m.subarray(0, at));
    out.set(m.subarray(after), at);
    return out;
  }
  const vl = value.length;
  if (after - at === kl + vl) {
    // The key is there with a value of as many bytes: the map is copied whole, and the value written over its copy.
    const v = at + kl;
    let i = 0;
    while (i < vl && m[v + i] === value[i]) i++;
    if (i === vl) return m;
    const same = m.slice();
    for (; i < vl; i++) same[v + i] = value[i]!;
    return same;
  }
  // The map is copied whole, the entries after the key's are moved to where they go, and the key and its value are
  // written between: three copies of bytes and no view of a part of the map, which costs more to make than a small
  // map does to copy.
  const n = at + kl + vl + end - after;
  let out: Uint8Array;
  if (n >= end) {
    out = new Uint8Array(n);
    out.set(m);
    if (after < end) out.copyWithin(at + kl + vl, after, end);
  } else {
    // A shorter map: its first bytes are a copy of the old one's, and the entries after the key's are read from the
    // old one.
    out = m.slice(0, n);
    for (let from = after, to = at + kl + vl; from < end; from++, to++) out[to] = m[from]!;
  }
  if (at === after) out.set(key, at);
  for (let i = 0; i < vl; i++) out[at + kl + i] = value[i]!;
  return out;
}

/** The tag of a NULL component. */
const NULL_TAG = encodeKey([null])[0]!;

/**
 * How {@link mapProbe} compares a map's value with a literal. `KindLt` and the three after it are the comparisons
 * within one kind (`cmp_lt_kind` and the others).
 */
export const MapCompare = { None: 0, Eq: 1, Ne: 2, Lt: 3, Le: 4, Gt: 5, Ge: 6, NotNull: 7, KindLt: 8, KindLe: 9, KindGt: 10, KindGe: 11 } as const;
export type MapCompare = (typeof MapCompare)[keyof typeof MapCompare];

/**
 * For generated scans (codegen.ts): false when a conjunct that needs the map stored at `m[start, end)` to have `key`
 * (encoded) cannot be true of the row, so the row is skipped without decoding the map. With `lit` (an encoded number
 * or text literal), also false when the key's value is of the literal's kind and `value op lit` does not hold (see
 * `compareSameKind`); with `NotNull`, false when the value is NULL. True otherwise: the conjunct itself decides.
 *
 * A comparison within one kind is decided here, true or not: it holds only for a value of the literal's kind that
 * compares so with it, which is what `compareSameKind` gives (NaN, which passes no test, for two other kinds). With
 * no literal (a parameter that is NULL, a NaN or neither a number nor text) it holds for no row.
 */
export function mapProbe(m: Uint8Array, start: number, end: number, key: Uint8Array, op: MapCompare, lit: Uint8Array | null): boolean {
  const at = findMapKey(m, start, end, key);
  if (at < 0) return false;
  if (op === MapCompare.NotNull) return m[at] !== NULL_TAG;
  if (op >= MapCompare.KindLt) {
    if (lit === null) return false;
    const c = compareSameKind(m, at, lit);
    return op === MapCompare.KindLt ? c < 0 : op === MapCompare.KindLe ? c <= 0 : op === MapCompare.KindGt ? c > 0 : c >= 0;
  }
  if (lit === null) return true;
  const c = compareSameKind(m, at, lit);
  if (c !== c) return true;
  switch (op) {
    case MapCompare.Eq:
      return c === 0;
    case MapCompare.Ne:
      return c !== 0;
    case MapCompare.Lt:
      return c < 0;
    case MapCompare.Le:
      return c <= 0;
    case MapCompare.Gt:
      return c > 0;
    case MapCompare.Ge:
      return c >= 0;
    default:
      return true;
  }
}

/**
 * Reads one key of maps without decoding the rest (ADR 0038): {@link findMapKey}, then only the value found is
 * decoded. A map whose elements are in `elements`' cache is binary searched there instead.
 */
class KeyFinder {
  private key: string | null = null;
  private enc: Uint8Array = new Uint8Array(0);

  constructor(private readonly fn: string) {}

  /** The offset of `k`'s value in map `m`'s bytes, or -1 when the map has no such key. */
  private find(m: Uint8Array, k: string): number {
    if (k !== this.key) {
      this.enc = encodeKey([k]);
      this.key = k;
    }
    return findMapKey(m, 0, m.length, this.enc);
  }

  /** `k`'s value in map `v`, or undefined when it has none. */
  get(v: SqlValue, k: string): SqlValue | undefined {
    const m = bytesOf(v, this.fn);
    const flat = cached(m);
    if (flat) {
      const i = findFlatKey(flat, k);
      return i < 0 ? undefined : flat[i + 1]!;
    }
    const at = this.find(m, k);
    return at < 0 ? undefined : decodeComponent(m, at);
  }

  has(v: SqlValue, k: string): boolean {
    const m = bytesOf(v, this.fn);
    const flat = cached(m);
    return flat ? findFlatKey(flat, k) >= 0 : this.find(m, k) >= 0;
  }
}

/** The index of `key` among the keys of flat entries (key, value, key, value, …), sorted by key, or -1. */
function findFlatKey(flat: readonly SqlValue[], key: string): number {
  let lo = 0;
  let hi = (flat.length >> 1) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = compareCodePoints(flat[mid * 2] as string, key);
    if (c === 0) return mid * 2;
    if (c < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

const valueOfMap = (fn: string) => (a: readonly Pick<CompiledArg, 'type'>[]): StaticType => {
  const v = mapOf(fn, a[0]!.type);
  return (v === 'null' ? 'any' : v) as StaticType;
};

const MAP_OPS: [string, ScalarFunction][] = [
  // map_of(k1, v1, k2, v2, …): a repeated key keeps its last value.
  op('map_of', 0, -1, (a) => mapType(common(a.filter((_, i) => i % 2 === 1).map((x) => x.type))), (args) => {
    if (args.length % 2 !== 0) throw mismatch('map_of takes keys and values in pairs');
    const w = asElements(args, common(args.filter((_, i) => i % 2 === 1).map((x) => x.type))) ?? args.map(() => null);
    // One pair is in key order and has no key twice, and its value is of the map's own type (nothing wraps it): the
    // key and the value are the map's bytes, with no list of entries made for them.
    if (args.length === 2) return (v) => encodeKey([keyArg(v[0]!, 'map_of'), v[1]!]);
    return (v) => {
      const entries: [string, SqlValue][] = [];
      for (let i = 0; i < v.length; i += 2) entries.push([keyArg(v[i]!, 'map_of'), w[i + 1] ? w[i + 1]!(v[i + 1]!) : v[i + 1]!]);
      return encodeEntries(entries);
    };
  }),
  // map_from_entries(list<struct<key text, value V>>): NULL entries are skipped; a repeated key keeps its last value.
  op(
    'map_from_entries',
    1,
    1,
    (a) => {
      const el = listOf('map_from_entries', a[0]!.type);
      const n = isNested(el) ? parseNested(el) : null;
      return mapType(n && n.kind === 'struct' && n.fields.length === 2 ? n.fields[1]!.type : 'any');
    },
    ([a]) => {
      const el = listOf('map_from_entries', a!.type);
      const n = el === 'null' ? null : isNested(el) ? parseNested(el) : null;
      if (el !== 'null' && el !== 'any' && (!n || n.kind !== 'struct' || n.fields.length !== 2)) throw mismatch(`map_from_entries takes a list of key and value structs, not ${a!.type}`);
      return ([v]) => {
        if (v === null) return null;
        const entries: [string, SqlValue][] = [];
        for (const e of decodeKey(bytesOf(v, 'map_from_entries'))) {
          if (e === null) continue;
          const kv = decodeKey(bytesOf(e, 'map_from_entries'));
          if (kv.length !== 2) throw mismatch('map_from_entries takes structs of a key and a value');
          entries.push([keyArg(kv[0]!, 'map_from_entries'), kv[1]!]);
        }
        return encodeEntries(entries);
      };
    },
  ),
  // map_get(m, key): the key's value, NULL when it is missing.
  op('map_get', 2, 2, valueOfMap('map_get'), ([a]) => {
    mapOf('map_get', a!.type);
    const finder = new KeyFinder('map_get');
    return ([m, k]) => (m === null || k === null ? null : (finder.get(m, keyArg(k, 'map_get')) ?? null));
  }),
  op('map_contains_key', 2, 2, () => 'bool', ([a]) => {
    mapOf('map_contains_key', a!.type);
    const finder = new KeyFinder('map_contains_key');
    return ([m, k]) => (m === null || k === null ? null : finder.has(m, keyArg(k, 'map_contains_key')) ? 1 : 0);
  }),
  op('map_len', 1, 1, () => 'int', ([a]) => {
    mapOf('map_len', a!.type);
    return ([m]) => (m === null ? null : elements(bytesOf(m, 'map_len')).length / 2);
  }),
  op('map_keys', 1, 1, () => 'list<text>' as StaticType, ([a]) => {
    mapOf('map_keys', a!.type);
    return ([m]) => (m === null ? null : encodeKey(entriesOf(m, 'map_keys').keys));
  }),
  op('map_values', 1, 1, (a) => `list<${(() => { const v = mapOf('map_values', a[0]!.type); return v === 'null' ? 'any' : v; })()}>` as StaticType, ([a]) => {
    mapOf('map_values', a!.type);
    return ([m]) => (m === null ? null : encodeKey(entriesOf(m, 'map_values').vals));
  }),
  // map_entries(m): list<struct<key text, value V>>, in key order: ADR 0020's form of a map.
  op('map_entries', 1, 1, (a) => `list<struct<key text, value ${(() => { const v = mapOf('map_entries', a[0]!.type); return v === 'null' ? 'any' : v; })()}>>` as StaticType, ([a]) => {
    mapOf('map_entries', a!.type);
    return ([m]) => {
      if (m === null) return null;
      const { keys, vals } = entriesOf(m, 'map_entries');
      return encodeKey(keys.map((k, i) => encodeKey([k, vals[i]!])));
    };
  }),
  // map_merge(a, b): b's entries win (Cypher's SET n += map).
  op('map_merge', 2, 2, (a) => {
    const x = mapOf('map_merge', a[0]!.type);
    const y = mapOf('map_merge', a[1]!.type);
    return mapType(x === 'null' ? y : y === 'null' ? x : x === y ? x : 'any');
  }, ([a, b]) => {
    const tx = mapOf('map_merge', a!.type);
    const ty = mapOf('map_merge', b!.type);
    // Values of maps of different types merge into a map of `any`, where they keep their types (ADR 0039).
    const differ = tx !== 'null' && ty !== 'null' && tx !== ty;
    const wx = differ ? toAny(tx) : null;
    const wy = differ ? toAny(ty) : null;
    return ([x, y]) => {
      if (x === null || y === null) return null;
      // Of one type, the maps' bytes merge as they are (`mergeMapBytes`): no value is decoded.
      if (!differ) return mergeMapBytes(bytesOf(x, 'map_merge'), bytesOf(y, 'map_merge'));
      const ex = entriesOf(x, 'map_merge');
      const ey = entriesOf(y, 'map_merge');
      const entries: [string, SqlValue][] = ex.keys.map((k, i) => [k, wx ? wx(ex.vals[i]!) : ex.vals[i]!]);
      ey.keys.forEach((k, i) => entries.push([k, wy ? wy(ey.vals[i]!) : ey.vals[i]!]));
      return encodeEntries(entries);
    };
  }),
  // map_remove(m, keys): m without the keys listed (list<text>).
  op('map_remove', 2, 2, (a) => mapType(mapOf('map_remove', a[0]!.type)), ([a, b]) => {
    mapOf('map_remove', a!.type);
    listOf('map_remove', b!.type);
    return ([m, ks]) => {
      if (m === null) return null;
      if (ks === null) return m;
      const drop = new Set(decodeKey(bytesOf(ks, 'map_remove')).filter((k) => k !== null).map((k) => keyArg(k, 'map_remove')));
      const { keys, vals } = entriesOf(m, 'map_remove');
      const flat: SqlValue[] = [];
      keys.forEach((k, i) => (drop.has(k) ? undefined : flat.push(k, vals[i]!)));
      return encodeKey(flat);
    };
  }),
];

/** The list, struct and map operations, for the scalar function registry. */
// ------------------------------------------------------------------ values under `any` (ADR 0039)

/** The type of a value as text: what a typed value keeps, else its kind. */
function anyType(v: SqlValue): string {
  if (v === null) return 'null';
  if (v instanceof TypedValue) return v.type;
  if (typeof v === 'bigint') return 'int';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'real';
  return typeof v === 'string' ? 'text' : 'blob';
}

/** A typed list, struct or map's elements, each as an `any` element (typed where its type says). */
function anyElements(v: TypedValue, n: NonNullable<ReturnType<typeof parseNested>>): SqlValue[] {
  const vals = decodeKey(v);
  if (n.kind === 'list') {
    const w = toAny(n.of);
    return w ? vals.map(w) : vals;
  }
  if (n.kind === 'map') {
    const w = toAny(n.of);
    return w ? vals.map((x, i) => (i % 2 === 1 ? w(x) : x)) : vals;
  }
  // A struct: its fields by name, sorted as a map's keys are.
  const entries: [string, SqlValue][] = n.fields.map((f, i) => {
    const w = toAny(f.type);
    const x = vals[i] ?? null;
    return [f.name, w ? w(x) : x];
  });
  return entries.sort((a, b) => compareCodePoints(a[0], b[0])).flat();
}

const ANY_OPS: [string, ScalarFunction][] = [
  op('any_type', 1, 1, () => 'text', () => ([v]) => anyType(v!)),
  // The value as a bool when it is one, else NULL.
  op('any_bool', 1, 1, () => 'bool', () => ([v]) => (v instanceof TypedValue && v.type === 'bool' ? v[0]! : null)),
  // A list as a list<any> (its elements keep their types), else NULL.
  op('any_list', 1, 1, () => 'list<any>' as StaticType, () => ([v]) => {
    if (!(v instanceof TypedValue)) return null;
    const n = isNested(v.type) ? parseNested(v.type) : null;
    return n && n.kind === 'list' ? encodeKey(anyElements(v, n)) : null;
  }),
  // A map, or a struct by field name, as a map<text, any>, else NULL.
  op('any_map', 1, 1, () => 'map<text, any>' as StaticType, () => ([v]) => {
    if (!(v instanceof TypedValue)) return null;
    const n = isNested(v.type) ? parseNested(v.type) : null;
    return n && n.kind !== 'list' ? encodeKey(anyElements(v, n)) : null;
  }),
];

export const NESTED_FUNCTIONS: readonly [string, ScalarFunction][] = [...LIST_OPS, ...MORE_LIST_OPS, LIST_SAMPLE, ...MAP_OPS, ...ANY_OPS];

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
  // A typed value (ADR 0039) prints as its type does.
  if (v instanceof TypedValue && t === 'any') return v.type === 'bool' ? (v[0] ? 'true' : 'false') : jsonOf(v.type, v);
  if (t === 'bool') return v !== 0 && v !== 0n ? 'true' : 'false';
  if (isTemporal(t)) return JSON.stringify(temporalText(t, v));
  if (isNested(t) && v instanceof Uint8Array) return nestedJson(t, v);
  if (typeof v === 'bigint') return v.toString();
  // An integer beyond 2^53 that a double holds exactly (2^60) prints all its digits.
  if (typeof v === 'number') return !Number.isFinite(v) ? 'null' : Number.isInteger(v) && !Number.isSafeInteger(v) ? BigInt(v).toString() : String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  return JSON.stringify(Array.from(v as Uint8Array, (b) => b.toString(16).padStart(2, '0')).join(''));
}

/** The JSON text of a typed value (ADR 0039): `true`, `[1,2]`, `{"a":1}`. */
export const typedJson = (v: TypedValue): string => jsonOf('any', v);

/** The JSON text of a list, struct or map value: `[1,2]`, `{"x":1,"y":"a"}`; integers beyond 2^53 exact, blobs as hex. */
export function nestedJson(t: NestedTypeName, bytes: Uint8Array): string {
  const n = parseNested(t);
  if (!n) return JSON.stringify(Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
  const vals = decodeKey(bytes);
  if (n.kind === 'list') return `[${vals.map((v) => jsonOf(n.of, v)).join(',')}]`;
  if (n.kind === 'map') {
    const parts: string[] = [];
    for (let i = 0; i + 1 < vals.length; i += 2) parts.push(`${JSON.stringify(vals[i])}:${jsonOf(n.of, vals[i + 1]!)}`);
    return `{${parts.join(',')}}`;
  }
  return `{${n.fields.map((f, i) => `${JSON.stringify(f.name)}:${jsonOf(f.type, vals[i] ?? null)}`).join(',')}}`;
}
