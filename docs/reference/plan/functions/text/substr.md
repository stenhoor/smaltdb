---
description: 'Part of a text, by character positions, or of a blob, by byte positions.'
---

# substr, substring

```ebnf
substr ::= '"fn": "substr"' ', "args": [' TEXT ',' START (',' LENGTH)? ']'
substring ::= '"fn": "substring"' ', "args": [' TEXT ',' START (',' LENGTH)? ']'
```

The part of `TEXT` that starts at character `START` and is `LENGTH` characters long, or runs to the end without
`LENGTH`. Positions count characters (code points) from 1. Of a blob, it gives the bytes, counting bytes. `substr` and
`substring` are two names for one function, SQLite's `substr`.

## Parameters

| Argument | Type | |
|---|---|---|
| `TEXT` | `text` or `blob` | The text or blob. A number is taken as its text. |
| `START` | `int` | Where the part starts: 1 is the first character, a negative number counts from the end (-1 is the last character). Taken as an integer: a real is truncated. |
| `LENGTH` | `int` | Optional: how many characters. A negative length takes that many characters before `START` instead. Taken as an integer. |

## Returns

`text`, or `blob` when `TEXT` is a blob (the call's `type` is then `blob`). NULL when any argument is NULL. A part
outside the text is the empty text.

## Errors

None.

## Notes

- Characters are code points, so an emoji counts as one, and a part never splits one. [`length`](./length) counts the
  same way.
- A `START` of 0 starts the part before the first character, so `0, 2` gives one character.
- Positions count characters whatever the call's collation.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "substr", "args": [
        {"k": "lit", "value": "héllo😀wörld", "type": "text"},
        {"k": "lit", "value": 2, "type": "int"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "text"},
      {"k": "call", "fn": "substr", "args": [
        {"k": "lit", "value": "héllo😀wörld", "type": "text"},
        {"k": "lit", "value": 6, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "text"},
      {"k": "call", "fn": "substr", "args": [
        {"k": "lit", "value": "héllo😀wörld", "type": "text"},
        {"k": "lit", "value": -5, "type": "int"}
      ], "type": "text"},
      {"k": "call", "fn": "substr", "args": [
        {"k": "lit", "value": "hello", "type": "text"},
        {"k": "lit", "value": 3, "type": "int"},
        {"k": "lit", "value": -2, "type": "int"}
      ], "type": "text"},
      {"k": "call", "fn": "substr", "args": [
        {"k": "lit", "value": "hello", "type": "text"},
        {"k": "lit", "value": 0, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "text"},
      {"k": "call", "fn": "substr", "args": [
        {"k": "lit", "value": 12.5, "type": "real"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "text"},
      {"k": "call", "fn": "substr", "args": [
        {"k": "lit", "value": null, "type": "text"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "text"}
    ]]
  },
  "columns": [
    {"name": "from_2"},
    {"name": "emoji"},
    {"name": "from_end"},
    {"name": "before"},
    {"name": "from_0"},
    {"name": "number"},
    {"name": "null"}
  ]
}
```

| from_2 | emoji | from_end | before | from_0 | number | null |
|---|---|---|---|---|---|---|
| éll | 😀 | wörld | he | h | 2.5 | NULL |

A blob gives bytes, and the call's type is `blob`; `substring` is the same function:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["blob", "text"],
    "rows": [[
      {"k": "call", "fn": "substring", "args": [
        {"k": "lit", "value": {"$blob": "0102030405"}, "type": "blob"},
        {"k": "lit", "value": 2, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "blob"},
      {"k": "call", "fn": "substring", "args": [
        {"k": "lit", "value": "hello", "type": "text"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "bytes"}, {"name": "text"}]
}
```

| bytes | text |
|---|---|
| x'0203' | ello |

## Demo

The first three letters of each fruit:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "substr", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "text"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "short"}]
}
```

| name | short |
|---|---|
| apple | app |
| pear | pea |
| plum | plu |
| cherry | che |
| lime | lim |

## See also

- [`length`](./length), [`instr`](./instr), [`ltrim`](./ltrim), [`regex_find`](./regex_find)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
