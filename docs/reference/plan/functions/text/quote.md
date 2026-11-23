---
description: 'A value as a SQL literal: quoted text, a blob literal, a number or NULL.'
---

# quote

```ebnf
quote ::= '"fn": "quote"' ', "args": [' X ']'
```

`X` written as a SQL literal, as SQLite's `quote` writes it: text in single quotes with each `'` doubled, a blob as
`X'…'` in upper-case hexadecimal, a number as its text, and NULL as the text `NULL`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. |

## Returns

`text`. Never NULL: a NULL argument gives the text `NULL`.

## Errors

None.

## Notes

- A real keeps its `.0`: `1.0` gives `1.0`. An infinite real gives `9.0e+999` (or `-9.0e+999`), a literal that reads
  back as infinity.
- [`printf`](./printf)'s `%Q` quotes text the same way.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "quote", "args": [{"k": "lit", "value": "it's", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "quote", "args": [{"k": "lit", "value": {"$blob": "00ff"}, "type": "blob"}], "type": "text"},
      {"k": "call", "fn": "quote", "args": [{"k": "lit", "value": 5, "type": "int"}], "type": "text"},
      {"k": "call", "fn": "quote", "args": [{"k": "lit", "value": 1, "type": "real"}], "type": "text"},
      {"k": "call", "fn": "quote", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "text"}
    ]]
  },
  "columns": [{"name": "text"}, {"name": "blob"}, {"name": "int"}, {"name": "real"}, {"name": "null"}]
}
```

| text | blob | int | real | null |
|---|---|---|---|---|
| 'it''s' | X'00FF' | 5 | 1.0 | NULL |

## Demo

Rows of the fruit table as SQL values, NULL included:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [0, 1, 4]},
    "exprs": [
      {"k": "call", "fn": "concat", "args": [
        {"k": "lit", "value": "(", "type": "text"},
        {"k": "call", "fn": "quote", "args": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
        ], "type": "text"},
        {"k": "lit", "value": ", ", "type": "text"},
        {"k": "call", "fn": "quote", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"}
        ], "type": "text"},
        {"k": "lit", "value": ", ", "type": "text"},
        {"k": "call", "fn": "quote", "args": [
          {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
        ], "type": "text"},
        {"k": "lit", "value": ")", "type": "text"}
      ], "type": "text"}
    ]
  },
  "columns": [{"name": "row"}]
}
```

| row |
|---|
| (1, 'apple', 10) |
| (2, 'pear', 4) |
| (3, 'plum', NULL) |
| (4, 'cherry', 25) |
| (5, 'lime', 0) |

## See also

- [`printf`](./printf), [`hex`](./hex)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
