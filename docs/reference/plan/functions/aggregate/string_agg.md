---
description: 'A group''s values as text, joined by a separator.'
---

# string_agg

```ebnf
string_agg ::= '"fn": "string_agg"' ', "args": [' X ',' SEPARATOR ']'
```

The values of `X` in a group, as text, joined by `SEPARATOR`: [`group_concat`](./group_concat) with a separator it
requires (PostgreSQL's name). NULL values are skipped. An aggregate: a call in an
[`aggregate`](../../operations/aggregate)'s `aggs` (or a [`window`](../../operations/window)'s `calls`, over a frame).

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. A number is taken as its text, a real as SQLite writes it (`1.0`). |
| `SEPARATOR` | `text` | The text between two values. Each value after the first is preceded by the separator of its own row; a NULL separator is empty text. |

## Returns

`text`. NULL when the group has no value that is not NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | One argument: `string_agg` takes two. |

## Notes

- The values come in the order of the group's rows, as the aggregate's input gives them: sort the input to choose it.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "values",
      "types": ["text", "real"],
      "rows": [
        [{"k": "lit", "value": "a", "type": "text"}, {"k": "lit", "value": 1, "type": "real"}],
        [{"k": "lit", "value": null, "type": "text"}, {"k": "lit", "value": 2.5, "type": "real"}],
        [{"k": "lit", "value": "b", "type": "text"}, {"k": "lit", "value": null, "type": "real"}],
        [{"k": "lit", "value": "c", "type": "text"}, {"k": "lit", "value": 0.5, "type": "real"}]
      ]
    },
    "keys": [],
    "aggs": [
      {"fn": "string_agg", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": "; ", "type": "text"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "text"},
      {"fn": "string_agg", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": null, "type": "text"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "text"},
      {"fn": "string_agg", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
        {"k": "lit", "value": " ", "type": "text"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "text"}
    ],
    "carry": []
  },
  "columns": [{"name": "separator"}, {"name": "NULL separator"}, {"name": "reals"}]
}
```

| separator | NULL separator | reals |
|---|---|---|
| a; b; c | abc | 1.0 2.5 0.5 |

<!-- docs:error SMALT_PLAN -->
```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "values",
      "types": ["text", "real"],
      "rows": [
        [{"k": "lit", "value": "a", "type": "text"}, {"k": "lit", "value": 1, "type": "real"}],
        [{"k": "lit", "value": null, "type": "text"}, {"k": "lit", "value": 2.5, "type": "real"}],
        [{"k": "lit", "value": "b", "type": "text"}, {"k": "lit", "value": null, "type": "real"}],
        [{"k": "lit", "value": "c", "type": "text"}, {"k": "lit", "value": 0.5, "type": "real"}]
      ]
    },
    "keys": [],
    "aggs": [
      {"fn": "string_agg", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "text"}
    ],
    "carry": []
  },
  "columns": [{"name": "names"}]
}
```

## Demo

The fruit of each colour, by name:

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "sort",
      "input": {
        "op": "scan",
        "table": "fruit",
        "columns": [0, 1, 2, 3, 4]
      },
      "keys": [
        {"expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
      ]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "text", "collation": "binary"}, "collation": "binary"}
    ],
    "aggs": [
      {"fn": "string_agg", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": ", ", "type": "text"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "text"}
    ],
    "carry": [],
    "ordered": "first"
  },
  "columns": [{"name": "color"}, {"name": "fruit"}]
}
```

| color | fruit |
|---|---|
| red | apple, cherry |
| green | lime, pear |
| purple | plum |

## See also

- [`group_concat`](./group_concat), [`implode`](./implode)
- [Aggregate functions](./)
