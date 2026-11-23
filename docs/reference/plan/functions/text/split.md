---
description: 'A text cut at each occurrence of a separator, as a list of texts.'
---

# split

```ebnf
split ::= '"fn": "split"' ', "args": [' TEXT ',' SEPARATOR ']'
```

`TEXT` cut at each occurrence of `SEPARATOR`, as a list of the pieces in order. Empty pieces are kept: `a,,b` gives
three. An empty separator cuts the text into its characters (code points).

## Parameters

| Argument | Type | |
|---|---|---|
| `TEXT` | `text` | The text. A number is taken as its text. |
| `SEPARATOR` | `text` | Where to cut. A number is taken as its text. The search is case-sensitive. |

## Returns

`list<text>`. NULL when either argument is NULL. An empty `TEXT` gives a list of one empty text.

## Errors

None.

## Notes

- [`list_join`](../list/list_join) puts the pieces back together.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<text>", "list<text>", "list<text>", "list<text>", "list<text>"],
    "rows": [[
      {"k": "call", "fn": "split", "args": [
        {"k": "lit", "value": "a,b,,c", "type": "text"},
        {"k": "lit", "value": ",", "type": "text"}
      ], "type": "list<text>"},
      {"k": "call", "fn": "split", "args": [
        {"k": "lit", "value": "a😀b", "type": "text"},
        {"k": "lit", "value": "", "type": "text"}
      ], "type": "list<text>"},
      {"k": "call", "fn": "split", "args": [
        {"k": "lit", "value": "", "type": "text"},
        {"k": "lit", "value": ",", "type": "text"}
      ], "type": "list<text>"},
      {"k": "call", "fn": "split", "args": [
        {"k": "lit", "value": 12.5, "type": "real"},
        {"k": "lit", "value": ".", "type": "text"}
      ], "type": "list<text>"},
      {"k": "call", "fn": "split", "args": [
        {"k": "lit", "value": "a,b", "type": "text"},
        {"k": "lit", "value": null, "type": "text"}
      ], "type": "list<text>"}
    ]]
  },
  "columns": [{"name": "pieces"}, {"name": "characters"}, {"name": "empty"}, {"name": "number"}, {"name": "null"}]
}
```

| pieces | characters | empty | number | null |
|---|---|---|---|---|
| ["a","b","","c"] | ["a","😀","b"] | [""] | ["12","5"] | NULL |

## Demo

Each fruit's name cut at each `e`:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "split", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": "e", "type": "text"}
      ], "type": "list<text>"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "pieces"}]
}
```

| name | pieces |
|---|---|
| apple | ["appl",""] |
| pear | ["p","ar"] |
| plum | ["plum"] |
| cherry | ["ch","rry"] |
| lime | ["lim",""] |

## See also

- [`list_join`](../list/list_join), [`instr`](./instr), [`regex_find`](./regex_find)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
