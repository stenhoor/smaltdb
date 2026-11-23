---
description: 'Whether two values differ, in SQLite''s order: NULL when either is NULL.'
---

# cmp_ne

```ebnf
cmp_ne ::= '"fn": "cmp_ne"' ', "args": [' X ',' Y ']'
```

Whether `X` differs from `Y`: SQL's `<>` and `!=`, comparing values in SQLite's order. NULL when either is NULL.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The left operand. |
| `Y` | any | The right operand. |

## Returns

`bool`: true or false (1 or 0 declared `int`). NULL when `X` or `Y` is NULL.

## Errors

None.

## Notes

- Values compare in SQLite's storage-class order: numbers before text, text before blobs. An `int` and a `real` compare
  by value (`1` equals `1.0`), integers beyond 2^53 exactly. A `bool`, list, struct or map under `any` sorts after blobs
  and equals only a value of its own type.
- The call applies no affinity: `1` and `'1'` are not equal, and a number is less than any text. A language that wants
  SQLite's column affinity wraps an operand in [`affinity_numeric`](../conversion/affinity_numeric) or
  [`affinity_text`](../conversion/affinity_text).
- Text compares by the call's `collation` (`binary` when it has none; see [collations](../../collations)). The `carries`
  field of an operand doesn't change it: a language reads `carries` to choose the call's `collation`.
- NaN equals NaN and sorts after every number, Infinity included, and before text
  ([ADR 0018](../../../../adr/0018-bool-and-nan.md)).
- The call's declared `type` says how results show the value: `bool` gives `true` / `false`, `int` gives 1 / 0 (as SQL's
  comparisons do). The value is 0 or 1 either way while the plan runs ([truth values](../../types#truth-values)).
- NULL is not equal to NULL here: [`cmp_is_not`](./cmp_is_not) compares NULL as a value and is never NULL.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool", "bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "cmp_ne", "args": [
        {"k": "lit", "value": 2, "type": "int"},
        {"k": "lit", "value": 2.5, "type": "real"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_ne", "args": [
        {"k": "lit", "value": 2, "type": "int"},
        {"k": "lit", "value": 2, "type": "real"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_ne", "args": [
        {"k": "lit", "value": "a  ", "type": "text"},
        {"k": "lit", "value": "a", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_ne", "args": [
        {"k": "lit", "value": "a  ", "type": "text"},
        {"k": "lit", "value": "a", "type": "text"}
      ], "type": "bool", "collation": "rtrim"},
      {"k": "call", "fn": "cmp_ne", "args": [
        {"k": "lit", "value": {"$real": "NaN"}, "type": "real"},
        {"k": "lit", "value": {"$real": "NaN"}, "type": "real"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_ne", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "bool"}
    ]]
  },
  "columns": [{"name": "numbers"}, {"name": "int_real"}, {"name": "binary"}, {"name": "rtrim"}, {"name": "nan"}, {"name": "null"}]
}
```

| numbers | int_real | binary | rtrim | nan | null |
|---|---|---|---|---|---|
| true | false | true | false | false | NULL |

## Demo

The fruit whose stock is not zero. Plum's `qty` is NULL, so the comparison is NULL and the filter drops it;
[`cmp_is_not`](./cmp_is_not) keeps it.

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "pred": {"k": "call", "fn": "cmp_ne", "args": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "lit", "value": 0, "type": "int"}
    ], "type": "bool"}
  },
  "columns": [{"name": "name"}, {"name": "qty"}]
}
```

| name | qty |
|---|---|
| apple | 10 |
| pear | 4 |
| cherry | 25 |

## See also

- [`cmp_eq`](./cmp_eq), [`cmp_lt`](./cmp_lt), [`cmp_le`](./cmp_le), [`cmp_gt`](./cmp_gt), [`cmp_ge`](./cmp_ge)
- [`cmp_is`](./cmp_is), [`cmp_is_not`](./cmp_is_not), [`in_list`](./in_list)
- [Comparison functions](./)
- [`call`](../../expressions/call): how a plan calls a function
