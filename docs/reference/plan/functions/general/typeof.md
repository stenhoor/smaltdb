---
description: 'SQLite''s storage class of a value: integer, real, text, blob or null.'
---

# typeof

```ebnf
typeof ::= '"fn": "typeof"' ', "args": [' X ']'
```

SQLite's storage class of a value, as text: `integer`, `real`, `text`, `blob` or `null`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. |

## Returns

`text`. Never NULL: a NULL value gives `null`.

## Errors

None.

## Notes

- A number is `real` when `X` is typed `real`, or isn't a whole number; else `integer`. A `real` that is a whole
  number (`3.0`) gives `real`.
- The plan's own types answer as they are held: a `bool`, `date`, `datetime`, `time` or `duration` gives `integer`,
  a list, struct or map `blob`, as does a typed value under `any`. [`any_type`](../any/any_type) names a value's
  type under `any` (`bool`, `list<int>`).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "typeof", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "text"},
      {"k": "call", "fn": "typeof", "args": [{"k": "lit", "value": 3, "type": "real"}], "type": "text"},
      {"k": "call", "fn": "typeof", "args": [{"k": "lit", "value": "a", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "typeof", "args": [{"k": "lit", "value": {"$blob": "00"}, "type": "blob"}], "type": "text"},
      {"k": "call", "fn": "typeof", "args": [{"k": "lit", "value": null, "type": "int"}], "type": "text"},
      {"k": "call", "fn": "typeof", "args": [{"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "list<int>"}], "type": "text"}
    ]]
  },
  "columns": [{"name": "int"}, {"name": "real"}, {"name": "text"}, {"name": "blob"}, {"name": "null"}, {"name": "list"}]
}
```

| int | real | text | blob | null | list |
|---|---|---|---|---|---|
| integer | real | text | blob | null | blob |

## Demo

The storage class of each order's columns: the day is a `date`, held as a number of days:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "limit", "input": {"op": "scan", "table": "orders", "columns": [0, 3]}, "count": {"k": "lit", "value": 1, "type": "int"}},
    "exprs": [
      {"k": "call", "fn": "typeof", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}], "type": "text"},
      {"k": "call", "fn": "typeof", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"}], "type": "text"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "day"}]
}
```

| id | day |
|---|---|
| integer | integer |

## See also

- [`any_type`](../any/any_type): the type of a value under `any`
- [General functions](./)
