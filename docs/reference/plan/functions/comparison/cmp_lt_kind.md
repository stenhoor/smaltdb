---
description: 'Whether the first value is less than the second, for two numbers or two texts; NULL for anything else.'
---

# cmp_lt_kind

```ebnf
cmp_lt_kind ::= '"fn": "cmp_lt_kind"' ', "args": [' X ',' Y ']'
```

Whether `X` is less than `Y`, comparing values of one kind only: two numbers, or two texts by their UTF-8 bytes. Any
other pair gives NULL. This is the comparison of a language whose `<` orders only values of one kind, as Cypher's does;
[`cmp_lt`](./cmp_lt) is SQL's, which ranks every pair.

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
- NULL where `cmp_lt` ranks by storage class: a number against text, a blob, a NaN, and a `bool`, list, struct or map
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
      {"k": "call", "fn": "cmp_lt_kind", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 2.5, "type": "real"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_lt_kind", "args": [
        {"k": "lit", "value": "apple", "type": "text"},
        {"k": "lit", "value": "pear", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_lt_kind", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": "1", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_lt", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": "1", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_lt_kind", "args": [
        {"k": "lit", "value": {"$real": "NaN"}, "type": "real"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_lt_kind", "args": [
        {"k": "lit", "value": null, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "bool"}
    ]]
  },
  "columns": [{"name": "numbers"}, {"name": "texts"}, {"name": "number_text"}, {"name": "cmp_lt"}, {"name": "nan"}, {"name": "null"}]
}
```

| numbers | texts | number_text | cmp_lt | nan | null |
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
      {"k": "call", "fn": "cmp_lt_kind", "args": [
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": "B", "type": "text"}
      ], "type": "bool", "collation": "nocase"}
    ]]
  },
  "columns": [{"name": "nocase"}]
}
```

## Demo

The people of the sample graph born before 1910. Their `born` is a value under `any` in a map, as a Cypher query reads
it:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "node", "columns": [0, 1]},
      "pred": {"k": "call", "fn": "cmp_lt_kind", "args": [
        {"k": "call", "fn": "map_get", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "map<text, any>", "collation": "binary"},
          {"k": "lit", "value": "born", "type": "text"}
        ], "type": "any"},
        {"k": "lit", "value": 1910, "type": "int"}
      ], "type": "bool"}
    },
    "exprs": [
      {"k": "call", "fn": "map_get", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "map<text, any>", "collation": "binary"},
        {"k": "lit", "value": "name", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "map_get", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "map<text, any>", "collation": "binary"},
        {"k": "lit", "value": "born", "type": "text"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "born"}]
}
```

| name | born |
|---|---|
| Ada | 1815 |
| Grace | 1906 |

## See also

- [`cmp_lt`](./cmp_lt), [`cmp_le_kind`](./cmp_le_kind), [`cmp_gt_kind`](./cmp_gt_kind), [`cmp_ge_kind`](./cmp_ge_kind)
- [Comparison functions](./)
