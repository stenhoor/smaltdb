---
description: 'A number in [0, 1) fixed by a seed and an index: the same arguments always give the same value.'
---

# random_at

```ebnf
random_at ::= '"fn": "random_at"' ', "args": [' SEED ',' INDEX ']'
```

A number in [0, 1) fixed by a seed and an index: the same arguments always give the same value, and different ones
values that look random. A plan that must give the same random choice each time it runs, as
[`sample`](../../operations/sample) does, ranks rows by it.

## Parameters

| Argument | Type | |
|---|---|---|
| `SEED` | `int` | The seed: one sequence of values for each. |
| `INDEX` | `int` | The position in the sequence (a row's id, its position). |

## Returns

`real`, from 0 up to but not including 1, with 53 random bits. NULL when `SEED` or `INDEX` is NULL.

## Errors

None.

## Notes

- The value depends on the arguments alone, not on the run or the platform, so the values below are exact.
- `SEED` and `INDEX` are read as integers: a fractional part is dropped.
- [`random`](./random) gives a new value each time instead.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "random_at", "args": [{"k": "lit", "value": 7, "type": "int"}, {"k": "lit", "value": 1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "random_at", "args": [{"k": "lit", "value": 7, "type": "int"}, {"k": "lit", "value": 2, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "random_at", "args": [{"k": "lit", "value": 8, "type": "int"}, {"k": "lit", "value": 1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "random_at", "args": [{"k": "lit", "value": null, "type": "int"}, {"k": "lit", "value": 1, "type": "int"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "seed7_1"}, {"name": "seed7_2"}, {"name": "seed8_1"}, {"name": "null"}]
}
```

| seed7_1 | seed7_2 | seed8_1 | null |
|---|---|---|---|
| 0.6353201374093331 | 0.5300472096725888 | 0.8117029228324575 | NULL |

## Demo

The fruit shuffled by seed 7: the same order every time the plan runs:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {"op": "scan", "table": "fruit", "columns": [0, 1]},
    "keys": [{"expr": {"k": "call", "fn": "random_at", "args": [
      {"k": "lit", "value": 7, "type": "int"},
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
    ], "type": "real"}, "desc": false, "nullsFirst": false, "collation": "binary"}]
  },
  "columns": [{"name": "id"}, {"name": "name"}]
}
```

| id | name |
|---|---|
| 4 | cherry |
| 2 | pear |
| 1 | apple |
| 5 | lime |
| 3 | plum |

## See also

- [`random`](./random), [`randomblob`](./randomblob)
- [`sample`](../../operations/sample)
- [General functions](./)
