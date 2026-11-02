# Date and time functions

smaltdb has no separate date or time storage type. Dates and times are stored as ISO-8601 text (`'2024-03-15 13:45:30'`), as a julian day number (REAL), or as a Unix timestamp (INTEGER), and these functions convert between the three. They are a port of SQLite 3.54's `date.c` and are tested against SQLite's own WebAssembly build, so they give the same results, including NULL for invalid input.

| Function | Returns |
| --- | --- |
| [`date(TIME, MOD, …)`](#date) | `YYYY-MM-DD` |
| [`time(TIME, MOD, …)`](#time) | `HH:MM:SS` |
| [`datetime(TIME, MOD, …)`](#datetime) | `YYYY-MM-DD HH:MM:SS` |
| [`julianday(TIME, MOD, …)`](#julianday) | Julian day number (REAL) |
| [`unixepoch(TIME, MOD, …)`](#unixepoch) | Seconds since 1970-01-01 00:00:00 UTC (INTEGER) |
| [`strftime(FORMAT, TIME, MOD, …)`](#strftime) | Text formatted by `FORMAT` |
| [`timediff(A, B)`](#timediff) | The difference `A - B` as `±YYYY-MM-DD HH:MM:SS.SSS` |
| [`CURRENT_DATE`, `CURRENT_TIME`, `CURRENT_TIMESTAMP`](#current_date) | The current UTC date, time, or both |

All of them take a [time value](#time-values) followed by zero or more [modifiers](#modifiers), applied from left to right. Times are UTC unless you use the `localtime` modifier.

## Rules that apply to all functions {#rules}

- **NULL and errors**: if the time value or any modifier is NULL or cannot be parsed, or the result falls outside the supported range, the result is NULL. No error is raised.
- **Range**: from `-4713-11-24 12:00:00` (julian day 0) to `9999-12-31 23:59:59.999`.
- **No arguments**: `date()`, `time()`, `datetime()`, `julianday()` and `unixepoch()` with no arguments, and `strftime(FORMAT)` with only a format, use the current time, like `'now'`.
- **`'now'` is fixed per statement**: every use of `'now'` (and of `CURRENT_*`) in one execution of a statement sees the same instant, so all rows of a query get the same timestamp. The next execution reads the clock again.
- **Time zone**: `'localtime'` and `'utc'` use the time zone of the host (the browser or Node.js process) through JavaScript's `Date`.
- **Fractional seconds**: stored to the millisecond. The text results drop them unless you add the [`subsec`](#subsec) modifier.

```sql
SELECT date('2024-02-30') AS rolled_over, date('2024-13-01') AS bad_month, datetime('nonsense') AS bad_text, date('10000-01-01') AS out_of_range, date(NULL) AS null_input;
```

| rolled_over | bad_month | bad_text | out_of_range | null_input |
| --- | --- | --- | --- | --- |
| 2024-03-01 | NULL | NULL | NULL | NULL |

As in SQLite, a day of 29 to 31 that does not exist in the month is accepted and rolls over into the next month.

## Time values {#time-values}

The first argument (the second for `strftime`) is a time value in one of these forms:

| Form | Example | Notes |
| --- | --- | --- |
| `YYYY-MM-DD` | `'2024-03-15'` | Midnight at the start of the day. |
| `YYYY-MM-DD HH:MM` | `'2024-03-15 13:45'` | |
| `YYYY-MM-DD HH:MM:SS` | `'2024-03-15 13:45:30'` | |
| `YYYY-MM-DD HH:MM:SS.SSS` | `'2024-03-15 13:45:30.250'` | Any number of fraction digits; kept to the millisecond. |
| `YYYY-MM-DDTHH:MM…` | `'2024-03-15T13:45:30'` | A `T` may separate date and time. |
| `HH:MM`, `HH:MM:SS`, `HH:MM:SS.SSS` | `'13:45'` | A time alone: the date is `2000-01-01`. |
| any of the above + time zone | `'2024-03-15 13:45:30+02:00'`, `'…Z'` | `[+-]HH:MM` or `Z`, optionally after spaces. The time is converted to UTC. |
| `24:00` | `'2024-03-15 24:00'` | Midnight at the end of the day: the start of the next day. |
| `now` | `'now'` | The current time (UTC). |
| `subsec`, `subsecond` | `'subsec'` | The current time, and output includes milliseconds. |
| number | `2460385.0703125` | A julian day number, or with the `unixepoch` / `auto` modifiers a Unix timestamp. Numeric text such as `'2460385.0703125'` is the same. |

Years have exactly four digits, optionally preceded by `-` for years before year 0. Months and days need two digits. Leading spaces are not allowed; trailing spaces are.

```sql
SELECT datetime('2024-03-15T13:45:30.250') AS iso_t, datetime('13:45') AS time_only, datetime('2024-03-15 13:45:30+02:00') AS with_zone, datetime('2024-03-15 24:00') AS end_of_day, datetime(2460385.0703125) AS julian;
```

| iso_t | time_only | with_zone | end_of_day | julian |
| --- | --- | --- | --- | --- |
| 2024-03-15 13:45:30 | 2000-01-01 13:45:00 | 2024-03-15 11:45:30 | 2024-03-16 00:00:00 | 2024-03-15 13:41:15 |

```sql
SELECT date('2024-1-5') AS one_digit_month, date(' 2024-01-05') AS leading_space, date('20240105') AS compact;
```

| one_digit_month | leading_space | compact |
| --- | --- | --- |
| NULL | NULL | NULL |

## Modifiers {#modifiers}

Modifiers are text arguments after the time value. Names are case-insensitive. Each one transforms the result of the ones before it.

| Modifier | Effect |
| --- | --- |
| `±N days`, `±N hours`, `±N minutes`, `±N seconds` | Add or subtract. `N` may have a fraction (`+1.5 hours`); the `+` is optional and the trailing `s` is optional (`+1 day`). |
| `±N months`, `±N years` | Add or subtract calendar months or years, keeping the day of the month; a day that does not exist rolls over (see `floor` / `ceiling`). A fraction is added as days (a month counts as 30 days, a year as 365). |
| `±HH:MM`, `±HH:MM:SS`, `±HH:MM:SS.SSS` | Add or subtract a time span. |
| `±YYYY-MM-DD`, `±YYYY-MM-DD HH:MM[:SS[.SSS]]` | Add or subtract years, months (0–11) and days (0–30), and optionally a time span. The sign is required. |
| `start of day` | Back to 00:00:00 of the day. |
| `start of month` | Back to the first day of the month, 00:00:00. |
| `start of year` | Back to January 1, 00:00:00. |
| `weekday N` | Forward to the next date whose weekday is `N` (0 = Sunday … 6 = Saturday), or no change if it already is. |
| `weekday -N` | Back to the most recent date whose weekday is `N`, or no change if it already is (SQLite 3.54). |
| `unixepoch` | The numeric time value is a Unix timestamp in seconds, not a julian day. Must be the first modifier. |
| `julianday` | The numeric time value is a julian day number (the default). Must be the first modifier. |
| `auto` | Guess: a number from 0 to 5373484.5 is a julian day, anything else a Unix timestamp. Must be the first modifier. |
| `localtime` | Convert from UTC to the host's local time. |
| `utc` | Convert from the host's local time to UTC. |
| `subsec`, `subsecond` | Include milliseconds in the output of `time`, `datetime`, `unixepoch` and `%s`. |
| `floor` | After a month or year addition that overflowed the month, go back to the last day of the intended month. |
| `ceiling` | After such an addition, keep the rolled-over date (the default behaviour). |

A modifier that does not parse, such as `'+1 fortnight'`, `'start of week'` or `'weekday 7'`, makes the result NULL.

### Adding and subtracting

```sql
SELECT date('2024-03-15', '+10 days') AS plus_days,
       datetime('2024-03-15 10:00', '+90 minutes') AS plus_minutes,
       datetime('2024-03-15 10:00', '+1.5 hours') AS fractional,
       date('2024-03-15', '-1 year') AS minus_year,
       datetime('2024-03-15 10:00', '+01:30') AS plus_hhmm,
       datetime('2024-03-15 10:00', '+0001-02-03') AS plus_ymd;
```

| plus_days | plus_minutes | fractional | minus_year | plus_hhmm | plus_ymd |
| --- | --- | --- | --- | --- | --- |
| 2024-03-25 | 2024-03-15 11:30:00 | 2024-03-15 11:30:00 | 2023-03-15 | 2024-03-15 11:30:00 | 2025-05-18 10:00:00 |

### Month ends: floor and ceiling {#floor}

Adding months keeps the day of the month. When that day does not exist, the date rolls over into the next month. `floor` goes back to the last day of the intended month instead:

```sql
SELECT date('2024-01-31', '+1 month') AS rolled,
       date('2024-01-31', '+1 month', 'floor') AS floor,
       date('2024-01-31', '+1 month', 'ceiling') AS ceiling,
       date('2024-02-29', '+1 year') AS leap_rolled,
       date('2024-02-29', '+1 year', 'floor') AS leap_floor;
```

| rolled | floor | ceiling | leap_rolled | leap_floor |
| --- | --- | --- | --- | --- |
| 2024-03-02 | 2024-02-29 | 2024-03-02 | 2025-03-01 | 2025-02-28 |

### Start of a period and weekdays

```sql
SELECT date('2024-03-15', 'start of month') AS month_start,
       date('2024-03-15', 'start of month', '+1 month', '-1 day') AS month_end,
       date('2024-03-15', 'start of year') AS year_start,
       datetime('2024-03-15 13:45:30', 'start of day') AS day_start,
       date('2024-03-15', 'weekday 0') AS next_sunday,
       date('2024-03-15', 'weekday -1') AS last_monday;
```

| month_start | month_end | year_start | day_start | next_sunday | last_monday |
| --- | --- | --- | --- | --- | --- |
| 2024-03-01 | 2024-03-31 | 2024-01-01 | 2024-03-15 00:00:00 | 2024-03-17 | 2024-03-11 |

2024-03-15 is a Friday. There is no `start of week` modifier; the Monday on or before a date is `date(d, 'weekday -1')`.

### Numbers: unixepoch, julianday and auto {#unixepoch-modifier}

```sql
SELECT datetime(1710510330, 'unixepoch') AS from_unix,
       datetime(1710510330.5, 'unixepoch', 'subsec') AS with_ms,
       datetime(2460385.5) AS from_julian,
       datetime(1710510330, 'auto') AS auto_unix,
       datetime(2460385.5, 'auto') AS auto_julian,
       datetime(1710510330, '+1 day', 'unixepoch') AS unixepoch_not_first;
```

| from_unix | with_ms | from_julian | auto_unix | auto_julian | unixepoch_not_first |
| --- | --- | --- | --- | --- | --- |
| 2024-03-15 13:45:30 | 2024-03-15 13:45:30.500 | 2024-03-16 00:00:00 | 2024-03-15 13:45:30 | 2024-03-16 00:00:00 | NULL |

### subsec {#subsec}

```sql
SELECT datetime('2024-03-15 13:45:30.25') AS plain, datetime('2024-03-15 13:45:30.25', 'subsec') AS subsec, time('13:45:30.987', 'subsec') AS time_ms;
```

| plain | subsec | time_ms |
| --- | --- | --- |
| 2024-03-15 13:45:30 | 2024-03-15 13:45:30.250 | 13:45:30.987 |

### localtime and utc {#localtime}

`localtime` and `utc` depend on the host's time zone, so their results vary between machines:

```sql
SELECT datetime('2024-03-15 13:45:30', 'localtime') AS local_time,
       datetime('2024-03-15 13:45:30', 'utc') AS from_local_to_utc,
       datetime('now', 'localtime') AS local_now;
```

## date {#date}

```
date(TIME, MOD, …)
```

The date as `YYYY-MM-DD` text. Years before 0 have a leading `-`.

```sql
SELECT date('2024-03-15 13:45:30') AS a, date(1710510330, 'unixepoch') AS b, date('2024-03-15', '+1 month') AS c;
```

| a | b | c |
| --- | --- | --- |
| 2024-03-15 | 2024-03-15 | 2024-04-15 |

## time {#time}

```
time(TIME, MOD, …)
```

The time of day as `HH:MM:SS` text, or `HH:MM:SS.SSS` with `subsec`.

```sql
SELECT time('2024-03-15 13:45:30') AS a, time('13:45', '+30 minutes') AS b, time('10:00', '+15:30') AS c;
```

| a | b | c |
| --- | --- | --- |
| 13:45:30 | 14:15:00 | 01:30:00 |

## datetime {#datetime}

```
datetime(TIME, MOD, …)
```

The date and time as `YYYY-MM-DD HH:MM:SS` text, or `YYYY-MM-DD HH:MM:SS.SSS` with `subsec`. This is the format to store timestamps in: it sorts and compares correctly as text.

```sql
SELECT datetime('2024-03-15T13:45:30Z') AS a, datetime('2024-03-15', '+30 seconds') AS b, datetime('2024-03-15 13:45:30', 'start of day', '+1 day', '-1 second') AS end_of_day;
```

| a | b | end_of_day |
| --- | --- | --- |
| 2024-03-15 13:45:30 | 2024-03-15 00:00:30 | 2024-03-15 23:59:59 |

## julianday {#julianday}

```
julianday(TIME, MOD, …)
```

The julian day number: days since noon UTC on November 24, 4714 BC in the proleptic Gregorian calendar, as a REAL. Subtracting two julian days gives a difference in days.

```sql
SELECT julianday('2024-03-15') AS a, julianday('2000-01-01 12:00') AS b, julianday('2024-03-16') - julianday('2024-03-01') AS days_between;
```

| a | b | days_between |
| --- | --- | --- |
| 2460384.5 | 2451545 | 15 |

## unixepoch {#unixepoch}

```
unixepoch(TIME, MOD, …)
```

Seconds since 1970-01-01 00:00:00 UTC, as an INTEGER (fractions are truncated). With the `subsec` modifier the result is a REAL with milliseconds.

```sql
SELECT unixepoch('2024-03-15 13:45:30') AS a, unixepoch('2024-03-15 13:45:30.250', 'subsec') AS b, unixepoch('1970-01-01') AS c, (unixepoch('2024-03-15 13:45') - unixepoch('2024-03-15 08:00')) / 60 AS minutes;
```

| a | b | c | minutes |
| --- | --- | --- | --- |
| 1710510330 | 1710510330.25 | 0 | 345 |

::: warning Differs from SQLite
With `subsec`, a result that is a whole number of seconds is reported by `typeof` as `'integer'` (SQLite: `'real'`). The value is the same. See [Types](../sql/types).
:::

## strftime {#strftime}

```
strftime(FORMAT, TIME, MOD, …)
```

Formats the time with `FORMAT`, in which each `%` code below is replaced and every other character is copied. A NULL format gives NULL. An unknown code, such as `%Q`, makes the whole result NULL.

### Format codes {#format-codes}

Results below are for `'2024-03-05 08:04:09.125'`, a Tuesday.

| Code | Meaning | Example |
| --- | --- | --- |
| `%d` | Day of month, `01`–`31` | `05` |
| `%e` | Day of month, space-padded, ` 1`–`31` | ` 5` |
| `%f` | Seconds with milliseconds, `SS.SSS` | `09.125` |
| `%F` | ISO date, same as `%Y-%m-%d` | `2024-03-05` |
| `%G` | ISO 8601 week-based year | `2024` |
| `%g` | ISO 8601 week-based year, last two digits | `24` |
| `%H` | Hour, `00`–`23` | `08` |
| `%I` | Hour on a 12-hour clock, `01`–`12` | `08` |
| `%j` | Day of year, `001`–`366` | `065` |
| `%J` | Julian day number, with fraction | `2460374.836216724` |
| `%k` | Hour, space-padded, ` 0`–`23` | ` 8` |
| `%l` | Hour on a 12-hour clock, space-padded, ` 1`–`12` | ` 8` |
| `%m` | Month, `01`–`12` | `03` |
| `%M` | Minute, `00`–`59` | `04` |
| `%p` | `AM` or `PM` | `AM` |
| `%P` | `am` or `pm` | `am` |
| `%R` | Hour and minute, same as `%H:%M` | `08:04` |
| `%s` | Seconds since 1970-01-01 (with milliseconds when `subsec` is used) | `1709625849` |
| `%S` | Seconds, `00`–`59` | `09` |
| `%T` | Time, same as `%H:%M:%S` | `08:04:09` |
| `%u` | Day of week, `1`–`7`, Monday = 1 | `2` |
| `%U` | Week of year, `00`–`53`; week 1 starts on the first Sunday | `09` |
| `%V` | ISO 8601 week of year, `01`–`53` | `10` |
| `%w` | Day of week, `0`–`6`, Sunday = 0 | `2` |
| `%W` | Week of year, `00`–`53`; week 1 starts on the first Monday | `10` |
| `%Y` | Year, `0000`–`9999` | `2024` |
| `%%` | A literal `%` | `%` |

```sql
SELECT strftime('%d|%e|%f|%F|%G|%g|%H|%I|%j|%J|%k|%l|%m|%M|%p|%P|%R|%s|%S|%T|%u|%U|%V|%w|%W|%Y|%%', '2024-03-05 08:04:09.125') AS codes;
```

| codes |
| --- |
| 05\| 5\|09.125\|2024-03-05\|2024\|24\|08\|08\|065\|2460374.836216724\| 8\| 8\|03\|04\|AM\|am\|08:04\|1709625849\|09\|08:04:09\|2\|09\|10\|2\|10\|2024\|% |

```sql
SELECT strftime('%Y-%m', '2024-03-15') AS month,
       strftime('%H:%M', '2024-03-15 13:45:30', '+1 hour') AS hour_later,
       strftime('%I:%M %p', '2024-03-15 00:30') AS twelve_hour,
       strftime('%G-W%V-%u', '2021-01-01') AS iso_week,
       strftime('%s', '2024-03-05 08:04:09.125', 'subsec') AS epoch_ms,
       strftime('%Q', '2024-03-15') AS unknown_code;
```

| month | hour_later | twelve_hour | iso_week | epoch_ms | unknown_code |
| --- | --- | --- | --- | --- | --- |
| 2024-03 | 14:45 | 12:30 AM | 2020-W53-5 | 1709625849.125 | NULL |

## timediff {#timediff}

```
timediff(A, B)
```

The time from `B` to `A`, as text in the form `±YYYY-MM-DD HH:MM:SS.SSS`: a sign, then whole years, months and days, then the remaining time. Months are calendar months counted from `B`, so the result can be added to `B` as a [modifier](#modifiers) to get `A`. Both arguments are time values; modifiers are not accepted. If either is NULL or invalid, the result is NULL.

```sql
SELECT timediff('2024-03-15', '2024-01-01') AS a,
       timediff('2024-01-01', '2024-03-15') AS b,
       timediff('2024-03-15 12:00:00.5', '2024-03-15 10:00') AS c,
       timediff('2025-03-01', '2024-02-29') AS d;
```

| a | b | c | d |
| --- | --- | --- | --- |
| +0000-02-14 00:00:00.000 | -0000-02-14 00:00:00.000 | +0000-00-00 02:00:00.500 | +0001-00-00 00:00:00.000 |

```sql
SELECT datetime('2024-01-01', timediff('2024-03-15 08:30', '2024-01-01')) AS round_trip;
```

| round_trip |
| --- |
| 2024-03-15 08:30:00 |

## CURRENT_DATE, CURRENT_TIME, CURRENT_TIMESTAMP {#current_date}

```
CURRENT_DATE
CURRENT_TIME
CURRENT_TIMESTAMP
```

These are keywords, written without parentheses. They return the current UTC date (`YYYY-MM-DD`), time (`HH:MM:SS`) or both (`YYYY-MM-DD HH:MM:SS`) as text, the same as `date('now')`, `time('now')` and `datetime('now')`. They can also be column defaults (`created TEXT DEFAULT CURRENT_TIMESTAMP`); see [CREATE TABLE](../sql/create-table).

```sql
SELECT CURRENT_DATE = date('now') AS same_date, CURRENT_TIMESTAMP = datetime('now') AS same_timestamp, length(CURRENT_TIME) AS time_length;
```

| same_date | same_timestamp | time_length |
| --- | --- | --- |
| 1 | 1 | 8 |

The current time is read once per statement execution, so both sides above see the same instant. To show the actual values (they change on every run):

```sql
SELECT CURRENT_DATE, CURRENT_TIME, CURRENT_TIMESTAMP, datetime('now', 'subsec') AS now_ms, unixepoch() AS epoch;
```

Writing them with parentheses, as in `current_date()`, is a syntax error (`SMALT_SYNTAX`), as in SQLite.

## In indexes and CHECK constraints {#indexes-and-check-constraints}

The date and time functions may be used in index expressions, in a partial index's `WHERE` clause, and in `CHECK` constraints. There, as in SQLite, a call that reads the clock or the time zone fails when it runs: a time value of `'now'`, `'subsec'` or `'subsecond'`, no time value at all (`date()`), and the `'localtime'` and `'utc'` modifiers. The error is `non-deterministic use of date() in an index` or `… in a CHECK constraint`, naming the function. Whether a call reads the clock can depend on the row, so the error comes from the row that does it, when it is inserted or updated (or when `CREATE INDEX` indexes the existing rows).

```sql
CREATE TABLE event(at TEXT);
CREATE INDEX event_day ON event(date(at));
INSERT INTO event VALUES ('2024-03-15 13:45:30');
SELECT at FROM event WHERE date(at) = '2024-03-15'
```

| at |
| --- |
| 2024-03-15 13:45:30 |

<!-- docs:error SMALT_ERROR -->
```sql
INSERT INTO event VALUES ('now')
```

`CURRENT_DATE`, `CURRENT_TIME` and `CURRENT_TIMESTAMP` are always prohibited in an index (`non-deterministic functions prohibited in index expressions`). A `DEFAULT` may use any of them.

## Differences from SQLite {#differences}

The results match SQLite 3.54 with these exceptions:

- `'now'` is read once per statement execution. SQLite guarantees a stable `'now'` only within one step of a statement, so a long query in SQLite can see the clock move; in smaltdb it cannot.
- A REAL result with no fractional part, such as `unixepoch(…, 'subsec')` on a whole second, reports `typeof` `'integer'`.
- Modifier chains whose intermediate values exceed about ±2^53 milliseconds (e.g. `'+400000000000000 seconds', '-400000000000000 seconds'`) can be off by a few milliseconds, because smaltdb computes in JavaScript doubles where SQLite uses 64-bit integers.
