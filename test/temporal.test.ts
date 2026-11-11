/**
 * Dates and times (ADR 0019 step 1): `date`, `datetime`, `time` and `duration` are plan types whose values are
 * integers (days, µs) while a plan runs, stored as DATE / DATETIME / TIME / DURATION, and given as text in results, in
 * process and through the client. Columns of values take days and µs, JS Dates and the result text; a JS Date binds as
 * a datetime.
 */
import fc from 'fast-check';
import * as client from '../src/client/index.js';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import type { ColumnDef } from '../src/engine/plan/schema.js';
import { EngineServer } from '../src/engine/server.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import type { Request, Response } from '../src/shared/protocol.js';
import { formatDate, formatDatetime, formatDuration, formatTime, parseDate, parseDatetime, parseDuration, parseTime } from '../src/shared/temporal.js';

const DAY = 86_400_000_000;

describe('text', () => {
  it('dates agree with JS Date over a million days either side of 1970', () => {
    fc.assert(
      fc.property(fc.integer({ min: -719_162, max: 2_932_896 }), (days) => {
        // Years 1-9999: JS gives the same calendar (proleptic Gregorian, UTC).
        const iso = new Date(days * 86_400_000).toISOString().slice(0, 10);
        expect(formatDate(days)).toBe(iso);
        expect(parseDate(iso)).toBe(days);
      }),
      { numRuns: 5000 },
    );
  });

  it('datetimes, times and durations', () => {
    expect(formatDatetime(0)).toBe('1970-01-01 00:00:00');
    expect(formatDatetime(-1)).toBe('1969-12-31 23:59:59.999999');
    expect(formatDatetime(1_500_000)).toBe('1970-01-01 00:00:01.500');
    expect(formatDatetime(Date.UTC(2026, 10, 7, 12, 30) * 1000 + 7)).toBe('2026-11-07 12:30:00.000007');
    // Beyond 2^53 µs (after 2255): a bigint, exact.
    const far = BigInt(Date.UTC(9999, 11, 31, 23, 59, 59)) * 1000n + 999_999n;
    expect(formatDatetime(far)).toBe('9999-12-31 23:59:59.999999');
    expect(parseDatetime('9999-12-31 23:59:59.999999')).toBe(far);
    expect(formatDate(-719_529)).toBe('-0001-12-31');
    expect(formatDate(2_932_897)).toBe('+10000-01-01');
    expect(parseDatetime('2026-11-07T12:30')).toBe(Date.UTC(2026, 10, 7, 12, 30) * 1000);
    expect(parseDatetime('2026-11-07')).toBe(Date.UTC(2026, 10, 7) * 1000);
    expect(formatTime(DAY - 1)).toBe('23:59:59.999999');
    expect(parseTime('12:00:00.25')).toBe(43_200_250_000);
    expect(formatDuration(0)).toBe('PT0S');
    expect(formatDuration(DAY + 3_723_500_000)).toBe('P1DT1H2M3.5S');
    expect(formatDuration(-1_000_000)).toBe('-PT1S');
    expect(formatDuration(2n * BigInt(DAY))).toBe('P2D');
    for (const bad of ['2026-02-29', '2026-13-01', '2026-1-1', 'x']) expect(parseDate(bad), bad).toBeNull();
    for (const bad of ['24:00', '12:60', '12']) expect(parseTime(bad), bad).toBeNull();
  });

  it('durations read back from their text (#191)', () => {
    expect(parseDuration('PT1H30M')).toBe(5_400_000_000);
    expect(parseDuration('P1DT1H2M3.5S')).toBe(DAY + 3_723_500_000);
    expect(parseDuration('-PT0.000001S')).toBe(-1);
    expect(parseDuration('PT0S')).toBe(0);
    expect(parseDuration('P2D')).toBe(2 * DAY);
    for (const bad of ['', 'P', 'PT', 'P1DT', '1H', 'PT1.5H', 'PT1.1234567S', 'P1W', 'P-1D', 'PT1S2M', 'x']) expect(parseDuration(bad), bad).toBeNull();
    // Every duration the engine writes reads back to itself, past 2^53 µs too.
    fc.assert(
      fc.property(fc.bigInt({ min: -(2n ** 62n), max: 2n ** 62n }), (us) => {
        const v = parseDuration(formatDuration(us));
        expect(BigInt(v as number | bigint)).toBe(us);
        expect(typeof v).toBe(Number.isSafeInteger(Number(us)) ? 'number' : 'bigint');
      }),
      { numRuns: 5000 },
    );
  });
});

const d = (y: number, m: number, day: number) => Math.round(Date.UTC(y, m - 1, day) / 86_400_000);
/** id INT, d DATE, ts DATETIME, t TIME, dur DURATION, three rows (the last NULL but its id). */
const frame = (): PlanOp =>
  p.fromColumns(
    [
      new Int32Array([1, 2, 3]),
      { data: new Int32Array([d(2026, 11, 7), d(1999, 12, 31), 0]), nulls: new Uint8Array([0b100]) },
      [new Date(Date.UTC(2026, 10, 7, 12, 30)), '1999-12-31 23:59:59.5', null],
      ['08:15', new Float64Array([0])[0]!, null],
      { data: new Float64Array([DAY + 1_000_000, -500_000, 0]), nulls: new Uint8Array([0b100]) },
    ] as never,
    ['int', 'date', 'datetime', 'time', 'duration'],
  );
const ROWS = [
  [1, '2026-11-07', '2026-11-07 12:30:00', '08:15:00', 'P1DT1S'],
  [2, '1999-12-31', '1999-12-31 23:59:59.500', '00:00:00', '-PT0.5S'],
  [3, null, null, null, null],
];

describe('in process', () => {
  it('values from columns: days and µs, JS Dates, text; results as text', () => {
    const r = Database.openMemory().queryPlan(frame());
    expect(r.rows).toEqual(ROWS);
    expect(r.columnTypes).toEqual(['int', 'date', 'datetime', 'time', 'duration']);
    expect(() => Database.openMemory().queryPlan(p.fromColumns([['2026-02-30']], ['date']))).toThrow(/cannot read "2026-02-30" as a date/);
  });

  it("a duration's text in values from columns: what a result gives back writes back (#191)", () => {
    const db = Database.openMemory();
    const durations = [['PT1H30M', 'P1DT1S', '-PT0.5S', 'PT0S', null]] as never;
    expect(db.queryPlan(p.fromColumns(durations, ['duration'])).rows).toEqual([['PT1H30M'], ['P1DT1S'], ['-PT0.5S'], ['PT0S'], [null]]);
    // Into a table and out again, as the issue has it.
    db.queryPlan({ kind: 'schema', op: { op: 'createTable', temp: false, ifNotExists: false, table: { name: 't', storage: 'row', columns: [{ name: 'v', declaredType: 'DURATION', type: 'DURATION', notNull: false, collation: 'binary' }], keys: [], checks: [], foreignKeys: [] } } } as never);
    db.queryPlan({ kind: 'write', plan: p.append('t', p.fromColumns([['PT1H30M']] as never, ['duration']), [0]) } as never);
    expect(db.queryPlan(p.scan('t', [0])).rows).toEqual([['PT1H30M']]);
    expect(() => db.queryPlan(p.fromColumns([['90 minutes']] as never, ['duration']))).toThrow(/cannot read "90 minutes" as a duration/);
  });

  it('sort and compare in time order, as their numbers do', () => {
    const db = Database.openMemory();
    expect(db.queryPlan(p.project(p.sort(frame(), [p.asc(p.col(0, 1, 'date'))]), [p.col(0, 0, 'int')])).rows).toEqual([[3], [2], [1]]);
    const after2000 = p.filter(frame(), p.call('cmp_gt', [p.col(0, 1, 'date'), p.lit(d(2000, 1, 1), 'date')], 'bool'));
    expect(db.queryPlan(p.project(after2000, [p.col(0, 1, 'date')])).rows).toEqual([['2026-11-07']]);
  });

  it('results in other forms on request: Date, or Temporal where the runtime has it', () => {
    const db = Database.openMemory();
    const [first] = db.queryPlan(frame(), [], { temporal: 'date' }).rows;
    expect(first![1]).toEqual(new Date(Date.UTC(2026, 10, 7)));
    expect(first![2]).toEqual(new Date(Date.UTC(2026, 10, 7, 12, 30)));
    // time and duration have no JS Date form: they stay text.
    expect(first!.slice(3)).toEqual(['08:15:00', 'P1DT1S']);
    expect(() => db.queryPlan(frame(), [], { temporal: 'temporal' })).toThrow(/no Temporal API/);
    const g = globalThis as { Temporal?: unknown };
    const seen: string[] = [];
    const kind = (k: string) => ({ from: (s: string) => (seen.push(`${k} ${s}`), { k, s }) });
    g.Temporal = { PlainDate: kind('PlainDate'), PlainDateTime: kind('PlainDateTime'), PlainTime: kind('PlainTime'), Duration: kind('Duration') };
    try {
      db.queryPlan(frame(), [], { temporal: 'temporal' });
      expect(seen.slice(0, 4)).toEqual(['PlainDate 2026-11-07', 'PlainDateTime 2026-11-07T12:30:00', 'PlainTime 08:15:00', 'Duration P1DT1S']);
    } finally {
      delete g.Temporal;
    }
  });

  it('a JS Date binds as a datetime', () => {
    const st = Database.openMemory().preparePlan(p.project(p.values([[]]), [p.param(0, 'datetime')]));
    expect(st.all([new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6)) as never])).toEqual([['2026-01-02 03:04:05.006']]);
  });
});

const col = (name: string, type: ColumnDef['type']): ColumnDef => ({ name, declaredType: type, type, notNull: false, collation: 'binary' });
const createT = (storage: 'row' | 'columnar') =>
  ({
    kind: 'schema',
    op: { op: 'createTable', table: { name: 'ev', columns: [col('id', 'INTEGER'), col('d', 'DATE'), col('ts', 'DATETIME'), col('t', 'TIME'), col('dur', 'DURATION')], keys: [], checks: [], foreignKeys: [], storage }, temp: false, ifNotExists: false },
  }) as const;
const scan = () => p.sort(p.scan('ev', [0, 1, 2, 3, 4]), [p.asc(p.col(0, 0, 'int'))]);

describe('storage', () => {
  for (const storage of ['row', 'columnar'] as const) {
    it(`${storage}: DATE, DATETIME, TIME, DURATION keep their values and types`, () => {
      const db = Database.openMemory();
      db.queryPlan(createT(storage));
      db.queryPlan({ kind: 'write', plan: p.append('ev', frame(), [0, 1, 2, 3, 4]) });
      if (storage === 'columnar') db.exec('PRAGMA compact(ev)');
      const r = db.queryPlan(scan());
      expect(r.rows).toEqual(ROWS);
      expect(r.columnTypes).toEqual(['int', 'date', 'datetime', 'time', 'duration']);
      expect(db.catalog.table('ev')!.columns.map((c) => [c.type, c.storageType])).toEqual([['int', 'INTEGER'], ['date', 'DATE'], ['datetime', 'DATETIME'], ['time', 'TIME'], ['duration', 'DURATION']]);
    });
  }

  it('a write takes the result text and refuses what is not a date', () => {
    const db = Database.openMemory();
    db.queryPlan(createT('row'));
    const put = (row: unknown[]) => db.queryPlan({ kind: 'write', plan: p.append('ev', p.values([row.map((v) => p.lit(v as never))]), [0, 1, 2, 3, 4]) });
    put([1, '2026-11-07', '2026-11-07 01:02:03', '23:59', 5]);
    expect(db.queryPlan(scan()).rows).toEqual([[1, '2026-11-07', '2026-11-07 01:02:03', '23:59:00', 'PT0.000005S']]);
    for (const bad of [[2, '07/11/2026', null, null, null], [3, null, 'soon', null, null], [4, null, null, DAY, null], [5, 1.5, null, null, null]]) {
      expect(() => put(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'SMALT_CONSTRAINT_DATATYPE' }));
    }
  });

  it('survives reopening the file', () => {
    const vfs = new MemoryVfs();
    const open = () => Database.openFile(vfs.openSync('t.db'), {}, vfs.openSync('t.db-wal'));
    let db = open();
    db.queryPlan(createT('row'));
    db.queryPlan({ kind: 'write', plan: p.append('ev', frame(), [0, 1, 2, 3, 4]) });
    db.close();
    db = open();
    expect(db.queryPlan(scan()).rows).toEqual(ROWS);
    db.close();
  });
});

describe('through the client', () => {
  class FakeWorker {
    onmessage: ((e: { data: Response }) => void) | null = null;
    onerror: unknown = null;
    private readonly server = new EngineServer((_s, msg) => setTimeout(() => this.onmessage?.({ data: structuredClone(msg) })), { open: () => Database.openMemory(), refreshTimer: false });
    postMessage(req: Request, transfer: Transferable[] = []): void {
      const r = structuredClone(req, { transfer });
      setTimeout(() => this.server.receive(EngineServer.LOCAL, r));
    }
    terminate(): void {}
  }
  (globalThis as { Worker?: unknown }).Worker ??= FakeWorker;
  const opened: client.Database[] = [];
  afterEach(async () => {
    for (const db of opened.splice(0)) await db.close();
  });

  it('gives the same text in every row mode and in streams', async () => {
    const db = await client.open(':memory:', { storage: 'memory', worker: new FakeWorker() as unknown as Worker });
    opened.push(db);
    expect([...(await db.queryPlan(frame(), [], { rowMode: 'array' }))]).toEqual(ROWS);
    const columnar = (await db.queryPlan(frame(), [], { rowMode: 'columnar' })) as unknown as { data: Record<string, unknown> };
    expect([...(Object.values(columnar.data)[1] as unknown[])]).toEqual(['2026-11-07', '1999-12-31', null]);
    const dated = [...(await db.queryPlan(frame(), [], { rowMode: 'array', temporal: 'date' }))] as unknown[][];
    expect(dated[0]!.slice(1)).toEqual([new Date(Date.UTC(2026, 10, 7)), new Date(Date.UTC(2026, 10, 7, 12, 30)), '08:15:00', 'P1DT1S']);
    const streamed: unknown[] = [];
    for await (const b of db.streamPlan(frame(), [], { batchSize: 2, rowMode: 'array' })) streamed.push(...b);
    expect(streamed).toEqual(ROWS);
  });
});
