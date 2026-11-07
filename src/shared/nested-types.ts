/**
 * List and struct types (ADR 0020), as text: `list<T>` and `struct<name T, …>`, nested to any depth, where `T` is any
 * plan type. Parsing only: the values are in `nested.ts`. No dependencies, so the plan format (`smaltdb/plan`) can use it.
 */

/** A list or struct type, as text. */
export type NestedTypeName = `list<${string}>` | `struct<${string}>`;

/** A list or struct type, parsed. */
export type NestedType = { readonly kind: 'list'; readonly of: string } | { readonly kind: 'struct'; readonly fields: readonly { readonly name: string; readonly type: string }[] };

const BASE_TYPES = new Set(['int', 'bool', 'real', 'num', 'text', 'blob', 'null', 'any', 'date', 'datetime', 'time', 'duration']);

/** Whether `t` is written as a list or struct type (`isNestedType` also checks it). */
export const isNested = (t: string): t is NestedTypeName => t.startsWith('list<') || t.startsWith('struct<');

const PARSED = new Map<string, NestedType | null>();

/** Split `s` at top-level commas (outside `<…>`). */
function splitTop(s: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '<') depth++;
    else if (c === '>') {
      if (--depth < 0) return null;
    } else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (depth !== 0) return null;
  out.push(s.slice(start).trim());
  return out;
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `t` parsed, or null when it isn't a well-formed list or struct type (its element types checked too). */
export function parseNested(t: string): NestedType | null {
  if (PARSED.has(t)) return PARSED.get(t)!;
  let r: NestedType | null = null;
  if (t.startsWith('list<') && t.endsWith('>')) {
    const of = t.slice(5, -1).trim();
    if (isPlanTypeName(of)) r = { kind: 'list', of };
  } else if (t.startsWith('struct<') && t.endsWith('>')) {
    const parts = splitTop(t.slice(7, -1));
    if (parts && parts.length > 0 && parts.every((p) => p !== '')) {
      const fields = parts.map((p) => {
        const sp = p.search(/\s/);
        return sp < 0 ? null : { name: p.slice(0, sp), type: p.slice(sp).trim() };
      });
      const names = new Set<string>();
      const ok = fields.every((f) => f !== null && FIELD_NAME.test(f.name) && !names.has(f.name) && (names.add(f.name), true) && isPlanTypeName(f.type));
      if (ok) r = { kind: 'struct', fields: fields as { name: string; type: string }[] };
    }
  }
  if (PARSED.size > 1000) PARSED.clear();
  PARSED.set(t, r);
  return r;
}

/** Whether `t` is a plan type: a simple one, or a well-formed list or struct type. */
export function isPlanTypeName(t: string): boolean {
  return BASE_TYPES.has(t) || (isNested(t) && parseNested(t) !== null);
}

/** Whether `t` is a well-formed list or struct type. */
export const isNestedType = (t: string): t is NestedTypeName => isNested(t) && parseNested(t) !== null;
