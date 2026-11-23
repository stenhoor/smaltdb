---
description: 'Whether two values differ, NULL equal to NULL: never NULL.'
---

# cmp_is_not

```ebnf
cmp_is_not ::= '"fn": "cmp_is_not"' ', "args": [' X ',' Y ']'
```

Whether `X` differs from `Y`, where NULL equals NULL and nothing else: SQL's `IS NOT` (and `IS DISTINCT FROM`). It is
never NULL.

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

- The opposite of [`cmp_is`](./cmp_is): two values that aren't NULL compare as [`cmp_ne`](./cmp_ne) compares them.
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
      {"k": "call", "fn": "cmp_is_not", "args": [
        {"k": "lit", "value": null, "type": "int"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_is_not", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_is_not", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_is_not", "args": [
        {"k": "lit", "value": "a ", "type": "text"},
        {"k": "lit", "value": "a", "type": "text"}
      ], "type": "bool", "collation": "rtrim"},
      {"k": "call", "fn": "cmp_ne", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "bool"}
    ]]
  },
  "columns": [{"name": "both_null"}, {"name": "one_null"}, {"name": "numbers"}, {"name": "rtrim"}, {"name": "cmp_ne"}]
}
```

| both_null | one_null | numbers | rtrim | cmp_ne |
|---|---|---|---|---|
| false | true | true | false | NULL |

## Demo

The fruit whose stock is not zero, plum's unknown stock included (compare [`cmp_ne`](./cmp_ne)'s demo):

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "pred": {"k": "call", "fn": "cmp_is_not", "args": [
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
| plum | NULL |
| cherry | 25 |

## See also

- [`cmp_is`](./cmp_is), [`cmp_ne`](./cmp_ne)
- [Comparison functions](./)
