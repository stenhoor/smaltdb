---
description: 'Whether the first value is less than the second, in SQLite''s order of every kind.'
---

# cmp_lt

```ebnf
cmp_lt ::= '"fn": "cmp_lt"' ', "args": [' X ',' Y ']'
```

Whether `X` is less than `Y`: SQL's `<`, ordering values of every kind in SQLite's storage-class order. NULL when either
is NULL.

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
- [`cmp_lt_kind`](./cmp_lt_kind) orders only two values of one kind (two numbers, or two texts by their bytes), and
  gives NULL for the rest, where `cmp_lt` ranks them by storage class: a language whose `<` doesn't compare a number
  with text uses it.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool", "bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "cmp_lt", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 2.5, "type": "real"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_lt", "args": [
        {"k": "lit", "value": 10, "type": "int"},
        {"k": "lit", "value": "9", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_lt", "args": [
        {"k": "lit", "value": "apple", "type": "text"},
        {"k": "lit", "value": "Pear", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_lt", "args": [
        {"k": "lit", "value": "apple", "type": "text"},
        {"k": "lit", "value": "Pear", "type": "text"}
      ], "type": "bool", "collation": "nocase"},
      {"k": "call", "fn": "cmp_lt", "args": [
        {"k": "lit", "value": "z", "type": "text"},
        {"k": "lit", "value": {"$blob": "00"}, "type": "blob"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_lt", "args": [
        {"k": "lit", "value": null, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "bool"}
    ]]
  },
  "columns": [
    {"name": "numbers"},
    {"name": "number_text"},
    {"name": "binary"},
    {"name": "nocase"},
    {"name": "text_blob"},
    {"name": "null"}
  ]
}
```

| numbers | number_text | binary | nocase | text_blob | null |
|---|---|---|---|---|---|
| true | true | false | true | true | NULL |

## Demo

The fruit that cost less than 1:

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
    "pred": {"k": "call", "fn": "cmp_lt", "args": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
      {"k": "lit", "value": 1, "type": "int"}
    ], "type": "bool"}
  },
  "columns": [{"name": "name"}, {"name": "price"}]
}
```

| name | price |
|---|---|
| apple | 0.5 |
| pear | 0.75 |
| lime | 0.4 |

## See also

- [`cmp_eq`](./cmp_eq), [`cmp_ne`](./cmp_ne), [`cmp_le`](./cmp_le), [`cmp_gt`](./cmp_gt), [`cmp_ge`](./cmp_ge)
- [`cmp_lt_kind`](./cmp_lt_kind), [`cmp_is`](./cmp_is)
- [Comparison functions](./)
- [`call`](../../expressions/call): how a plan calls a function
