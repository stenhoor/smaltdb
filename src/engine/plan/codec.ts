/**
 * Plans as data that crosses a boundary (ADR 0015 section 9): to another worker (`structuredClone`, postMessage) or as
 * text (JSON). A plan is plain data: everything about its meaning is in its fields (ADR 0016 section 2), so encoding
 * copies it and a decoded plan plans and runs exactly as the original. Plans of format version 0 kept SQL's metadata
 * as `$sql` / `$flattened` fields; decoding still reads them, into the meaning fields.
 *
 * - `encodePlan` / `decodePlan`: a structured-clone-safe object (bigints and blobs stay as they are).
 * - `planToJSON` / `planFromJSON`: JSON text; bigints, blobs and non-finite numbers are tagged objects (`encodeDataJSON` /
 *   `decodeDataJSON` for other data that holds plan nodes).
 *
 * Decoding checks the format version only; the validator (plan/validate.ts) checks the plan itself.
 */
import { SmaltError } from '../errors.js';
import { markFlattened, setMeta, type SqlMeta } from '../exec/sql-meta.js';
import type { BoundExpr } from './expr.js';
import type { PlanOp } from './ops.js';
import { PLAN_FORMAT_VERSION } from './types.js';

/** An encoded plan: the format version and the plan, as plain data. */
export interface EncodedPlan {
  readonly version: number;
  readonly plan: unknown;
}

/** `x` (plan nodes anywhere inside) as plain data, with SQL's metadata written as fields. */
export function encodeData(x: unknown): unknown {
  return encode(x, false);
}

/**
 * `x` as {@link encodeData} encodes it, as JSON text: bigints, blobs and non-finite numbers are tagged objects, and
 * typed arrays other than blobs `{$typed: kind, data}`. With `lifted`, typed arrays are not written: each is pushed to
 * `lifted` and written as `{$data: i}`, its position there, so that it can travel beside the text as binary data (the
 * worker protocol: plan requests' `data`); {@link decodeDataJSON} puts them back.
 */
export function encodeDataJSON(x: unknown, lifted?: unknown[]): string {
  return JSON.stringify(encode(x, true, lifted));
}

/** The typed arrays JSON can tag, by the name their tag records. */
const TYPED: Readonly<Record<string, new (values: ArrayLike<number> & ArrayLike<bigint>) => ArrayBufferView>> = {
  f64: Float64Array as never,
  f32: Float32Array as never,
  i32: Int32Array as never,
  i16: Int16Array as never,
  i8: Int8Array as never,
  u32: Uint32Array as never,
  u16: Uint16Array as never,
  i64: BigInt64Array as never,
};
const typedName = (x: ArrayBufferView): string | undefined => Object.keys(TYPED).find((k) => x instanceof TYPED[k]);

/** `x` encoded; with `json`, also tagged for JSON. One walk does both: a `JSON.stringify` replacer is slow. */
function encode(x: unknown, json: boolean, lifted?: unknown[]): unknown {
  // A JS Date (a datetime in a column of values, ADR 0019): kept, or tagged with its ms for JSON.
  if (x instanceof Date) return json ? { $date: String(x.getTime()) } : x;
  if (json) {
    if (lifted && ArrayBuffer.isView(x)) return { $data: lifted.push(x) - 1 };
    if (typeof x === 'bigint') return { $bigint: x.toString() };
    if (x instanceof Uint8Array) return { $blob: Array.from(x, (b) => b.toString(16).padStart(2, '0')).join('') };
    if (typeof x === 'number' && !Number.isFinite(x)) return { $real: String(x) };
    if (ArrayBuffer.isView(x)) {
      const kind = typedName(x);
      if (kind) return { $typed: kind, data: Array.from(x as unknown as ArrayLike<number | bigint>, (v) => (typeof v === 'bigint' ? v.toString() : Number.isFinite(v) ? v : String(v))) };
    }
  }
  if (Array.isArray(x)) return x.map((v) => encode(v, json, lifted));
  if (!x || typeof x !== 'object' || ArrayBuffer.isView(x)) return x;
  const out: Record<string, unknown> = {};
  for (const k in x) {
    const v = (x as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = encode(v, json, lifted);
  }
  return out;
}

/** `plan` as plain data, with SQL's metadata written as fields. */
export function encodePlan(plan: PlanOp): EncodedPlan {
  return { version: PLAN_FORMAT_VERSION, plan: encodeData(plan) };
}

/** The plan `e` encodes, with SQL's metadata restored. */
export function decodePlan(e: EncodedPlan): PlanOp {
  if (!e || typeof e !== 'object' || (e.version !== PLAN_FORMAT_VERSION && e.version !== 0)) {
    throw new SmaltError('SMALT_PLAN', `plan format version ${String((e as { version?: unknown } | null)?.version)} is not supported (this engine reads version ${PLAN_FORMAT_VERSION})`);
  }
  return decodeData(e.plan) as PlanOp;
}

/** Data {@link encodeData} made, with SQL's metadata restored on its plan nodes. */
export function decodeData(x: unknown): unknown {
  return decode(x, false);
}

/**
 * `x` decoded; with `json`, also the values {@link encodeDataJSON} tagged. One walk does both: `JSON.parse` with a reviver
 * is several times slower than parsing plain JSON and walking the result.
 */
function decode(x: unknown, json: boolean, lifted?: readonly unknown[]): unknown {
  if (Array.isArray(x)) return x.map((v) => decode(v, json, lifted));
  if (!x || typeof x !== 'object' || ArrayBuffer.isView(x)) return x;
  if (json) {
    const tagged = untag(x as Record<string, unknown>, lifted);
    if (tagged !== x) return tagged;
  }
  const out: Record<string, unknown> = {};
  let meta: SqlMeta | undefined;
  let flattened = false;
  for (const k in x) {
    const v = (x as Record<string, unknown>)[k];
    if (k === '$sql') meta = v as SqlMeta;
    else if (k === '$flattened') flattened = v === true;
    else out[k] = decode(v, json, lifted);
  }
  if (meta) setMeta(out as unknown as BoundExpr, { ...meta });
  if (flattened) markFlattened(out as unknown as PlanOp);
  return out;
}

/** A value of JSON text {@link encodeDataJSON} made: a tagged value (`{$bigint}`, `{$blob}`, `{$real}`) restored. */
export function valueFromJSON(v: unknown): unknown {
  return v && typeof v === 'object' && !Array.isArray(v) ? untag(v as Record<string, unknown>) : v;
}

/** The value a tagged object (`{$bigint}`, `{$blob}`, `{$real}`, `{$date}`, `{$typed, data}`, `{$data}`) stands for, or `o` itself. */
function untag(o: Record<string, unknown>, lifted?: readonly unknown[]): unknown {
  if (typeof o.$typed === 'string' && Array.isArray(o.data) && Object.keys(o).length === 2) {
    const make = TYPED[o.$typed];
    if (!make) throw new SmaltError('SMALT_PLAN', `unknown typed array ${JSON.stringify(o.$typed)}`);
    return new make((o.data as unknown[]).map((v) => (o.$typed === 'i64' ? BigInt(v as string) : Number(v))) as never);
  }
  let key: string | undefined;
  for (const k in o) {
    if (key !== undefined) return o;
    key = k;
  }
  const v = key === undefined ? undefined : o[key];
  if (key === '$data' && typeof v === 'number') {
    if (!lifted || !(v in lifted)) throw new SmaltError('SMALT_PLAN', `the plan refers to data ${v} it was not given`);
    return lifted[v];
  }
  if (typeof v !== 'string') return o;
  if (key === '$bigint') return BigInt(v);
  if (key === '$blob') {
    const b = new Uint8Array(v.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(v.slice(2 * i, 2 * i + 2), 16);
    return b;
  }
  if (key === '$real') return Number(v);
  if (key === '$date') return new Date(Number(v));
  return o;
}

/** JSON text {@link encodeDataJSON} made, decoded: its tagged values and SQL's metadata restored. */
export function decodeDataJSON(text: string, lifted?: readonly unknown[]): unknown {
  return decode(JSON.parse(text), true, lifted);
}

/**
 * `x` as canonical JSON text: {@link encodeDataJSON}'s form with every object's keys sorted, so equal data gives equal
 * text whatever order its fields were written in (statement caches key plans by it).
 */
export function canonicalJSON(x: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = sort(o[k]);
    return out;
  };
  return JSON.stringify(sort(encode(x, true)));
}

/** `plan` as JSON text. */
export function planToJSON(plan: PlanOp): string {
  return JSON.stringify({ version: PLAN_FORMAT_VERSION, plan: encode(plan, true) });
}

/** The plan JSON text `text` (from {@link planToJSON}) holds. */
export function planFromJSON(text: string): PlanOp {
  const e = JSON.parse(text) as { version?: unknown; plan?: unknown } | null;
  // Version 0 (with `$sql` / `$flattened` metadata) and the current version decode alike; others are refused.
  if (!e || typeof e !== 'object' || (e.version !== PLAN_FORMAT_VERSION && e.version !== 0)) return decodePlan(e as EncodedPlan);
  return decode(e.plan, true) as PlanOp;
}
