/**
 * Definitions without source text (ADR 0016 section 6): a schema operation without `source` is stored as its
 * definition alone, shown as a neutral description (the definition as JSON), and altered without any language.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import type { AlterAction, ColumnDef, SchemaOp, TableDef } from '../src/engine/plan/schema.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const col = (name: string, type: ColumnDef['type'], more: Partial<ColumnDef> = {}): ColumnDef => ({ name, declaredType: type, type, notNull: false, collation: 'binary', ...more });
const schemaOp = (op: SchemaOp): PlanStatementInput => ({ kind: 'schema', op });
const run = (d: Database, op: SchemaOp) => d.preparePlan(schemaOp(op)).run();

/** t(id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT 'anon', qty INTEGER CHECK qty >= 0), with no source text. */
const tableDef: TableDef = {
  name: 't',
  columns: [col('id', 'INTEGER'), col('name', 'TEXT', { notNull: true, default: { text: "'anon'", expr: p.lit('anon'), value: 'anon' } }), col('qty', 'INTEGER')],
  keys: [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }] }],
  checks: [{ name: 'nonnegative', text: 'qty >= 0', expr: p.call('cmp_ge', [p.col(0, 2, 'int'), p.lit(0)], 'int') }],
  foreignKeys: [],
  storage: 'row',
};
const createT: SchemaOp = { op: 'createTable', table: tableDef, temp: false, ifNotExists: false };
const alter = (action: AlterAction, table = 't'): SchemaOp => ({ op: 'alterTable', table, action });
const schemaRow = (d: Database, name: string) => d.query('SELECT type, sql FROM sqlite_schema WHERE name = ?', [name]).rows[0];

describe('definitions without source text', () => {
  it('a table: stored as its definition, shown as a description, and used like any other', () => {
    const d = Database.openMemory();
    run(d, createT);
    d.preparePlan({ kind: 'write', plan: p.append('t', p.values([[p.lit(1), p.lit(5)]]), [0, 2]) }).run();
    expect(d.query('SELECT id, name, qty FROM t').rows).toEqual([[1, 'anon', 5]]);
    expect(() => d.preparePlan({ kind: 'write', plan: p.append('t', p.values([[p.lit(2), p.lit(-1)]]), [0, 2]) }).run()).toThrow(/nonnegative/);
    const [type, sql] = schemaRow(d, 't');
    expect(type).toBe('table');
    // The description is the definition as JSON, in no language's syntax.
    expect(JSON.parse(sql as string)).toMatchObject({ kind: 'table', table: { name: 't', columns: [{ name: 'id' }, { name: 'name', notNull: true }, { name: 'qty' }] } });
    expect(d.query('PRAGMA table_info(t)').rows.map((r) => [r[1], r[2], r[3], r[4], r[5]])).toEqual([['id', 'INTEGER', 0, null, 1], ['name', 'TEXT', 1, "'anon'", 0], ['qty', 'INTEGER', 0, null, 0]]);
    const t = d.catalog.table('t')!;
    expect(t.source).toBeUndefined();
    expect(t.keys).toEqual([{ kind: 'primaryKey', columns: [0] }]);
  });

  it('an index and a temp table', () => {
    const d = Database.openMemory();
    run(d, createT);
    run(d, { op: 'createIndex', index: { name: 't_name', table: 't', columns: [{ column: 1, desc: false, collation: 'binary' }], unique: true }, ifNotExists: false });
    d.exec("INSERT INTO t(id, name) VALUES (1, 'a')");
    expect(() => d.exec("INSERT INTO t(id, name) VALUES (2, 'a')")).toThrow(/UNIQUE/);
    expect(JSON.parse(schemaRow(d, 't_name')[1] as string)).toMatchObject({ kind: 'index', index: { name: 't_name', table: 't' } });
    run(d, { ...createT, table: { ...tableDef, name: 'scratch' }, temp: true } as SchemaOp);
    d.exec("INSERT INTO temp.scratch(id) VALUES (7)");
    expect(d.query('SELECT id, name FROM temp.scratch').rows).toEqual([[7, 'anon']]);
  });

  it('ALTER TABLE changes the definition and its description, without a language', () => {
    const d = Database.openMemory();
    run(d, createT);
    d.exec("INSERT INTO t(id, name, qty) VALUES (1, 'a', 2)");
    run(d, alter({ kind: 'renameColumn', column: 'qty', newName: 'amount' }));
    run(d, alter({ kind: 'addColumn', column: col('note', 'TEXT', { default: { text: "'-'", expr: p.lit('-'), value: '-' } }), checks: [], foreignKeys: [], text: '' }));
    run(d, alter({ kind: 'renameTable', newName: 'items' }));
    expect(d.query('SELECT id, name, amount, note FROM items').rows).toEqual([[1, 'a', 2, '-']]);
    const desc = JSON.parse(schemaRow(d, 'items')[1] as string);
    expect(desc.table.name).toBe('items');
    expect(desc.table.columns.map((c: { name: string }) => c.name)).toEqual(['id', 'name', 'amount', 'note']);
    // The CHECK's expression follows the renamed column; its text is the definition's own.
    expect(() => d.exec('UPDATE items SET amount = -1')).toThrow(/nonnegative/);
    run(d, alter({ kind: 'dropColumn', column: 'note' }, 'items'));
    expect(JSON.parse(schemaRow(d, 'items')[1] as string).table.columns.map((c: { name: string }) => c.name)).toEqual(['id', 'name', 'amount']);
    // SQL's ALTER TABLE works on it too, and leaves SQL views over it edited by SQL.
    d.exec('CREATE VIEW v AS SELECT name FROM items');
    d.exec('ALTER TABLE items RENAME COLUMN name TO label');
    expect(JSON.parse(schemaRow(d, 'items')[1] as string).table.columns.map((c: { name: string }) => c.name)).toEqual(['id', 'label', 'amount']);
    expect(schemaRow(d, 'v')[1]).toBe('CREATE VIEW v AS SELECT label FROM items');
    expect(d.query('SELECT * FROM v').rows).toEqual([['a']]);
    // A column added to it needs its bound expressions.
    const unbound = alter({ kind: 'addColumn', column: col('later', 'TEXT', { default: { text: 'nofn()', value: null } }), checks: [], foreignKeys: [], text: 'later TEXT DEFAULT (nofn())' }, 'items');
    expect(() => run(d, unbound)).toThrow(/bound expression/);
  });

  it('survives reopening', async () => {
    const vfs = new MemoryVfs();
    const d = await Database.open(vfs, 'db');
    run(d, createT);
    run(d, { op: 'createIndex', index: { name: 't_qty', table: 't', columns: [{ column: 2, desc: false, collation: 'binary' }], unique: false }, ifNotExists: false });
    d.exec("INSERT INTO t(id, qty) VALUES (1, 3)");
    d.close();
    const again = await Database.open(vfs, 'db');
    expect(again.query('SELECT id, name, qty FROM t WHERE qty = 3').rows).toEqual([[1, 'anon', 3]]);
    expect(() => again.exec('INSERT INTO t(id, qty) VALUES (2, -5)')).toThrow(/nonnegative/);
    run(again, alter({ kind: 'renameColumn', column: 'qty', newName: 'n' }));
    expect(JSON.parse(schemaRow(again, 't')[1] as string).table.columns[2].name).toBe('n');
    expect(again.catalog.table('t')!.source).toBeUndefined();
    again.close();
  });

  it('the validator requires bound expressions without source text', () => {
    const d = Database.openMemory();
    const unboundDefault: SchemaOp = { ...createT, table: { ...tableDef, columns: [col('a', 'TEXT', { default: { text: 'nofn()', value: null } })], keys: [], checks: [] } };
    expect(() => run(d, unboundDefault)).toThrow(/a definition without source text needs its bound expression/);
    const unboundCheck: SchemaOp = { ...createT, table: { ...tableDef, checks: [{ text: 'qty > 0' }] } };
    expect(() => run(d, unboundCheck)).toThrow(/needs its bound expression/);
    // With source text, an unbound DEFAULT is bound from it when used, as before.
    run(d, { ...unboundDefault, source: { language: 'sql', text: 'CREATE TABLE t(a TEXT DEFAULT (nofn()))' } } as SchemaOp);
    expect(schemaRow(d, 't')[1]).toBe('CREATE TABLE t(a TEXT DEFAULT (nofn()))');
  });
});
