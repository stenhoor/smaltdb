---
description: 'A group''s values as text, joined by a separator: a comma unless another is given.'
---

# group_concat

```ebnf
group_concat ::= '"fn": "group_concat"' ', "args": [' X (',' SEPARATOR)? ']'
```

The values of `X` in a group, as text, joined by `SEPARATOR` (`,` without one), as SQLite's `group_concat`. NULL values
are skipped. An aggregate: a call in an [`aggregate`](../../operations/aggregate)'s `aggs` (or a
[`window`](../../operations/window)'s `calls`, over a frame).

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. A number is taken as its text, a real as SQLite writes it (`1.0`). |
| `SEPARATOR` | `text` | Optional: the text between two values. Each value after the first is preceded by the separator of its own row; a NULL separator is empty text. |

## Returns

`text`. NULL when the group has no value that is not NULL.

## Errors

None.

## Notes

- The values come in the order of the group's rows, as the aggregate's input gives them: sort the input to choose it.
- With `distinct`, each different value once.
- [`string_agg`](./string_agg) is the same with a separator it requires.

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
      {"fn": "group_concat", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "text"},
      {"fn": "group_concat", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": " + ", "type": "text"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "text"},
      {"fn": "group_concat", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "text"}
    ],
    "carry": []
  },
  "columns": [{"name": "text"}, {"name": "separator"}, {"name": "reals"}]
}
```

| text | separator | reals |
|---|---|---|
| a,b,c | a + b + c | 1.0,2.5,0.5 |

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
      {"fn": "group_concat", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": " / ", "type": "text"}
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
| red | apple / cherry |
| green | lime / pear |
| purple | plum |

## See also

- [`string_agg`](./string_agg), [`implode`](./implode), [`list_join`](../list/list_join)
- [Aggregate functions](./)
