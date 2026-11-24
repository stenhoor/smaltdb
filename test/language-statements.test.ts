/**
 * Statements of a registered language through the entry points that take text (ADR 0042, section 4): kept by their
 * text, by their shape (`LanguageStatement.shape`) and by the variant their values make of them
 * (`LanguageStatement.variant`). The language here is a toy one, `tiny`:
 *
 *   all <table>                          every row
 *   find <table> <column> <value>        the rows whose column is the value: a number, a 'text', or $name
 *   add <table> <value> <value>          a row
 *   either <table> <id> $name            the row with the id, and the rows whose id or name is $name, by its kind
 *   kind $v                              the kind of value $v is bound for: the statement binds by its values
 *   pin $v                               $v, bound for its value: a variant for every value
 *   sum $list                            the length of a list given as a parameter
 *   raw <table>                          every row, the table named in the plan and not looked up
 *   broken                               plan data that is not a plan
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p, registerLanguage } from '../src/engine/index.js';
import type { BindContext } from '../src/engine/plan/bind-context.js';
import type { LanguageStatement, SmaltLanguage, StatementParams } from '../src/engine/plan/language.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import type { SqlValue } from '../src/engine/values.js';

/** What the language was asked to do. */
const asked = { parsed: 0, bound: [] as string[] };
beforeEach(() => {
  asked.parsed = 0;
  asked.bound = [];
});

const column = (name: string, type: 'int' | 'text' | 'any') => ({ name, type });
const kindOf = (v: unknown): 'int' | 'text' => (typeof v === 'string' ? 'text' : 'int');
const named = (params: StatementParams | undefined, name: string): unknown => (params === undefined ? undefined : Array.isArray(params) ? params[0] : (params as Record<string, unknown>)[name]);

/** A statement with what its shape is found by. */
interface Tiny extends LanguageStatement {
  readonly key?: string;
}

/** A hash that is the same for many shapes: the engine must ask `same`. */
const weakHash = (key: string): number => key.length % 3;

function statement(source: string): Tiny {
  asked.parsed++;
  const [verb, ...rest] = source.trim().split(/\s+/);
  const plain = { text: source, paramCount: 0, paramNames: new Map<string, number>() };
  const table = (ctx: BindContext, name: string) => ctx.table(name) ?? (() => { throw new Error(`tiny: no table ${name}`); })();
  switch (verb) {
    case 'all': {
      const [name] = rest;
      return { ...plain, bind: (ctx) => (asked.bound.push(source), { kind: 'query', plan: p.scan(table(ctx, name!).name, [0, 1]), columns: [column('id', 'int'), column('name', 'text')] }) };
    }
    case 'find': {
      const [name, col, written] = rest;
      const find = (ctx: BindContext, kind: 'int' | 'text'): PlanStatementInput => {
        const t = table(ctx, name!);
        const at = t.columns.findIndex((c) => c.name === col);
        return { kind: 'query', plan: p.filter(p.scan(t.name, [0, 1]), p.call('cmp_eq', [p.col(0, at, kind), p.param(0, kind)], 'bool')), columns: [column('id', 'int'), column('name', 'text')] };
      };
      if (written!.startsWith('$')) {
        // A parameter: what it is compared as is its value's kind, so the statement binds by its values.
        return {
          text: source,
          paramCount: 1,
          paramNames: new Map([[written!, 1]]),
          variant: (params) => kindOf(named(params, written!.slice(1))),
          bind: (ctx, params) => (asked.bound.push(`${source} for ${kindOf(named(params, written!.slice(1)))}`), find(ctx, kindOf(named(params, written!.slice(1))))),
        };
      }
      // A value written in the text: taken out. The shape is the statement without it, and the value's kind.
      const value: SqlValue = written!.startsWith("'") ? written!.slice(1, -1) : Number(written);
      const key = `find ${name} ${col} ${kindOf(value)}`;
      return { ...plain, key, shape: { hash: weakHash(key), values: [value], same: (other) => (other as Tiny).key === key }, bind: (ctx) => (asked.bound.push(source), find(ctx, kindOf(value))) };
    }
    case 'add': {
      const [name, id, text] = rest;
      const key = `add ${name}`;
      return {
        ...plain,
        key,
        shape: { hash: weakHash(key), values: [Number(id), text!.slice(1, -1)], same: (other) => (other as Tiny).key === key },
        bind: (ctx) => (asked.bound.push(source), { kind: 'write', plan: p.append(table(ctx, name!).name, p.values([[p.param(0, 'int'), p.param(1, 'text')]], ['int', 'text']), [0, 1]) }),
      };
    }
    case 'either': {
      // A value written in the text and a parameter: a shape, and for each kind of the parameter's value a variant.
      const [name, written, param] = rest;
      const key = `either ${name}`;
      const kindNow = (params: StatementParams | undefined) => kindOf(named(params, param!.slice(1)));
      return {
        text: source,
        paramCount: 1,
        paramNames: new Map([[param!, 1]]),
        key,
        shape: { hash: weakHash(key), values: [Number(written)], same: (other) => (other as Tiny).key === key },
        variant: kindNow,
        bind: (ctx, params) => {
          const kind = kindNow(params);
          asked.bound.push(`${source} for ${kind}`);
          // The statement's own parameter first; the value taken out of the text is the parameter after it.
          const own = p.call('cmp_eq', [p.col(0, kind === 'text' ? 1 : 0, kind), p.param(0, kind)], 'bool');
          const written = p.call('cmp_eq', [p.col(0, 0, 'int'), p.param(1, 'int')], 'bool');
          return { kind: 'query', plan: p.filter(p.scan(table(ctx, name!).name, [0, 1]), p.or(own, written)), columns: [column('id', 'int'), column('name', 'text')] };
        },
      };
    }
    case 'pin':
      return {
        text: source,
        paramCount: 1,
        paramNames: new Map([['$v', 1]]),
        variant: (params) => Number(named(params, 'v')),
        bind: (_ctx, params) => {
          const v = params === undefined ? null : Number(named(params, 'v'));
          asked.bound.push(`${source} for ${v}`);
          return { kind: 'query', plan: p.project(p.values([[]]), [p.lit(v), p.param(0, 'int')]), columns: [column('pinned', 'int'), column('v', 'int')] };
        },
      };
    case 'raw':
      return { ...plain, bind: () => ({ kind: 'query', plan: p.scan(rest[0]!, [0, 1]) }) };
    case 'broken':
      // The scan gives one column, and the projection reads its sixth.
      return { ...plain, bind: () => ({ kind: 'query', plan: p.project(p.scan('fruit', [0]), [p.col(0, 5, 'int')]) }) };
    case 'kind':
      return {
        text: source,
        paramCount: 1,
        paramNames: new Map([['$v', 1]]),
        variant: (params) => kindOf(named(params, 'v')),
        bind: (_ctx, params) => {
          const kind = params === undefined ? 'unknown' : kindOf(named(params, 'v'));
          asked.bound.push(`${source} for ${kind}`);
          return { kind: 'query', plan: p.project(p.values([[]]), [p.lit(kind), p.param(0, kind === 'text' ? 'text' : 'int')]), columns: [column('kind', 'text'), column('v', 'any')] };
        },
      };
    case 'sum':
      return {
        text: source,
        paramCount: 1,
        paramNames: new Map([['$list', 1]]),
        bind: () => (asked.bound.push(source), { kind: 'query', plan: p.project(p.values([[]]), [p.call('list_len', [p.param(0, 'list<int>')], 'int')]), columns: [column('n', 'int')] }),
      };
    default:
      throw new Error(`tiny: what is ${verb}?`);
  }
}

const tiny: SmaltLanguage = {
  name: 'tiny',
  plans: 'data',
  parseOne: statement,
  parse: (source) => source.split(';').map((s) => s.trim()).filter((s) => s !== '').map(statement),
};
registerLanguage(tiny);

/** A language that gives one answer to every text. */
const shout: SmaltLanguage = {
  name: 'shout',
  plans: 'data',
  parseOne: (source) => ({ text: source, paramCount: 0, paramNames: new Map(), bind: () => ({ kind: 'query', plan: p.project(p.values([[]]), [p.lit('SHOUT')]), columns: [{ name: 'x', type: 'text' }] }) }),
};

const T = { language: 'tiny' };
function fruit(options = {}): Database {
  const d = Database.openMemory(options);
  d.exec("CREATE TABLE fruit(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO fruit VALUES (1, 'apple'), (2, 'pear'), (3, 'plum')");
  return d;
}

describe('the entry points that take text take a registered language', () => {
  it('query, run, exec and prepare, with the language named', () => {
    const d = fruit();
    expect(d.query('all fruit', undefined, T)).toEqual({ columns: ['id', 'name'], rows: [[1, 'apple'], [2, 'pear'], [3, 'plum']] });
    expect(d.run("add fruit 4 'fig'", undefined, T).changes).toBe(1);
    d.exec("add fruit 5 'lime'; add fruit 6 'kiwi'", undefined, T);
    expect(d.query('SELECT count(*) FROM fruit').rows).toEqual([[6]]);
    const st = d.prepare('find fruit name $n', T);
    expect(st.all(['pear'])).toEqual([[2, 'pear']]);
    expect(st.all({ n: 'kiwi' })).toEqual([[6, 'kiwi']]);
    expect(st.all({ $n: 'fig' })).toEqual([[4, 'fig']]);
  });

  it('the async entry points too', async () => {
    const d = fruit();
    expect((await d.queryAsync('find fruit id 2', undefined, T)).rows).toEqual([[2, 'pear']]);
    expect((await d.runAsync("add fruit 9 'date'", undefined, T)).changes).toBe(1);
    await d.execAsync("add fruit 10 'sloe'; add fruit 11 'haw'", undefined, T);
    expect(d.query('SELECT count(*) FROM fruit').rows).toEqual([[6]]);
  });

  it('SQL is the language where none is named, and named', () => {
    const d = fruit();
    expect(d.query('SELECT name FROM fruit WHERE id = ?', [2]).rows).toEqual([['pear']]);
    expect(d.query('SELECT name FROM fruit WHERE id = ?', [3], { language: 'sql' }).rows).toEqual([['plum']]);
  });

  it('a language that is not registered is an error that names it', () => {
    expect(() => fruit().query('all fruit', undefined, { language: 'other' })).toThrow(/written in other, which is not registered/);
  });

  it("a statement's errors are worded by its language", () => {
    registerLanguage({ ...tiny, name: 'polite', errorMessage: (e) => (e.code.startsWith('SMALT_CONSTRAINT') ? `sorry: ${e.message}` : undefined) });
    const d = fruit();
    expect(() => d.run("add fruit 1 'again'", undefined, { language: 'polite' })).toThrow(/^sorry: /);
    expect(() => d.run("add fruit 1 'again'", undefined, T)).toThrow(/^(?!sorry)/);
  });

  it('plan data that is not a plan is refused, as one given to preparePlan is', () => {
    const d = fruit();
    expect(() => d.query('broken', undefined, T)).toThrow(expect.objectContaining({ code: 'SMALT_PLAN' }));
    expect(() => d.prepare('broken', T).columns).toThrow(expect.objectContaining({ code: 'SMALT_PLAN' }));
  });

  it('a statement that names a TEMP table in its plan reads memory objects', () => {
    const d = fruit();
    d.exec("CREATE TEMP TABLE scratch(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO scratch VALUES (1, 's')");
    expect(d.query('raw scratch', undefined, T).rows).toEqual([[1, 's']]);
    expect(d.prepare('raw scratch', T).usesMemoryObjects).toBe(true);
    expect(d.prepare('raw fruit', T).usesMemoryObjects).toBe(false);
  });

  it('a text that is also SQL is not read as SQL: it is not split into morsels by its text', () => {
    const d = fruit();
    const count = 'SELECT count(*) FROM fruit';
    expect(d.parallelSplit(d.prepare(count), 2, 0)).not.toBeNull();
    // In `shout` (below) the same text means something else.
    registerLanguage(shout);
    expect(d.query(count, undefined, { language: 'shout' }).rows).toEqual([['SHOUT']]);
    expect(d.parallelSplit(d.prepare(count, { language: 'shout' }), 2, 0)).toBeNull();
  });

  it('the same text in two languages is two statements', () => {
    registerLanguage(shout);
    const d = fruit();
    expect(d.query('all fruit', undefined, T).rows.length).toBe(3);
    expect(d.query('all fruit', undefined, { language: 'shout' }).rows).toEqual([['SHOUT']]);
    expect(d.query('all fruit', undefined, T).rows.length).toBe(3);
  });
});

describe('a statement is kept by its text', () => {
  it('the same text is parsed and bound once', () => {
    const d = fruit();
    for (let i = 0; i < 5; i++) expect(d.query('all fruit', undefined, T).rows.length).toBe(3);
    expect(asked).toEqual({ parsed: 1, bound: ['all fruit'] });
  });

  it('after the schema changes it is bound again, and not parsed again', () => {
    const d = fruit();
    d.query('all fruit', undefined, T);
    d.exec('CREATE TABLE other(x)');
    d.query('all fruit', undefined, T);
    expect(asked).toEqual({ parsed: 1, bound: ['all fruit', 'all fruit'] });
  });

  it('more texts than the cache holds: the oldest is parsed again', () => {
    const d = fruit({ statementCacheSize: 2 });
    d.exec('CREATE TABLE a(id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE b(id INTEGER PRIMARY KEY, name TEXT)');
    for (const text of ['all fruit', 'all a', 'all b', 'all a', 'all b']) d.query(text, undefined, T);
    expect(asked.parsed).toBe(3);
    d.query('all fruit', undefined, T);
    expect(asked.parsed).toBe(4);
  });
});

describe('a statement is kept by its shape', () => {
  it('the next statement of a shape is not bound: it runs what the first bound to, with its own values', () => {
    const d = fruit();
    expect(d.query('find fruit id 2', undefined, T).rows).toEqual([[2, 'pear']]);
    expect(d.query('find fruit id 3', undefined, T).rows).toEqual([[3, 'plum']]);
    expect(d.query('find fruit id 7', undefined, T).rows).toEqual([]);
    // Each text is parsed (that is where its shape comes from); one is bound.
    expect(asked).toEqual({ parsed: 3, bound: ['find fruit id 2'] });
    // The one that was bound is found by its text when it comes again.
    expect(d.query('find fruit id 2', undefined, T).rows).toEqual([[2, 'pear']]);
    expect(asked.parsed).toBe(3);
    // One that ran what it bound to is parsed the second time it comes, and found by its text from then on: each
    // time with its own values.
    for (let i = 0; i < 3; i++) expect(d.query('find fruit id 3', undefined, T).rows).toEqual([[3, 'plum']]);
    expect(asked).toEqual({ parsed: 4, bound: ['find fruit id 2'] });
  });

  it('texts of a kept shape that come once are not kept by their text, and put none that is kept out', () => {
    const d = fruit({ statementCacheSize: 2 });
    d.query('all fruit', undefined, T);
    d.query('find fruit id 1', undefined, T);
    // 40 more statements of the shape, each another text: an application's statements, which differ in a value.
    for (let i = 2; i < 42; i++) expect(d.query(`find fruit id ${i}`, undefined, T).rows).toEqual(i <= 3 ? [[i, i === 2 ? 'pear' : 'plum']] : []);
    expect(asked).toEqual({ parsed: 42, bound: ['all fruit', 'find fruit id 1'] });
    // The two texts the cache holds are still there.
    d.query('all fruit', undefined, T);
    d.query('find fruit id 1', undefined, T);
    expect(asked.parsed).toBe(42);
    // The last of the 40 comes again: parsed once more, then found by its text.
    for (let i = 0; i < 3; i++) d.query('find fruit id 41', undefined, T);
    expect(asked).toEqual({ parsed: 43, bound: ['all fruit', 'find fruit id 1'] });
  });

  it('a write of a kept shape that comes again writes again, whichever way it is found', () => {
    const d = fruit();
    d.exec('CREATE TABLE log(id INTEGER, name TEXT)');
    // The same text four times: bound and kept by its text.
    for (let i = 0; i < 4; i++) expect(d.run("add log 1 'a'", undefined, T).changes).toBe(1);
    // Another text of the shape four times: not kept by its text the first time, kept from the second.
    for (let i = 0; i < 4; i++) expect(d.run("add log 2 'b'", undefined, T).changes).toBe(1);
    expect(d.query('SELECT id, name, count(*) FROM log GROUP BY id, name ORDER BY id').rows).toEqual([[1, 'a', 4], [2, 'b', 4]]);
    expect(asked).toEqual({ parsed: 3, bound: ["add log 1 'a'"] });
  });

  it('shapes with one hash are told apart', () => {
    const d = fruit();
    // `find fruit id int` and `find fruit name text` differ, and this language's hash does not always say so.
    expect(d.query('find fruit id 1', undefined, T).rows).toEqual([[1, 'apple']]);
    expect(d.query("find fruit name 'plum'", undefined, T).rows).toEqual([[3, 'plum']]);
    expect(d.query("find fruit name 'pear'", undefined, T).rows).toEqual([[2, 'pear']]);
    expect(d.query('find fruit id 3', undefined, T).rows).toEqual([[3, 'plum']]);
    expect(asked.bound).toEqual(['find fruit id 1', "find fruit name 'plum'"]);
  });

  it('statements of one shape that do not take the same parameters are refused', () => {
    // A language that says every statement has one shape, whatever values it took out.
    const one = (source: string): LanguageStatement => ({
      text: source,
      paramCount: 0,
      paramNames: new Map(),
      shape: { hash: 1, values: source.split(' ').map(Number), same: () => true },
      bind: () => ({ kind: 'query', plan: p.project(p.values([[]]), [p.param(0, 'int')]) }),
    });
    registerLanguage({ name: 'careless', plans: 'data', parseOne: one });
    const d = fruit();
    expect(d.query('1', undefined, { language: 'careless' }).rows).toEqual([[1]]);
    expect(d.query('2', undefined, { language: 'careless' }).rows).toEqual([[2]]);
    expect(() => d.query('3 4', undefined, { language: 'careless' })).toThrow(expect.objectContaining({ code: 'SMALT_MISUSE', message: 'the careless language gives two statements one shape that do not take the same parameters: "1" and "3 4"' }));
  });

  it('a write of a shape: every statement writes its own values', () => {
    const d = fruit();
    for (let i = 10; i < 20; i++) expect(d.run(`add fruit ${i} 'f${i}'`, undefined, T).changes).toBe(1);
    expect(asked.bound).toEqual(["add fruit 10 'f10'"]);
    expect(d.query('SELECT id, name FROM fruit WHERE id >= 10 ORDER BY id').rows).toEqual(Array.from({ length: 10 }, (_, i) => [10 + i, `f${10 + i}`]));
  });

  it('prepared statements of one shape share what is bound, each with its values', () => {
    const d = fruit();
    const two = d.prepare('find fruit id 2', T);
    const three = d.prepare('find fruit id 3', T);
    expect([two.all(), three.all(), two.all()]).toEqual([[[2, 'pear']], [[3, 'plum']], [[2, 'pear']]]);
    expect(asked.bound).toEqual(['find fruit id 2']);
    // The schema changes: what is shared is bound again, once.
    d.exec('CREATE TABLE other(x)');
    expect([three.all(), two.all()]).toEqual([[[3, 'plum']], [[2, 'pear']]]);
    expect(asked.bound).toEqual(['find fruit id 2', 'find fruit id 2']);
  });

  it('more shapes than are kept: the oldest is bound again, and the statements made for it still run', () => {
    const d = fruit({ statementCacheSize: 1 });
    const tables = ['a', 'b', 'c', 'd', 'e'];
    for (const t of tables) d.exec(`CREATE TABLE ${t}(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO ${t} VALUES (1, '${t}1'), (2, '${t}2')`);
    const first = d.prepare('find fruit id 1', T);
    // Four shapes are kept for a statement the cache holds: with five more, the first has gone.
    for (const t of tables) expect(d.query(`find ${t} id 2`, undefined, T).rows).toEqual([[2, `${t}2`]]);
    expect(first.all()).toEqual([[1, 'apple']]);
    asked.bound = [];
    expect(d.query('find fruit id 3', undefined, T).rows).toEqual([[3, 'plum']]);
    expect(asked.bound).toEqual(['find fruit id 3']);
  });
});

describe('a statement that binds by its values is kept for each variant of them', () => {
  it('one text, bound once for each kind of value', () => {
    const d = fruit();
    const kind = (v: SqlValue) => d.query('kind $v', { v }, T).rows;
    expect(kind(1)).toEqual([['int', 1]]);
    expect(kind(2)).toEqual([['int', 2]]);
    expect(kind('a')).toEqual([['text', 'a']]);
    expect(kind(3)).toEqual([['int', 3]]);
    expect(kind('b')).toEqual([['text', 'b']]);
    expect(asked).toEqual({ parsed: 1, bound: ['kind $v for int', 'kind $v for text'] });
  });

  it('a comparison with a parameter of either kind', () => {
    const d = fruit();
    const st = d.prepare('find fruit name $n', T);
    const byId = d.prepare('find fruit id $n', T);
    expect(st.all(['plum'])).toEqual([[3, 'plum']]);
    expect(byId.all([2])).toEqual([[2, 'pear']]);
    expect(st.all({ n: 'apple' })).toEqual([[1, 'apple']]);
    expect(asked.bound).toEqual(['find fruit name $n for text', 'find fruit id $n for int']);
  });

  it('more variants than are kept for a statement: the oldest is bound again', () => {
    const d = fruit();
    const st = d.prepare('pin $v', T);
    for (let v = 0; v < 17; v++) expect(st.all([v])).toEqual([[v, v]]);
    expect(asked.bound.length).toBe(17);
    // Sixteen are kept: the last one and the second are among them, the first is not.
    expect([st.all([16]), st.all([1])]).toEqual([[[16, 16]], [[1, 1]]]);
    expect(asked.bound.length).toBe(17);
    expect(st.all([0])).toEqual([[0, 0]]);
    expect(asked.bound.length).toBe(18);
  });

  it('a statement with a shape and variants: bound once for each kind, whatever value is written in it', () => {
    const d = fruit();
    expect(d.query('either fruit 1 $n', { n: 'plum' }, T).rows).toEqual([[1, 'apple'], [3, 'plum']]);
    expect(d.query('either fruit 2 $n', { n: 'plum' }, T).rows).toEqual([[2, 'pear'], [3, 'plum']]);
    expect(d.query('either fruit 2 $n', { n: 1 }, T).rows).toEqual([[1, 'apple'], [2, 'pear']]);
    expect(d.query('either fruit 3 $n', { n: 2 }, T).rows).toEqual([[2, 'pear'], [3, 'plum']]);
    expect(d.query('either fruit 1 $n', { n: 'pear' }, T).rows).toEqual([[1, 'apple'], [2, 'pear']]);
    // What is bound is the first statement of the shape, for each kind.
    expect(asked.bound).toEqual(['either fruit 1 $n for text', 'either fruit 1 $n for int']);
  });

  it('after the schema changes a variant is bound again, with the values of the run at hand', () => {
    const d = fruit();
    const st = d.prepare('kind $v', T);
    // The caller keeps one object for its values, and changes it.
    const values: { v: SqlValue } = { v: 1 };
    expect(st.all(values)).toEqual([['int', 1]]);
    values.v = 'a';
    expect(st.all(values)).toEqual([['text', 'a']]);
    d.exec('CREATE TABLE other(x)');
    // What it says of itself without running is now bound without values.
    expect(st.columns).toEqual(['kind', 'v']);
    expect(st.all({ v: 2 })).toEqual([['int', 2]]);
    expect(st.all(values)).toEqual([['text', 'a']]);
    expect(asked.bound).toEqual(['kind $v for int', 'kind $v for text', 'kind $v for unknown', 'kind $v for int', 'kind $v for text']);
  });

  it('what it says of itself before it has run is what it binds to without values', () => {
    const d = fruit();
    const st = d.prepare('kind $v', T);
    expect(st.columns).toEqual(['kind', 'v']);
    expect(asked.bound).toEqual(['kind $v for unknown']);
    // Once it has run, it is the variant it ran last.
    expect(st.all(['x'])).toEqual([['text', 'x']]);
    expect(st.readonly).toBe(true);
    expect(asked.bound).toEqual(['kind $v for unknown', 'kind $v for text']);
  });
});

describe("a language statement's parameters", () => {
  it('one read as a list takes an array', () => {
    const d = fruit();
    expect(d.query('sum $list', { list: [1, 2, 3] }, T).rows).toEqual([[3]]);
    expect(d.query('sum $list', [[4, 5]], T).rows).toEqual([[2]]);
    expect(() => d.query('sum $list', { list: 7 }, T)).toThrow(/a list<int> is bound with an array/);
  });

  it('a missing value, and too many', () => {
    const d = fruit();
    expect(() => d.query('find fruit id $n', {}, T)).toThrow(/missing value for parameter \$n/);
    expect(() => d.query('find fruit id $n', [1, 2], T)).toThrow(/expects 1 parameter/);
  });
});
