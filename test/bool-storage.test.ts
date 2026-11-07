/**
 * The BOOLEAN storage type (ADR 0018 section 1, step 5): a column of a table defined as a plan holds 0 and 1, stored as
 * an INTEGER is, and reads as `bool` (true / false in results). Row and columnar tables, an index, the catalog, a
 * reopened file, and writes of anything but 0, 1 and NULL refused.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { ColumnDef } from '../src/engine/plan/schema.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const col = (name: string, type: ColumnDef['type']): ColumnDef => ({ name, declaredType: type, type, notNull: false, collation: 'binary' });
const create = (storage: 'row' | 'columnar'): PlanStatementInput => ({
  kind: 'schema',
  op: { op: 'createTable', table: { name: 'f', columns: [col('id', 'INTEGER'), col('ok', 'BOOLEAN')], keys: [], checks: [], foreignKeys: [], storage }, temp: false, ifNotExists: false },
});
const fill = (d: Database) => d.queryPlan({ kind: 'write', plan: p.append('f', p.fromColumns([new Int32Array([1, 2, 3, 4]), [true, false, null, true]], ['int', 'bool']), [0, 1]) });
const rows = (d: Database) => d.queryPlan(p.sort(p.scan('f', [0, 1]), [p.asc(p.col(0, 0, 'int'))]));
const ok = p.col(0, 1, 'bool');

for (const storage of ['row', 'columnar'] as const) {
  describe(`${storage} table`, () => {
    const d = Database.openMemory();
    d.queryPlan(create(storage));
    fill(d);
    if (storage === 'columnar') d.exec('PRAGMA compact(f)');

    it('stores booleans and reads them back as bool', () => {
      const r = rows(d);
      expect(r.rows).toEqual([[1, true], [2, false], [3, null], [4, true]]);
      expect(r.columnTypes).toEqual(['int', 'bool']);
    });

    it('filters, groups and counts by it as an integer', () => {
      expect(d.queryPlan(p.project(p.filter(p.scan('f', [0, 1]), ok), [p.col(0, 0, 'int')])).rows.map((x) => x[0]).sort()).toEqual([1, 4]);
      const g = d.queryPlan(p.sort(p.aggregate(p.scan('f', [0, 1]), [ok], [p.agg('count', [], 'int', { star: true })]), [p.asc(p.col(0, 0, 'bool'))]));
      expect(g.rows).toEqual([[null, 1], [false, 1], [true, 2]]);
      expect(d.queryPlan(p.aggregate(p.scan('f', [0, 1]), [], [p.agg('sum', [ok], 'int')])).rows).toEqual([[2]]);
    });

    it('refuses anything but 0, 1 and NULL', () => {
      const write = (v: unknown) => () => d.queryPlan({ kind: 'write', plan: p.append('f', p.fromColumns([new Int32Array([9]), [v as never]], ['int', 'any']), [0, 1]) });
      for (const bad of [2, -1, 0.5, 'yes']) expect(write(bad), String(bad)).toThrow(expect.objectContaining({ code: 'SMALT_CONSTRAINT_DATATYPE' }));
      expect(write(1)).not.toThrow();
      expect(write(0n)).not.toThrow();
    });
  });
}

it('the catalog describes a BOOLEAN column as bool', () => {
  const d = Database.openMemory();
  d.queryPlan(create('row'));
  expect(d.catalog.table('f')!.columns[1]).toMatchObject({ name: 'ok', type: 'bool', storageType: 'BOOLEAN' });
});

it('an index on a BOOLEAN column, and the definition survives reopening the file', () => {
  const vfs = new MemoryVfs();
  const open = () => Database.openFile(vfs.openSync('b.db'), {}, vfs.openSync('b.db-wal'));
  let d = open();
  d.queryPlan(create('row'));
  d.queryPlan({ kind: 'schema', op: { op: 'createIndex', index: { name: 'f_ok', table: 'f', columns: [{ column: 1, desc: false, collation: 'binary' }], unique: false }, ifNotExists: false } } as never);
  fill(d);
  expect(d.catalog.table('f')!.indexes.map((i) => i.name)).toContain('f_ok');
  d.close();
  d = open();
  expect(d.catalog.table('f')!.columns[1]).toMatchObject({ type: 'bool', storageType: 'BOOLEAN' });
  expect(rows(d).rows).toEqual([[1, true], [2, false], [3, null], [4, true]]);
  expect(d.queryPlan(p.project(p.filter(p.scan('f', [0, 1]), p.call('cmp_eq', [ok, p.lit(1, 'bool')], 'bool')), [p.col(0, 0, 'int')])).rows.map((x) => x[0]).sort()).toEqual([1, 4]);
  d.close();
});
