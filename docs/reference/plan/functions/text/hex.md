---
description: 'The bytes of a value as upper-case hexadecimal text.'
---

# hex

```ebnf
hex ::= '"fn": "hex"' ', "args": [' X ']'
```

The bytes of `X` as hexadecimal text, two upper-case digits a byte: the bytes of a blob, the UTF-8 bytes of a text, or
of a number's text.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. A number is taken as its text: `12` gives the hex of the characters `1` and `2`, not of the number. |

## Returns

`text`. Not NULL for NULL: a NULL argument gives the empty text.

## Errors

None.

## Notes

- [`quote`](./quote) writes a blob as a literal (`X'00FF'`).
- A real is taken as its text: `1.0` gives `312E30`.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "hex", "args": [{"k": "lit", "value": {"$blob": "00ff"}, "type": "blob"}], "type": "text"},
      {"k": "call", "fn": "hex", "args": [{"k": "lit", "value": "aé", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "hex", "args": [{"k": "lit", "value": 12, "type": "int"}], "type": "text"},
      {"k": "call", "fn": "hex", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "text"}
    ]]
  },
  "columns": [{"name": "blob"}, {"name": "text"}, {"name": "number"}, {"name": "null"}]
}
```

| blob | text | number | null |
|---|---|---|---|
| 00FF | 61C3A9 | 3132 | `''` |

## Demo

The UTF-8 bytes of the green fruit's names:

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
      {"k": "call", "fn": "hex", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}
      ], "type": "text"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "hex"}]
}
```

| name | hex |
|---|---|
| pear | 70656172 |
| lime | 6C696D65 |

## See also

- [`quote`](./quote), [`zeroblob`](./zeroblob), [`unicode`](./unicode)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
