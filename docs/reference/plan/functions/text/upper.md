---
description: 'Text with its ASCII letters in upper case.'
---

# upper

```ebnf
upper ::= '"fn": "upper"' ', "args": [' TEXT ']'
```

Text with its ASCII letters in upper case: `a` to `z` become `A` to `Z`, and every other character stays as it is.

## Parameters

| Argument | Type | |
|---|---|---|
| `TEXT` | `text` | The text. A number is taken as its text. |

## Returns

`text`. NULL when `TEXT` is NULL.

## Errors

None.

## Notes

- Only ASCII letters change: `straße` gives `STRAßE`. [`upper_unicode`](./upper_unicode) maps the case of every
  script.
- The case mapping doesn't depend on a collation.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "upper", "args": [{"k": "lit", "value": "smalt db", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "upper", "args": [{"k": "lit", "value": "straße", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "upper", "args": [{"k": "lit", "value": 12.5, "type": "real"}], "type": "text"},
      {"k": "call", "fn": "upper", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "text"}
    ]]
  },
  "columns": [{"name": "ascii"}, {"name": "other"}, {"name": "number"}, {"name": "null"}]
}
```

| ascii | other | number | null |
|---|---|---|---|
| SMALT DB | STRAßE | 12.5 | NULL |

## Demo

The names of the red fruit, in upper case:

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
        {"k": "lit", "value": "red", "type": "text"}
      ], "type": "bool"}
    },
    "exprs": [
      {"k": "call", "fn": "upper", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}
      ], "type": "text"}
    ]
  },
  "columns": [{"name": "name"}]
}
```

| name |
|---|
| APPLE |
| CHERRY |

## See also

- [`lower`](./lower), [`upper_unicode`](./upper_unicode)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
