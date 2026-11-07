/**
 * Time zone offsets (ADR 0019 section 2, amended): a zone's offset from UTC at an instant, read from
 * `Intl.DateTimeFormat` (the engine carries no time zone database) and cached by day, so a lookup is a map read.
 *
 * A zone is an IANA name (`Europe/Paris`), `UTC`, or a fixed offset (`+05:30`, `-08`, `Z`).
 */
import { SmaltError } from '../errors.js';
import { daysFromCivil } from '../../shared/temporal.js';

const MS_PER_DAY = 86_400_000;
/** The range of a JS Date, in ms: instants beyond it take the offset at its edge. */
const MAX_MS = 8.64e15;

/** One day of a zone: its offset (ms) all day, or the instant it changes and the offsets either side. */
type DayOffsets = number | { at: number; before: number; after: number };

interface Zone {
  /** A fixed offset, or null for an IANA zone. */
  fixed: number | null;
  format: Intl.DateTimeFormat | null;
  days: Map<number, DayOffsets>;
}

const ZONES = new Map<string, Zone>();
const FIXED = /^([+-])(\d{2})(?::?(\d{2}))?$/;

function zoneOf(name: string): Zone {
  const cached = ZONES.get(name);
  if (cached) return cached;
  let zone: Zone;
  const m = FIXED.exec(name);
  if (name === 'Z' || name === 'UTC' || name === 'Etc/UTC') zone = { fixed: 0, format: null, days: new Map() };
  else if (m) {
    const h = Number(m[2]);
    const mi = Number(m[3] ?? 0);
    if (h > 23 || mi > 59) throw new SmaltError('SMALT_MISMATCH', `'${name}' is not a time zone`);
    zone = { fixed: (m[1] === '-' ? -1 : 1) * (h * 60 + mi) * 60_000, format: null, days: new Map() };
  } else {
    let format: Intl.DateTimeFormat;
    try {
      format = new Intl.DateTimeFormat('en-US', {
        timeZone: name,
        hourCycle: 'h23',
        era: 'short',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      throw new SmaltError('SMALT_MISMATCH', `'${name.length > 40 ? name.slice(0, 40) + '…' : name}' is not a time zone`);
    }
    zone = { fixed: null, format, days: new Map() };
  }
  if (ZONES.size >= 1000) ZONES.clear();
  ZONES.set(name, zone);
  return zone;
}

/** The offset (ms) of `zone` at `ms`, a whole second, asked of Intl. */
function askIntl(format: Intl.DateTimeFormat, ms: number): number {
  const p: Record<string, string> = {};
  for (const part of format.formatToParts(ms)) p[part.type] = part.value;
  const y = p.era === 'BC' || p.era === 'B' ? 1 - Number(p.year) : Number(p.year);
  const wall = daysFromCivil(y, Number(p.month), Number(p.day)) * MS_PER_DAY + ((Number(p.hour) * 60 + Number(p.minute)) * 60 + Number(p.second)) * 1000;
  return wall - ms;
}

function dayOffsets(zone: Zone, day: number): DayOffsets {
  let e = zone.days.get(day);
  if (e !== undefined) return e;
  const start = day * MS_PER_DAY;
  const f = zone.format!;
  const before = askIntl(f, start);
  const after = askIntl(f, start + MS_PER_DAY);
  if (before === after) e = before;
  else {
    // The first whole second with the new offset (one change a day, as every zone has).
    let lo = start;
    let hi = start + MS_PER_DAY;
    while (hi - lo > 1000) {
      const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
      if (askIntl(f, mid) === after) hi = mid;
      else lo = mid;
    }
    e = { at: hi, before, after };
  }
  if (zone.days.size >= 100_000) zone.days.clear();
  zone.days.set(day, e);
  return e;
}

/** The offset from UTC, in ms, of zone `name` at the instant `ms` (ms since the epoch, UTC). */
export function zoneOffsetMs(name: string, ms: number): number {
  const zone = zoneOf(name);
  if (zone.fixed !== null) return zone.fixed;
  const t = Math.min(Math.max(ms, -MAX_MS), MAX_MS - MS_PER_DAY);
  const e = dayOffsets(zone, Math.floor(t / MS_PER_DAY));
  return typeof e === 'number' ? e : t < e.at ? e.before : e.after;
}

/** Checks that `name` is a zone (an error if not). */
export const checkZone = (name: string): void => void zoneOf(name);
