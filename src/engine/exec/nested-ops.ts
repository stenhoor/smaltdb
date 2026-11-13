/**
 * The list and struct operations (ADR 0020, section 4): building, the `list_*` operations, `struct_field`, the
 * `implode` aggregate, and lists and structs as JSON text. A value is a blob of index-key components (see
 * `src/shared/nested.ts`); an operation decodes what it needs and encodes what it gives.
 */
import { SmaltError } from '../errors.js';
import { decodeKey, encodeKey } from '../storage/key-codec.js';
import { Collation, type SqlValue, compareValues, normalizeInt } from '../values.js';
import { type NestedTypeName, isNested, parseNested } from '../../shared/nested-types.js';
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
  op('list_of', 0, -1, (a) => `list<${common(a.map((x) => x.type)) === 'null' ? 'any' : common(a.map((x) => x.type))}>` as StaticType, () => (v) => encodeKey(v)),
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
        return decodeKey(bytesOf(v, 'struct_field'))[k] ?? null;
      };
    },
  ),
];

/** The list and struct operations, for the scalar function registry. */
export const NESTED_FUNCTIONS: readonly [string, ScalarFunction][] = [...LIST_OPS, ...MORE_LIST_OPS, LIST_SAMPLE];

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
