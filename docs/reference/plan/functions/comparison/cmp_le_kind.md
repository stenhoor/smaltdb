---
description: 'Whether the first value is less than or equal to the second, for two numbers or two texts; NULL for anything else.'
---

# cmp_le_kind

```ebnf
cmp_le_kind ::= '"fn": "cmp_le_kind"' ', "args": [' X ',' Y ']'
```

Whether `X` is less than or equal to `Y`, comparing values of one kind only: two numbers, or two texts by their UTF-8
bytes. Any other pair gives NULL. This is the comparison of a language whose `<=` orders only values of one kind, as
Cypher's does; [`cmp_le`](./cmp_le) is SQL's, which ranks every pair.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The left operand. |
| `Y` | any | The right operand. |

## Returns

`bool`: true or false (1 or 0 declared `int`). NULL when `X` or `Y` is NULL or NaN, and when they are not both numbers
or both text.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | The call has a `collation` other than `binary`, when the plan is compiled. |

## Notes

- Two numbers compare by value: an `int` with a `real`, and integers beyond 2^53 exactly. `bool`, `date`, `datetime`,
  `time` and `duration` values are integers while a plan runs, and compare as numbers.
- Text compares by its UTF-8 bytes. The call takes no other collation.
- NULL where `cmp_le` ranks by storage class: a number against text, a blob, a NaN, and a `bool`, list, struct or map
  under `any` ([ADR 0039](../../../../adr/0039-typed-values-under-any.md)).
- No affinity is applied: numeric text is text.
- The call's declared `type` says how results show the value: `bool` gives `true` / `false`, `int` gives 1 / 0 (as SQL's
  comparisons do). The value is 0 or 1 either way while the plan runs ([truth values](../../types#truth-values)).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool", "bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "cmp_le_kind", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 2.5, "type": "real"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_le_kind", "args": [
        {"k": "lit", "value": "apple", "type": "text"},
        {"k": "lit", "value": "pear", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_le_kind", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": "1", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_le", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": "1", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_le_kind", "args": [
        {"k": "lit", "value": {"$real": "NaN"}, "type": "real"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_le_kind", "args": [
        {"k": "lit", "value": null, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "bool"}
    ]]
  },
  "columns": [{"name": "numbers"}, {"name": "texts"}, {"name": "number_text"}, {"name": "cmp_le"}, {"name": "nan"}, {"name": "null"}]
}
```

| numbers | texts | number_text | cmp_le | nan | null |
|---|---|---|---|---|---|
| true | true | NULL | true | NULL | NULL |

A collation other than `binary` is refused:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool"],
    "rows": [[
      {"k": "call", "fn": "cmp_le_kind", "args": [
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": "B", "type": "text"}
      ], "type": "bool", "collation": "nocase"}
    ]]
  },
  "columns": [{"name": "nocase"}]
}
```

## Demo

Whether each `KNOWS` relationship began in 1944 or before, and the same comparison with text, which orders nothing here:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "knows", "columns": [0, 1, 2]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "cmp_le_kind", "args": [
        {"k": "call", "fn": "map_get", "args": [
          {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "map<text, any>", "collation": "binary"},
          {"k": "lit", "value": "since", "type": "text"}
        ], "type": "any"},
        {"k": "lit", "value": 1944, "type": "int"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_le_kind", "args": [
        {"k": "call", "fn": "map_get", "args": [
          {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "map<text, any>", "collation": "binary"},
          {"k": "lit", "value": "since", "type": "text"}
        ], "type": "any"},
        {"k": "lit", "value": "1944", "type": "text"}
      ], "type": "bool"}
    ]
  },
  "columns": [{"name": "start"}, {"name": "end"}, {"name": "early"}, {"name": "with_text"}]
}
```

| start | end | early | with_text |
|---|---|---|---|
| 0 | 1 | true | NULL |
| 1 | 2 | true | NULL |
| 1 | 3 | false | NULL |
| 2 | 3 | false | NULL |

## See also

- [`cmp_le`](./cmp_le), [`cmp_lt_kind`](./cmp_lt_kind), [`cmp_gt_kind`](./cmp_gt_kind), [`cmp_ge_kind`](./cmp_ge_kind)
- [Comparison functions](./)
