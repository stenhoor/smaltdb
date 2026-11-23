---
description: 'A recursive query: its first rows, then the rows its steps give for each row in turn, until no row is left.'
---

# iterate

```railroad
iterate
sort-key
```

A recursive query (SQL's `WITH RECURSIVE`): its first rows, then the rows its steps give for each row in turn, until
no row is left. A step reads the row it runs for through a [`working`](./working) with the iterate's `id`.

## Fields

| Field | Type | |
|---|---|---|
| `id` | integer | The number a `working` inside the steps names it by. No other `iterate` or [`graphMerge`](./graphMerge) around it may use it. |
| `name` | string | A name for `EXPLAIN` (a recursive CTE's). |
| `init` | operation | The first rows. |
| `steps` | operations | The plans run for each row, each giving rows with as many columns as `init`'s. |
| `distinct` | boolean | Drop a row equal to one given before, by `collations` (SQL's `UNION`); `false` keeps every row (`UNION ALL`). |
| `collations` | [collations](../collations) | One per column: how `distinct` and `key` compare text. |
| `order` | [sort keys](./sort) | Optional: the row whose steps run next is the lowest by these keys, over the iterate's columns. |
| `limit` | expression | Optional: stop after this many rows. An expression over no columns; negative is no limit. |
| `offset` | expression | Optional: leave out this many rows first. An expression over no columns. |
| `key` | integers | Optional, with `distinct`: drop a row whose values of these columns were seen before, instead of comparing whole rows. The first row of a key is kept or, with `order`, the lowest. |
| `maxDepth` | integer | Optional: run the steps only for rows fewer than this many steps from `init`, whose rows are at depth 0. |

## Output

`init`'s columns.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | A step gives a different number of columns from `init`; `key` is given without `distinct`, is empty, names a column twice or one the iterate hasn't; `maxDepth` is negative; or the `id` is used by an `iterate` or `graphMerge` around it. |

## Notes

- **How it runs.** The rows of `init` are queued. The row at the head of the queue is taken, every step is run with
  `working` holding that one row, and the rows they give are queued after it; then the row is given. This goes on
  until the queue is empty, `limit` rows were given, or the plan above stops reading.
- **Order.** Without `order`, the queue is first in, first out: the first rows, then the rows each gives, breadth
  first. With `order`, the lowest queued row is taken next, the rows in the order queued when they are equal.
- **An end.** A step that always gives a row never ends without `limit` or `maxDepth`. With `distinct`, a row seen
  before is dropped and its steps are not run again, which ends a walk whose rows hold only nodes of a finite graph
  (not one that also counts hops).
- **Shortest paths.** With `key` on a node column, each node is reached once: by the fewest steps without `order`, or
  by the lowest cost with `order` on a cost column. A key taken from the queue is final.
- Without `order`, a step's row whose key was seen may be dropped before its other columns are computed: an error one
  of them would raise is not raised.
- [`paths`](./paths) runs as an `iterate`.
- An `iterate` may not hold a write ([writing a property graph](../graph-writes)).

## Examples

The numbers from 1 to 5: one first row, and a step that adds one while the result is at most 5:

```json
{
  "kind": "query",
  "plan": {
    "op": "iterate",
    "id": 1,
    "name": "n",
    "init": {"op": "values", "types": ["int"], "rows": [[{"k": "lit", "value": 1, "type": "int"}]]},
    "steps": [
      {
        "op": "filter",
        "input": {
          "op": "project",
          "input": {"op": "working", "id": 1, "types": ["int"]},
          "exprs": [{"k": "call", "fn": "add", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, {"k": "lit", "value": 1, "type": "int"}], "type": "int"}]
        },
        "pred": {"k": "call", "fn": "cmp_le", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, {"k": "lit", "value": 5, "type": "int"}], "type": "bool"}
      }
    ],
    "distinct": false,
    "collations": ["binary"]
  },
  "columns": [{"name": "n"}]
}
```

| n |
|---|
| 1 |
| 2 |
| 3 |
| 4 |
| 5 |

A step with no end, stopped by `maxDepth`: the steps run for the rows at depths 0, 1 and 2.

```json
{
  "kind": "query",
  "plan": {
    "op": "iterate",
    "id": 1,
    "name": "n",
    "init": {"op": "values", "types": ["int"], "rows": [[{"k": "lit", "value": 1, "type": "int"}]]},
    "steps": [
      {
        "op": "project",
        "input": {"op": "working", "id": 1, "types": ["int"]},
        "exprs": [{"k": "call", "fn": "add", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, {"k": "lit", "value": 1, "type": "int"}], "type": "int"}]
      }
    ],
    "distinct": false,
    "collations": ["binary"],
    "maxDepth": 3
  },
  "columns": [{"name": "n"}]
}
```

| n |
|---|
| 1 |
| 2 |
| 3 |
| 4 |

`order` takes the lowest queued row next. Two first rows, 5 and 1, and a step that adds 10 below 20; `offset` and
`limit` then keep the second and third rows:

```json
{
  "kind": "query",
  "plan": {
    "op": "iterate",
    "id": 1,
    "name": "n",
    "init": {"op": "values", "types": ["int"], "rows": [[{"k": "lit", "value": 5, "type": "int"}], [{"k": "lit", "value": 1, "type": "int"}]]},
    "steps": [
      {
        "op": "filter",
        "input": {
          "op": "project",
          "input": {"op": "working", "id": 1, "types": ["int"]},
          "exprs": [{"k": "call", "fn": "add", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, {"k": "lit", "value": 10, "type": "int"}], "type": "int"}]
        },
        "pred": {"k": "call", "fn": "cmp_lt", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, {"k": "lit", "value": 20, "type": "int"}], "type": "bool"}
      }
    ],
    "distinct": false,
    "collations": ["binary"],
    "order": [
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ],
    "offset": {"k": "lit", "value": 1, "type": "int"},
    "limit": {"k": "lit", "value": 2, "type": "int"}
  },
  "columns": [{"name": "n"}]
}
```

| n |
|---|
| 5 |
| 11 |

A `key` without `distinct`:

<!-- docs:error SMALT_PLAN -->
```json
{
  "op": "iterate",
  "id": 1,
  "name": "n",
  "init": {"op": "values", "types": ["int"], "rows": [[{"k": "lit", "value": 1, "type": "int"}]]},
  "steps": [],
  "distinct": false,
  "collations": ["binary"],
  "key": [0]
}
```

## Demo

Who Ada (node 0) reaches along `knows`, each with the fewest hops it takes: a row is a node and its hops, a step
follows each relationship from the row's node, and `key` keeps each node's first row.

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "iterate",
      "id": 1,
      "name": "reach",
      "init": {"op": "values", "types": ["int", "int"], "rows": [[{"k": "lit", "value": 0, "type": "int"}, {"k": "lit", "value": 0, "type": "int"}]]},
      "steps": [
        {
          "op": "project",
          "input": {
            "op": "join",
            "kind": "inner",
            "inputs": [{"op": "working", "id": 1, "types": ["int", "int"]}, {"op": "scan", "table": "knows", "columns": [0, 1]}],
            "on": {
              "k": "call",
              "fn": "cmp_eq",
              "args": [
                {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
                {"k": "col", "input": 1, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
              ],
              "type": "bool"
            }
          },
          "exprs": [
            {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "int", "collation": "binary"},
            {"k": "call", "fn": "add", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}, {"k": "lit", "value": 1, "type": "int"}], "type": "int"}
          ]
        }
      ],
      "distinct": true,
      "collations": ["binary", "binary"],
      "key": [0]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ]
  },
  "columns": [{"name": "node"}, {"name": "hops"}]
}
```

| node | hops |
|---|---|
| 0 | 0 |
| 1 | 1 |
| 2 | 2 |
| 3 | 2 |

Without `key`, `distinct` compares whole rows, and node 3 comes twice: once 2 hops away (through Alan), once 3
(through Grace).

## See also

- [`working`](./working): the row a step runs for
- [`paths`](./paths): paths through a graph, run as an `iterate`
- [`setop`](./setop): a union that isn't recursive
- [Operations](./)
