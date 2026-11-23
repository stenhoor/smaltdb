---
description: 'The value of a group''s last row: in input order, or at the largest key.'
---

# last

```ebnf
last ::= '"fn": "last"' ', "args": [' VALUE (',' KEY (',' TIE)?)? ']'
```

The value of `VALUE` at a group's last row. With one argument, the last row in input order; with `KEY`, the row with the
largest key, rows whose key is NULL skipped; `TIE` is a second key for rows whose keys are equal. An aggregate: a call
in an [`aggregate`](../../operations/aggregate)'s `aggs` (or a [`window`](../../operations/window)'s `calls`, over a
frame).

## Parameters

| Argument | Type | |
|---|---|---|
| `VALUE` | any | The value given. It may be NULL: the row's NULL is the result. |
| `KEY` | any | Optional: the key; the row with the largest is taken. Rows where it is NULL are skipped. |
| `TIE` | any | Optional: a second key, for rows whose `KEY` is equal: the largest is taken. Rows where it is NULL are skipped. |

## Returns

The type of `VALUE`. NULL when the group has no row (or no row with keys that are not NULL), or when the value at that
row is NULL.

## Errors

None.

## Notes

- Rows whose keys are all equal are taken by input order: `last` keeps the later of them. The input order is the order
  of the aggregate's input, whatever order the engine reads it in ([order](../../order)).
- Keys order as SQLite orders values. A text `KEY` compares by the collation that `VALUE` carries ([meaning
  fields](../../meaning-fields)), `binary` when it carries none; `TIE` by `binary`.
- Unlike [`max`](./max), it doesn't skip a NULL value: `last` of a row whose value is NULL is NULL.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "values",
      "types": ["text", "int", "int"],
      "rows": [
        [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 5, "type": "int"}
        ],
        [
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": null, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"}
        ],
        [
          {"k": "lit", "value": "c", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"}
        ],
        [
          {"k": "lit", "value": "d", "type": "text"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"}
        ]
      ]
    },
    "keys": [],
    "aggs": [
      {"fn": "last", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "text"},
      {"fn": "last", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "text"},
      {"fn": "last", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "text"}
    ],
    "carry": []
  },
  "columns": [{"name": "by input"}, {"name": "by key"}, {"name": "by key and tie"}]
}
```

| by input | by key | by key and tie |
|---|---|---|
| d | d | a |

## Demo

For each day, the fruit of its last order and of its largest order:

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "scan",
      "table": "orders",
      "columns": [0, 1, 2, 3]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "date", "collation": "binary"}, "collation": "binary"}
    ],
    "aggs": [
      {"fn": "last", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "int"},
      {"fn": "last", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "int"}
    ],
    "carry": [],
    "ordered": "first"
  },
  "columns": [{"name": "day"}, {"name": "last order"}, {"name": "largest"}]
}
```

| day | last order | largest |
|---|---|---|
| 2026-11-02 | 2 | 1 |
| 2026-11-03 | 1 | 1 |
| 2026-11-04 | 4 | 4 |
| 2026-11-05 | 1 | 3 |

## See also

- [`first`](./first), [`max`](./max), [`min_list`](./min_list), [`last_value`](../window/last_value)
- [Aggregate functions](./)
