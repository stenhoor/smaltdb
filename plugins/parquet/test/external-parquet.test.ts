/**
 * Parquet (M8.3, ADR 0011; the @smaltdb/parquet plugin, ADR 0012, with @smaltdb/external for local paths, files and HTTP): read with hyparquet from files written by pyarrow (an independent
 * writer; scripts/gen-parquet-fixtures.py). Remote files are read with HTTP Range requests: only the
 * footer, the column chunks the statement uses and the row groups its filters cannot rule out.
 */
import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../../../src/engine/database.js';
import { MemoryVfs } from '../../../src/engine/vfs/memory.js';
import external from '@smaltdb/external';
import { registerFile } from '@smaltdb/external/client';
import parquet from '../src/index.js';

const F = 'test/fixtures/parquet';

async function db(): Promise<Database> {
  return Database.open(new MemoryVfs(), 'db', { plugins: [external, parquet] });
}

describe('Parquet values and types', () => {
  it('every common type, as pyarrow wrote them', async () => {
    const d = await db();
    const r = await d.queryAsync(`SELECT * FROM read_parquet('${F}/types.parquet')`);
    expect(r.columns).toEqual(['i32', 'i64', 'u8', 'f32', 'f64', 'b', 's', 'bin', 'd', 'ts', 'tsu', 'dec', 'lst', 'st']);
    expect(r.rows).toEqual([
      [1, 2 ** 40, 255, 1.5, 3.141592653589793, 1, 'héllo', new Uint8Array([0, 1]), '2024-02-29', '2024-01-02 03:04:05.678', '2024-01-02 03:04:05.678901', 12.34, '[1,2]', '{"x":1,"y":"a"}'],
      [-2, null, 0, null, 2.5, 0, null, null, null, null, null, null, null, null],
      [null, -(2n ** 62n), null, -0.25, null, null, '', new Uint8Array([255]), '1970-01-01', '1999-12-31 23:59:59', null, -0.01, '[]', '{"x":null,"y":"b"}'],
    ]);
    await d.execAsync(`CREATE EXTERNAL TABLE t WITH (location = '${F}/types.parquet')`);
    expect(d.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 't'").rows).toEqual([
      ['i32', 'INTEGER'],
      ['i64', 'INTEGER'],
      ['u8', 'INTEGER'],
      ['f32', 'REAL'],
      ['f64', 'REAL'],
      ['b', 'INTEGER'],
      ['s', 'TEXT'],
      ['bin', 'BLOB'],
      ['d', 'TEXT'],
      ['ts', 'TEXT'],
      ['tsu', 'TEXT'],
      ['dec', 'REAL'],
      ['lst', 'TEXT'],
      ['st', 'TEXT'],
    ]);
    // Dates compare and work with the date functions like SQLite text dates.
    expect((await d.queryAsync("SELECT date(d, '+1 day'), strftime('%Y', ts) FROM t WHERE d > '2000-01-01'")).rows).toEqual([['2024-03-01', '2024']]);
  });

  it('every codec (snappy, gzip, zstd, none) reads the same rows', async () => {
    const d = await db();
    const results = [];
    for (const c of ['snappy', 'gzip', 'zstd', 'none']) {
      results.push((await d.queryAsync(`SELECT count(*), sum(amount), min(day), max(day), count(DISTINCT region), sum(length(note)) FROM read_parquet('${F}/sales-${c}.parquet')`)).rows);
    }
    expect(results[0]).toEqual([[4000, 191149, '2024-01-01', '2024-03-20', 3, 4000 * 40 + 10 + 90 * 2 + 900 * 3 + 3000 * 4]]);
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it('Hive-partitioned datasets, and errors', async () => {
    const d = await db();
    expect((await d.queryAsync(`SELECT year, month, sum(n) FROM read_parquet('${F}/events/**/*.parquet') WHERE year = 2024 GROUP BY 1, 2 ORDER BY 1, 2`)).rows).toEqual([
      [2024, 1, 404803],
      [2024, 2, 404805],
    ]);
    await registerFile(d, 'bad.parquet', 'not parquet at all');
    expect((await d.queryAsync("SELECT * FROM read_parquet('file:bad.parquet')").catch((e: Error) => e.message)) as string).toMatch(/not a readable Parquet file/);
  });
});

describe('ranged reads: projection and row-group pruning', () => {
  const ranges: { file: string; bytes: number; range: string | null; method: string }[] = [];
  let ignoreRanges = false;
  const server = createServer((req, res) => {
    const file = join(F, decodeURIComponent(new URL(req.url!, 'http://x').pathname));
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
    const headers = { etag: `"${statSync(file).mtimeMs}"`, 'accept-ranges': 'bytes' };
    if (req.method === 'HEAD') {
      ranges.push({ file, bytes: 0, range: null, method: 'HEAD' });
      res.writeHead(200, { ...headers, 'content-length': size });
      res.end();
      return;
    }
    const body = readFileSync(file);
    if (m && !ignoreRanges) {
      const [s, e] = [Number(m[1]), Number(m[2])];
      ranges.push({ file, bytes: e - s + 1, range: req.headers.range!, method: 'GET' });
      res.writeHead(206, { ...headers, 'content-range': `bytes ${s}-${e}/${size}`, 'content-length': e - s + 1 });
      res.end(body.subarray(s, e + 1));
      return;
    }
    ranges.push({ file, bytes: size, range: null, method: 'GET' });
    res.writeHead(200, { ...headers, 'content-length': size });
    res.end(body);
  });
  let base = '';
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  const fetched = () => ranges.reduce((n, r) => n + r.bytes, 0);

  it('fetches the footer and only the column chunks the statement uses', async () => {
    const d = await db();
    const url = `${base}/sales-none.parquet`;
    const size = statSync(join(F, 'sales-none.parquet')).size;
    ranges.length = 0;
    expect((await d.queryAsync(`SELECT sum(id) FROM read_parquet('${url}')`)).rows).toEqual([[(3999 * 4000) / 2]]);
    const idOnly = fetched();
    expect(ranges.every((r) => r.method === 'HEAD' || r.range !== null)).toBe(true);
    ranges.length = 0;
    await d.queryAsync(`SELECT max(note) FROM read_parquet('${url}')`);
    const noteOnly = fetched();
    // The 40-character note column is most of the file; ids are a small part of it.
    expect(idOnly).toBeLessThan(size / 3);
    expect(noteOnly).toBeGreaterThan(idOnly * 3);
    ranges.length = 0;
    // The table's columns come from the footer alone.
    await d.execAsync(`CREATE EXTERNAL TABLE s WITH (location = '${url}')`);
    expect(fetched()).toBeLessThan(size / 10);
  });

  it('skips row groups whose statistics rule them out, with the same answers', async () => {
    const d = await db();
    const url = `${base}/sales-none.parquet`;
    await d.execAsync(`CREATE EXTERNAL TABLE s WITH (location = '${url}')`);
    // The same columns, with a condition statistics cannot use (id + 0) and one they can.
    ranges.length = 0;
    expect((await d.queryAsync('SELECT count(*), min(id) FROM s WHERE id + 0 >= 3700')).rows).toEqual([[300, 3700]]);
    const all = fetched();
    const allGets = ranges.filter((r) => r.method === 'GET').length;
    ranges.length = 0;
    expect((await d.queryAsync('SELECT count(*), min(id) FROM s WHERE id >= 3700')).rows).toEqual([[300, 3700]]);
    // The footer, plus the id chunk of 1 row group of 8 instead of all 8.
    expect(fetched()).toBeLessThan(all / 2);
    expect(ranges.filter((r) => r.method === 'GET').length).toBeLessThan(allGets);
    // Against a local copy of every row, for conditions it can use and cannot.
    d.exec('CREATE TABLE copy(id INT, region TEXT, amount REAL, day TEXT, note TEXT)');
    await d.execAsync('INSERT INTO copy SELECT * FROM s');
    for (const where of [
      'id < 10',
      'id BETWEEN 990 AND 1010',
      'id IN (5, 3999)',
      '3700 <= id',
      "day = '2024-01-05'",
      "day >= '2024-03-15' AND amount > 90",
      "region = 'apac' AND id > 3990",
      'amount = 96',
      "id = '1500'",
      'id > 1e9',
      'id + 0 = 7',
    ]) {
      const got = (await d.queryAsync(`SELECT id, region, amount, day FROM s WHERE ${where} ORDER BY id`)).rows;
      expect(got, where).toEqual(d.query(`SELECT id, region, amount, day FROM copy WHERE ${where} ORDER BY id`).rows);
    }
    // LEFT JOIN: rows of the right side are not pruned (they would become NULL rows).
    d.exec('CREATE TABLE k(id INT); INSERT INTO k VALUES (1), (3999)');
    expect((await d.queryAsync('SELECT k.id, s.id FROM k LEFT JOIN s ON s.id = k.id WHERE s.id IS NULL OR s.id > 3990 ORDER BY 1')).rows).toEqual([[3999, 3999]]);
  });

  it('servers that ignore Range get one whole download; IF CHANGED uses HEAD', async () => {
    const d = await db();
    const url = `${base}/sales-snappy.parquet`;
    ignoreRanges = true;
    ranges.length = 0;
    try {
      expect((await d.queryAsync(`SELECT count(*) FROM read_parquet('${url}') WHERE id < 5`)).rows).toEqual([[5]]);
    } finally {
      ignoreRanges = false;
    }
    expect(ranges.filter((r) => r.method === 'GET').length).toBeLessThanOrEqual(2); // schema read + data read
    await d.execAsync(`CREATE MATERIALIZED VIEW m AS SELECT count(*) AS n FROM read_parquet('${url}')`);
    ranges.length = 0;
    await d.execAsync('REFRESH MATERIALIZED VIEW m IF CHANGED');
    expect(ranges.map((r) => r.method)).toEqual(['HEAD']);
  });
});
