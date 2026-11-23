---
description: 'Text made of the characters with the given code points.'
---

# char

```ebnf
char ::= '"fn": "char"' ', "args": [' (CODE (',' CODE)*)? ']'
```

Text made of the characters whose Unicode code points are the arguments, in order: `72, 105` gives `Hi`.

## Parameters

| Argument | Type | |
|---|---|---|
| `CODE` | `int` | A code point. Each argument is taken as an integer: a real is truncated, text gives its leading integer (none: 0). |

## Returns

`text`. Never NULL: no arguments give the empty text, and a NULL argument counts as 0 (the character U+0000).

## Errors

None.

## Notes

- A code point below 0 or above `0x10FFFF` gives the replacement character U+FFFD.
- [`unicode`](./unicode) goes the other way: the code point of a text's first character.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text", "int"],
    "rows": [[
      {"k": "call", "fn": "char", "args": [
        {"k": "lit", "value": 72, "type": "int"},
        {"k": "lit", "value": 105, "type": "int"}
      ], "type": "text"},
      {"k": "call", "fn": "char", "args": [{"k": "lit", "value": 128512, "type": "int"}], "type": "text"},
      {"k": "call", "fn": "char", "args": [], "type": "text"},
      {"k": "call", "fn": "char", "args": [{"k": "lit", "value": -1, "type": "int"}], "type": "text"},
      {"k": "call", "fn": "length", "args": [
        {"k": "call", "fn": "char", "args": [
          {"k": "lit", "value": 65, "type": "int"},
          {"k": "lit", "value": null, "type": "int"},
          {"k": "lit", "value": 66, "type": "int"}
        ], "type": "text"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "hi"}, {"name": "emoji"}, {"name": "none"}, {"name": "out_of_range"}, {"name": "with_null"}]
}
```

| hi | emoji | none | out_of_range | with_null |
|---|---|---|---|---|
| Hi | 😀 | `''` | � | 3 |

The last column is 3: the NULL became the character U+0000 between `A` and `B`.

## Demo

A letter for each fruit, from its id:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [0, 1]},
    "exprs": [
      {"k": "call", "fn": "char", "args": [
        {"k": "call", "fn": "add", "args": [
          {"k": "lit", "value": 64, "type": "int"},
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
        ], "type": "int"}
      ], "type": "text"},
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"}
    ]
  },
  "columns": [{"name": "letter"}, {"name": "name"}]
}
```

| letter | name |
|---|---|
| A | apple |
| B | pear |
| C | plum |
| D | cherry |
| E | lime |

## See also

- [`unicode`](./unicode), [`concat`](./concat)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
