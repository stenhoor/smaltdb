---
description: 'A value as a blob, as SQLite''s CAST(x AS BLOB): the bytes of its text.'
---

# cast_blob

```ebnf
cast_blob ::= '"fn": "cast_blob"' ', "args": [' X ']'
```

A value as a blob, as SQLite's `CAST(x AS BLOB)`: text gives its UTF-8 bytes, and a number the bytes of its text.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. |

## Returns

`blob`. NULL when `X` is NULL.

## Errors

None.

## Notes

- A number is written as [`cast_text`](./cast_text) writes it, then encoded: the real 3.0 gives the bytes of `3.0`.
- A blob stays as it is.
- It can be the `fn` of a [`cast`](../../expressions/cast) expression as well as a [`call`](../../expressions/call):
  `{"k": "cast", "fn": "cast_blob", "to": "blob", "arg": …}` gives the same value, with the type `to` names.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["blob", "blob", "blob", "blob", "blob"],
    "rows": [[
      {"k": "call", "fn": "cast_blob", "args": [{"k": "lit", "value": "hi", "type": "text"}], "type": "blob"},
      {"k": "call", "fn": "cast_blob", "args": [{"k": "lit", "value": 12, "type": "int"}], "type": "blob"},
      {"k": "call", "fn": "cast_blob", "args": [{"k": "lit", "value": 1.5, "type": "real"}], "type": "blob"},
      {"k": "call", "fn": "cast_blob", "args": [{"k": "lit", "value": {"$blob": "00ff"}, "type": "blob"}], "type": "blob"},
      {"k": "call", "fn": "cast_blob", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "blob"}
    ]]
  },
  "columns": [{"name": "text"}, {"name": "int"}, {"name": "real"}, {"name": "blob"}, {"name": "null"}]
}
```

| text | int | real | blob | null |
|---|---|---|---|---|
| x'6869' | x'3132' | x'312e35' | x'00ff' | NULL |

The same conversion as a `cast` expression:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["blob"],
    "rows": [[{"k": "cast", "fn": "cast_blob", "to": "blob", "arg": {"k": "lit", "value": "é", "type": "text"}}]]
  },
  "columns": [{"name": "cast"}]
}
```

| cast |
|---|
| x'c3a9' |

## Demo

The bytes of each green fruit's name:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 2]},
      "pred": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": "green", "type": "text"}
      ], "type": "bool"}
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "cast_blob", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}
      ], "type": "blob"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "bytes"}]
}
```

| name | bytes |
|---|---|
| pear | x'70656172' |
| lime | x'6c696d65' |

## See also

- [`cast_text`](./cast_text)
- [Conversions](../../conversions): which conversion the engine uses from one type to another
- [`cast`](../../expressions/cast): a conversion as an expression
- [Conversion functions](./)
