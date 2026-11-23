---
description: 'The bitwise complement of a 64-bit integer.'
---

# bit_not

```ebnf
bit_not ::= '"fn": "bit_not"' ', "args": [' X ']'
```

`X` with every bit flipped: SQL's `~`. For any integer it is `-X - 1`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | int | An integer; other values convert as [`cast_integer`](../conversion/cast_integer) converts them. |

## Returns

`int`. NULL when `X` is NULL.

## Errors

None.

## Notes

- Operands are 64-bit two's-complement integers. A real is truncated, text takes the integer it begins with (`'abc'` is
  0), and a value beyond the 64-bit range saturates, as `cast_integer` does.
- NaN converts to 0.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "bit_not", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "bit_not", "args": [{"k": "lit", "value": 5, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "bit_not", "args": [
        {"k": "lit", "value": {"$bigint": "9223372036854775807"}, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "bit_not", "args": [{"k": "lit", "value": 5.7, "type": "real"}], "type": "int"},
      {"k": "call", "fn": "bit_not", "args": [{"k": "lit", "value": null, "type": "int"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "zero"}, {"name": "five"}, {"name": "largest"}, {"name": "real"}, {"name": "null"}]
}
```

| zero | five | largest | real | null |
|---|---|---|---|---|
| -1 | -6 | -9223372036854775808 | -6 | NULL |

## Demo

The complement of each fruit's id:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [0, 1]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "bit_not", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "complement"}]
}
```

| name | complement |
|---|---|
| apple | -2 |
| pear | -3 |
| plum | -4 |
| cherry | -5 |
| lime | -6 |

## See also

- [`bit_and`](./bit_and), [`bit_or`](./bit_or), [`neg`](./neg)
- [Arithmetic functions](./)
