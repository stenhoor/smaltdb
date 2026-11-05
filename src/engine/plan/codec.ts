/**
 * Plans as data that crosses a boundary (ADR 0015 section 9): to another worker (`structuredClone`, postMessage) or as
 * text (JSON). A plan in memory is plain data except for what SQL keeps beside it (exec/sql-meta.ts: an expression's
 * collation source and affinity, a SELECT's flattening mark), held under symbols that copying leaves out. Encoding
 * writes those as `$sql` / `$flattened` fields, and decoding puts them back, so a decoded plan plans and runs exactly
 * as the original.
 *
 * - `encodePlan` / `decodePlan`: a structured-clone-safe object (bigints and blobs stay as they are).
 * - `planToJSON` / `planFromJSON`: JSON text; bigints, blobs and non-finite numbers are tagged objects.
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
  if (Array.isArray(x)) return x.map(encodeData);
  if (!x || typeof x !== 'object' || x instanceof Uint8Array) return x;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) if (v !== undefined) out[k] = encodeData(v);
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
  if (Array.isArray(x)) return x.map(decodeData);
  if (!x || typeof x !== 'object' || x instanceof Uint8Array) return x;
  const out: Record<string, unknown> = {};
  let meta: SqlMeta | undefined;
  let flattened = false;
  for (const [k, v] of Object.entries(x)) {
    if (k === '$sql') meta = v as SqlMeta;
    else if (k === '$flattened') flattened = v === true;
    else out[k] = decodeData(v);
  }
  if (meta) setMeta(out as unknown as BoundExpr, { ...meta });
  if (flattened) markFlattened(out as unknown as PlanOp);
  return out;
}

/** Encoded data as JSON text: bigints, blobs and non-finite numbers are tagged objects. */
export function dataToJSON(encoded: unknown): string {
  return JSON.stringify(encoded, (_k, v: unknown) => {
    if (typeof v === 'bigint') return { $bigint: v.toString() };
    if (v instanceof Uint8Array) return { $blob: Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('') };
    if (typeof v === 'number' && !Number.isFinite(v)) return { $real: String(v) };
    return v;
  });
}

/** JSON text {@link dataToJSON} made, with its tagged values restored. */
export function dataFromJSON(text: string): unknown {
  return JSON.parse(text, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (Object.keys(o).length === 1) {
        if (typeof o.$bigint === 'string') return BigInt(o.$bigint);
        if (typeof o.$blob === 'string') {
          const h = o.$blob;
          const b = new Uint8Array(h.length / 2);
          for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
          return b;
        }
        if (typeof o.$real === 'string') return Number(o.$real);
      }
    }
    return v;
  });
}

/** `plan` as JSON text. */
export function planToJSON(plan: PlanOp): string {
  return dataToJSON(encodePlan(plan));
}

/** The plan JSON text `text` (from {@link planToJSON}) holds. */
export function planFromJSON(text: string): PlanOp {
  return decodePlan(dataFromJSON(text) as EncodedPlan);
}
