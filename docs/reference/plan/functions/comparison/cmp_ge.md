---
description: 'Whether the first value is greater than or equal to the second, in SQLite''s order of every kind.'
---

# cmp_ge

```ebnf
cmp_ge ::= '"fn": "cmp_ge"' ', "args": [' X ',' Y ']'
```

Whether `X` is greater than or equal to `Y`: SQL's `>=`, ordering values of every kind in SQLite's storage-class order.
NULL when either is NULL.

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
- [`cmp_ge_kind`](./cmp_ge_kind) orders only two values of one kind (two numbers, or two texts by their bytes), and
  gives NULL for the rest, where `cmp_ge` ranks them by storage class: a language whose `>=` doesn't compare a number
  with text uses it.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool", "int", "bool"],
    "rows": [[
      {"k": "call", "fn": "cmp_ge", "args": [
        {"k": "lit", "value": 3, "type": "int"},
        {"k": "lit", "value": 3, "type": "real"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_ge", "args": [
        {"k": "lit", "value": {"$blob": "00"}, "type": "blob"},
        {"k": "lit", "value": "zz", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_ge", "args": [
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": "a ", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_ge", "args": [
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": "a ", "type": "text"}
      ], "type": "bool", "collation": "rtrim"},
      {"k": "call", "fn": "cmp_ge", "args": [
        {"k": "lit", "value": 3, "type": "int"},
        {"k": "lit", "value": 3, "type": "real"}
      ], "type": "int"},
      {"k": "call", "fn": "cmp_ge", "args": [
        {"k": "lit", "value": 3, "type": "int"},
        {"k": "lit", "value": null, "type": "real"}
      ], "type": "bool"}
    ]]
  },
  "columns": [{"name": "int_real"}, {"name": "blob_text"}, {"name": "binary"}, {"name": "rtrim"}, {"name": "as_int"}, {"name": "null"}]
}
```

| int_real | blob_text | binary | rtrim | as_int | null |
|---|---|---|---|---|---|
| true | true | false | true | 1 | NULL |

## Demo

Whether each fruit costs 1 or more, declared `int`, so the result shows 1 / 0 as SQL's comparisons do:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "cmp_ge", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "dear"}]
}
```

| name | dear |
|---|---|
| apple | 0 |
| pear | 0 |
| plum | 1 |
| cherry | 1 |
| lime | 0 |

## See also

- [`cmp_eq`](./cmp_eq), [`cmp_ne`](./cmp_ne), [`cmp_lt`](./cmp_lt), [`cmp_le`](./cmp_le), [`cmp_gt`](./cmp_gt)
- [`cmp_ge_kind`](./cmp_ge_kind), [`cmp_is`](./cmp_is)
- [Comparison functions](./)
- [`call`](../../expressions/call): how a plan calls a function
