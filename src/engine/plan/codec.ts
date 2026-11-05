/**
 * Plans as data that crosses a boundary (ADR 0015 section 9): to another worker (`structuredClone`, postMessage) or as
 * text (JSON). A plan in memory is plain data except for what SQL keeps beside it (exec/sql-meta.ts: an expression's
 * collation source and affinity, a SELECT's flattening mark), held under symbols that copying leaves out. Encoding
 * writes those as `$sql` / `$flattened` fields, and decoding puts them back, so a decoded plan plans and runs exactly
 * as the original.
 *
 * - `encodePlan` / `decodePlan`: a structured-clone-safe object (bigints and blobs stay as they are).
 * - `planToJSON` / `planFromJSON`: JSON text; bigints, blobs and non-finite numbers are tagged objects (`encodeDataJSON` /
 *   `decodeDataJSON` for other data that holds plan nodes).
 *
 * Decoding checks the format version only; the validator (plan/validate.ts) checks the plan itself.
 */
import { SmaltError } from '../errors.js';
import { getMeta, isFlattened, markFlattened, setMeta, type SqlMeta } from '../exec/sql-meta.js';
import type { BoundExpr } from './expr.js';
import type { PlanOp } from './ops.js';
import { PLAN_FORMAT_VERSION } from './types.js';

/** An encoded plan: the format version and the plan, as plain data. */
export interface EncodedPlan {
  readonly version: number;
  readonly plan: unknown;
}

const isNode = (o: object): boolean => typeof (o as { op?: unknown }).op === 'string' || typeof (o as { k?: unknown }).k === 'string';

/** `x` (plan nodes anywhere inside) as plain data, with SQL's metadata written as fields. */
export function encodeData(x: unknown): unknown {
  return encode(x, false);
}

/** `x` as {@link encodeData} encodes it, as JSON text: bigints, blobs and non-finite numbers are tagged objects. */
export function encodeDataJSON(x: unknown): string {
  return JSON.stringify(encode(x, true));
}

/** `x` encoded; with `json`, also tagged for JSON. One walk does both: a `JSON.stringify` replacer is slow. */
function encode(x: unknown, json: boolean): unknown {
  if (json) {
    if (typeof x === 'bigint') return { $bigint: x.toString() };
    if (x instanceof Uint8Array) return { $blob: Array.from(x, (b) => b.toString(16).padStart(2, '0')).join('') };
    if (typeof x === 'number' && !Number.isFinite(x)) return { $real: String(x) };
  }
  if (Array.isArray(x)) return x.map((v) => encode(v, json));
  if (!x || typeof x !== 'object' || x instanceof Uint8Array) return x;
  const out: Record<string, unknown> = {};
  for (const k in x) {
    const v = (x as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = encode(v, json);
  }
  if (isNode(x)) {
    const m = getMeta(x as BoundExpr);
    if (m) out.$sql = { ...m };
    if (isFlattened(x as PlanOp)) out.$flattened = true;
  }
  return out;
}

/** `plan` as plain data, with SQL's metadata written as fields. */
export function encodePlan(plan: PlanOp): EncodedPlan {
  return { version: PLAN_FORMAT_VERSION, plan: encodeData(plan) };
}

/** The plan `e` encodes, with SQL's metadata restored. */
export function decodePlan(e: EncodedPlan): PlanOp {
  if (!e || typeof e !== 'object' || e.version !== PLAN_FORMAT_VERSION) {
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
function decode(x: unknown, json: boolean): unknown {
  if (Array.isArray(x)) return x.map((v) => decode(v, json));
  if (!x || typeof x !== 'object' || x instanceof Uint8Array) return x;
  if (json) {
    const tagged = untag(x as Record<string, unknown>);
    if (tagged !== x) return tagged;
  }
  const out: Record<string, unknown> = {};
  let meta: SqlMeta | undefined;
  let flattened = false;
  for (const k in x) {
    const v = (x as Record<string, unknown>)[k];
    if (k === '$sql') meta = v as SqlMeta;
    else if (k === '$flattened') flattened = v === true;
    else out[k] = decode(v, json);
  }
  if (meta) setMeta(out as unknown as BoundExpr, { ...meta });
  if (flattened) markFlattened(out as unknown as PlanOp);
  return out;
}

/** A value of JSON text {@link encodeDataJSON} made: a tagged value (`{$bigint}`, `{$blob}`, `{$real}`) restored. */
export function valueFromJSON(v: unknown): unknown {
  return v && typeof v === 'object' && !Array.isArray(v) ? untag(v as Record<string, unknown>) : v;
}

/** The value a tagged object (`{$bigint}`, `{$blob}`, `{$real}`) stands for, or `o` itself. */
function untag(o: Record<string, unknown>): unknown {
  let key: string | undefined;
  for (const k in o) {
    if (key !== undefined) return o;
    key = k;
  }
  const v = key === undefined ? undefined : o[key];
  if (typeof v !== 'string') return o;
  if (key === '$bigint') return BigInt(v);
  if (key === '$blob') {
    const b = new Uint8Array(v.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(v.slice(2 * i, 2 * i + 2), 16);
    return b;
  }
  if (key === '$real') return Number(v);
  return o;
}

/** JSON text {@link encodeDataJSON} made, decoded: its tagged values and SQL's metadata restored. */
export function decodeDataJSON(text: string): unknown {
  return decode(JSON.parse(text), true);
}

/** `plan` as JSON text. */
export function planToJSON(plan: PlanOp): string {
  return JSON.stringify({ version: PLAN_FORMAT_VERSION, plan: encode(plan, true) });
}

/** The plan JSON text `text` (from {@link planToJSON}) holds. */
export function planFromJSON(text: string): PlanOp {
  const e = JSON.parse(text) as { version?: unknown; plan?: unknown } | null;
  if (!e || typeof e !== 'object' || e.version !== PLAN_FORMAT_VERSION) return decodePlan(e as EncodedPlan);
  return decode(e.plan, true) as PlanOp;
}
