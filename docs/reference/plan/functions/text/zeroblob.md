---
description: 'A blob of a given number of zero bytes.'
---

# zeroblob

```ebnf
zeroblob ::= '"fn": "zeroblob"' ', "args": [' N ']'
```

A blob of `N` bytes, each 0.

## Parameters

| Argument | Type | |
|---|---|---|
| `N` | `int` | How many bytes. Taken as an integer: a real is truncated, text gives its leading integer. |

## Returns

`blob`. Never NULL: a NULL or negative `N` gives an empty blob.

## Errors

None.

## Notes

- [`randomblob`](../general/randomblob) gives random bytes.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["blob", "blob", "blob", "blob", "blob"],
    "rows": [[
      {"k": "call", "fn": "zeroblob", "args": [{"k": "lit", "value": 3, "type": "int"}], "type": "blob"},
      {"k": "call", "fn": "zeroblob", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "blob"},
      {"k": "call", "fn": "zeroblob", "args": [{"k": "lit", "value": 2.9, "type": "real"}], "type": "blob"},
      {"k": "call", "fn": "zeroblob", "args": [{"k": "lit", "value": -1, "type": "int"}], "type": "blob"},
      {"k": "call", "fn": "zeroblob", "args": [{"k": "lit", "value": null, "type": "int"}], "type": "blob"}
    ]]
  },
  "columns": [{"name": "three"}, {"name": "zero"}, {"name": "real"}, {"name": "negative"}, {"name": "null"}]
}
```

| three | zero | real | negative | null |
|---|---|---|---|---|
| x'000000' | x'' | x'0000' | x'' | x'' |

## Demo

A blob as long as each fruit's id, and its length:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "project",
      "input": {"op": "scan", "table": "fruit", "columns": [0]},
      "exprs": [
        {"k": "call", "fn": "zeroblob", "args": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
        ], "type": "blob"}
      ]
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "blob", "collation": "binary"},
      {"k": "call", "fn": "length", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "blob", "collation": "binary"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "bytes"}, {"name": "length"}]
}
```

| bytes | length |
|---|---|
| x'00' | 1 |
| x'0000' | 2 |
| x'000000' | 3 |
| x'00000000' | 4 |
| x'0000000000' | 5 |

## See also

- [`hex`](./hex), [`substr`](./substr), [`randomblob`](../general/randomblob)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
