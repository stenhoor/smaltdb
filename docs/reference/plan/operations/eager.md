---
description: 'Its input''s rows, all read before the first is passed on.'
---

# eager

```railroad
eager
```

Its input's rows, all read before the first is passed on: everything below it is done before anything above it
starts. In a plan that writes a property graph, it decides what a row's expressions see of the rows written before
it.

## Fields

| Field | Type | |
|---|---|---|
| `input` | operation | The rows to read. |

## Output

The input's columns and rows, in the input's order.

## Errors

None of its own.

## Notes

- A write handles its rows one by one, and some operations below it run when each row's turn comes: a `filter`,
  `project`, `explode` or `unpivot` with a nested plan, and `paths`. These read the graph as the rows before wrote it.
  An `eager` below the write has them run for every row first, so each reads the graph as it was before the write
  ([the order a plan that writes a graph runs in](../graph-writes#order)).
- In a plan that writes no graph, an `eager` changes nothing: the engine removes it.

## Examples

In a plan that writes nothing, its input:

```json
{
  "kind": "query",
  "plan": {"op": "eager", "input": {"op": "scan", "table": "fruit", "columns": [1]}},
  "columns": [{"name": "name"}]
}
```

| name |
|---|
| apple |
| pear |
| plum |
| cherry |
| lime |

## Demo

Three new nodes, each row with the number of nodes there were when its expressions ran. Without `eager`, a row's
count runs when its turn comes, and sees the nodes the rows before it made:

```json
{
  "kind": "write",
  "plan": {
    "op": "graphCreate",
    "graph": "social",
    "input": {
      "op": "project",
      "input": {"op": "values", "types": ["text"], "rows": [[{"k": "lit", "value": "a", "type": "text"}], [{"k": "lit", "value": "b", "type": "text"}], [{"k": "lit", "value": "c", "type": "text"}]]},
      "exprs": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        {
          "k": "subquery",
          "mode": "scalar",
          "plan": {
            "op": "aggregate",
            "input": {"op": "scan", "table": "node", "columns": [0]},
            "keys": [],
            "aggs": [{"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"}],
            "carry": []
          },
          "type": "int",
          "collation": "binary"
        }
      ]
    },
    "nodes": [{"labels": []}],
    "relationships": []
  },
  "returning": [{"name": "row"}, {"name": "nodes"}, {"name": "id"}]
}
```

| row | nodes | id |
|---|---|---|
| a | 4 | 4 |
| b | 5 | 5 |
| c | 6 | 6 |

With `eager` around the input, every count runs before the first node is made:

```json
{
  "kind": "write",
  "plan": {
    "op": "graphCreate",
    "graph": "social",
    "input": {
      "op": "eager",
      "input": {
        "op": "project",
        "input": {"op": "values", "types": ["text"], "rows": [[{"k": "lit", "value": "a", "type": "text"}], [{"k": "lit", "value": "b", "type": "text"}], [{"k": "lit", "value": "c", "type": "text"}]]},
        "exprs": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
          {
            "k": "subquery",
            "mode": "scalar",
            "plan": {
              "op": "aggregate",
              "input": {"op": "scan", "table": "node", "columns": [0]},
              "keys": [],
              "aggs": [{"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"}],
              "carry": []
            },
            "type": "int",
            "collation": "binary"
          }
        ]
      }
    },
    "nodes": [{"labels": []}],
    "relationships": []
  },
  "returning": [{"name": "row"}, {"name": "nodes"}, {"name": "id"}]
}
```

| row | nodes | id |
|---|---|---|
| a | 7 | 7 |
| b | 7 | 8 |
| c | 7 | 9 |

## See also

- [The order a plan that writes a graph runs in](../graph-writes#order)
- [`graphCreate`](./graphCreate), [`graphSet`](./graphSet), [`graphDelete`](./graphDelete), [`graphMerge`](./graphMerge)
- [Operations](./)
