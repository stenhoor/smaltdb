---
description: 'Whether the first value is greater than the second, in SQLite''s order of every kind.'
---

# cmp_gt

```ebnf
cmp_gt ::= '"fn": "cmp_gt"' ', "args": [' X ',' Y ']'
```

Whether `X` is greater than `Y`: SQL's `>`, ordering values of every kind in SQLite's storage-class order. NULL when
either is NULL.

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
- [`cmp_gt_kind`](./cmp_gt_kind) orders only two values of one kind (two numbers, or two texts by their bytes), and
  gives NULL for the rest, where `cmp_gt` ranks them by storage class: a language whose `>` doesn't compare a number
  with text uses it.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool", "bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "cmp_gt", "args": [
        {"k": "lit", "value": 2.5, "type": "real"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_gt", "args": [
        {"k": "lit", "value": "1", "type": "text"},
        {"k": "lit", "value": 100, "type": "int"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_gt", "args": [
        {"k": "lit", "value": "b", "type": "text"},
        {"k": "lit", "value": "B", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_gt", "args": [
        {"k": "lit", "value": "b", "type": "text"},
        {"k": "lit", "value": "B", "type": "text"}
      ], "type": "bool", "collation": "nocase"},
      {"k": "call", "fn": "cmp_gt", "args": [
        {"k": "lit", "value": {"$real": "NaN"}, "type": "real"},
        {"k": "lit", "value": {"$real": "Infinity"}, "type": "real"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_gt", "args": [
        {"k": "lit", "value": null, "type": "text"},
        {"k": "lit", "value": "a", "type": "text"}
      ], "type": "bool"}
    ]]
  },
  "columns": [{"name": "numbers"}, {"name": "text_number"}, {"name": "binary"}, {"name": "nocase"}, {"name": "nan"}, {"name": "null"}]
}
```

| numbers | text_number | binary | nocase | nan | null |
|---|---|---|---|---|---|
| true | true | true | false | true | NULL |

## Demo

Whether each fruit has more than 5 in stock; plum's stock is NULL, and so is its answer.

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "cmp_gt", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 5, "type": "int"}
      ], "type": "bool"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "plenty"}]
}
```

| name | plenty |
|---|---|
| apple | true |
| pear | false |
| plum | NULL |
| cherry | true |
| lime | false |

## See also

- [`cmp_eq`](./cmp_eq), [`cmp_ne`](./cmp_ne), [`cmp_lt`](./cmp_lt), [`cmp_le`](./cmp_le), [`cmp_ge`](./cmp_ge)
- [`cmp_gt_kind`](./cmp_gt_kind), [`cmp_is`](./cmp_is)
- [Comparison functions](./)
- [`call`](../../expressions/call): how a plan calls a function
