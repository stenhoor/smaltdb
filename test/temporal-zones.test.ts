/**
 * Time zones (ADR 0019 step 3, decision 2 amended): a zone is a value passed to `to_zone`, `from_zone` and
 * `zone_offset`, any expression, so one per row. Offsets come from Intl, cached by day.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanType } from '../src/engine/plan/types.js';
import { formatDatetime } from '../src/shared/temporal.js';

const db = Database.openMemory();
const at = (iso: string) => Date.parse(iso + 'Z') * 1000;
const ts = (iso: string) => p.lit(at(iso), 'datetime');
const text = (s: string) => p.lit(s, 'text');

function call(fn: string, args: PlanExpr[], type: PlanType): unknown {
  return db.queryPlan(p.project(p.values([[]]), [p.call(fn, args, type)])).rows[0]![0];
}

/** The wall-clock text of `ms` in `zone`, as Intl gives it. */
function intlWall(ms: number, zone: string): string {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const q = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
  return `${q.year}-${q.month}-${q.day} ${q.hour}:${q.minute}:${q.second}`;
}

describe('to_zone and zone_offset', () => {
  it('follow daylight saving changes', () => {
    // Paris moves from +01:00 to +02:00 at 01:00 UTC on 2026-03-29.
    expect(call('to_zone', [ts('2026-03-29T00:59:59'), text('Europe/Paris')], 'datetime')).toBe('2026-03-29 01:59:59');
    expect(call('to_zone', [ts('2026-03-29T01:00:00'), text('Europe/Paris')], 'datetime')).toBe('2026-03-29 03:00:00');
    expect(call('zone_offset', [ts('2026-07-01T00:00:00'), text('Europe/Paris')], 'duration')).toBe('PT2H');
    expect(call('zone_offset', [ts('2026-07-01T00:00:00'), text('America/Los_Angeles')], 'duration')).toBe('-PT7H');
    expect(call('to_zone', [ts('2026-11-07T12:00:00.25'), text('+05:30')], 'datetime')).toBe('2026-11-07 17:30:00.250');
    expect(call('to_zone', [ts('2026-11-07T12:00:00'), text('UTC')], 'datetime')).toBe('2026-11-07 12:00:00');
    expect(call('to_zone', [ts('2026-11-07T12:00:00'), p.lit(null, 'text')], 'datetime')).toBeNull();
  });

  it('agree with Intl at any instant and zone', () => {
    const zones = ['Europe/Paris', 'America/New_York', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'America/Sao_Paulo', 'Pacific/Chatham'];
    fc.assert(
      fc.property(fc.integer({ min: Date.UTC(1900, 0, 1) / 1000, max: Date.UTC(2100, 0, 1) / 1000 }), fc.constantFrom(...zones), (s, zone) => {
        const ms = s * 1000;
        expect(call('to_zone', [p.lit(ms * 1000, 'datetime'), text(zone)], 'datetime')).toBe(intlWall(ms, zone));
      }),
      { numRuns: 400 },
    );
  });

  it('take a zone per row', () => {
    const rows = db.queryPlan(
      p.project(p.fromColumns([[at('2026-11-07T12:00:00'), at('2026-11-07T12:00:00'), at('2026-11-07T12:00:00')], ['Asia/Tokyo', 'America/Chicago', null]], ['datetime', 'text']), [
        p.call('hour', [p.call('to_zone', [p.col(0, 0, 'datetime'), p.col(0, 1, 'text')], 'datetime')], 'int'),
      ]),
    ).rows;
    expect(rows).toEqual([[21], [6], [null]]);
  });

  it('refuse what is not a zone', () => {
    expect(() => call('to_zone', [ts('2026-01-01T00:00:00'), text('Mars/Olympus')], 'datetime')).toThrow(/'Mars\/Olympus' is not a time zone/);
    expect(() => call('to_zone', [ts('2026-01-01T00:00:00'), text('+25:00')], 'datetime')).toThrow(/not a time zone/);
    expect(() => call('to_zone', [p.lit(0, 'date'), text('UTC')], 'datetime')).toThrow(/to_zone takes datetime, not date/);
  });
});

describe('from_zone', () => {
  const from = (wall: string, zone: string, how?: string) =>
    call('from_zone', [ts(wall), text(zone), ...(how ? [text(how)] : [])], 'datetime');

  it('gives the instant of a wall-clock time', () => {
    expect(from('2026-11-07T12:00:00', 'Europe/Paris')).toBe('2026-11-07 11:00:00');
    expect(from('2026-07-01T12:00:00', 'Europe/Paris')).toBe('2026-07-01 10:00:00');
    expect(from('2026-11-07T12:00:00', '-08:00')).toBe('2026-11-07 20:00:00');
  });

  it('a time in a gap moves forward, or back; a repeated time is the earlier, or the later', () => {
    // 02:30 doesn't occur in Paris on 2026-03-29.
    expect(from('2026-03-29T02:30:00', 'Europe/Paris')).toBe('2026-03-29 01:30:00');
    expect(from('2026-03-29T02:30:00', 'Europe/Paris', 'later')).toBe('2026-03-29 01:30:00');
    expect(from('2026-03-29T02:30:00', 'Europe/Paris', 'earlier')).toBe('2026-03-29 00:30:00');
    expect(() => from('2026-03-29T02:30:00', 'Europe/Paris', 'reject')).toThrow(/does not occur/);
    // 02:30 occurs twice on 2026-10-25.
    expect(from('2026-10-25T02:30:00', 'Europe/Paris')).toBe('2026-10-25 00:30:00');
    expect(from('2026-10-25T02:30:00', 'Europe/Paris', 'later')).toBe('2026-10-25 01:30:00');
    expect(() => from('2026-10-25T02:30:00', 'Europe/Paris', 'reject')).toThrow(/occurs twice/);
    expect(() => from('2026-10-25T02:30:00', 'Europe/Paris', 'nearest')).toThrow(/not compatible, earlier, later or reject/);
  });

  it('undoes to_zone', () => {
    fc.assert(
      fc.property(fc.integer({ min: Date.UTC(1950, 0, 1) / 1000, max: Date.UTC(2080, 0, 1) / 1000 }), fc.constantFrom('Europe/London', 'America/Denver', 'Asia/Tehran'), (s, zone) => {
        const us = s * 1_000_000;
        const wall = p.call('to_zone', [p.lit(us, 'datetime'), text(zone)], 'datetime');
        const back = call('from_zone', [wall, text(zone)], 'datetime');
        // A repeated wall-clock time gives the earlier instant, which shows the same wall clock.
        expect(call('to_zone', [p.lit(at(String(back).replace(' ', 'T')), 'datetime'), text(zone)], 'datetime')).toBe(formatDatetime(at(intlWall(s * 1000, zone).replace(' ', 'T'))));
        if (back !== formatDatetime(us)) expect(at(String(back).replace(' ', 'T'))).toBeLessThan(us);
      }),
      { numRuns: 300 },
    );
  });
});
