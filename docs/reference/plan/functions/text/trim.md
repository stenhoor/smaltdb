---
description: 'Text with given characters, by default spaces, removed from both ends.'
---

# trim

```ebnf
trim ::= '"fn": "trim"' ', "args": [' TEXT (',' CHARACTERS)? ']'
```

`TEXT` with the characters in `CHARACTERS` removed from both ends. Without `CHARACTERS`, it removes spaces.

## Parameters

| Argument | Type | |
|---|---|---|
| `TEXT` | `text` | The text. A number is taken as its text. |
| `CHARACTERS` | `text` | Optional: the set of characters to remove, in any order (default a space). Each character counts on its own: `xy` removes every `x` and every `y`. |

## Returns

`text`. NULL when either argument is NULL.

## Errors

None.

## Notes

- The default removes the space U+0020 only, not tabs or line breaks: give them in `CHARACTERS` to remove them.
- Characters are code points, and compare exactly: case and collation don't apply.
- An empty `CHARACTERS` removes nothing.
- [`ltrim`](./ltrim) removes from the start only, [`rtrim`](./rtrim) from the end only.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "trim", "args": [{"k": "lit", "value": "  a b  ", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "trim", "args": [
        {"k": "lit", "value": "xxaxyx", "type": "text"},
        {"k": "lit", "value": "xy", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "trim", "args": [
        {"k": "lit", "value": 100, "type": "real"},
        {"k": "lit", "value": "0.", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "trim", "args": [
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": null, "type": "text"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "spaces"}, {"name": "set"}, {"name": "number"}, {"name": "null"}]
}
```

| spaces | set | number | null |
|---|---|---|---|
| a b | a | 1 | NULL |

## Demo

The fruit names without their `a`, `e` and `p` at either end:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "trim", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": "aep", "type": "text"}
      ], "type": "text"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "trimmed"}]
}
```

| name | trimmed |
|---|---|
| apple | l |
| pear | r |
| plum | lum |
| cherry | cherry |
| lime | lim |

## See also

- [`ltrim`](./ltrim), [`rtrim`](./rtrim)
- [`replace`](./replace), [`regex_replace_all`](./regex_replace_all)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
