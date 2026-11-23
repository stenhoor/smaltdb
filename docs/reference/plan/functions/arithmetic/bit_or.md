---
description: 'The bitwise OR of two 64-bit integers.'
---

# bit_or

```ebnf
bit_or ::= '"fn": "bit_or"' ', "args": [' X ',' Y ']'
```

The bits set in `X` or `Y` or both: SQL's `|`.

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
      {"k": "call", "fn": "bit_or", "args": [
        {"k": "lit", "value": 12, "type": "int"},
        {"k": "lit", "value": 10, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "bit_or", "args": [
        {"k": "lit", "value": -256, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "bit_or", "args": [
        {"k": "lit", "value": 1e+30, "type": "real"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "bit_or", "args": [
        {"k": "lit", "value": "abc", "type": "text"},
        {"k": "lit", "value": 5, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "bit_or", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "ints"}, {"name": "negative"}, {"name": "saturated"}, {"name": "text"}, {"name": "null"}]
}
```

| ints | negative | saturated | text | null |
|---|---|---|---|---|
| 14 | -255 | 9223372036854775807 | 5 | NULL |

## Demo

Each fruit's stock rounded up to an odd number:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "bit_or", "args": [
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
| apple | 10 | 11 |
| pear | 4 | 5 |
| plum | NULL | NULL |
| cherry | 25 | 25 |
| lime | 0 | 1 |

## See also

- [`bit_and`](./bit_and), [`bit_not`](./bit_not)
- [Arithmetic functions](./)
