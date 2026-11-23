---
description: 'Where a text first occurs in another, counting characters from 1.'
---

# instr

```ebnf
instr ::= '"fn": "instr"' ', "args": [' TEXT ',' PART ']'
```

The position of the first occurrence of `PART` in `TEXT`, counting characters (code points) from 1, or 0 when it
doesn't occur. The search is case-sensitive, whatever the call's collation.

## Parameters

| Argument | Type | |
|---|---|---|
| `TEXT` | `text` | The text to search. A number is taken as its text. |
| `PART` | `text` | The text to find. A number is taken as its text. |

## Returns

`int`. NULL when either argument is NULL.

## Errors

None.

## Notes

- An empty `PART` gives 1.
- When either argument is a blob, both are searched as bytes (text as its UTF-8 bytes) and the position counts bytes.
- [`contains`](./contains) gives only whether it occurs.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "instr", "args": [
        {"k": "lit", "value": "héllo", "type": "text"},
        {"k": "lit", "value": "l", "type": "text"}
      ], "type": "int"},
      {"k": "call", "fn": "instr", "args": [
        {"k": "lit", "value": "héllo", "type": "text"},
        {"k": "lit", "value": "L", "type": "text"}
      ], "type": "int"},
      {"k": "call", "fn": "instr", "args": [
        {"k": "lit", "value": "abc", "type": "text"},
        {"k": "lit", "value": "", "type": "text"}
      ], "type": "int"},
      {"k": "call", "fn": "instr", "args": [
        {"k": "lit", "value": {"$blob": "0102030405"}, "type": "blob"},
        {"k": "lit", "value": {"$blob": "0304"}, "type": "blob"}
      ], "type": "int"},
      {"k": "call", "fn": "instr", "args": [
        {"k": "lit", "value": 12.5, "type": "real"},
        {"k": "lit", "value": ".", "type": "text"}
      ], "type": "int"},
      {"k": "call", "fn": "instr", "args": [
        {"k": "lit", "value": null, "type": "text"},
        {"k": "lit", "value": "a", "type": "text"}
      ], "type": "int"}
    ]]
  },
  "columns": [
    {"name": "found"},
    {"name": "other_case"},
    {"name": "empty"},
    {"name": "blob"},
    {"name": "number"},
    {"name": "null"}
  ]
}
```

| found | other_case | empty | blob | number | null |
|---|---|---|---|---|---|
| 3 | 0 | 1 | 3 | 3 | NULL |

## Demo

Where the first `e` is in each fruit's name:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "instr", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": "e", "type": "text"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "e_at"}]
}
```

| name | e_at |
|---|---|
| apple | 5 |
| pear | 2 |
| plum | 0 |
| cherry | 3 |
| lime | 4 |

## See also

- [`contains`](./contains), [`substr`](./substr), [`regex_find`](./regex_find)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
