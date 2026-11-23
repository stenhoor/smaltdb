---
description: 'A random 64-bit integer, a new one each time it is evaluated.'
---

# random

```ebnf
random ::= '"fn": "random"' ', "args": []'
```

A random 64-bit integer, from −2^63 to 2^63 − 1, a new one each time it is evaluated.

## Parameters

None.

## Returns

`int`. Never NULL.

## Errors

None.

## Notes

- It is evaluated for each row: rows of one statement get different values.
- The bits come from the runtime's `crypto.getRandomValues`. A value that the plan must be able to give again comes
  from [`random_at`](./random_at), fixed by a seed.
- Its value is different every time, so the examples below show what doesn't change: its type, and that the rows'
  values differ.

## Examples

Its storage class, and whether it is in the 64-bit range:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "bool"],
    "rows": [[
      {"k": "call", "fn": "typeof", "args": [{"k": "call", "fn": "random", "args": [], "type": "int"}], "type": "text"},
      {"k": "call", "fn": "cmp_ge", "args": [
        {"k": "call", "fn": "random", "args": [], "type": "int"},
        {"k": "lit", "value": {"$bigint": "-9223372036854775808"}, "type": "int"}
      ], "type": "bool"}
    ]]
  },
  "columns": [{"name": "type"}, {"name": "in_range"}]
}
```

| type | in_range |
|---|---|
| integer | true |

## Demo

A random number for each fruit, counted: five rows, five different values:

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "project",
      "input": {"op": "scan", "table": "fruit", "columns": [0]},
      "exprs": [{"k": "call", "fn": "random", "args": [], "type": "int"}]
    },
    "keys": [],
    "aggs": [{"fn": "count", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": true, "collation": "binary", "type": "int"}],
    "carry": []
  },
  "columns": [{"name": "distinct_values"}]
}
```

| distinct_values |
|---|
| 5 |

## See also

- [`random_at`](./random_at), [`randomblob`](./randomblob)
- [`sample`](../../operations/sample): a random sample of rows
- [General functions](./)
