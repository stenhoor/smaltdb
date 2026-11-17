/**
 * Lists, structs and maps (ADR 0020, ADR 0038): their types, the bytes their values are while a plan runs, and the JavaScript values
 * results give them as. Shared by the engine (values in, results in process) and the client (results through the
 * worker).
 *
 * A type is text: `list<T>` or `struct<name T, …>`, nested to any depth, where `T` is any plan type. A value is a blob
 * of its elements (a struct's fields, in order) encoded as index-key components one after another, so blobs compare,
 * sort, group and hash as the values do: element by element, a shorter list first. A nested value is a blob element.
 * A map is its entries sorted by key (code point order, which is UTF-8 byte order), each a key then a value, so equal
 * maps have equal bytes (ADR 0038).
 */
import { decodeKey, encodeKey } from '../engine/storage/key-codec.js';
import type { SqlValue } from '../engine/values.js';
import { type NestedTypeName, isNested, parseNested } from './nested-types.js';
import { isTemporal, parseDate, parseDatetime, parseTime, temporalText } from './temporal.js';

export { type NestedType, type NestedTypeName, isNested, isNestedType, isPlanTypeName, parseNested } from './nested-types.js';

// ------------------------------------------------------------------ values in

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array) && !(v instanceof Date) && !ArrayBuffer.isView(v);

/** A JavaScript value as an element of type `t` (the engine's value for it), or an error naming `where`. */
function elementValue(t: string, v: unknown, where: string): SqlValue {
  if (v === null || v === undefined) return null;
  if (isNested(t)) {
    if (v instanceof Uint8Array) return v;
    return encodeNested(t, v, where);
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isTemporal(t)) {
    if (typeof v === 'number' || typeof v === 'bigint') return v;
    if (v instanceof Date) return t === 'date' ? Math.floor(v.getTime() / 86_400_000) : v.getTime() * 1000;
    if (typeof v === 'string') {
      const p = t === 'date' ? parseDate(v) : t === 'datetime' ? parseDatetime(v) : t === 'time' ? parseTime(v) : null;
      if (p !== null) return p;
    }
    throw new TypeError(`${where}: cannot read ${JSON.stringify(v)} as a ${t}`);
  }
  if (t === 'bool') {
    if (v === 0 || v === 1) return v;
    throw new TypeError(`${where}: a bool is true or false, not ${JSON.stringify(v)}`);
  }
  // Each simple type holds its own values; `any` holds every engine value.
  const ok =
    t === 'text' ? typeof v === 'string'
    : t === 'int' ? typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v))
    : t === 'real' || t === 'num' ? typeof v === 'number' || typeof v === 'bigint'
    : t === 'blob' ? v instanceof Uint8Array
    : typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string' || v instanceof Uint8Array;
  if (ok) return v as SqlValue;
  const what = Array.isArray(v) ? 'an array' : v instanceof Uint8Array ? 'a blob' : typeof v === 'string' ? JSON.stringify(v) : typeof v === 'object' ? 'an object' : String(v);
  throw new TypeError(`${where}: a ${t} element cannot hold ${what}`);
}

/**
 * The bytes of a value of list or struct type `t` given as JavaScript: an array for a list; an object (by field name,
 * missing fields NULL) or an array (by position) for a struct. Elements are as the element types take them.
 */
export function encodeNested(t: NestedTypeName, v: unknown, where = 'value'): Uint8Array {
  const n = parseNested(t);
  if (!n) throw new TypeError(`${where}: ${t} is not a list, struct or map type`);
  if (n.kind === 'map') {
    let entries: [unknown, unknown][];
    if (v instanceof Map) entries = [...v.entries()];
    else if (isPlainObject(v)) entries = Object.entries(v);
    else throw new TypeError(`${where}: a ${t} is an object or a Map, not ${Array.isArray(v) ? 'an array' : typeof v}`);
    const flat: SqlValue[] = [];
    for (const [k] of entries) if (typeof k !== 'string') throw new TypeError(`${where}: a ${t}'s keys are text, not ${typeof k}`);
    entries.sort((a, b) => compareCodePoints(a[0] as string, b[0] as string));
    for (const [k, x] of entries) flat.push(k as string, elementValue(n.of, x, `${where}.${k as string}`));
    return encodeKey(flat);
  }
  if (n.kind === 'list') {
    if (!Array.isArray(v)) throw new TypeError(`${where}: a ${t} is an array, not ${typeof v}`);
    return encodeKey(v.map((x, i) => elementValue(n.of, x, `${where}[${i}]`)));
  }
  if (Array.isArray(v)) {
    if (v.length !== n.fields.length) throw new TypeError(`${where}: a ${t} has ${n.fields.length} fields, not ${v.length}`);
    return encodeKey(n.fields.map((f, i) => elementValue(f.type, v[i], `${where}.${f.name}`)));
  }
  if (!isPlainObject(v)) throw new TypeError(`${where}: a ${t} is an object, not ${typeof v}`);
  for (const k of Object.keys(v)) if (!n.fields.some((f) => f.name === k)) throw new TypeError(`${where}: ${t} has no field ${k}`);
  return encodeKey(n.fields.map((f) => elementValue(f.type, v[f.name], `${where}.${f.name}`)));
}

/** Order of two strings by code point, which is the order of their UTF-8 bytes (UTF-16 order differs past U+FFFF). */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    // A surrogate (a code point past U+FFFF) sorts after every other code unit, as its UTF-8 bytes do.
    const xs = x >= 0xd800 && x <= 0xdfff;
    const ys = y >= 0xd800 && y <= 0xdfff;
    if (xs !== ys) return xs ? 1 : -1;
    return x - y;
  }
  return a.length - b.length;
}

// ------------------------------------------------------------------ results

/** A result value of an element of type `t`: bool as a boolean, dates and times as text, lists and structs as JS. */
function resultElement(t: string, v: SqlValue): unknown {
  if (v === null) return null;
  if (t === 'bool') return v !== 0 && v !== 0n;
  if (isTemporal(t)) return temporalText(t, v);
  if (isNested(t) && v instanceof Uint8Array) return decodeNested(t, v);
  return v;
}

/** The JavaScript value of `bytes`, a value of list, struct or map type `t`: an array, or an object by field or key. */
export function decodeNested(t: NestedTypeName, bytes: Uint8Array): unknown {
  const n = parseNested(t);
  if (!n) return bytes;
  const vals = decodeKey(bytes);
  if (n.kind === 'list') return vals.map((v) => resultElement(n.of, v));
  if (n.kind === 'map') {
    // fromEntries: a key such as "__proto__" is an own property, not the object's prototype.
    const entries: [string, unknown][] = [];
    for (let i = 0; i + 1 < vals.length; i += 2) entries.push([vals[i] as string, resultElement(n.of, vals[i + 1]!)]);
    return Object.fromEntries(entries);
  }
  const out: Record<string, unknown> = {};
  n.fields.forEach((f, i) => (out[f.name] = resultElement(f.type, vals[i] ?? null)));
  return out;
}

/** A result value of type `t`: decoded when `t` is a list or struct type and `v` its bytes. */
export const nestedResult = (t: string, v: SqlValue): unknown => (v instanceof Uint8Array && isNested(t) ? decodeNested(t, v) : v);
