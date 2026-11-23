---
description: 'Sets properties and labels of the nodes and relationships each row names.'
---

# graphSet

```railroad
graph-set
set-item
relationship-ref
```

Sets properties and labels of the nodes and relationships each row names (Cypher's `SET` and `REMOVE`): for each
input row, its `items` in order. It passes each row on.

## Fields

| Field | Type | |
|---|---|---|
| `graph` | string | The property graph to write. It must have a node table with a properties column and a label index ([writing a property graph](../graph-writes)). |
| `input` | operation | The rows that name what to change. |
| `items` | [set items](#set-item) | What to change for each row, in order. |
| `tables` | `{label, table}` list | Optional: the name of the table made for a label the graph doesn't have yet, as a [`graphCreate`](./graphCreate)'s. |

## Output

The input's columns.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | No property graph has the name; an item names both a node and a relationship, or neither; a `labels` item names a relationship. |
| `SMALT_CONSTRAINT_FOREIGNKEY` | A label is added to a node that is not in the graph. |

## Notes

- **What is passed over.** A NULL node or relationship is passed over, and the item's `value` is not computed for it.
  One that is not in the graph has no property set and no label removed; adding a label to it is an error.
- **Properties** are a `map<text, any>`, and values keep their kind there: a truth value, a list or a map set as a
  property is one.
- A relationship whose type's table has no properties column takes no properties.
- **Row by row.** Each row's items read the graph as the rows before it left it, so a property set from itself
  counts up over rows that name the same node
  ([the order a plan that writes a graph runs in](../graph-writes#order)).
- The statement's result counts what it did: `propertiesSet` counts each key set or removed, whether or not its value
  changed; `labelsAdded` and `labelsRemoved` each label.

### set-item {#set-item}

```railroad
set-item
relationship-ref
```

An item names a node (`node`: an expression that gives its id) or a relationship (`relationship`: `{type, id}`,
expressions that give its type's name and its rowid), and is one of:

| `kind` | Fields | |
|---|---|---|
| `"property"` | `key`, `value` | Sets the key to `value`. A NULL `value` removes the key. |
| `"properties"` | `value`, `merge` | `value` is a map. Without `merge`, it replaces the properties, its NULL values setting no key. With `merge`, its keys are set over the properties there are, and a NULL value removes its key. |
| `"labels"` | `add`, `remove` | A node's: adds the labels of `add` the node doesn't have, and removes those of `remove` it has. A label the graph doesn't have is added to it. |

## Examples

A surname for Ada (node 0) and Alan (node 1), from the input's rows:

```json
{
  "kind": "write",
  "plan": {
    "op": "graphSet",
    "graph": "social",
    "input": {
      "op": "values",
      "types": ["int", "text"],
      "rows": [
        [{"k": "lit", "value": 0, "type": "int"}, {"k": "lit", "value": "Lovelace", "type": "text"}],
        [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": "Turing", "type": "text"}]
      ]
    },
    "items": [
      {
        "kind": "property",
        "key": "surname",
        "value": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
        "node": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      }
    ]
  }
}
```

Ada's properties merged with a map: `born` removed (NULL), `name` set. Grace's (node 2) replaced: she keeps only the
map's keys.

```json
{
  "kind": "write",
  "plan": {
    "op": "graphSet",
    "graph": "social",
    "input": {"op": "values", "types": [], "rows": [[]]},
    "items": [
      {
        "kind": "properties",
        "value": {
          "k": "call",
          "fn": "map_of",
          "args": [
            {"k": "lit", "value": "born", "type": "text"},
            {"k": "lit", "value": null, "type": "int"},
            {"k": "lit", "value": "name", "type": "text"},
            {"k": "lit", "value": "Augusta Ada", "type": "text"}
          ],
          "type": "map<text, any>"
        },
        "merge": true,
        "node": {"k": "lit", "value": 0, "type": "int"}
      },
      {
        "kind": "properties",
        "value": {"k": "call", "fn": "map_of", "args": [{"k": "lit", "value": "name", "type": "text"}, {"k": "lit", "value": "Grace Hopper", "type": "text"}], "type": "map<text, any>"},
        "merge": false,
        "node": {"k": "lit", "value": 2, "type": "int"}
      }
    ]
  }
}
```

```json
{
  "kind": "query",
  "plan": {"op": "scan", "table": "node", "columns": [0, 1]},
  "columns": [{"name": "id"}, {"name": "props"}]
}
```

| id | props |
|---|---|
| 0 | {"name":"Augusta Ada","surname":"Lovelace"} |
| 1 | {"born":1912,"name":"Alan","surname":"Turing"} |
| 2 | {"name":"Grace Hopper"} |
| 3 | {"born":1930,"name":"Edsger"} |

A property of a relationship, `KNOWS` rowid 0, and a label for Grace that the graph doesn't have yet:

```json
{
  "kind": "write",
  "plan": {
    "op": "graphSet",
    "graph": "social",
    "input": {"op": "values", "types": [], "rows": [[]]},
    "items": [
      {
        "kind": "property",
        "key": "since",
        "value": {"k": "lit", "value": 1935, "type": "int"},
        "relationship": {"type": {"k": "lit", "value": "KNOWS", "type": "text"}, "id": {"k": "lit", "value": 0, "type": "int"}}
      },
      {"kind": "labels", "add": ["Admiral"], "remove": [], "node": {"k": "lit", "value": 2, "type": "int"}}
    ]
  }
}
```

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "scan", "table": "social_labels", "columns": [0, 1]},
    "pred": {"k": "call", "fn": "cmp_eq", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, {"k": "lit", "value": 2, "type": "int"}], "type": "bool"}
  },
  "columns": [{"name": "node"}, {"name": "label"}]
}
```

| node | label |
|---|---|
| 2 | Person |
| 2 | Admiral |

A label for a node that isn't there:

<!-- docs:error SMALT_CONSTRAINT_FOREIGNKEY -->
```json
{
  "kind": "write",
  "plan": {
    "op": "graphSet",
    "graph": "social",
    "input": {"op": "values", "types": [], "rows": [[]]},
    "items": [{"kind": "labels", "add": ["Person"], "remove": [], "node": {"k": "lit", "value": 99, "type": "int"}}]
  }
}
```

## Demo

Each person's number of `KNOWS` relationships, either way, as a property `friends`: the input counts them with
[`relationships`](./relationships), and the item sets them.

```json
{
  "kind": "write",
  "plan": {
    "op": "graphSet",
    "graph": "social",
    "input": {
      "op": "aggregate",
      "input": {"op": "relationships", "graph": "social", "direction": "both", "types": ["KNOWS"]},
      "keys": [{"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "collation": "binary"}],
      "aggs": [{"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"}],
      "carry": []
    },
    "items": [
      {
        "kind": "property",
        "key": "friends",
        "value": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        "node": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      }
    ]
  }
}
```

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "node", "columns": [0, 1]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "map_get", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "map<text, any>", "collation": "binary"}, {"k": "lit", "value": "friends", "type": "text"}], "type": "int"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "friends"}]
}
```

| id | friends |
|---|---|
| 0 | 1 |
| 1 | 3 |
| 2 | 2 |
| 3 | 2 |

## See also

- [`graphCreate`](./graphCreate), [`graphMerge`](./graphMerge): `graphMerge`'s `onMatch` and `onCreate` are items too
- [`update`](./update): sets columns of a table's rows
- [Writing a property graph](../graph-writes)
- [Operations](./)
