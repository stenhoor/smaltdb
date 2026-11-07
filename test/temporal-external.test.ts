/**
 * Dates and times from external data (ADR 0019 step 4): a format gives a column a temporal type (`FormatColumn.type`),
 * its values are integers (days, µs), and the engine types the column by it: in table functions, in external tables
 * whose columns come from the source, and in the catalog, where an external table keeps the type.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { SmaltPlugin } from '../src/engine/plugin.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const DAY = 86_400_000_000;

/** `events` files: a JSON array of rows [id, day, µs]; the format types the columns int, date and datetime. */
function eventsPlugin(): SmaltPlugin {
  return {
    name: 'events-plugin',
    version: '1.0.0',
    apiVersion: 1,
    setup(host) {
      const files = new Map<string, string>();
      host.addFormat({
        name: 'events',
        extensions: ['events'],
        options: ['nested'],
        access: 'bytes',
        async read(bytes, req) {
          const rows = JSON.parse(new TextDecoder().decode(bytes)) as unknown[][];
          return {
            columns: [
              { name: 'id', declType: 'INTEGER' },
              { name: 'day', declType: 'DATE', type: 'date' },
              { name: 'at', declType: 'TIMESTAMP', type: 'datetime' },
              ...(req.options.nested ? [{ name: 'tags', declType: 'TEXT', type: 'list<text>' as const }, { name: 'pt', declType: 'TEXT', type: 'struct<x real, y real>' as const }] : []),
            ],
            rows: req.schemaOnly ? [] : (rows as never),
          };
        },
      });
      host.addTableFunction('read_events', { format: 'events' });
      host.addSource({
        name: 'memory',
        prefixes: ['mem:'],
        async open(target) {
          const text = files.get(target.location.replace(/^mem:/, ''));
          if (text === undefined) throw new Error('no file');
          return { bytes: async () => ({ bytes: new TextEncoder().encode(text), validator: text }) };
        },
        async validator(target) {
          return files.get(target.location.replace(/^mem:/, '')) ?? null;
        },
      });
      host.addMethod('put', (_ctx, [name, text]) => void files.set(String(name), String(text)));
    },
  };
}

const ROWS = JSON.stringify([
  [1, 20_764, 20_764 * DAY + 12.5 * 3_600_000_000],
  [2, -1, -1],
  [3, null, null],
]);

describe('temporal columns from a format', () => {
  it('a table function gives them their types and text', async () => {
    const db = Database.openMemory({ plugins: [eventsPlugin()] });
    await db.callPlugin('events-plugin', 'put', ['a.events', ROWS]);
    const scan = p.source('function', 'read_events', [p.lit('mem:a.events', 'text')], ['int', 'date', 'datetime']);
    const r = await db.queryPlanAsync(p.project(scan, [p.col(0, 0, 'int'), p.col(0, 1, 'date'), p.col(0, 2, 'datetime'), p.call('year', [p.col(0, 1, 'date')], 'int')]));
    expect(r.rows).toEqual([
      [1, '2026-11-07', '2026-11-07 12:30:00', 2026],
      [2, '1969-12-31', '1969-12-31 23:59:59.999999', 1969],
      [3, null, null, null],
    ]);
    expect(r.columnTypes).toEqual(['int', 'date', 'datetime', 'int']);
  });

  it('an external table keeps them, also after the database is reopened', async () => {
    const vfs = new MemoryVfs();
    const db = await Database.open(vfs, 'ev.db', { plugins: [eventsPlugin()] });
    await db.callPlugin('events-plugin', 'put', ['a.events', ROWS]);
    await db.queryPlanAsync({ kind: 'schema', op: { op: 'createExternalTable', name: 'ev', columns: [], options: { location: 'mem:a.events' }, ifNotExists: false } } as never);
    const columns = () => db.catalog.table('ev')!.columns.map((c) => [c.name, c.type, c.storageType]);
    expect(columns()).toEqual([
      ['id', 'int', 'INTEGER'],
      ['day', 'date', 'DATE'],
      ['at', 'datetime', 'DATETIME'],
    ]);
    const read = async (d: Database) =>
      (await d.queryPlanAsync(p.project(p.source('external', 'ev', [], ['int', 'date', 'datetime']), [p.col(0, 1, 'date'), p.col(0, 2, 'datetime')]))).rows;
    expect((await read(db))[0]).toEqual(['2026-11-07', '2026-11-07 12:30:00']);
    db.close();
    const again = await Database.open(vfs, 'ev.db', { plugins: [eventsPlugin()] });
    await again.callPlugin('events-plugin', 'put', ['a.events', ROWS]);
    expect(again.catalog.table('ev')!.columns.map((c) => c.type)).toEqual(['int', 'date', 'datetime']);
    expect((await read(again))[1]).toEqual(['1969-12-31', '1969-12-31 23:59:59.999999']);
  });

  it('a value that is not an integer is an error', async () => {
    const db = Database.openMemory({ plugins: [eventsPlugin()] });
    await db.callPlugin('events-plugin', 'put', ['b.events', JSON.stringify([[1, '2026-11-07', 0]])]);
    const scan = p.source('function', 'read_events', [p.lit('mem:b.events', 'text')], ['int', 'date', 'datetime']);
    await expect(db.queryPlanAsync(p.project(scan, [p.col(0, 1, 'date')]))).rejects.toThrow(/a date value must be an integer, not '2026-11-07'/);
  });
});

describe('list and struct columns from a format (ADR 0020)', () => {
  it('a format gives JS arrays and objects; the engine encodes them by the type', async () => {
    const db = Database.openMemory({ plugins: [eventsPlugin()] });
    const rows = JSON.stringify([
      [1, 0, 0, ['a', 'b'], { x: 1, y: 2 }],
      [2, null, null, [], null],
    ]);
    await db.callPlugin('events-plugin', 'put', ['n.events', rows]);
    const types = ['int', 'date', 'datetime', 'list<text>', 'struct<x real, y real>'] as const;
    const scan = p.source('function', 'read_events', [p.lit('mem:n.events', 'text')], [...types], { named: { nested: p.lit(1, 'int') } });
    const r = await db.queryPlanAsync(p.project(scan, [p.col(0, 3, 'list<text>'), p.col(0, 4, 'struct<x real, y real>'), p.call('list_len', [p.col(0, 3, 'list<text>')], 'int')]));
    expect(r.rows).toEqual([
      [['a', 'b'], { x: 1, y: 2 }, 2],
      [[], null, 0],
    ]);
    await db.callPlugin('events-plugin', 'put', ['bad.events', JSON.stringify([[1, 0, 0, [1], null]])]);
    const bad = p.source('function', 'read_events', [p.lit('mem:bad.events', 'text')], [...types], { named: { nested: p.lit(1, 'int') } });
    await expect(db.queryPlanAsync(p.project(bad, [p.col(0, 3, 'list<text>')]))).rejects.toThrow(/a text element cannot hold|column tags/);
  });
});
