---
description: 'Whether a text ends with another.'
---

# ends_with

```ebnf
ends_with ::= '"fn": "ends_with"' ', "args": [' TEXT ',' PART ']'
```

Whether `TEXT` ends with `PART`. Characters compare by code point: the test is case-sensitive, whatever the call's
collation.

## Parameters

| Argument | Type | |
|---|---|---|
| `TEXT` | `text` | The text to test. A number is taken as its text. |
| `PART` | `text` | The text to look for. A number is taken as its text. |

## Returns

`bool`. NULL when either argument is NULL.

## Errors

None.

## Notes

- An empty `PART` gives true.
- When either argument is a blob, both are compared as bytes (text as its UTF-8 bytes).
- To compare without case, apply [`lower`](./lower) or [`lower_unicode`](./lower_unicode) to both sides, or use a
  pattern: [`like`](./like) ignores the case of ASCII letters.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "ends_with", "args": [
        {"k": "lit", "value": "apple", "type": "text"},
        {"k": "lit", "value": "le", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "ends_with", "args": [
        {"k": "lit", "value": "apple", "type": "text"},
        {"k": "lit", "value": "LE", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "ends_with", "args": [
        {"k": "lit", "value": "apple", "type": "text"},
        {"k": "lit", "value": "", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "ends_with", "args": [
        {"k": "lit", "value": 12.5, "type": "real"},
        {"k": "lit", "value": ".5", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "ends_with", "args": [
        {"k": "lit", "value": null, "type": "text"},
        {"k": "lit", "value": "a", "type": "text"}
      ], "type": "bool"}
    ]]
  },
  "columns": [{"name": "plain"}, {"name": "other_case"}, {"name": "empty"}, {"name": "number"}, {"name": "null"}]
}
```

| plain | other_case | empty | number | null |
|---|---|---|---|---|
| true | false | true | true | NULL |

## Demo

The fruit whose names end with `e`:

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "scan", "table": "fruit", "columns": [1]},
    "pred": {"k": "call", "fn": "ends_with", "args": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "lit", "value": "e", "type": "text"}
    ], "type": "bool"}
  },
  "columns": [{"name": "name"}]
}
```

| name |
|---|
| apple |
| lime |

## See also

- [`starts_with`](./starts_with), [`contains`](./contains)
- [`instr`](./instr), [`like`](./like), [`regex_match`](./regex_match)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
