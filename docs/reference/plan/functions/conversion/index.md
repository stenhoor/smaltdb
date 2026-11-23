---
description: 'SQLite''s CAST, strict conversions, dates and times from text, affinity.'
---

# Conversion functions

A plan converts nothing implicitly: a value becomes another type through one of these functions. The SQLite casts
(`cast_integer`, `cast_real`, `cast_text`, `cast_blob`, `cast_numeric`) never fail: what isn't a number becomes 0. The
strict ones (`cast_integer_strict`, `cast_real_strict`, `cast_date`, `cast_datetime`, `cast_time`) fail instead, with
`SMALT_MISMATCH` for a value that doesn't convert and `SMALT_RANGE` for one out of range. The affinity functions apply
the conversion SQLite applies to a comparison operand. A NULL argument gives NULL.

Each of them is the `fn` of a [`call`](../../expressions/call). All but `cast_date`, `cast_datetime` and `cast_time`
can also be the `fn` of a [`cast`](../../expressions/cast) expression, whose value has the type its `to` names. The
[conversion table](../../conversions) says which of these the engine uses to turn one type into another.

## Functions {#functions}

- [`cast_integer`](./cast_integer): A value as an integer, as SQLite's CAST(x AS INTEGER): never an error.
- [`cast_real`](./cast_real): A value as a real, as SQLite's CAST(x AS REAL): never an error.
- [`cast_text`](./cast_text): A value as text, as SQLite's CAST(x AS TEXT); dates, times, lists, structs and maps as their text.
- [`cast_blob`](./cast_blob): A value as a blob, as SQLite's CAST(x AS BLOB): the bytes of its text.
- [`cast_numeric`](./cast_numeric): A value as a number, integer or real, as SQLite's CAST(x AS NUMERIC): never an error.
- [`cast_integer_strict`](./cast_integer_strict): A value as an integer, or an error for one that isn't: no prefixes of text, no saturation.
- [`cast_real_strict`](./cast_real_strict): A value as a real, or an error for text that isn't a number in full and for blobs.
- [`cast_date`](./cast_date): A date from a datetime, from text in the date format, or from a number of days.
- [`cast_datetime`](./cast_datetime): A datetime from a date (its midnight), from text in the datetime format, or from a number of microseconds.
- [`cast_time`](./cast_time): A time of day from a datetime, from text HH:MM[:SS[.f]], or from a number of microseconds within a day.
- [`affinity_numeric`](./affinity_numeric): Text that is a number in full as that number; any other value as it is: SQLite's numeric affinity.
- [`affinity_text`](./affinity_text): A number as its text; any other value as it is: SQLite's text affinity.
