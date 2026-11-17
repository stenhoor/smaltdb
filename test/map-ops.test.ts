/**
 * The map operations (ADR 0038 step 2): building (`map_of`, `map_from_entries`), reading (`map_get`,
 * `map_contains_key`, `map_len`, `map_keys`, `map_values`, `map_entries`) and changing (`map_merge`, `map_remove`).
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanType } from '../src/engine/plan/types.js';

const db = Database.openMemory();
const M = 'map<text, any>' as PlanType;
const MI = 'map<text, int>' as PlanType;

/** One row's value of `e`, from a frame with columns props (map<text, any>) and counts (map<text, int>). */
function one(e: (props: PlanExpr, counts: PlanExpr) => PlanExpr, type: PlanType, row = 0): unknown {
  const frame = p.fromColumns(
    [
      [{ name: 'Ada', born: 1815, title: null }, null],
      [{ a: 1, b: 2 }, { c: 3 }],
    ] as never,
    [M, MI],
  );
  const out = db.queryPlan(p.project(frame, [e(p.col(0, 0, M), p.col(0, 1, MI))].map((x) => ({ ...x, type }) as PlanExpr)));
  return out.rows[row]![0];
}
const call = (fn: string, args: PlanExpr[], type: PlanType) => p.call(fn, args, type);

describe('building maps', () => {
  it('map_of takes keys and values in pairs; a repeated key keeps its last value; keys end up sorted', () => {
    expect(one(() => call('map_of', [p.lit('b'), p.lit(2), p.lit('a'), p.lit(1), p.lit('b'), p.lit(3)], MI), MI)).toEqual({ a: 1, b: 3 });
    expect(Object.keys(one(() => call('map_of', [p.lit('z'), p.lit(1), p.lit('a'), p.lit(2)], MI), MI) as object)).toEqual(['a', 'z']);
    expect(one(() => call('map_of', [], M), M)).toEqual({});
  });

  it('map_of refuses an odd number of arguments and keys that are not text', () => {
    expect(() => one(() => call('map_of', [p.lit('a')], M), M)).toThrow(/keys and values in pairs/);
    expect(() => one(() => call('map_of', [p.lit(1), p.lit(2)], M), M)).toThrow(/keys are text, not number/);
  });

  it('map_from_entries and map_entries convert to and from ADR 0020 lists of key and value structs', () => {
    const entries = one((props) => call('map_entries', [props], 'list<struct<key text, value any>>' as PlanType), 'list<struct<key text, value any>>' as PlanType);
    expect(entries).toEqual([
      { key: 'born', value: 1815 },
      { key: 'name', value: 'Ada' },
      { key: 'title', value: null },
    ]);
    const back = one((props) => call('map_from_entries', [call('map_entries', [props], 'list<struct<key text, value any>>' as PlanType)], M), M);
    expect(back).toEqual({ born: 1815, name: 'Ada', title: null });
  });
});

describe('reading maps', () => {
  it('map_get gives a key value, NULL for a missing key and a NULL map', () => {
    expect(one((props) => call('map_get', [props, p.lit('name')], 'any'), 'any')).toBe('Ada');
    expect(one((props) => call('map_get', [props, p.lit('nope')], 'any'), 'any')).toBeNull();
    expect(one((_props, counts) => call('map_get', [counts, p.lit('c')], 'int'), 'int', 0)).toBeNull();
    expect(one((_props, counts) => call('map_get', [counts, p.lit('c')], 'int'), 'int', 1)).toBe(3);
  });

  it('map_contains_key tells a NULL value from a missing key', () => {
    expect(one((props) => call('map_contains_key', [props, p.lit('title')], 'bool'), 'bool')).toBe(true);
    expect(one((props) => call('map_contains_key', [props, p.lit('nope')], 'bool'), 'bool')).toBe(false);
  });

  it('map_len, map_keys and map_values, in key order', () => {
    expect(one((props) => call('map_len', [props], 'int'), 'int')).toBe(3);
    expect(one((props) => call('map_keys', [props], 'list<text>' as PlanType), 'list<text>' as PlanType)).toEqual(['born', 'name', 'title']);
    expect(one((props) => call('map_values', [props], 'list<any>' as PlanType), 'list<any>' as PlanType)).toEqual([1815, 'Ada', null]);
  });

  it('a map operation on something that is not a map is an error when the plan is compiled', () => {
    expect(() => one(() => call('map_get', [p.lit('x'), p.lit('a')], 'any'), 'any')).toThrow(/map_get takes a map, not text/);
  });
});

describe('changing maps', () => {
  it("map_merge keeps both maps' entries, the second winning (Cypher's SET n += map)", () => {
    expect(one((props) => call('map_merge', [props, call('map_of', [p.lit('name'), p.lit('Ada Lovelace'), p.lit('died'), p.lit(1852)], M)], M), M)).toEqual({
      born: 1815,
      died: 1852,
      name: 'Ada Lovelace',
      title: null,
    });
  });

  it('map_remove drops the keys listed, and gives the map unchanged for a NULL list', () => {
    expect(one((props) => call('map_remove', [props, call('list_of', [p.lit('title'), p.lit('nope')], 'list<text>' as PlanType)], M), M)).toEqual({ born: 1815, name: 'Ada' });
    expect(one((props) => call('map_remove', [props, p.lit(null)], M), M)).toEqual({ born: 1815, name: 'Ada', title: null });
  });

  it('results of map operations are maps like any other: equal maps group together', () => {
    const frame = p.fromColumns([[{ a: 1 }, { b: 2 }]] as never, [MI]);
    const merged = p.project(frame, [call('map_merge', [p.col(0, 0, MI), call('map_of', [p.lit('a'), p.lit(1), p.lit('b'), p.lit(2)], MI)], MI)]);
    expect(db.queryPlan(p.aggregate(merged, [p.col(0, 0, MI)], [p.agg('count', [], 'int', { star: true })])).rows).toEqual([[{ a: 1, b: 2 }, 2]]);
  });
});
