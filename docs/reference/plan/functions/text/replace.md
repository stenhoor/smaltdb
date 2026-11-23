---
description: 'Text with every occurrence of one text replaced by another.'
---

# replace

```ebnf
replace ::= '"fn": "replace"' ', "args": [' TEXT ',' FIND ',' REPLACEMENT ']'
```

`TEXT` with every occurrence of `FIND` replaced by `REPLACEMENT`, from left to right. The search is case-sensitive,
whatever the call's collation.

## Parameters

| Argument | Type | |
|---|---|---|
| `TEXT` | `text` | The text. A number is taken as its text. |
| `FIND` | `text` | The text to replace. A number is taken as its text. |
| `REPLACEMENT` | `text` | What goes in its place. A number is taken as its text. |

## Returns

`text`. NULL when any argument is NULL.

## Errors

None.

## Notes

- An empty `FIND` leaves `TEXT` as it is.
- [`regex_replace_all`](./regex_replace_all) replaces matches of a pattern, and can ignore case.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "replace", "args": [
        {"k": "lit", "value": "banana", "type": "text"},
        {"k": "lit", "value": "an", "type": "text"},
        {"k": "lit", "value": "AN", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "replace", "args": [
        {"k": "lit", "value": "Banana", "type": "text"},
        {"k": "lit", "value": "b", "type": "text"},
        {"k": "lit", "value": "x", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "replace", "args": [
        {"k": "lit", "value": "banana", "type": "text"},
        {"k": "lit", "value": "", "type": "text"},
        {"k": "lit", "value": "x", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "replace", "args": [
        {"k": "lit", "value": 1.5, "type": "real"},
        {"k": "lit", "value": ".", "type": "text"},
        {"k": "lit", "value": ",", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "replace", "args": [
        {"k": "lit", "value": "banana", "type": "text"},
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": null, "type": "text"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "every"}, {"name": "other_case"}, {"name": "empty"}, {"name": "number"}, {"name": "null"}]
}
```

| every | other_case | empty | number | null |
|---|---|---|---|---|
| bANANa | Banana | banana | 1,5 | NULL |

## Demo

Prices with a decimal comma:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "replace", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
        {"k": "lit", "value": ".", "type": "text"},
        {"k": "lit", "value": ",", "type": "text"}
      ], "type": "text"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "price"}]
}
```

| name | price |
|---|---|
| apple | 0,5 |
| pear | 0,75 |
| plum | 1,25 |
| cherry | 3,0 |
| lime | 0,4 |

## See also

- [`regex_replace_all`](./regex_replace_all), [`trim`](./trim), [`substr`](./substr)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
