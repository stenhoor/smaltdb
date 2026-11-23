---
description: 'The number of bytes in a value: a text''s UTF-8 bytes, or a blob''s.'
---

# octet_length

```ebnf
octet_length ::= '"fn": "octet_length"' ', "args": [' X ']'
```

The number of bytes in `X`: the UTF-8 bytes of a text, or the bytes of a blob. A number gives the bytes of its text.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. A number is taken as its text. |

## Returns

`int`. NULL when `X` is NULL.

## Errors

None.

## Notes

- [`length`](./length) counts characters: for text of ASCII characters only, the two are equal.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "octet_length", "args": [{"k": "lit", "value": "héllo", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "octet_length", "args": [{"k": "lit", "value": "😀", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "octet_length", "args": [{"k": "lit", "value": {"$blob": "010203"}, "type": "blob"}], "type": "int"},
      {"k": "call", "fn": "octet_length", "args": [{"k": "lit", "value": 12.5, "type": "real"}], "type": "int"},
      {"k": "call", "fn": "octet_length", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "text"}, {"name": "emoji"}, {"name": "blob"}, {"name": "number"}, {"name": "null"}]
}
```

| text | emoji | blob | number | null |
|---|---|---|---|---|
| 6 | 4 | 3 | 4 | NULL |

## Demo

A price label for each fruit, in characters and in bytes: the euro sign is one character and three bytes.

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "project",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
      "exprs": [
        {"k": "call", "fn": "printf", "args": [
          {"k": "lit", "value": "%s €%.2f", "type": "text"},
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}
        ], "type": "text"}
      ]
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "length", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}
      ], "type": "int"},
      {"k": "call", "fn": "octet_length", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "label"}, {"name": "length"}, {"name": "octet_length"}]
}
```

| label | length | octet_length |
|---|---|---|
| apple €0.50 | 11 | 13 |
| pear €0.75 | 10 | 12 |
| plum €1.25 | 10 | 12 |
| cherry €3.00 | 12 | 14 |
| lime €0.40 | 10 | 12 |

## See also

- [`length`](./length), [`hex`](./hex)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
