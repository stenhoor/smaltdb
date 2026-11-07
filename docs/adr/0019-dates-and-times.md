# ADR 0019: Dates and times

- **Status:** accepted with the owner's decisions of 2026-11-07 (at the end: each as recommended); decision 2
  amended the same day: a zone is a value passed to the operations, not part of a type (section 2)
- **Date:** 2026-11-07
- **Builds on:** [ADR 0016](0016-plan-api-for-every-language.md) section 3 (types), item 3; [ADR 0018](0018-bool-and-nan.md)
  (the pattern: a static type over integers, a storage type, results converted at the boundary)

## Context

ADR 0016 section 3 lists `date`, `time` and `datetime` (with its unit), and `duration` as the third group of types.
Each group gets its own record. This one proposes them. The engine was surveyed for it on `main` (`68eac60`).

**What exists today.**
- **No temporal types.** Dates are values of other types, as in SQLite: text (`'2026-11-07 12:00:00'`), Julian day
  numbers (real) or Unix times (int).
- **SQLite's date functions** are the engine's own (`exec/datetime.ts`, 1,100 lines): `date`, `time`, `datetime`,
  `julianday`, `unixepoch`, `strftime`, `timediff`, with SQLite's modifiers (`'+1 day'`, `'start of month'`,
  `'localtime'`, `'utc'`, `'subsec'`). They parse text or numbers and give text or numbers.
  - `'now'` is fixed for one statement.
  - `'localtime'` and `'utc'` use the host's zone through JS `Date`.
  - The catalog marks them `dateTime`: deterministic unless an argument asks for the current time.
- **Parquet** (`@smaltdb/parquet`) gives DATE, TIMESTAMP (millis, micros, nanos) and INT96 columns as TEXT in
  SQLite's format, in UTC. That keeps them ordered for zone maps, but makes every date a string.
- **smaltdf** has no date type yet. Its reference defers dates to this step.

**What a dataframe language needs.** Polars, the reference smaltdf compares itself with, has:
- `Date`: days since the epoch, 32-bit;
- `Datetime(unit, zone)`: a 64-bit count of ms, µs (the default) or ns since the epoch, with an optional IANA time
  zone;
- `Time`: ns since midnight;
- `Duration(unit)`: a 64-bit count.

It also has the `dt` functions (year, month, weekday, truncate, offset by, to string, from string), arithmetic
(`datetime - datetime` is a `duration`), and casts between them.

**The pattern from ADR 0018.** A type the engine knows statically, whose values are ordinary engine values (numbers,
or bigints beyond 2^53) at run time, works well:
- operations, keys, records, columnar chunks and the protocol need nothing new;
- comparisons and sorts are the numbers';
- results turn values into what the type means at the boundary, in process and in the client;
- a storage type keeps the type for plan-defined tables, as `BOOLEAN` does.

## Proposal

### 1. Four types over integers

| Type | Value at run time | Range at full speed (numbers) | Beyond |
|---|---|---|---|
| `date` | days since 1970-01-01 | any date | n/a (it fits in a number) |
| `datetime` | µs since 1970-01-01T00:00:00 (decision 1) | 1685 to 2255 | a bigint, exact, slower |
| `time` | µs since midnight, 0 to 86,400,000,000 − 1 | all | n/a |
| `duration` | µs (decision 1) | ±285 years | a bigint |

- **Plan types:** `date`, `time`, `datetime` and `duration` are plan types, as `bool` is. To every arithmetic and
  comparison operation they are integers.
- **Sorting and grouping:** they sort, group and compare as their numbers do. That is also chronological order.
- **Storage types:** `DATE`, `TIME`, `DATETIME` and `DURATION` are fixed 8-byte columns, stored as INTEGER is.
  They join format 4, which is still unreleased, as `BOOLEAN` did.
- **Index keys and zone maps:** they need nothing new; they are numbers.

### 2. Time zones (decision 2, amended)

A zone fixed to a column's type fits data from one place, but not data from many (flights, users around the world),
where each row has its own zone. So the zone is a value, not part of a type:

- **`datetime` stays one type with no zone.** A value is either a wall-clock time or a UTC instant, as the data means
  it; the engine doesn't tell them apart, as Polars' naive `Datetime` doesn't.
- **A zone is an argument:** text naming an IANA zone (`Europe/Paris`), `UTC`, or a fixed offset (`+05:30`). It can
  be any expression, so a constant or a column of zones, one per row.
- **Two operations convert,** and the others compose with them (`hour(to_zone(ts, zone))`):
  - `to_zone(instant, zone)`: the wall-clock time in `zone` of a UTC instant;
  - `from_zone(wall_clock, zone)`: the UTC instant of a wall-clock time in `zone`. A time that occurs twice (clocks
    going back) gives the earlier instant, and one that doesn't occur (clocks going forward) is moved forward by the
    gap, as `Temporal`'s `compatible` disambiguation does. An optional third argument picks `earlier`, `later` or
    `reject` (an error).
  - `zone_offset(instant, zone)`: the zone's offset from UTC at that instant, a `duration`.
- **Conversion** uses `Intl.DateTimeFormat`, which every browser has. The engine carries no time zone database. An
  unknown zone is an error (`SMALT_MISMATCH`).
- **Speed:** an `Intl` call costs microseconds, too slow per row. The engine caches each zone's offsets by day and
  finds the instant of a change by bisection, so a lookup is a map read; a column of zones costs one more lookup per
  row. Storage, sorting and code generation don't change: values stay 8-byte integers.
- **Storage types** have no zone. A language that wants a default zone for a column keeps it in its own metadata
  and passes it to the operations.

### 3. Results (decision 3)

A result column of a temporal type gives each value as text, in a fixed format that sorts as the values do:

| Type | Format |
|---|---|
| `date` | `2026-11-07` |
| `datetime` | `2026-11-07 12:00:00`, then `.123` or `.123456` when there is a fraction |
| `time` | `12:00:00` (and a fraction) |
| `duration` | ISO 8601, e.g. `PT1H30M` |

- **Why text:** the format is SQLite's own date text, so SQL's date functions read it and Parquet's text today
  matches it. It is exact to the µs, and it crosses JSON and `structuredClone` unchanged.
- **Other forms:** `rowMode`-style options can give other forms on request, such as JS `Date` (ms, an instant) or
  `Temporal` objects where the browser has them. A language's own collect can choose too: smaltdf could give
  `Date` objects.
- **Wire:** results travel as numbers and are converted in the client from the column types, as `bool` is.

### 4. Operations

These are new engine operations, named by behaviour:
- **Build from parts:** `make_date`, `make_datetime`.
- **Parse and format:**
  - `parse_date` and `parse_datetime` (ISO, or with a `strftime` format);
  - `format_temporal` (`strftime`).
- **Parts:** `year`, `month`, `day`, `weekday` (ISO, Monday = 1), `day_of_year`, `hour`, `minute`, `second`,
  `microsecond`.
- **Truncation and offsets:**
  - `trunc_temporal` (to a unit: year, month, week, day, hour, …);
  - `offset_by` (calendar-aware: `+1 month` stays on the same day, or the last day of a shorter month).
- **Arithmetic:**
  - `datetime - datetime` is a `duration`;
  - `datetime ± duration` is a `datetime`;
  - `date - date` is a `duration` in days.

  These are the existing arithmetic operations on the numbers, with result types the binder (and the operations'
  `resultType`) gives.
- **Time zones** (section 2): `to_zone`, `from_zone` and `zone_offset`.
- **Casts:**
  - `cast_date` and `cast_datetime` from text (strict: a string that isn't one is an error, as ADR 0016 decision E
    has it for numbers) and from numbers;
  - casts to text give the result format.

SQLite's date functions stay as they are. They are SQL's.

### 5. Data in

- **Values from columns:**
  - an `Int32Array` typed `date` holds days;
  - a `BigInt64Array` or `Float64Array` typed `datetime` or `duration` holds µs;
  - an array of JS `Date`s is a `datetime` (ms, so µs end in 000);
  - text in the result format parses.
- **Parameters:** a JS `Date` binds as a `datetime`. Text stays text: a language converts it where it means a date.
- **Parquet:** DATE and TIMESTAMP become `date` and `datetime` (micros, or nanos truncated: decision 1). They are no longer
  text. A TIMESTAMP with `isAdjustedToUTC` is a UTC instant: its values are as stored.

### 6. SQL (decision 4)

SQLite has no date types, and smaltql keeps SQLite's meaning:
- **Results:** a temporal column read by SQL gives the result format of section 3, which is SQLite's date text. So
  SQL that reads Parquet sees what it sees today.
- **Comparisons with text:** where SQL compares a temporal column with text (`WHERE d > '2026-01-01'`), smaltql
  converts the text with `cast_date` / `cast_datetime`, as it applies affinity today. This needs the column's type,
  which the catalog gives.
- **SQLite's date functions** read a temporal value as its text.
- **`CREATE TABLE … (d DATE)`** in SQL stays NUMERIC, as in SQLite. Temporal storage is for plan-defined tables, such
  as smaltdf's, and for external data.

### 7. smaltdf

- **Types and parts:** `date`, `datetime`, `time` and `duration` columns, `col(...).dt.year()` and the rest of
  section 4, `lit(new Date(...))`.
- **Data in:** `frame({ d: [new Date(...)] })`.
- **Collect** gives `Date` objects for `datetime` and ISO text for the others (decision 3).
- **Polars:** the comparison tests gain the `dt` functions.

## Order of work

One PR each, after this ADR:

1. The types, storage and results: plan types, storage types (format 4), the result format, and values from columns.
   The result options (`Date` or `Temporal` objects on request) follow in their own PR, after this one.
2. The operations: parts, truncation, offsets, arithmetic types, parse, format and casts.
3. Time zones (decision 2, amended): `to_zone`, `from_zone` and `zone_offset`, with `Intl`-based conversion.
4. Parquet gives `date` and `datetime` (`stenhoor/smaltdb-parquet`).
5. smaltql: comparisons with text, and SQLite's functions reading temporal values.
6. smaltdf: the types, `dt`, collect, and the comparison tests.

## Owner's decisions (2026-11-07)

Each as recommended. The questions as they were put, with the recommendation taken:

1. **Unit.**
   - **Recommendation:** one unit, µs, for `datetime`, `time` and `duration`, as Polars' default. Plan types stay
     plain names.
     - Parquet nanoseconds are truncated to µs. They are rare outside pandas exports.
     - JS `Date` is ms, which fits.
   - **Alternative:** a unit per column (`datetime[ns]`), as Polars and Arrow allow. That makes plan types
     parameterized, which every type check would then handle. Choose it if exact nanoseconds matter.
2. **Time zones.**
   - **Recommendation:** naive `datetime` by default, plus an optional IANA zone in the type, converted with `Intl`
     (step 3). That is Polars' model.
   - **Amended (owner, 2026-11-07):** a zone fixed per column doesn't fit data whose rows have different zones. The
     zone is a value passed to the operations instead, which allows a zone per row and keeps values 8-byte integers
     (section 2).
   - **Alternative A:** UTC instants only, no zones. Simpler, but `dt.hour()` and truncation to days are UTC's.
   - **Alternative B:** naive only, for now.
3. **What results give.**
   - **Recommendation:** ISO / SQLite-format text by default, as section 3 shows. It is exact, sortable and
     serializable, and it matches SQL's date text. Options give `Date` or `Temporal` objects, and smaltdf's collect
     gives `Date` for `datetime`.
   - **Alternatives:**
     - JS `Date` by default: ms only, and a `date` would become a midnight instant;
     - the raw numbers: compact, but meaningless without the type.
4. **SQL.**
   - **Recommendation:** SQL keeps SQLite's text world. Temporal values show as their text, and smaltql converts text
     where it is compared with a temporal column. SQL's `DATE` declared type stays NUMERIC.
   - **Alternative:** SQL's `DATE` / `TIMESTAMP` declared types become temporal storage. That would be a departure
     from SQLite that SQL users would see.
5. **Range.**
   - **Recommendation:** no limit beyond int64 (µs: about ±292,000 years), with years 1685–2255 on the fast number
     path, as integers already work.
   - **Alternative:** a range check (for example years 1–9999) that makes values outside it errors, as some
     databases do.
