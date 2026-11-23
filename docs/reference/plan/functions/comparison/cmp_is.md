---
description: 'Whether two values are equal, NULL equal to NULL: never NULL.'
---

# cmp_is

```ebnf
cmp_is ::= '"fn": "cmp_is"' ', "args": [' X ',' Y ']'
```

Whether `X` equals `Y`, where NULL equals NULL and nothing else: SQL's `IS` (and `IS NOT DISTINCT FROM`). It is never
NULL.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The left operand. |
| `Y` | any | The right operand. |

## Returns

`bool`: true or false (1 or 0 declared `int`), never NULL.

## Errors

None.

## Notes

- Two values that aren't NULL compare as [`cmp_eq`](./cmp_eq) compares them: in SQLite's order, `1` equal to `1.0`, NaN
  equal to NaN, and no affinity.
- Text compares by the call's `collation` (`binary` when it has none; see [collations](../../collations)). The `carries`
  field of an operand doesn't change it: a language reads `carries` to choose the call's `collation`.
- The call's declared `type` says how results show the value: `bool` gives `true` / `false`, `int` gives 1 / 0 (as SQL's
  comparisons do). The value is 0 or 1 either way while the plan runs ([truth values](../../types#truth-values)).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "cmp_is", "args": [
        {"k": "lit", "value": null, "type": "int"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_is", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_is", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 1, "type": "real"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_is", "args": [
        {"k": "lit", "value": "A", "type": "text"},
        {"k": "lit", "value": "a", "type": "text"}
      ], "type": "bool", "collation": "nocase"},
      {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "lit", "value": null, "type": "int"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "bool"}
    ]]
  },
  "columns": [{"name": "both_null"}, {"name": "one_null"}, {"name": "int_real"}, {"name": "nocase"}, {"name": "cmp_eq"}]
}
```

| both_null | one_null | int_real | nocase | cmp_eq |
|---|---|---|---|---|
| true | false | true | true | NULL |

## Demo

The fruit whose stock is unknown:

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "pred": {"k": "call", "fn": "cmp_is", "args": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "lit", "value": null, "type": "int"}
    ], "type": "bool"}
  },
  "columns": [{"name": "name"}, {"name": "qty"}]
}
```

| name | qty |
|---|---|
| plum | NULL |

## See also

- [`cmp_is_not`](./cmp_is_not), [`cmp_eq`](./cmp_eq)
- [`isNull`](../../expressions/isNull): whether one value is NULL
- [Comparison functions](./)
