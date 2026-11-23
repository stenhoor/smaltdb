---
description: 'Makes nodes and relationships of a property graph for each of its input''s rows.'
---

# graphCreate

```railroad
graph-create
new-node
new-relationship
graph-end
new-table
```

Makes nodes and relationships of a property graph for each of its input's rows (Cypher's `CREATE`): first its
`nodes`, in order, then its `relationships`. It passes each row on with the new ids after it.

## Fields

| Field | Type | |
|---|---|---|
| `graph` | string | The property graph to write. It must have a node table with a properties column and a label index ([writing a property graph](../graph-writes)). |
| `input` | operation | The rows to make nodes and relationships for. |
| `nodes` | `{labels, props?}` list | The nodes to make for each row: their labels, and their properties, a map. May be empty. |
| `relationships` | `{type, start, end, props?}` list | The relationships to make for each row: the type, the [ends](#graph-end), and the properties, a map. May be empty. |
| `tables` | `{label, table}` or `{type, table}` list | Optional: the name of the table made for a label or relationship type the graph doesn't have yet. |

## Output

The input's columns, then each new node's id (`int`), then each new relationship's rowid (`int`), in the order of
`nodes` and `relationships`.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | No property graph has the name; an end names a node the operation doesn't make; a label or type is empty. |
| `SMALT_CONSTRAINT_FOREIGNKEY` | A relationship's end is NULL or is not a node of the graph. |

## Notes

- **Expressions read the row as far as it is made:** the input's columns, then the ids of the nodes and relationships
  made before. A node's `props` reads the nodes before it; a relationship's ends and `props` read every node and the
  relationships before it.
- **Properties** are a `map<text, any>`. A key whose value is NULL is not set. Without `props`, a node has no
  properties.
- **Ids.** A new node's id is one more than the largest the graph's node tables have had, and a new relationship's
  rowid one more than the largest its relationship tables have had: the rules are on
  [writing a property graph](../graph-writes).
- **New labels and types** are added to the graph when a row first needs them, as `alterPropertyGraph` adds them;
  `tables` names the tables made for them, which must not exist.
- `graphCreate` passes rows on, so a plan can read on from it. A plan that holds it is a `write` statement's, and the
  statement's result counts what it did ([writing a property graph](../graph-writes)).

### graph-end {#graph-end}

```railroad
graph-end
```

`{"node": i}` is the `i`-th node this operation makes for the row, from 0. `{"id": …}` is an expression that gives the
id of a node in the graph.

## Examples

Barbara, a Person born in 1939, whom Edsger (node 3) knows since 1970:

```json
{
  "kind": "write",
  "plan": {
    "op": "graphCreate",
    "graph": "social",
    "input": {
      "op": "values",
      "types": ["text", "int"],
      "rows": [[{"k": "lit", "value": "Barbara", "type": "text"}, {"k": "lit", "value": 1939, "type": "int"}]]
    },
    "nodes": [
      {
        "labels": ["Person"],
        "props": {
          "k": "call",
          "fn": "map_of",
          "args": [
            {"k": "lit", "value": "name", "type": "text"},
            {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
            {"k": "lit", "value": "born", "type": "text"},
            {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
          ],
          "type": "map<text, any>"
        }
      }
    ],
    "relationships": [
      {
        "type": "KNOWS",
        "start": {"id": {"k": "lit", "value": 3, "type": "int"}},
        "end": {"node": 0},
        "props": {"k": "call", "fn": "map_of", "args": [{"k": "lit", "value": "since", "type": "text"}, {"k": "lit", "value": 1970, "type": "int"}], "type": "map<text, any>"}
      }
    ]
  },
  "returning": [{"name": "name"}, {"name": "born"}, {"name": "node"}, {"name": "knows"}]
}
```

| name | born | node | knows |
|---|---|---|---|
| Barbara | 1939 | 4 | 4 |

The relationships of `KNOWS` now:

```json
{
  "kind": "query",
  "plan": {"op": "scan", "table": "knows", "columns": [-1, 0, 1, 2]},
  "columns": [{"name": "rowid"}, {"name": "start"}, {"name": "end"}, {"name": "props"}]
}
```

| rowid | start | end | props |
|---|---|---|---|
| 0 | 0 | 1 | {"since":1936} |
| 1 | 1 | 2 | {"since":1944} |
| 2 | 1 | 3 | {"since":1950} |
| 3 | 2 | 3 | {"since":1960} |
| 4 | 3 | 4 | {"since":1970} |

A relationship to a node that isn't there:

<!-- docs:error SMALT_CONSTRAINT_FOREIGNKEY -->
```json
{
  "kind": "write",
  "plan": {
    "op": "graphCreate",
    "graph": "social",
    "input": {"op": "values", "types": [], "rows": [[]]},
    "nodes": [],
    "relationships": [{"type": "KNOWS", "start": {"id": {"k": "lit", "value": 99, "type": "int"}}, "end": {"id": {"k": "lit", "value": 1, "type": "int"}}}]
  }
}
```

## Demo

A label and a relationship type the graph doesn't have: a Robot that Barbara (node 4) built, with the tables for them
named. The robot is a Person too.

```json
{
  "kind": "write",
  "plan": {
    "op": "graphCreate",
    "graph": "social",
    "input": {"op": "values", "types": ["text"], "rows": [[{"k": "lit", "value": "Robby", "type": "text"}]]},
    "nodes": [
      {
        "labels": ["Robot", "Person"],
        "props": {"k": "call", "fn": "map_of", "args": [{"k": "lit", "value": "name", "type": "text"}, {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}], "type": "map<text, any>"}
      }
    ],
    "relationships": [{"type": "BUILT", "start": {"id": {"k": "lit", "value": 4, "type": "int"}}, "end": {"node": 0}}],
    "tables": [{"label": "Robot", "table": "robot"}, {"type": "BUILT", "table": "built"}]
  },
  "returning": [{"name": "name"}, {"name": "node"}, {"name": "built"}]
}
```

| name | node | built |
|---|---|---|
| Robby | 5 | 6 |

The relationship's rowid is 6, not 5: the statement that failed above took 5, and a rowid an earlier statement of the
connection gave is not given again, also when that statement failed ([writing a property graph](../graph-writes)).
The new `built` table holds it:

```json
{
  "kind": "query",
  "plan": {"op": "scan", "table": "built", "columns": [-1, 0, 1]},
  "columns": [{"name": "rowid"}, {"name": "start"}, {"name": "end"}]
}
```

| rowid | start | end |
|---|---|---|
| 6 | 4 | 5 |

## See also

- [`graphMerge`](./graphMerge): makes what it doesn't find
- [`graphSet`](./graphSet), [`graphDelete`](./graphDelete)
- [Writing a property graph](../graph-writes)
- [Operations](./)
