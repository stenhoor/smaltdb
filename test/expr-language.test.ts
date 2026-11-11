/**
 * The language of a described table's expression texts (TableDef.exprLanguage, #190): a table defined without source
 * text names the language its CHECK and index expression texts are written in, and a column rename edits them with
 * that language's source editor. Without one, the texts stay as given (the bound expressions still hold).
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p, registerLanguage } from '../src/engine/index.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import type { SchemaOp, TableDef } from '../src/engine/plan/schema.js';

/** A language whose expressions name columns in braces (`{qty} >= 0`): its editor renames them there. */
registerLanguage({
  name: 'braces',
  sourceEditor: {
    renameTable: (text) => text,
    renameColumn: (text) => text,
    renameColumnInExpr: (text, _table, oldName, newName) => text.split(`{${oldName}}`).join(`{${newName}}`),
    addColumn: (text) => text,
    dropColumn: (text) => text,
    externalTable: () => '',
  },
});

const qty = p.col(0, 0, 'int');
const table = (exprLanguage?: string): TableDef => ({
  name: 't',
  storage: 'row',
  columns: [{ name: 'qty', declaredType: 'INTEGER', type: 'INTEGER', notNull: false, collation: 'binary' }],
  keys: [],
  checks: [{ name: 'positive', text: '{qty} >= 0', expr: p.call('cmp_ge', [qty, p.lit(0)], 'bool') }],
  foreignKeys: [],
  ...(exprLanguage ? { exprLanguage } : {}),
});
const schema = (db: Database, op: SchemaOp) => db.queryPlan({ kind: 'schema', op });
const rename = (db: Database) => schema(db, { op: 'alterTable', table: 't', action: { kind: 'renameColumn', column: 'qty', newName: 'amount' } });
const failure = (db: Database) => {
  try {
    db.queryPlan({ kind: 'write', plan: p.append('t', p.fromColumns([[-1]], ['int']), [0]) });
  } catch (e) {
    return (e as Error).message;
  }
  return 'no error';
};

describe('exprLanguage', () => {
  it("a column rename edits a described table's CHECK texts with its language's editor, kept after a reopen", async () => {
    const vfs = new MemoryVfs();
    const db = await Database.open(vfs, 'db');
    schema(db, { op: 'createTable', table: table('braces'), temp: false, ifNotExists: false });
    expect(db.catalog.table('t')!.exprLanguage).toBe('braces');
    rename(db);
    // The text follows: the catalog and information_schema say amount.
    expect(db.catalog.table('t')!.checks.map((c) => c.text)).toEqual(['{amount} >= 0']);
    const checks = { op: 'source', kind: 'virtual', schema: 'information_schema', name: 'check_constraints', args: [], types: ['any', 'any', 'any', 'any'] } as never;
    expect(db.queryPlan(checks).rows).toEqual([['main', 'main', 'positive', '{amount} >= 0']]);
    expect(failure(db)).toMatch(/check positive failed/);
    // The constraint still holds, and all of it stays after a reopen.
    db.queryPlan({ kind: 'write', plan: p.append('t', p.fromColumns([[5]], ['int']), [0]) });
    db.close();
    const again = await Database.open(vfs, 'db');
    expect(again.catalog.table('t')!.checks.map((c) => c.text)).toEqual(['{amount} >= 0']);
    expect(again.catalog.table('t')!.columns.map((c) => c.name)).toEqual(['amount']);
    expect(failure(again)).toMatch(/check positive failed/);
    expect(again.queryPlan(p.scan('t', [0])).rows).toEqual([[5]]);
    again.close();
  });

  it('without exprLanguage, or with a language that has no editor, the texts stay as given', () => {
    for (const language of [undefined, 'not-registered']) {
      const db = Database.openMemory();
      schema(db, { op: 'createTable', table: table(language), temp: false, ifNotExists: false });
      rename(db);
      expect(db.catalog.table('t')!.checks.map((c) => c.text)).toEqual(['{qty} >= 0']);
      expect(failure(db)).toMatch(/check positive failed/);
    }
  });
});
