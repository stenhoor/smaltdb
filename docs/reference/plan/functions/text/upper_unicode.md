---
description: 'Text in upper case, in every script.'
---

# upper_unicode

```ebnf
upper_unicode ::= '"fn": "upper_unicode"' ', "args": [' TEXT ']'
```

Text in upper case by Unicode's case mapping, in every script: `straße` gives `STRASSE`. It maps as JavaScript's
`toUpperCase` does, without regard to a language.

## Parameters

| Argument | Type | |
|---|---|---|
| `TEXT` | `text` | The text. A number is taken as its text. |

## Returns

`text`. NULL when `TEXT` is NULL.

## Errors

None.

## Notes

- [`upper`](./upper) maps ASCII letters only, as SQLite's `upper` does.
- A character may become more than one (`ß` becomes `SS`), so the length can change.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "upper_unicode", "args": [{"k": "lit", "value": "smalt db", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "upper_unicode", "args": [{"k": "lit", "value": "straße", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "upper_unicode", "args": [{"k": "lit", "value": "àς", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "upper_unicode", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "text"}
    ]]
  },
  "columns": [{"name": "ascii"}, {"name": "other"}, {"name": "greek"}, {"name": "null"}]
}
```

| ascii | other | greek | null |
|---|---|---|---|
| SMALT DB | STRASSE | ÀΣ | NULL |

## Demo

The names of the green fruit, in upper case:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 2]},
      "pred": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": "green", "type": "text"}
      ], "type": "bool"}
    },
    "exprs": [
      {"k": "call", "fn": "upper_unicode", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}
      ], "type": "text"}
    ]
  },
  "columns": [{"name": "name"}]
}
```

| name |
|---|
| PEAR |
| LIME |

## See also

- [`lower_unicode`](./lower_unicode), [`upper`](./upper)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
