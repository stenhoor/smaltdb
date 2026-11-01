/**
 * Glob patterns and Hive-style partitions for external locations (M8.2).
 *
 * - `*` matches within one path segment, `**` across segments (also none), `?` one character,
 *   `[abc]` / `[a-z]` / `[!abc]` a character class, `{a,b}` alternatives.
 * - `key=value` path segments (Hive partitioning, as written by Spark, Athena, DuckDB, …) become
 *   columns of every row of that file.
 */
import type { SqlValue } from '../values.js';

const SPECIAL = /[*?[{]/;

/** Whether `location` is a pattern (has a wildcard). */
export function isGlob(location: string): boolean {
  return SPECIAL.test(location);
}

/** The literal part of `pattern` before its first wildcard (the prefix to list). */
export function globPrefix(pattern: string): string {
  const i = pattern.search(SPECIAL);
  return i < 0 ? pattern : pattern.slice(0, i);
}

/** A RegExp matching whole paths against `pattern`. */
export function globRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` also matches no directory at all.
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i++;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 2);
      if (end < 0) {
        re += '\\[';
        continue;
      }
      let cls = pattern.slice(i + 1, end);
      if (cls.startsWith('!')) cls = '^' + cls.slice(1);
      re += '[' + cls.replace(/\\/g, '\\\\') + ']';
      i = end;
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end < 0) {
        re += '\\{';
        continue;
      }
      re += '(?:' + pattern.slice(i + 1, end).split(',').map(escape).join('|') + ')';
      i = end;
    } else re += escape(c);
  }
  return new RegExp('^' + re + '$');
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Hive's marker for a NULL partition value. */
const HIVE_NULL = '__HIVE_DEFAULT_PARTITION__';

/** The `key=value` directory segments of `path` (not the file name), in order. */
export function hivePartitions(path: string): [string, string | null][] {
  const segs = path.replace(/[?#].*$/, '').split('/');
  segs.pop(); // the file name
  const out: [string, string | null][] = [];
  for (const s of segs) {
    const m = /^([^=]+)=(.*)$/.exec(s);
    if (!m) continue;
    let v: string | null;
    try {
      v = decodeURIComponent(m[2]);
    } catch {
      v = m[2];
    }
    out.push([m[1], v === HIVE_NULL ? null : v]);
  }
  return out;
}

const INT_RE = /^[+-]?\d+$/;
const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** A partition value typed like CSV text: integers and reals become numbers. */
export function partitionValue(v: string | null): SqlValue {
  if (v === null) return null;
  if (INT_RE.test(v) && Number.isSafeInteger(Number(v))) return Number(v);
  if (NUM_RE.test(v)) return Number(v);
  return v;
}
