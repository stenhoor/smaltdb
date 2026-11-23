---
description: 'Deletes the nodes, relationships and paths each row names.'
---

# graphDelete

```railroad
graph-delete
delete-target
relationship-ref
```

Deletes the nodes, relationships and paths each row names (Cypher's `DELETE`): for each input row, its `targets` in
order, each before the next is looked at. It passes each row on.

## Fields

| Field | Type | |
|---|---|---|
| `graph` | string | The property graph to write. It must have a node table with a properties column and a label index ([writing a property graph](../graph-writes)). |
| `input` | operation | The rows that name what to delete. |
| `targets` | [delete targets](#delete-target) | What to delete for each row, in order. |
| `detach` | boolean | Delete a node's relationships before the node (Cypher's `DETACH DELETE`). Without it, a node that has relationships is an error. |

## Output

The input's columns.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | No property graph has the name, or a target is not exactly one of the kinds below. |
| `SMALT_CONSTRAINT_FOREIGNKEY` | A node to delete still has relationships, and `detach` is `false`. |

## Notes

- A NULL target, a NULL in a list, and what is gone already, is passed over.
- A deleted node's labels go with it.
- The statement's result counts the nodes and relationships deleted ([writing a property graph](../graph-writes)).

### delete-target {#delete-target}

```railroad
delete-target
```

| Target | |
|---|---|
| `{"node": …}` | A node: an expression that gives its id. |
| `{"nodes": …}` | Nodes: an expression that gives a `list<int>` of ids. |
| `{"relationship": {"type": …, "id": …}}` | A relationship: expressions that give its type's name and its rowid. |
| `{"hops": …}` | The relationships of a path, as [`paths`](./paths) gives it (a `list<struct<edge int, rowid int, from int, to int>>`). A hop's `edge` is its type's position in the graph. |
| `{"path": {"start": …, "hops": …}}` | A whole path: the relationships of its hops, then its nodes (`start`, then each hop's `to`). |

## Examples

The relationship `KNOWS` rowid 3, from Grace to Edsger:

```json
{
  "kind": "write",
  "plan": {
    "op": "graphDelete",
    "graph": "social",
    "input": {"op": "values", "types": [], "rows": [[]]},
    "targets": [{"relationship": {"type": {"k": "lit", "value": "KNOWS", "type": "text"}, "id": {"k": "lit", "value": 3, "type": "int"}}}],
    "detach": false
  }
}
```

Edsger (node 3) still has a relationship from Alan, so deleting him without `detach` is an error:

<!-- docs:error SMALT_CONSTRAINT_FOREIGNKEY -->
```json
{
  "kind": "write",
  "plan": {
    "op": "graphDelete",
    "graph": "social",
    "input": {"op": "values", "types": [], "rows": [[]]},
    "targets": [{"node": {"k": "lit", "value": 3, "type": "int"}}],
    "detach": false
  }
}
```

The relationships of the shortest path from Ada (node 0) to Edsger, which `paths` finds:

```json
{
  "kind": "write",
  "plan": {
    "op": "graphDelete",
    "graph": "social",
    "input": {
      "op": "paths",
      "input": {"op": "values", "types": ["int", "int"], "rows": [[{"k": "lit", "value": 0, "type": "int"}, {"k": "lit", "value": 3, "type": "int"}]]},
      "start": 0,
      "edges": [{"table": "knows", "start": 0, "end": 1}],
      "direction": "out",
      "selector": "anyShortest",
      "target": 1
    },
    "targets": [{"hops": {"k": "col", "input": 0, "index": 4, "depth": 0, "type": "list<struct<edge int, rowid int, from int, to int>>", "collation": "binary"}}],
    "detach": false
  },
  "returning": [{"name": "from"}, {"name": "to"}, {"name": "end"}, {"name": "hops"}, {"name": "path"}]
}
```

| from | to | end | hops | path |
|---|---|---|---|---|
| 0 | 3 | 3 | 2 | [{"edge":0,"rowid":0,"from":0,"to":1},{"edge":0,"rowid":2,"from":1,"to":3}] |

One relationship is left:

```json
{
  "kind": "query",
  "plan": {"op": "scan", "table": "knows", "columns": [-1, 0, 1]},
  "columns": [{"name": "rowid"}, {"name": "start"}, {"name": "end"}]
}
```

| rowid | start | end |
|---|---|---|
| 1 | 1 | 2 |

## Demo

Everyone born before 1910, with their relationships (`detach`): Ada and Grace, and with Grace the relationship from
Alan.

```json
{
  "kind": "write",
  "plan": {
    "op": "graphDelete",
    "graph": "social",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "node", "columns": [0, 1]},
      "pred": {
        "k": "call",
        "fn": "cmp_lt",
        "args": [
          {"k": "call", "fn": "map_get", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "map<text, any>", "collation": "binary"}, {"k": "lit", "value": "born", "type": "text"}], "type": "int"},
          {"k": "lit", "value": 1910, "type": "int"}
        ],
        "type": "bool"
      }
    },
    "targets": [{"node": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}}],
    "detach": true
  }
}
```

```json
{
  "kind": "query",
  "plan": {
    "op": "join",
    "kind": "inner",
    "inputs": [{"op": "scan", "table": "node", "columns": [0, 1]}, {"op": "scan", "table": "social_labels", "columns": [0, 1]}],
    "on": {
      "k": "call",
      "fn": "cmp_eq",
      "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "col", "input": 1, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ],
      "type": "bool"
    },
    "ordered": true
  },
  "columns": [{"name": "id"}, {"name": "props"}, {"name": "node"}, {"name": "label"}]
}
```

| id | props | node | label |
|---|---|---|---|
| 1 | {"born":1912,"name":"Alan"} | 1 | Person |
| 3 | {"born":1930,"name":"Edsger"} | 3 | Person |

## See also

- [`paths`](./paths): the paths a `hops` or `path` target deletes
- [`delete`](./delete): deletes a table's rows
- [Writing a property graph](../graph-writes)
- [Operations](./)
