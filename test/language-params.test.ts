/**
 * Parameters and NaN (ADR 0018 section 2): a plan's parameters keep NaN, a value of `real`; a language statement's
 * parameters go through its language's `parameter` hook, and without one NaN binds as NULL (SQL's meaning, until
 * smaltql provides the hook).
 */
import { afterEach, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p, registerLanguage } from '../src/engine/index.js';
import { registeredLanguage } from '../src/engine/plan/language.js';
import type { SqlValue } from '../src/engine/values.js';

const sql = registeredLanguage('sql')!;
afterEach(() => registerLanguage(sql));

it("a plan's parameters keep NaN", () => {
  const d = Database.openMemory();
  const st = d.preparePlan(p.project(p.values([[]]), [p.param(0, 'real')]));
  const v = st.all([NaN])[0][0];
  expect(Number.isNaN(v as number)).toBe(true);
});

it("a language statement's parameters: NaN as NULL without the hook", () => {
  const d = Database.openMemory();
  expect(d.query('SELECT ?', [NaN]).rows).toEqual([[null]]);
});

it("a language statement's parameters go through its parameter hook", () => {
  const seen: SqlValue[] = [];
  registerLanguage({ ...sql, parameter: (v: SqlValue) => (seen.push(v), typeof v === 'number' && v !== v ? 'nan' : v) });
  const d = Database.openMemory();
  expect(d.query('SELECT ?, ?, ?', [NaN, true, 2n]).rows).toEqual([['nan', 1, 2]]);
  // The hook sees the engine's own conversions done: NaN as given, true as 1, a safe bigint as a number.
  expect(seen.length).toBe(3);
  expect(Number.isNaN(seen[0] as number)).toBe(true);
  expect(seen.slice(1)).toEqual([1, 2]);
});
