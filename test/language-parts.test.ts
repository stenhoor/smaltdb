/**
 * The language interface by capability (ADR 0016 section 6): a language provides what it uses. Here a language that
 * parses no text keeps its views as its own serialized source (JSON naming a table and columns), bound late by name;
 * using a part a language lacks is an error that names the language and the part.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p, registerLanguage } from '../src/engine/index.js';
import type { BindContext } from '../src/engine/plan/bind-context.js';
import type { SchemaOp } from '../src/engine/plan/schema.js';
import type { SmaltLanguage } from '../src/engine/plan/language.js';
import { Collation } from '../src/engine/values.js';

/** A view's source: the table it reads and the columns it keeps, by name. */
interface FrameSource {
  readonly table: string;
  readonly columns: readonly string[];
}

/** Stored objects only: no parser, no source editor. */
const frames: SmaltLanguage = {
  name: 'frames',
  bindView(source, ctx: BindContext) {
    const f = JSON.parse(source.text) as FrameSource;
    const t = ctx.table(f.table);
    if (!t) throw new Error(`no such table: ${f.table}`);
    const at = f.columns.map((c) => t.columns.findIndex((x) => x.name === c));
    return {
      kind: 'query',
      plan: p.scan(t.name, at),
      columns: f.columns.map((name, i) => ({ name, type: t.columns[at[i]].type === 'text' ? 'text' : 'any', collation: Collation.Binary, affinity: 'NONE' })),
    } as never;
  },
  viewReferences: (source) => [{ name: (JSON.parse(source.text) as FrameSource).table }],
  viewDefinition: (source) => source.text,
};
registerLanguage(frames);
/** Text only in name: neither views nor edits. */
registerLanguage({ name: 'bare' });

const view = (name: string, source: FrameSource, language = 'frames'): SchemaOp => ({
  op: 'createView',
  name,
  temp: false,
  ifNotExists: false,
  materialized: false,
  source: { language, text: JSON.stringify(source) },
});
const run = (d: Database, op: SchemaOp) => d.preparePlan({ kind: 'schema', op }).run();

describe('a language provides what it uses', () => {
  it('views from a language without a parser, bound late by name', () => {
    const d = Database.openMemory();
    // The view names a table that does not exist yet: it is bound where it is read.
    run(d, view('names', { table: 'fruit', columns: ['name'] }));
    d.exec("CREATE TABLE fruit(id INTEGER PRIMARY KEY, name TEXT, qty INT); INSERT INTO fruit VALUES (1, 'apple', 3), (2, 'pear', 5)");
    // A plan reads it by name, as it reads a table.
    expect(d.queryPlan(p.sort(p.scan('names', [0]), [p.asc(p.col(0, 0, 'text'))])).rows).toEqual([['apple'], ['pear']]);
    // SQL reads views by parsing their SQL, so it cannot read this one.
    expect(() => d.query('SELECT name FROM names')).toThrow(/view is written in frames/);
    expect(d.query("SELECT view_definition FROM information_schema.views WHERE table_name = 'names'").rows).toEqual([['{"table":"fruit","columns":["name"]}']]);
    expect(d.catalog.view('names')).toMatchObject({ language: 'frames', text: '{"table":"fruit","columns":["name"]}' });
    // Bound where it is read: a column added to the table later is there for a view that names it.
    const stock = view('stock', { table: 'fruit', columns: ['name', 'colour'] });
    run(d, stock);
    expect(() => d.queryPlan(p.scan('stock', [0, 1]))).toThrow();
    d.exec("ALTER TABLE fruit ADD COLUMN colour TEXT DEFAULT 'green'");
    const prepared = d.preparePlan(p.filter(p.scan('stock', [0, 1]), p.call('cmp_eq', [p.col(0, 0, 'text'), p.lit('pear')], 'int')));
    expect(prepared.all()).toEqual([['pear', 'green']]);
    // A prepared plan binds the view again after the schema changes.
    d.exec("UPDATE fruit SET colour = 'yellow' WHERE name = 'pear'");
    expect(prepared.all()).toEqual([['pear', 'yellow']]);
    // A plan over a view in a write, and a view has no rowid.
    d.exec('CREATE TABLE copy(name TEXT)');
    d.preparePlan({ kind: 'write', plan: p.append('copy', p.scan('names', [0]), [0]) }).run();
    expect(d.query('SELECT count(*) FROM copy').rows).toEqual([[2]]);
    expect(() => d.queryPlan(p.scan('names', [-1]))).toThrow(/view names has no rowid/);
  });

  it("using a part a language lacks names the language and the part", () => {
    const d = Database.openMemory();
    d.exec('CREATE TABLE t(a INT)');
    run(d, view('v', { table: 't', columns: ['a'] }, 'bare'));
    expect(() => d.queryPlan(p.scan('v', [0]))).toThrow(/the bare language does not bind views/);
    // A language that does not describe views leaves view_definition empty; the rest of the catalog still reads.
    expect(d.query("SELECT table_name, view_definition FROM information_schema.views").rows).toEqual([['v', null]]);
    // ALTER TABLE edits every object's text, each by its language: one without an editor stops it.
    expect(() => d.exec('ALTER TABLE t RENAME TO t2')).toThrow(/the bare language does not edit its objects' source text/);
    d.exec('DROP VIEW v');
    // A table whose source is in a language without a source editor cannot be altered.
    run(d, { op: 'createTable', table: { name: 'u', columns: [{ name: 'a', declaredType: 'INT', type: 'INTEGER', notNull: false, collation: 'binary' }], keys: [], checks: [], foreignKeys: [], storage: 'row' }, temp: false, ifNotExists: false, source: { language: 'frames', text: '{"table":"u"}' } });
    expect(() => d.exec('ALTER TABLE u RENAME TO w')).toThrow(/the frames language does not edit its objects' source text/);
    // Defined without source text, the same table needs no language to alter (once nothing else needs editing).
    d.exec('DROP TABLE u');
    run(d, { op: 'createTable', table: { name: 'x', columns: [{ name: 'a', declaredType: 'INT', type: 'INTEGER', notNull: false, collation: 'binary' }], keys: [], checks: [], foreignKeys: [], storage: 'row' }, temp: false, ifNotExists: false });
    expect(() => d.exec('ALTER TABLE x RENAME TO y')).not.toThrow();
  });
});
