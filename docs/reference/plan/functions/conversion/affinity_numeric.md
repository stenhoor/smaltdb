---
description: 'Text that is a number in full as that number; any other value as it is: SQLite''s numeric affinity.'
---

# affinity_numeric

```ebnf
affinity_numeric ::= '"fn": "affinity_numeric"' ', "args": [' X ']'
```

The conversion SQLite applies to a comparison operand of numeric affinity: text that is a number in full becomes that
number, an integer when it is a whole one that fits in 64 bits, else a real. Any other value, other text included, stays
as it is.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. |

## Returns

The argument's value, converted. NULL when `X` is NULL.

## Errors

None.

## Notes

- Unlike [`cast_numeric`](./cast_numeric), text that only starts with a number stays text (`'12abc'`), and blobs stay
  blobs.
- Spaces around the number are allowed (`' 12 '`); hexadecimal is not a number here (`'0x10'` stays text).
- Its value has the argument's type: give the call the type the plan needs, usually `any`.
- An [`affinity`](../../meaning-fields) meaning field on an operand converts nothing by itself: a plan that wants the
  conversion calls this function.
- It can be the `fn` of a [`cast`](../../expressions/cast) expression as well as a [`call`](../../expressions/call):
  `{"k": "cast", "fn": "affinity_numeric", "to": "any", "arg": …}` gives the same value, with the type `to` names.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["any", "any", "any", "any", "any", "any"],
    "rows": [[
      {"k": "call", "fn": "affinity_numeric", "args": [{"k": "lit", "value": "12", "type": "text"}], "type": "any"},
      {"k": "call", "fn": "affinity_numeric", "args": [{"k": "lit", "value": "1e3", "type": "text"}], "type": "any"},
      {"k": "call", "fn": "affinity_numeric", "args": [{"k": "lit", "value": " 12.5 ", "type": "text"}], "type": "any"},
      {"k": "call", "fn": "affinity_numeric", "args": [{"k": "lit", "value": "12abc", "type": "text"}], "type": "any"},
      {"k": "call", "fn": "affinity_numeric", "args": [{"k": "lit", "value": 2.5, "type": "real"}], "type": "any"},
      {"k": "call", "fn": "affinity_numeric", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "any"}
    ]]
  },
  "columns": [{"name": "int"}, {"name": "whole"}, {"name": "real"}, {"name": "text"}, {"name": "number"}, {"name": "null"}]
}
```

| int | whole | real | text | number | null |
|---|---|---|---|---|---|
| 12 | 1000 | 12.5 | 12abc | 2.5 | NULL |

## Demo

Fruit whose stock equals a number given as text: the text is converted first, as SQLite does when it compares it with an
INTEGER column:

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "pred": {"k": "call", "fn": "cmp_eq", "args": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "affinity_numeric", "args": [{"k": "lit", "value": "25", "type": "text"}], "type": "any"}
    ], "type": "bool"}
  },
  "columns": [{"name": "name"}, {"name": "qty"}]
}
```

| name | qty |
|---|---|
| cherry | 25 |

## See also

- [`affinity_text`](./affinity_text), [`cast_numeric`](./cast_numeric), [`cmp_eq`](../comparison/cmp_eq)
- [Conversion functions](./)
