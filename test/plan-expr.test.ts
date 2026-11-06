/** Plan expressions and the SQL semantic functions (ADR 0014, step 3a). */
import { describe, expect, it } from 'vitest';
import { SQL_FUNCTIONS, sqlFunction, SQL_ALIASES, canonicalName, isEngineOperation } from '../src/engine/exec/sql-functions.js';
import { applyNumericAffinity } from '../src/engine/exec/convert.js';
import { call, col, lit, param, typeOf } from '../src/engine/plan/expr.js';
import { printExpr } from '../src/engine/plan/print.js';
import { PLAN_FORMAT_VERSION } from '../src/engine/plan/types.js';
import { Collation, type SqlValue } from '../src/engine/values.js';

const arg = (v: SqlValue, type: 'int' | 'real' | 'text' | 'any' = 'any') => ({ fn: () => v, type, constant: true });

describe('plan expressions', () => {
  it('build, type and print', () => {
    const e = call('sql.eq', [col(0, 2, 'text', 'nocase'), lit('x')], 'int', 'nocase');
    expect(typeOf(e)).toBe('int');
    expect(printExpr(e)).toBe("sql.eq(#0.2, 'x')[nocase]");
    expect(printExpr(call('sql.add', [col(1, 0, 'int', 'binary', 1), param(0)], 'num'))).toBe('sql.add(#1.0^1, $0)');
    expect(printExpr({ k: 'and', args: [lit(1), { k: 'isNull', arg: lit(null), not: true }] })).toBe('(1 and NULL is not null)');
    expect(typeOf(lit(1.5))).toBe('real');
    expect(typeOf(lit(2n))).toBe('int');
    expect(PLAN_FORMAT_VERSION).toBe(1); // 1: meaning fields replace version 0's $sql / $flattened (ADR 0016 section 2)
  });
});

describe('SQL semantic functions', () => {
  it('have behaviour names, with their former sql.* names as aliases of the same operation (ADR 0016 step 4)', () => {
    const names = [...SQL_FUNCTIONS.keys()];
    const canonical = names.filter((n) => !n.startsWith('sql.'));
    expect(canonical.length).toBeGreaterThan(0);
    for (const [alias, name] of Object.entries(SQL_ALIASES)) {
      expect(alias.startsWith('sql.'), alias).toBe(true);
      expect(name.startsWith('sql.'), name).toBe(false);
      expect(canonicalName(alias)).toBe(name);
      expect(isEngineOperation(alias) && isEngineOperation(name), alias).toBe(true);
      // The same definition, traits included, under both names (the clock operations are compiled, not registered).
      if (SQL_FUNCTIONS.has(name)) expect(SQL_FUNCTIONS.get(alias), alias).toBe(SQL_FUNCTIONS.get(name));
    }
    for (const n of names) if (n.startsWith('sql.')) expect(SQL_ALIASES[n], n).toBeDefined();
    expect(() => sqlFunction('sql.nope')).toThrow(/no SQL function/);
  });

  it('keep SQLite semantics', () => {
    const run = (name: string, args: ReturnType<typeof arg>[], o = {}) => sqlFunction(name).compile(args, o).fn([]);
    expect(run('sql.div', [arg(7, 'int'), arg(2, 'int')])).toBe(3);
    expect(run('sql.div', [arg(7, 'int'), arg(0, 'int')])).toBe(null);
    expect(run('sql.add', [arg(9007199254740991, 'int'), arg(1, 'int')])).toBe(9007199254740992n);
    expect(run('sql.mul', [arg(2n ** 62n, 'int'), arg(4, 'int')])).toBe(2 ** 64);
    expect(run('sql.add', [arg('3abc', 'text'), arg(1, 'int')])).toBe(4);
    expect(run('sql.eq', [arg('abc', 'text'), arg('ABC', 'text')], { collation: Collation.NoCase })).toBe(1);
    expect(run('sql.eq', [arg(null), arg(1, 'int')])).toBe(null);
    expect(run('sql.is', [arg(null), arg(null)])).toBe(1);
    // An affinity conversion on the left operand: '10' compares as the number 10.
    expect(sqlFunction('sql.eq').compile([{ ...arg('10', 'text'), convert: applyNumericAffinity }, arg(10, 'int')], {}).fn([])).toBe(1);
    expect(run('sql.lt', [arg(1, 'int'), arg('1', 'text')])).toBe(1); // numbers sort before text
    expect(run('sql.concat', [arg(1.0, 'real'), arg('x', 'text')])).toBe('1.0x');
    expect(run('sql.like', [arg('Hello', 'text'), arg('h%', 'text')])).toBe(1);
    expect(run('sql.glob', [arg('Hello', 'text'), arg('h*', 'text')], { negated: true })).toBe(1);
    expect(run('sql.in_list', [arg('2', 'text'), arg(1, 'int'), arg(2, 'int')], { probeAffinity: 'NONE' })).toBe(0);
    expect(run('sql.in_list', [arg('2', 'text'), arg(1, 'int'), arg(2, 'int')], { probeAffinity: 'NUMERIC' })).toBe(0);
    expect(run('sql.in_list', [arg(2, 'int'), arg(1, 'int'), arg(null)], {})).toBe(null);
    expect(run('sql.cast_integer', [arg('12.7xyz', 'text')])).toBe(12);
    expect(run('sql.shl', [arg(1, 'int'), arg(-1, 'int')])).toBe(0);
    expect(run('sql.neg', [arg(-(2n ** 63n), 'int')])).toBe(2 ** 63);
  });
});
