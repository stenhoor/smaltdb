---
description: 'Whether two values are equal, in SQLite''s order: NULL when either is NULL.'
---

# cmp_eq

```ebnf
cmp_eq ::= '"fn": "cmp_eq"' ', "args": [' X ',' Y ']'
```

Whether `X` equals `Y`: SQL's `=`, comparing values in SQLite's order. NULL when either is NULL.

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
- NULL is not equal to NULL here: [`cmp_is`](./cmp_is) compares NULL as a value and is never NULL.
- [`in_list`](./in_list) tests equality with several values at once.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool", "bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 1, "type": "real"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": "1", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "lit", "value": "Pear", "type": "text"},
        {"k": "lit", "value": "pear", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "lit", "value": "Pear", "type": "text"},
        {"k": "lit", "value": "pear", "type": "text"}
      ], "type": "bool", "collation": "nocase"},
      {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "lit", "value": {"$real": "NaN"}, "type": "real"},
        {"k": "lit", "value": {"$real": "NaN"}, "type": "real"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "lit", "value": null, "type": "int"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "bool"}
    ]]
  },
  "columns": [{"name": "int_real"}, {"name": "int_text"}, {"name": "binary"}, {"name": "nocase"}, {"name": "nan"}, {"name": "null"}]
}
```

| int_real | int_text | binary | nocase | nan | null |
|---|---|---|---|---|---|
| true | false | false | true | true | NULL |

SQLite's comparison of a number with numeric text, by way of [`affinity_numeric`](../conversion/affinity_numeric), and
the same call declared `int`:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "int"],
    "rows": [[
      {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "call", "fn": "affinity_numeric", "args": [{"k": "lit", "value": "1", "type": "text"}], "type": "int"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "call", "fn": "affinity_numeric", "args": [{"k": "lit", "value": "1", "type": "text"}], "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "as_bool"}, {"name": "as_int"}]
}
```

| as_bool | as_int |
|---|---|
| true | 1 |

## Demo

The red fruit, matched without regard to case: the call compares by `nocase`.

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 2]},
      "pred": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": "RED", "type": "text"}
      ], "type": "bool", "collation": "nocase"}
    },
    "exprs": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}]
  },
  "columns": [{"name": "name"}]
}
```

| name |
|---|
| apple |
| cherry |

## See also

- [`cmp_ne`](./cmp_ne), [`cmp_lt`](./cmp_lt), [`cmp_le`](./cmp_le), [`cmp_gt`](./cmp_gt), [`cmp_ge`](./cmp_ge)
- [`cmp_is`](./cmp_is), [`cmp_is_not`](./cmp_is_not), [`in_list`](./in_list)
- [Comparison functions](./)
- [`call`](../../expressions/call): how a plan calls a function
