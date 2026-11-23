---
description: 'A value as text, as SQLite''s CAST(x AS TEXT); dates, times, lists, structs and maps as their text.'
---

# cast_text

```ebnf
cast_text ::= '"fn": "cast_text"' ', "args": [' X ']'
```

A value as text, as SQLite's `CAST(x AS TEXT)`. Numbers are written as SQLite writes them; dates and times give their
text, and lists, structs and maps their JSON.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. |

## Returns

`text`. NULL when `X` is NULL.

## Errors

None.

## Notes

- A `real` is written as a real: `3.0`, not `3`. It is SQLite's `%!.17g` form, with up to 17 significant digits: `0.1`
  gives `0.1`, and `0.1 + 0.2` gives `0.30000000000000004`; large and small numbers use an exponent
  (`1.0e+20`, `1.0e-07`). Infinities are `Inf` and `-Inf`; NaN is `NaN`.
- How a number is written depends on the argument's type: an integral number under `real` gets `.0`, one under `int` or
  `num` doesn't.
- A blob gives its bytes read as UTF-8.
- A `date`, `datetime` or `time` gives its text (`2026-11-02`, `2026-11-02 00:00:00`); a list, struct or map gives its
  JSON (`["apple","pear"]`). A `bool` gives `1` or `0`.
- It can be the `fn` of a [`cast`](../../expressions/cast) expression as well as a [`call`](../../expressions/call):
  `{"k": "cast", "fn": "cast_text", "to": "text", "arg": …}` gives the same value, with the type `to` names.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "cast_text", "args": [{"k": "lit", "value": 42, "type": "int"}], "type": "text"},
      {"k": "call", "fn": "cast_text", "args": [{"k": "lit", "value": 3, "type": "real"}], "type": "text"},
      {"k": "call", "fn": "cast_text", "args": [{"k": "lit", "value": 100000000000000000000, "type": "real"}], "type": "text"},
      {"k": "call", "fn": "cast_text", "args": [{"k": "lit", "value": {"$blob": "6869"}, "type": "blob"}], "type": "text"},
      {"k": "call", "fn": "cast_text", "args": [{"k": "lit", "value": {"$real": "Infinity"}, "type": "real"}], "type": "text"},
      {"k": "call", "fn": "cast_text", "args": [{"k": "lit", "value": null, "type": "int"}], "type": "text"}
    ]]
  },
  "columns": [{"name": "int"}, {"name": "real"}, {"name": "large"}, {"name": "blob"}, {"name": "infinite"}, {"name": "null"}]
}
```

| int | real | large | blob | infinite | null |
|---|---|---|---|---|---|
| 42 | 3.0 | 1.0e+20 | hi | Inf | NULL |

The same conversion as a `cast` expression:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text"],
    "rows": [[{"k": "cast", "fn": "cast_text", "to": "text", "arg": {"k": "lit", "value": 0.5, "type": "real"}}]]
  },
  "columns": [{"name": "cast"}]
}
```

| cast |
|---|
| 0.5 |

## Demo

The baskets' lists as their JSON text:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "cast_text", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "list<text>", "collation": "binary"}
      ], "type": "text"},
      {"k": "call", "fn": "cast_text", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "list<int>", "collation": "binary"}
      ], "type": "text"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "items"}, {"name": "counts"}]
}
```

| owner | items | counts |
|---|---|---|
| Ada | ["apple","pear"] | [2,1] |
| Alan | ["plum"] | [6] |
| Grace | [] | [] |
| Edsger | NULL | NULL |

## See also

- [`cast_blob`](./cast_blob), [`affinity_text`](./affinity_text)
- [Conversions](../../conversions): which conversion the engine uses from one type to another
- [`cast`](../../expressions/cast): a conversion as an expression
- [Conversion functions](./)
