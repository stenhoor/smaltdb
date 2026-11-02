/**
 * Plugins (ADR 0012): installing them, a plugin format end to end, and an engine without a plugin a
 * database or statement needs (it opens, and reports SMALT_PLUGIN_MISSING where the plugin is needed).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import parquet from '@smaltdb/parquet';
import { Database } from '../src/engine/database.js';
import type { SmaltPlugin } from '../src/engine/plugin.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const code = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code ?? String(e),
  );

/** A tiny format: one value per line, column `line`. */
const lines: SmaltPlugin = {
  name: 'test-lines',
  version: '1.0.0',
  apiVersion: 1,
  setup(host) {
    host.addFormat({
      name: 'lines',
      extensions: ['lines'],
      options: ['upper'],
      access: 'bytes',
      async read(bytes, req) {
        const text = new TextDecoder().decode(bytes);
        if (text.startsWith('!')) throw new Error('bad file');
        const values = text.split('\n').filter((l) => l !== '');
        return { columns: [{ name: 'line', declType: 'TEXT' }], rows: req.schemaOnly ? [] : values.map((v) => [req.options.upper ? v.toUpperCase() : v]) };
      },
    });
    host.addTableFunction('read_lines', { format: 'lines' });
  },
};

describe('plugins', () => {
  it('a plugin format: table function, external table, options, errors', async () => {
    const db = Database.openMemory({ plugins: [lines] });
    db.registerFile('a.lines', 'x\ny\n');
    expect((await db.queryAsync("SELECT line FROM read_lines('file:a.lines')")).rows).toEqual([['x'], ['y']]);
    expect((await db.queryAsync("SELECT line FROM read_lines('file:a.lines', upper => 1)")).rows).toEqual([['X'], ['Y']]);
    await db.execAsync("CREATE EXTERNAL TABLE t WITH (location = 'file:a.lines')");
    expect(db.query("SELECT data_type FROM information_schema.columns WHERE table_name = 't'").rows).toEqual([['TEXT']]);
    expect((await db.queryAsync('SELECT count(*) FROM t')).rows).toEqual([[2]]);
    expect(db.query("SELECT format FROM information_schema.external_tables WHERE table_name = 't'").rows).toEqual([['lines']]);
    db.registerFile('bad.lines', '!x');
    await expect(db.queryAsync("SELECT * FROM read_lines('file:bad.lines')")).rejects.toMatchObject({ code: 'SMALT_EXTERNAL', message: "read_lines('file:bad.lines'): bad file" });
    // Built-in formats are unaffected.
    db.registerFile('a.csv', 'n\n1\n');
    expect((await db.queryAsync("SELECT n FROM read_csv('file:a.csv')")).rows).toEqual([[1]]);
  });

  it('refuses plugins for another API version, and duplicates', () => {
    expect(() => Database.openMemory({ plugins: [{ ...lines, apiVersion: 2 }] })).toThrow(/plugin API version 2/);
    expect(() => Database.openMemory({ plugins: [lines, lines] })).toThrow(/installed twice/);
    expect(() => Database.openMemory({ plugins: [lines, { ...lines, name: 'other' }] })).toThrow(/format 'lines' is already defined/);
  });

  it('without @smaltdb/parquet: SMALT_PLUGIN_MISSING with the plugin to install', async () => {
    const db = Database.openMemory();
    db.registerFile('s.parquet', new Uint8Array(readFileSync('test/fixtures/parquet/sales-snappy.parquet')));
    await expect(db.queryAsync("SELECT count(*) FROM read_parquet('file:s.parquet')")).rejects.toMatchObject({
      code: 'SMALT_PLUGIN_MISSING',
      message: "read_parquet('file:s.parquet'): reading Parquet needs the @smaltdb/parquet plugin (install it and add it to the engine's plugins)",
    });
    expect(await code(db.execAsync("CREATE EXTERNAL TABLE p WITH (location = 'file:s.parquet')"))).toBe('SMALT_PLUGIN_MISSING');
    expect(await code(db.execAsync("CREATE EXTERNAL TABLE p WITH (location = 'file:s.bin', format = 'parquet')"))).toBe('SMALT_PLUGIN_MISSING');
    expect(await code(db.queryAsync("SELECT * FROM read_csv('file:s.bin', format => 'parquet')"))).toBe('SMALT_PLUGIN_MISSING');
    // An unknown format is still an ordinary error.
    expect(await code(db.queryAsync("SELECT * FROM read_csv('file:s.bin', format => 'xlsx')"))).toBe('SMALT_EXTERNAL');
  });

  it('a database with Parquet tables opens without the plugin; only those tables need it', async () => {
    const vfs = new MemoryVfs();
    const bytes = new Uint8Array(readFileSync('test/fixtures/parquet/sales-snappy.parquet'));
    const a = await Database.open(vfs, 'db', { plugins: [parquet] });
    a.registerFile('s.parquet', bytes);
    await a.execAsync("CREATE EXTERNAL TABLE sales WITH (location = 'file:s.parquet')");
    a.exec('CREATE TABLE local(x INT); INSERT INTO local VALUES (1)');
    expect((await a.queryAsync('SELECT count(*) FROM sales')).rows).toEqual([[4000]]);
    a.close();

    const b = await Database.open(vfs, 'db');
    b.registerFile('s.parquet', bytes);
    expect(b.query('SELECT x FROM local').rows).toEqual([[1]]);
    expect(b.query("SELECT table_type FROM information_schema.tables WHERE table_name = 'sales'").rows).toEqual([['EXTERNAL']]);
    expect(b.query("SELECT count(*) FROM information_schema.columns WHERE table_name = 'sales'").rows).toEqual([[5]]);
    await expect(b.queryAsync('SELECT count(*) FROM sales')).rejects.toMatchObject({ code: 'SMALT_PLUGIN_MISSING' });
    b.exec('DROP EXTERNAL TABLE sales');
    expect(b.query("SELECT count(*) FROM information_schema.tables WHERE table_name = 'sales'").rows).toEqual([[0]]);
    b.close();
  });
});
