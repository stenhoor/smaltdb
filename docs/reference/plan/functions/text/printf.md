---
description: 'Text made from a format and values, as SQLite''s printf writes it.'
---

# format, printf

```ebnf
format ::= '"fn": "format"' ', "args": [' (FORMAT (',' ARG)*)? ']'
printf ::= '"fn": "printf"' ', "args": [' (FORMAT (',' ARG)*)? ']'
```

`FORMAT` with each `%` conversion replaced by the next argument, written as SQLite's `printf()` writes it: the engine
carries a port of SQLite's formatter, so the output is the same byte for byte. `format` and `printf` are two names for
one function.

A conversion is `%[flags][width][.precision]type`. `width` and `precision` may be `*`, to take them from the next
argument.

| Type | Output |
|---|---|
| `d`, `i` | A signed integer. A real is truncated; text gives its leading integer (`'12abc'` is 12, `'x12'` is 0). |
| `u` | The integer as an unsigned 64-bit value: `-1` gives `18446744073709551615`. |
| `f` | Fixed-point decimal; the precision is the digits after the point (6 by default). |
| `e`, `E` | Exponent form: `3.141590e+04`. |
| `g`, `G` | `%e` when the exponent is below -4 or not below the precision, otherwise `%f`; the precision counts significant digits (6 by default), and trailing zeros go. |
| `x`, `X`, `o` | Hexadecimal (lower or upper case) or octal. |
| `c` | The first character of the argument's text; with a precision, repeated that many times. |
| `s`, `z` | The argument as text; the precision limits its length. NULL gives the empty text. |
| `q` | The text with each `'` doubled. |
| `Q` | As `q`, in single quotes; NULL gives `NULL` without quotes. |
| `w` | The text with each `"` doubled. |
| `%` | A `%`. |

| Flag | Effect |
|---|---|
| `-` | Align left within the width. |
| `+` | A sign on positive numbers too. |
| space | A space where a positive number's sign would be. |
| `0` | Pad numbers with zeros to the width. |
| `,` | Thousands separators. |
| `#` | `0x` before `%x`, `0` before `%o`; keep trailing zeros of `%g`. |
| `!` | Widths and precisions of text count characters, not UTF-8 bytes; numbers get up to 20 significant digits, and a whole number keeps `.0`. |

## Parameters

| Argument | Type | |
|---|---|---|
| `FORMAT` | `text` | The format. A number is taken as its text. |
| `ARG` | any | The values for the conversions, in order. Extra arguments are left unused. |

## Returns

`text`. NULL when `FORMAT` is NULL or there are no arguments.

## Errors

| Code | When |
|---|---|
| `SMALT_TOOBIG` | The result would be longer than 1,000,000,000 bytes. |

## Notes

- A conversion with no argument left takes NULL: `%s` gives the empty text, `%d` gives `0`.
- Without the `!` flag, widths and precisions of text count UTF-8 bytes, as in SQLite: `%5s` pads `é` (two bytes) with
  three spaces.
- A `%` followed by something that is not a conversion ends the result there: `a%yb` gives `a`.
- [`format_temporal`](../temporal/format_temporal) and [`strftime`](../datetime/strftime) format dates and times.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "printf", "args": [
        {"k": "lit", "value": "%d|%5d|%-5d|%05d|%+d|%,d", "type": "text"},
        {"k": "lit", "value": 42, "type": "int"},
        {"k": "lit", "value": 42, "type": "int"},
        {"k": "lit", "value": 42, "type": "int"},
        {"k": "lit", "value": 42, "type": "int"},
        {"k": "lit", "value": 42, "type": "int"},
        {"k": "lit", "value": 1234567, "type": "int"}
      ], "type": "text"},
      {"k": "call", "fn": "printf", "args": [
        {"k": "lit", "value": "%.2f %e %g", "type": "text"},
        {"k": "lit", "value": 3.14159, "type": "real"},
        {"k": "lit", "value": 31415.9, "type": "real"},
        {"k": "lit", "value": 0.0001, "type": "real"}
      ], "type": "text"},
      {"k": "call", "fn": "printf", "args": [
        {"k": "lit", "value": "%x %X %#o %u", "type": "text"},
        {"k": "lit", "value": 255, "type": "int"},
        {"k": "lit", "value": 255, "type": "int"},
        {"k": "lit", "value": 8, "type": "int"},
        {"k": "lit", "value": -1, "type": "int"}
      ], "type": "text"},
      {"k": "call", "fn": "printf", "args": [
        {"k": "lit", "value": "%.3s %q %Q %Q", "type": "text"},
        {"k": "lit", "value": "hello", "type": "text"},
        {"k": "lit", "value": "it's", "type": "text"},
        {"k": "lit", "value": "it's", "type": "text"},
        {"k": "lit", "value": null, "type": "text"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "integers"}, {"name": "reals"}, {"name": "radix"}, {"name": "text"}]
}
```

| integers | reals | radix | text |
|---|---|---|---|
| 42\|   42\|42   \|00042\|+42\|1,234,567 | 3.14 3.141590e+04 0.0001 | ff FF 010 18446744073709551615 | hel it''s 'it''s' NULL |

`format` is the same function; a NULL format gives NULL:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "format", "args": [
        {"k": "lit", "value": "%s-%s", "type": "text"},
        {"k": "lit", "value": "a", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "format", "args": [
        {"k": "lit", "value": "%5s|%!5s|", "type": "text"},
        {"k": "lit", "value": "é", "type": "text"},
        {"k": "lit", "value": "é", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "format", "args": [
        {"k": "lit", "value": null, "type": "text"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "missing"}, {"name": "width"}, {"name": "null"}]
}
```

| missing | width | null |
|---|---|---|
| a- | `'   é\|    é\|'` | NULL |

## Demo

A price list with aligned columns:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
    "exprs": [
      {"k": "call", "fn": "printf", "args": [
        {"k": "lit", "value": "%-8s%6.2f", "type": "text"},
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}
      ], "type": "text"}
    ]
  },
  "columns": [{"name": "line"}]
}
```

| line |
|---|
| apple     0.50 |
| pear      0.75 |
| plum      1.25 |
| cherry    3.00 |
| lime      0.40 |

## See also

- [`concat`](./concat), [`quote`](./quote), [`format_temporal`](../temporal/format_temporal)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
