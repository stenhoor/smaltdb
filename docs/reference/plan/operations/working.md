---
description: 'Inside an `iterate`, the row its steps run for; inside a `graphMerge`''s match, the rows being matched.'
---

# working

```railroad
working
```

The rows an enclosing operation hands to a plan inside it. Inside an [`iterate`](./iterate)'s steps, the row the
steps run for. Inside a [`graphMerge`](./graphMerge)'s `match`, the input rows being matched, each with its number.

## Fields

| Field | Type | |
|---|---|---|
| `id` | integer | The `id` of the `iterate` or `graphMerge` whose rows it reads. It must be around the `working`. |
| `types` | [types](../types) | The types of its columns: one per column of the `iterate`'s `init`, or one per column of the `graphMerge`'s input and then `int`. |

## Output

Inside an `iterate`, the iterate's columns. Inside a `graphMerge`, the input's columns, then the row's number
(`int`).

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | No `iterate` or `graphMerge` with its `id` is around it, or `types` has a different number of columns from the rows it reads. |

## Notes

- In an `iterate`, a `working` holds one row: the one taken from the queue, whose steps are running. A step is a plan
  over it, so a step that joins it with a table gives the rows one hop on.
- In a `graphMerge`, a `match` reads the rows being matched through a `working`, and gives the row's number first in
  each of its rows: that is how the engine knows whose match a row is. The engine hands `match` one row, or with `key`
  several at once; a number means nothing beyond the statement.

## Examples

Everyone Ada (node 0) reaches along `knows`: the step joins the row `working` holds with the relationships from its
node:

<!-- docs:unordered -->
```json
{
  "kind": "query",
  "plan": {
    "op": "iterate",
    "id": 1,
    "name": "reach",
    "init": {"op": "values", "types": ["int"], "rows": [[{"k": "lit", "value": 0, "type": "int"}]]},
    "steps": [
      {
        "op": "project",
        "input": {
          "op": "join",
          "kind": "inner",
          "inputs": [{"op": "working", "id": 1, "types": ["int"]}, {"op": "scan", "table": "knows", "columns": [0, 1]}],
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
        "exprs": [{"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}]
      }
    ],
    "distinct": true,
    "collations": ["binary"]
  },
  "columns": [{"name": "node"}]
}
```

| node |
|---|
| 0 |
| 1 |
| 2 |
| 3 |

A `working` outside its `iterate`:

<!-- docs:error SMALT_PLAN -->
```json
{"op": "working", "id": 1, "types": ["int"]}
```

## Demo

For each name, the node that has it, or a new `Person` node: `match` reads each name through `working` (the name,
then the row's number) and gives the number, then the node's id. Bo is made once: the second Bo finds the node the
first made.

```json
{
  "kind": "write",
  "plan": {
    "op": "graphMerge",
    "graph": "social",
    "id": 1,
    "input": {
      "op": "values",
      "types": ["text"],
      "rows": [[{"k": "lit", "value": "Ada", "type": "text"}], [{"k": "lit", "value": "Bo", "type": "text"}], [{"k": "lit", "value": "Bo", "type": "text"}]]
    },
    "match": {
      "op": "project",
      "input": {
        "op": "filter",
        "input": {
          "op": "join",
          "kind": "cross",
          "inputs": [{"op": "working", "id": 1, "types": ["text", "int"]}, {"op": "scan", "table": "node", "columns": [0, 1]}]
        },
        "pred": {
          "k": "call",
          "fn": "cmp_eq",
          "args": [
            {"k": "call", "fn": "map_get", "args": [{"k": "col", "input": 0, "index": 3, "depth": 0, "type": "map<text, any>", "collation": "binary"}, {"k": "lit", "value": "name", "type": "text"}], "type": "text"},
            {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}
          ],
          "type": "bool"
        }
      },
      "exprs": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ]
    },
    "nodes": [{"labels": ["Person"], "props": {"k": "call", "fn": "map_of", "args": [{"k": "lit", "value": "name", "type": "text"}, {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}], "type": "map<text, any>"}}],
    "relationships": [],
    "created": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}],
    "onMatch": [],
    "onCreate": []
  },
  "returning": [{"name": "name"}, {"name": "id"}]
}
```

| name | id |
|---|---|
| Ada | 0 |
| Bo | 4 |
| Bo | 4 |

## See also

- [`iterate`](./iterate), [`graphMerge`](./graphMerge): the operations whose rows it reads
- [Operations](./)
