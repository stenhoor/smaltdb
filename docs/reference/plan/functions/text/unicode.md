---
description: 'The code point of a text''s first character.'
---

# unicode

```ebnf
unicode ::= '"fn": "unicode"' ', "args": [' TEXT ']'
```

The Unicode code point of the first character of `TEXT`.

## Parameters

| Argument | Type | |
|---|---|---|
| `TEXT` | `text` | The text. A number is taken as its text: `5` gives 53, the code point of `5`. |

## Returns

`int`. NULL when `TEXT` is NULL or empty.

## Errors

None.

## Notes

- [`char`](./char) goes the other way: text from code points.
- A character outside the Basic Multilingual Plane gives its whole code point (`😀` gives 128512), not half of a
  UTF-16 pair.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "unicode", "args": [{"k": "lit", "value": "Ábc", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "unicode", "args": [{"k": "lit", "value": "😀", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "unicode", "args": [{"k": "lit", "value": 5, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "unicode", "args": [{"k": "lit", "value": "", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "unicode", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "text"}, {"name": "emoji"}, {"name": "number"}, {"name": "empty"}, {"name": "null"}]
}
```

| text | emoji | number | empty | null |
|---|---|---|---|---|
| 193 | 128512 | 53 | NULL | NULL |

## Demo

The code point of each fruit's initial:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "unicode", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "initial"}]
}
```

| name | initial |
|---|---|
| apple | 97 |
| pear | 112 |
| plum | 112 |
| cherry | 99 |
| lime | 108 |

## See also

- [`char`](./char), [`hex`](./hex)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
