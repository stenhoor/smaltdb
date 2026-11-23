---
description: 'The number of characters in a text, or of bytes in a blob.'
---

# length

```ebnf
length ::= '"fn": "length"' ', "args": [' X ']'
```

The number of characters (Unicode code points) in a text, or of bytes in a blob. A number gives the length of its
text.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. A number is taken as its text: the real `12.5` has 4 characters, `100.0` 5. |

## Returns

`int`. NULL when `X` is NULL.

## Errors

None.

## Notes

- It counts code points, not UTF-16 units or bytes: `😀` is 1. [`octet_length`](./octet_length) counts UTF-8 bytes.
- Every code point counts, U+0000 too.
- [`list_len`](../list/list_len) counts the items of a list.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "length", "args": [{"k": "lit", "value": "héllo", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "length", "args": [{"k": "lit", "value": "😀", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "length", "args": [{"k": "lit", "value": {"$blob": "010203"}, "type": "blob"}], "type": "int"},
      {"k": "call", "fn": "length", "args": [{"k": "lit", "value": 12.5, "type": "real"}], "type": "int"},
      {"k": "call", "fn": "length", "args": [{"k": "lit", "value": "", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "length", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "text"}, {"name": "emoji"}, {"name": "blob"}, {"name": "number"}, {"name": "empty"}, {"name": "null"}]
}
```

| text | emoji | blob | number | empty | null |
|---|---|---|---|---|---|
| 5 | 1 | 3 | 4 | 0 | NULL |

## Demo

The fruit, shortest name first:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "project",
      "input": {"op": "scan", "table": "fruit", "columns": [1]},
      "exprs": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "call", "fn": "length", "args": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}
        ], "type": "int"}
      ]
    },
    "keys": [
      {
        "expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        "desc": false,
        "nullsFirst": true,
        "collation": "binary"
      },
      {
        "expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        "desc": false,
        "nullsFirst": true,
        "collation": "binary"
      }
    ]
  },
  "columns": [{"name": "name"}, {"name": "length"}]
}
```

| name | length |
|---|---|
| lime | 4 |
| pear | 4 |
| plum | 4 |
| apple | 5 |
| cherry | 6 |

## See also

- [`octet_length`](./octet_length), [`substr`](./substr), [`list_len`](../list/list_len)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
