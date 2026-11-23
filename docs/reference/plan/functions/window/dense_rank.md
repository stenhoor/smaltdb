---
description: 'The rank of a row in its partition, without gaps: the number of its peer group.'
---

# dense_rank

```ebnf
dense_rank ::= '"fn": "dense_rank"' ', "args": []'
```

The rank of the row in its partition without gaps: the number of its group of peers, from 1 (1, 2, 2, 3). Rows whose
`order` keys are equal are peers. A ranking function: a call in a [`window`](../../operations/window)'s `calls`. It
reads the window's `partition` and `order`, not its frame.

## Parameters

None.

## Returns

`int`, from 1. Never NULL.

## Errors

None.

## Notes

- Without an `order`, every row of a partition is a peer of every other, and every rank is 1.
- NULL keys are peers of each other, and sort where the sort key's `nullsFirst` puts them.

## Examples

Over five scores, in ascending order (NULL first):

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "window",
      "input": {
        "op": "values",
        "types": ["text", "int"],
        "rows": [
          [{"k": "lit", "value": "a", "type": "text"}, {"k": "lit", "value": 10, "type": "int"}],
          [{"k": "lit", "value": "b", "type": "text"}, {"k": "lit", "value": 20, "type": "int"}],
          [{"k": "lit", "value": "c", "type": "text"}, {"k": "lit", "value": 20, "type": "int"}],
          [{"k": "lit", "value": "d", "type": "text"}, {"k": "lit", "value": 30, "type": "int"}],
          [{"k": "lit", "value": "e", "type": "text"}, {"k": "lit", "value": null, "type": "int"}]
        ]
      },
      "partition": [],
      "order": [
        {"expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
      ],
      "frame": {"unit": "RANGE", "start": {"kind": "unboundedPreceding"}, "end": {"kind": "currentRow"}, "exclude": "NO OTHERS"},
      "calls": [{"fn": "dense_rank", "args": [], "star": false, "type": "int", "collation": "binary"}]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"},
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "score"}, {"name": "dense_rank"}]
}
```

| name | score | dense_rank |
|---|---|---|
| e | NULL | 1 |
| a | 10 | 2 |
| b | 20 | 3 |
| c | 20 | 3 |
| d | 30 | 4 |

## Demo

The orders of each day, largest first:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "window",
      "input": {
        "op": "scan",
        "table": "orders",
        "columns": [0, 1, 2, 3]
      },
      "partition": [
        {"expr": {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "date", "collation": "binary"}, "collation": "binary"}
      ],
      "order": [
        {"expr": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}, "desc": true, "nullsFirst": false, "collation": "binary"}
      ],
      "frame": {"unit": "RANGE", "start": {"kind": "unboundedPreceding"}, "end": {"kind": "currentRow"}, "exclude": "NO OTHERS"},
      "calls": [{"fn": "dense_rank", "args": [], "star": false, "type": "int", "collation": "binary"}]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "date", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"},
      {"expr": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}, "desc": true, "nullsFirst": false, "collation": "binary"},
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "fruit"}, {"name": "n"}, {"name": "day"}, {"name": "dense_rank"}]
}
```

| id | fruit | n | day | dense_rank |
|---|---|---|---|---|
| 1 | 1 | 3 | 2026-11-02 | 1 |
| 2 | 2 | 1 | 2026-11-02 | 2 |
| 3 | 1 | 2 | 2026-11-03 | 1 |
| 4 | 4 | 10 | 2026-11-04 | 1 |
| 5 | 3 | 5 | 2026-11-05 | 1 |
| 6 | 1 | 1 | 2026-11-05 | 2 |

## See also

- [`row_number`](./row_number), [`rank`](./rank), [`percent_rank`](./percent_rank), [`cume_dist`](./cume_dist), [`ntile`](./ntile)
- [Window functions](./)
