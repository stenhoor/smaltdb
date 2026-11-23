---
description: 'How a value of one plan type becomes one of another: the conversion table, and casts.'
---

# Conversions

A plan converts nothing by itself: every conversion is a [`cast`](./expressions/cast) or a function
[`call`](./expressions/call) that the plan writes. The engine's conversion table says which operation converts a
value of one type to another, and whether every value converts exactly
([ADR 0027](../../adr/0027-view-interfaces.md)).

## The conversion table

`conversion(from, to)` in `smaltdb/plan` gives `{ loss, fn? }`, or undefined when there is no conversion. `fn` names
the operation that converts, applied as a call (`call(fn, [value], to)`); without it, the value is kept as it is.
`loss` is `none` when every value converts exactly, and `possible` when some change or fail. It is decided by the two
types alone, never by the values a database holds, so every language gets the same answer. `isLossless(from, to)` is
`conversion(from, to)?.loss === 'none'`: the changes a view's interface accepts.

| From | Lossless | Possible loss |
|---|---|---|
| any type | itself; `null` to anything | |
| `int` | `num`, `any`; `text` (`cast_text`) | `real` (`cast_real`) |
| `real` | `num`, `any`; `text` (`cast_text`) | `int` (`cast_integer_strict`) |
| `num` | `any`; `text` (`cast_text`) | `int` (`cast_integer_strict`), `real` (`cast_real_strict`) |
| `bool` | `int`, `num`, `any`; `real` (`cast_real`), `text` (`cast_text`) | |
| `text` | `any`; `blob` (`cast_blob`) | `int` (`cast_integer_strict`), `real` (`cast_real_strict`), `num` (`cast_numeric`), `date` (`cast_date`), `datetime` (`cast_datetime`), `time` (`cast_time`) |
| `blob` | `any` | |
| `date` | `datetime` (`cast_datetime`), `text` and `any` (`cast_text`) | |
| `datetime` | `text` and `any` (`cast_text`) | `date` (`cast_date`), `time` (`cast_time`) |
| `time`, `duration` | `text` and `any` (`cast_text`) | |
| `list<T>`, `struct<…>`, `map<text, T>` | `text` and `any` (`cast_text`: JSON text); a list, struct or map of the same kind whose elements, fields (the same names, in order) or values are kept as they are | |
| `any` | | `text` (`cast_text`), `num` (`cast_numeric`), `blob` (`cast_blob`) |

A temporal value, a list or a struct becomes `any` as its text: kept as it is, it would read as the integer or blob
underneath. `int` to `real` loses precision beyond 2^53, so it is not lossless. A `duration` has no conversion to
`int`.

```ts
import { plan as p } from 'smaltdb/engine';

p.conversion('int', 'num'); // { loss: 'none' }
p.conversion('date', 'datetime'); // { loss: 'none', fn: 'cast_datetime' }
p.conversion('real', 'int'); // { loss: 'possible', fn: 'cast_integer_strict' }
p.isLossless('list<int>', 'list<num>'); // true
```

## Casts and calls

A [`cast`](./expressions/cast) names a conversion of one argument: `cast_integer`, `cast_real`, `cast_text`,
`cast_blob`, `cast_numeric`, `cast_integer_strict`, `cast_real_strict`, `affinity_numeric` or `affinity_text`.
`cast_date`, `cast_datetime` and `cast_time` are called with a [`call`](./expressions/call), as every conversion may
be. The two give the same value.

| Conversion | Meaning |
|---|---|
| [`cast_integer`](./functions/conversion/cast_integer), [`cast_real`](./functions/conversion/cast_real), [`cast_text`](./functions/conversion/cast_text), [`cast_blob`](./functions/conversion/cast_blob), [`cast_numeric`](./functions/conversion/cast_numeric) | SQLite's CAST: never an error. Text that isn't a number gives its numeric prefix, or 0 |
| [`cast_integer_strict`](./functions/conversion/cast_integer_strict), [`cast_real_strict`](./functions/conversion/cast_real_strict) | A number, or an error (`SMALT_MISMATCH`, `SMALT_RANGE`) for anything that isn't exactly one |
| [`cast_date`](./functions/conversion/cast_date), [`cast_datetime`](./functions/conversion/cast_datetime), [`cast_time`](./functions/conversion/cast_time) | A date or time from text in the result format, from another temporal value, or from a number |
| [`affinity_numeric`](./functions/conversion/affinity_numeric), [`affinity_text`](./functions/conversion/affinity_text) | The conversion SQLite applies to an operand of a comparison with a column of that affinity |

## Example

Text to an integer, by SQLite's CAST and strictly, as a `cast` and as a `call`:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "date"],
    "rows": [[
      {"k": "cast", "fn": "cast_integer", "to": "int", "arg": {"k": "lit", "value": "12 apples", "type": "text"}},
      {"k": "cast", "fn": "cast_integer_strict", "to": "int", "arg": {"k": "lit", "value": "12", "type": "text"}},
      {"k": "call", "fn": "cast_integer_strict", "args": [{"k": "lit", "value": "12", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-07", "type": "text"}], "type": "date"}
    ]]
  },
  "columns": [{"name": "cast"}, {"name": "strict"}, {"name": "strict call"}, {"name": "date"}]
}
```

| cast | strict | strict call | date |
|---|---|---|---|
| 12 | 12 | 12 | 2026-11-07 |

The strict conversion of text that isn't all an integer:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "op": "values",
  "types": ["int"],
  "rows": [[{"k": "cast", "fn": "cast_integer_strict", "to": "int", "arg": {"k": "lit", "value": "12 apples", "type": "text"}}]]
}
```

## See also

- [Types](./types)
- [Conversion functions](./functions/conversion/)
- [View interfaces](../engine/schema#view-interfaces): the changes of a column's type a view accepts
