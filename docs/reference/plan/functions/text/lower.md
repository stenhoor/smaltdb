---
description: 'Text with its ASCII letters in lower case.'
---

# lower

```ebnf
lower ::= '"fn": "lower"' ', "args": [' TEXT ']'
```

Text with its ASCII letters in lower case: `A` to `Z` become `a` to `z`, and every other character stays as it is.

## Parameters

| Argument | Type | |
|---|---|---|
| `TEXT` | `text` | The text. A number is taken as its text. |

## Returns

`text`. NULL when `TEXT` is NULL.

## Errors

None.

## Notes

- Only ASCII letters change: `ÀBC` gives `Àbc`. [`lower_unicode`](./lower_unicode) maps the case of every script.
- The case mapping doesn't depend on a collation.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "lower", "args": [{"k": "lit", "value": "SMALT DB", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "lower", "args": [{"k": "lit", "value": "ÀBC", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "lower", "args": [{"k": "lit", "value": 100000000000000000000, "type": "int"}], "type": "text"},
      {"k": "call", "fn": "lower", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "text"}
    ]]
  },
  "columns": [{"name": "ascii"}, {"name": "other"}, {"name": "number"}, {"name": "null"}]
}
```

| ascii | other | number | null |
|---|---|---|---|
| smalt db | Àbc | 1.0e+20 | NULL |

## Demo

The owners of the baskets, in lower case:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [1]},
    "exprs": [
      {"k": "call", "fn": "lower", "args": [
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

- [`upper`](./upper), [`lower_unicode`](./lower_unicode)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
