---
description: 'A number as its text; any other value as it is: SQLite''s text affinity.'
---

# affinity_text

```ebnf
affinity_text ::= '"fn": "affinity_text"' ', "args": [' X ']'
```

The conversion SQLite applies to a comparison operand of text affinity: a number becomes its text, written as
[`cast_text`](./cast_text) writes it. Any other value stays as it is.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. |

## Returns

The argument's value, converted. NULL when `X` is NULL.

## Errors

None.

## Notes

- A `real` is written as a real: 3.0 gives `3.0`.
- Blobs stay blobs, unlike [`cast_text`](./cast_text).
- Its value has the argument's type: give the call the type the plan needs, usually `any`.
- An [`affinity`](../../meaning-fields) meaning field on an operand converts nothing by itself: a plan that wants the
  conversion calls this function.
- It can be the `fn` of a [`cast`](../../expressions/cast) expression as well as a [`call`](../../expressions/call):
  `{"k": "cast", "fn": "affinity_text", "to": "any", "arg": …}` gives the same value, with the type `to` names.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["any", "any", "any", "any", "any"],
    "rows": [[
      {"k": "call", "fn": "affinity_text", "args": [{"k": "lit", "value": 12, "type": "int"}], "type": "any"},
      {"k": "call", "fn": "affinity_text", "args": [{"k": "lit", "value": 3, "type": "real"}], "type": "any"},
      {"k": "call", "fn": "affinity_text", "args": [{"k": "lit", "value": "x", "type": "text"}], "type": "any"},
      {"k": "call", "fn": "affinity_text", "args": [{"k": "lit", "value": {"$blob": "3132"}, "type": "blob"}], "type": "any"},
      {"k": "call", "fn": "affinity_text", "args": [{"k": "lit", "value": null, "type": "int"}], "type": "any"}
    ]]
  },
  "columns": [{"name": "int"}, {"name": "real"}, {"name": "text"}, {"name": "blob"}, {"name": "null"}]
}
```

| int | real | text | blob | null |
|---|---|---|---|---|
| 12 | 3.0 | x | x'3132' | NULL |

## Demo

Fruit whose stock, as text, is `'10'`:

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "pred": {"k": "call", "fn": "cmp_eq", "args": [
      {"k": "call", "fn": "affinity_text", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
      ], "type": "any"},
      {"k": "lit", "value": "10", "type": "text"}
    ], "type": "bool"}
  },
  "columns": [{"name": "name"}, {"name": "qty"}]
}
```

| name | qty |
|---|---|
| apple | 10 |

## See also

- [`affinity_numeric`](./affinity_numeric), [`cast_text`](./cast_text)
- [Conversion functions](./)
