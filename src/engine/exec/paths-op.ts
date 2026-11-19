/**
 * `paths` run natively (prototype of the traversal operator, smaltcy ADR 0004's step 9 bar): for each input row, the
 * paths from its start node walked level by level over the in-memory copies of the edge tables' `(start, end)` and
 * `(end, start)` indexes (exec/index-cache.ts), not rewritten into a recursive CTE (plan-normalize.ts `pathRows`). The
 * same rows, in the same order: an input row's paths shortest first, then in the order the steps find them (each
 * edge table in `edges`' order, `out` before `in`, each node's relationships in its index's order).
 */
import type { SqlValue } from '../values.js';
import type { Operator, ExecState } from './operators.js';
import type { IndexCache } from './index-cache.js';
import { encodeKey } from '../storage/key-codec.js';

/** One way to walk one edge table: the copy of its index on the end walked from, and the table's position. */
export interface PathStep {
  readonly edge: number;
  readonly cache: () => IndexCache | undefined;
}

export interface PathsSpec {
  readonly steps: readonly PathStep[];
  readonly edgeCount: number;
  readonly minHops: number;
  readonly maxHops: number | undefined;
  readonly mode: 'walk' | 'trail' | 'acyclic' | 'simple';
  readonly selector: 'all' | 'any' | 'anyShortest' | 'allShortest' | { readonly shortest: number };
  /** Read a self-loop once, though `both` reads it from each end. */
  readonly loopsOnce: boolean;
  /** Whether the path column is wanted (else NULL: nothing reads it). */
  readonly path: boolean;
}

/** A path, as a link to the one it extends (a chain at most `maxHops` long): nothing is copied per path. */
interface Path {
  readonly end: SqlValue;
  readonly hops: number;
  readonly parent: Path | null;
  /** The hop that ends it (none for the empty path): edge position, rowid, from, and the relationship's identity. */
  readonly edge: number;
  readonly rowid: number | bigint;
  readonly from: SqlValue;
  readonly relId: number | bigint | string;
  /** Its path value's bytes, made when first wanted (its parent's, then its hop's component). */
  bytes?: Uint8Array;
}

/**
 * A path's `PATH_TYPE` value: a list is its elements' key components one after another, and each element (a struct of
 * edge, rowid, from and to) is one component of its own fields' encoding; so a path's bytes are its parent's followed
 * by its hop's component, made once per path.
 */
function pathBytes(p: Path): Uint8Array {
  if (p.bytes) return p.bytes;
  if (p.hops === 0 || p.parent === null) return (p.bytes = EMPTY);
  const before = pathBytes(p.parent);
  const hop = encodeKey([encodeKey([p.edge, p.rowid, p.from, p.end])]);
  const out = new Uint8Array(before.length + hop.length);
  out.set(before);
  out.set(hop, before.length);
  return (p.bytes = out);
}
const EMPTY = new Uint8Array(0);

/** Whether a path has walked a relationship (trail mode). */
function hasRel(p: Path, id: number | bigint | string): boolean {
  for (let x: Path | null = p; x !== null && x.hops > 0; x = x.parent) if (x.relId === id) return true;
  return false;
}

/** Whether a path has visited a node (acyclic and simple modes): its start and every hop's end. */
function hasNode(p: Path, n: SqlValue): boolean {
  for (let x: Path | null = p; x !== null; x = x.parent) if (x.end === n) return true;
  return false;
}

export class PathsScan implements Operator {
  readonly children: Operator[];
  private r!: SqlValue[];
  private found: Path[] = [];
  private at = 0;

  constructor(
    private readonly input: Operator,
    private readonly inRegs: readonly number[],
    private readonly startReg: number,
    private readonly outRegs: readonly number[],
    private readonly spec: PathsSpec,
  ) {
    this.children = [input];
  }

  get detail(): string {
    return `PATHS (native, ${this.spec.mode}, ${this.spec.minHops}..${this.spec.maxHops ?? ''})`;
  }

  open(r: SqlValue[]): void {
    this.r = r;
    this.found = [];
    this.at = 0;
    this.input.open(r);
  }

  next(): boolean {
    const r = this.r;
    while (this.at >= this.found.length) {
      if (!this.input.next()) return false;
      const start = r[this.startReg];
      this.found = start === null ? [] : this.walk(start);
      this.at = 0;
    }
    const p = this.found[this.at++]!;
    const out = this.outRegs;
    const n = this.inRegs.length;
    for (let i = 0; i < n; i++) r[out[i]!] = r[this.inRegs[i]!]!;
    r[out[n]!] = p.end;
    r[out[n + 1]!] = p.hops;
    r[out[n + 2]!] = this.spec.path ? pathBytes(p) : null;
    return true;
  }

  close(): void {
    this.input.close();
    this.found = [];
  }

  /** Every path from `start` the spec asks for, shortest first. */
  private walk(start: SqlValue): Path[] {
    const s = this.spec;
    const caches = s.steps.map((x) => x.cache());
    const keyed = s.mode === 'walk' && (s.selector === 'any' || s.selector === 'anyShortest');
    const bucket = (h: number) => (h >= s.minHops ? s.minHops : h);
    const seen = keyed ? new Set<string>() : null;
    const keyOf = (end: SqlValue, h: number) => `${typeof end}:${String(end)}:${bucket(h)}`;
    const first: Path = { end: start, hops: 0, parent: null, edge: -1, rowid: 0, from: null, relId: -1 };
    seen?.add(keyOf(start, 0));
    const out: Path[] = [];
    if (s.minHops <= 0) out.push(first);
    const trail = s.mode === 'trail';
    const nodes = s.mode === 'acyclic' || s.mode === 'simple';
    let level: Path[] = [first];
    for (let h = 1; level.length && (s.maxHops === undefined || h <= s.maxHops); h++) {
      const next: Path[] = [];
      for (let k = 0; k < s.steps.length; k++) {
        const step = s.steps[k]!;
        const cache = caches[k]!;
        // A self-loop read from its other end too, when it is read once: the `in` step of a `both` walk skips it.
        const skipLoops = s.loopsOnce && k % 2 === 1;
        for (const p of level) {
          if (s.mode === 'simple' && p.hops > 0 && p.end === start) continue;
          const g = cache?.group(p.end);
          if (!g) continue;
          for (let j = 0; j < g.rowids.length; j++) {
            const to = g.second[j]!;
            const rowid = g.rowids[j]!;
            if (skipLoops && to === p.end) continue;
            const relId = s.edgeCount === 1 ? rowid : `${String(rowid)}:${step.edge}`;
            if (trail && hasRel(p, relId)) continue;
            if (nodes) {
              const fresh = !hasNode(p, to);
              if (s.mode === 'acyclic' ? !fresh : !(fresh || to === start)) continue;
            }
            if (seen) {
              const key = keyOf(to, h);
              if (seen.has(key)) continue;
              seen.add(key);
            }
            next.push({ end: to, hops: h, parent: p, edge: step.edge, rowid, from: p.end, relId });
          }
        }
      }
      if (h >= s.minHops) out.push(...next);
      level = next;
    }
    if (keyed || s.selector === 'all') return out;
    // Each last node's paths, ranked by hops (they come shortest first): the ranks the selector keeps.
    const kept: Path[] = [];
    const byEnd = new Map<string, { n: number; hops: number }>();
    const k = typeof s.selector === 'object' ? s.selector.shortest : 1;
    for (const p of out) {
      const key = `${typeof p.end}:${String(p.end)}`;
      const e = byEnd.get(key);
      if (s.selector === 'allShortest') {
        if (e && p.hops > e.hops) continue;
        if (!e) byEnd.set(key, { n: 1, hops: p.hops });
        kept.push(p);
      } else {
        if (e && e.n >= k) continue;
        byEnd.set(key, { n: (e?.n ?? 0) + 1, hops: p.hops });
        kept.push(p);
      }
    }
    return kept;
  }
}

export type { ExecState };
