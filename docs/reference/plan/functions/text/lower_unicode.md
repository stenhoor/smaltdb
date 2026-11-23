---
description: 'Text in lower case, in every script.'
---

# lower_unicode

```ebnf
lower_unicode ::= '"fn": "lower_unicode"' ', "args": [' TEXT ']'
```

Text in lower case by Unicode's case mapping, in every script: `ÀΣ` gives `àς`. It maps as JavaScript's `toLowerCase`
does, without regard to a language: a final Greek sigma becomes `ς`, another `σ`.

## Parameters

| Argument | Type | |
|---|---|---|
| `TEXT` | `text` | The text. A number is taken as its text. |

## Returns

`text`. NULL when `TEXT` is NULL.

## Errors

None.

## Notes

- [`lower`](./lower) maps ASCII letters only, as SQLite's `lower` does.
- A character may become more than one: `İ` gives `i` followed by a combining dot above, so the length can change.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "lower_unicode", "args": [{"k": "lit", "value": "SMALT DB", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "lower_unicode", "args": [{"k": "lit", "value": "ÀBC", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "lower_unicode", "args": [{"k": "lit", "value": "ΣΑΣ", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "lower_unicode", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "text"}
    ]]
  },
  "columns": [{"name": "ascii"}, {"name": "other"}, {"name": "greek"}, {"name": "null"}]
}
```

| ascii | other | greek | null |
|---|---|---|---|
| smalt db | àbc | σας | NULL |

## Demo

The owners of the baskets, in lower case:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [1]},
    "exprs": [
      {"k": "call", "fn": "lower_unicode", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}
      ], "type": "text"}
    ]
  },
  "columns": [{"name": "owner"}]
}
```

| owner |
|---|
| ada |
| alan |
| grace |
| edsger |

## See also

- [`upper_unicode`](./upper_unicode), [`lower`](./lower)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
