---
description: 'The bitwise AND of two 64-bit integers.'
---

# bit_and

```ebnf
bit_and ::= '"fn": "bit_and"' ', "args": [' X ',' Y ']'
```

The bits set in both `X` and `Y`: SQL's `&`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | int | An integer; other values convert as [`cast_integer`](../conversion/cast_integer) converts them. |
| `Y` | int | The same. |

## Returns

`int`. NULL when `X` or `Y` is NULL.

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
      {"k": "call", "fn": "bit_and", "args": [
        {"k": "lit", "value": 12, "type": "int"},
        {"k": "lit", "value": 10, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "bit_and", "args": [
        {"k": "lit", "value": -1, "type": "int"},
        {"k": "lit", "value": 255, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "bit_and", "args": [
        {"k": "lit", "value": 12.9, "type": "real"},
        {"k": "lit", "value": 10, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "bit_and", "args": [
        {"k": "lit", "value": "12", "type": "text"},
        {"k": "lit", "value": 10, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "bit_and", "args": [
        {"k": "lit", "value": null, "type": "int"},
        {"k": "lit", "value": 10, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "ints"}, {"name": "negative"}, {"name": "real"}, {"name": "text"}, {"name": "null"}]
}
```

| ints | negative | real | text | null |
|---|---|---|---|---|
| 8 | 255 | 8 | 8 | NULL |

## Demo

Whether each fruit's stock is odd (1) or even (0):

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "bit_and", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "qty"}, {"name": "odd"}]
}
```

| name | qty | odd |
|---|---|---|
| apple | 10 | 0 |
| pear | 4 | 0 |
| plum | NULL | NULL |
| cherry | 25 | 1 |
| lime | 0 | 0 |

## See also

- [`bit_or`](./bit_or), [`bit_not`](./bit_not)
- [Arithmetic functions](./)
