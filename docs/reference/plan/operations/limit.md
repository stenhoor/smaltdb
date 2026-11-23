---
description: 'At most `count` of its input''s rows, after skipping `offset`, from the start or the end.'
---

# limit

```railroad
limit
```

At most `count` of its input's rows, after skipping `offset`, from the start or the end. SQL's `LIMIT` and `OFFSET`
are a limit; over a [`sort`](./sort), it gives the first rows of an order.

## Fields

| Field | Type | |
|---|---|---|
| `input` | operation | The rows to take from. |
| `count` | [expression](../expressions/) | How many rows to give, an expression over no columns (a literal or a parameter). A negative count gives every row. |
| `offset` | [expression](../expressions/) | Optional: how many rows to skip first, an expression over no columns. 0 when left out; a negative offset is 0. |
| `fromEnd` | `true` | Optional: count from the end: the last `count` rows before the last `offset` rows, in input order. |

## Output

Its input's columns.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | `fromEnd` is not `true`. |
| `SMALT_MISMATCH` | `count` or `offset` is NULL, or is not a number: text must be a whole number (`'2'`). |

## Notes

- Rows keep their input's order ([order](../order)). Without a sort below it, which rows a limit takes depends on an
  order the input doesn't promise.
- A `count` or `offset` that is a real number is truncated toward zero: `2.7` takes 2 rows.
- A limit over a sort is run as a top-N sort, and is as stable as the sort.

## Examples

Two rows after skipping one:

```json
{
  "kind": "query",
  "plan": {
    "op": "limit",
    "input": {"op": "scan", "table": "fruit", "columns": [0, 1]},
    "count": {"k": "lit", "value": 2, "type": "int"},
    "offset": {"k": "lit", "value": 1, "type": "int"}
  },
  "columns": [{"name": "id"}, {"name": "name"}]
}
```

| id | name |
|---|---|
| 2 | pear |
| 3 | plum |

From the end: the last two rows before the last one, in input order:

```json
{
  "kind": "query",
  "plan": {
    "op": "limit",
    "input": {"op": "scan", "table": "fruit", "columns": [0, 1]},
    "count": {"k": "lit", "value": 2, "type": "int"},
    "offset": {"k": "lit", "value": 1, "type": "int"},
    "fromEnd": true
  },
  "columns": [{"name": "id"}, {"name": "name"}]
}
```

| id | name |
|---|---|
| 3 | plum |
| 4 | cherry |

A negative count: every row after the offset. The count here is a parameter:

<!-- docs:params [-1] -->
```json
{
  "kind": "query",
  "plan": {
    "op": "limit",
    "input": {"op": "scan", "table": "fruit", "columns": [0, 1]},
    "count": {"k": "param", "index": 0, "type": "int"},
    "offset": {"k": "lit", "value": 3, "type": "int"}
  },
  "columns": [{"name": "id"}, {"name": "name"}]
}
```

| id | name |
|---|---|
| 4 | cherry |
| 5 | lime |

A NULL count:

<!-- docs:error SMALT_MISMATCH -->
```json
{"op": "limit", "input": {"op": "scan", "table": "fruit", "columns": [1]}, "count": {"k": "lit", "value": null, "type": "int"}}
```

## Demo

The two dearest fruit:

```json
{
  "kind": "query",
  "plan": {
    "op": "limit",
    "input": {
      "op": "sort",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
      "keys": [
        {
          "expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
          "desc": true,
          "nullsFirst": false,
          "collation": "binary"
        }
      ]
    },
    "count": {"k": "lit", "value": 2, "type": "int"}
  },
  "columns": [{"name": "name"}, {"name": "price"}]
}
```

| name | price |
|---|---|
| cherry | 3 |
| plum | 1.25 |

## See also

- [`sort`](./sort)
- [`sample`](./sample): rows drawn at random
- [Order](../order)
- [Operations](./)
