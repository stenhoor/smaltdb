---
description: 'The least of two or more values, or NULL when any is NULL.'
---

# min

```ebnf
min ::= '"fn": "min"' ', "args": [' X ',' X (',' X)* ']'
```

The least of two or more values, or NULL when any is NULL. This is the scalar `min`; the aggregate of one argument,
the smallest value of a group, is [`min` among the aggregates](../aggregate/min).

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The values, two or more. |

## Returns

The arguments' type: declare it on the call (`num` for integers and reals). NULL when any argument is NULL.

## Errors

None.

## Notes

- Values compare in SQLite's order: numbers, then text, then blobs. `min` of `1` and `'a'` is `1`.
- Text compares by the collation the first argument [carries](../../meaning-fields#carries-and-affinity), else
  `binary`. The call's `collation` field doesn't change it.
- Unlike the aggregate, which skips NULLs, one NULL argument makes the result NULL.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "num", "int", "any", "text"],
    "rows": [[
      {"k": "call", "fn": "min", "args": [{"k": "lit", "value": 3, "type": "int"}, {"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": 2, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "min", "args": [{"k": "lit", "value": 3, "type": "int"}, {"k": "lit", "value": 1, "type": "real"}], "type": "num"},
      {"k": "call", "fn": "min", "args": [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": null, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "min", "args": [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": "a", "type": "text"}], "type": "any"},
      {"k": "call", "fn": "min", "args": [{"k": "lit", "value": "a", "type": "text", "carries": {"collation": "nocase", "from": "explicit"}}, {"k": "lit", "value": "B", "type": "text"}], "type": "text"}
    ]]
  },
  "columns": [{"name": "ints"}, {"name": "mixed"}, {"name": "null"}, {"name": "number_text"}, {"name": "nocase"}]
}
```

| ints | mixed | null | number_text | nocase |
|---|---|---|---|---|
| 1 | 1 | NULL | 1 | a |

## Demo

Each fruit's price, capped at 1:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "min", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
        {"k": "lit", "value": 1, "type": "real"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "price"}]
}
```

| name | price |
|---|---|
| apple | 0.5 |
| pear | 0.75 |
| plum | 1 |
| cherry | 1 |
| lime | 0.4 |

## See also

- [`max`](./max), [`min`](../aggregate/min) (the aggregate), [`list_min`](../list/list_min)
- [General functions](./)
