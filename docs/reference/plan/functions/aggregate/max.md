---
description: 'The greatest of a group''s values that are not NULL.'
---

# max

```ebnf
max ::= '"fn": "max"' ', "args": [' X ']'
```

The greatest value of `X` in a group, in SQLite's order of values. NULL values are skipped. An aggregate: a call in an
[`aggregate`](../../operations/aggregate)'s `aggs` (or a [`window`](../../operations/window)'s `calls`, over a frame).
The scalar `max` of several arguments is a [general function](../general/max).

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. |

## Returns

The type of `X`. NULL when the group has no value that is not NULL.

## Errors

None.

## Notes

- Values order as SQLite orders them: numbers (an `int` and a `real` by value), then text, then blobs. NaN comes after
  every number ([ADR 0018](../../../../adr/0018-bool-and-nan.md)).
- Text compares by the collation `X` carries ([meaning fields](../../meaning-fields)), `binary` when it carries none. Of
  values equal by that collation, the first is kept.
- `distinct` doesn't change the result.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "values",
      "types": ["text"],
      "rows": [
        [{"k": "lit", "value": "banana", "type": "text"}],
        [{"k": "lit", "value": "Cherry", "type": "text"}],
        [{"k": "lit", "value": null, "type": "text"}],
        [{"k": "lit", "value": "apple", "type": "text"}]
      ]
    },
    "keys": [],
    "aggs": [
      {"fn": "max", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "text"},
      {"fn": "max", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary", "carries": {"collation": "nocase", "from": "explicit"}}
      ], "star": false, "distinct": false, "collation": "binary", "type": "text"}
    ],
    "carry": []
  },
  "columns": [{"name": "binary"}, {"name": "nocase"}]
}
```

| binary | nocase |
|---|---|
| banana | Cherry |

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "values",
      "types": ["real"],
      "rows": [
        [{"k": "lit", "value": 2.5, "type": "real"}],
        [{"k": "lit", "value": {"$real": "NaN"}, "type": "real"}],
        [{"k": "lit", "value": -1, "type": "real"}]
      ]
    },
    "keys": [],
    "aggs": [
      {"fn": "max", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "real", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": []
  },
  "columns": [{"name": "max"}]
}
```

| max |
|---|
| NaN |

## Demo

The dearest price of each colour of fruit, and the last name in binary order:

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "scan",
      "table": "fruit",
      "columns": [0, 1, 2, 3, 4]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "text", "collation": "binary"}, "collation": "binary"}
    ],
    "aggs": [
      {"fn": "max", "args": [
        {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "real", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "max", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "text"}
    ],
    "carry": [],
    "ordered": "first"
  },
  "columns": [{"name": "color"}, {"name": "price"}, {"name": "name"}]
}
```

| color | price | name |
|---|---|---|
| red | 3 | cherry |
| green | 0.75 | pear |
| purple | 1.25 | plum |

## See also

- [`min`](./min), [`min_list`](./min_list), [`first`](./first), [`max` (scalar)](../general/max)
- [Aggregate functions](./)
