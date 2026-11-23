---
description: 'For each row, what a plan finds in the graph, or what it makes when it finds nothing.'
---

# graphMerge

```railroad
graph-merge
```

For each row, what a plan finds in the graph, or what it makes when it finds nothing (Cypher's `MERGE`). `match`
looks for the row's matches; a row that has some is passed on once for each, after `onMatch`; a row that has none
gets `nodes` and `relationships` made, as a [`graphCreate`](./graphCreate) makes them, and is passed on after
`onCreate`.

## Fields

| Field | Type | |
|---|---|---|
| `graph` | string | The property graph to write. It must have a node table with a properties column and a label index ([writing a property graph](../graph-writes)). |
| `id` | integer | The number the [`working`](./working) inside `match` names this operation by. No `iterate` or `graphMerge` around it may use it. |
| `input` | operation | The rows to merge. |
| `match` | operation | A plan that reads the graph for the rows a `working` with this `id` gives it (the input's columns, then the row's number) and gives a row for each match: the row's number, then the columns it adds. |
| `nodes` | `{labels, props?}` list | The nodes to make for a row with no match, as `graphCreate`'s. |
| `relationships` | `{type, start, end, props?}` list | The relationships to make for a row with no match, as `graphCreate`'s. |
| `created` | expressions | For a row with no match, the columns `match` would add: expressions over the input's columns, then the new nodes' ids, then the new relationships' rowids. One for each column `match` adds. |
| `onMatch` | [set items](./graphSet#set-item) | Applied to each row with a match, as a `graphSet`'s items, over the row passed on. |
| `onCreate` | [set items](./graphSet#set-item) | Applied to each row with no match, over the row passed on. |
| `tables` | `{label, table}` or `{type, table}` list | Optional: the names of the tables made for labels and types the graph doesn't have, as `graphCreate`'s. |
| `key` | expressions | Optional: expressions over the input row that let the engine match all the rows at once ([below](#key)). |

## Output

The input's columns, then the columns `match` adds (or `created` gives).

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | No property graph has the name; `match` gives no column for the row's number; `created` doesn't give one expression for each column `match` adds; or `id` is used by an `iterate` or `graphMerge` around it. |
| `SMALT_UNSUPPORTED` | `match` holds a write. |
| `SMALT_CONSTRAINT_FOREIGNKEY` | A relationship made for a row has an end that is NULL or not a node of the graph. |

## Notes

- **A row finds what an earlier row made.** Rows are merged in order, so two rows that want the same thing make it
  once.
- `onMatch` and `onCreate` read the row passed on: the input's columns, then those `match` adds.
- The statement's result counts what the merge made and set ([writing a property graph](../graph-writes)).

### key {#key}

Without `key`, each row is matched when its turn comes. With it, the engine matches all the rows in one query before
it makes anything. Give it where this holds of its expressions: two rows with the same values of them have the same
matches, and a row finds what an earlier row made exactly when it has that row's values, `match` then adding what
`created` gave that row. Of the rows that match nothing, the first with each key makes, and the later ones with that
key are passed on with what it made. A row with a NULL in its key is matched when its turn comes, as without a `key`.

## Examples

A `KNOWS` relationship from Ada (node 0) to Alan (1) and to Grace (2), unless there is one. Ada knows Alan already:
that row is passed on with the relationship's rowid, and marked `seen`. She doesn't know Grace: the first row for
Grace makes a relationship, with `since` set, and the second finds it.

```json
{
  "kind": "write",
  "plan": {
    "op": "graphMerge",
    "graph": "social",
    "id": 1,
    "input": {
      "op": "values",
      "types": ["int", "int"],
      "rows": [
        [{"k": "lit", "value": 0, "type": "int"}, {"k": "lit", "value": 1, "type": "int"}],
        [{"k": "lit", "value": 0, "type": "int"}, {"k": "lit", "value": 2, "type": "int"}],
        [{"k": "lit", "value": 0, "type": "int"}, {"k": "lit", "value": 2, "type": "int"}]
      ]
    },
    "match": {
      "op": "project",
      "input": {
        "op": "join",
        "kind": "inner",
        "inputs": [{"op": "working", "id": 1, "types": ["int", "int", "int"]}, {"op": "relationships", "graph": "social", "direction": "out", "types": ["KNOWS"]}],
        "on": {
          "k": "and",
          "args": [
            {"k": "call", "fn": "cmp_eq", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, {"k": "col", "input": 1, "index": 0, "depth": 0, "type": "int", "collation": "binary"}], "type": "bool"},
            {"k": "call", "fn": "cmp_eq", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}, {"k": "col", "input": 1, "index": 1, "depth": 0, "type": "int", "collation": "binary"}], "type": "bool"}
          ]
        }
      },
      "exprs": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "col", "input": 0, "index": 6, "depth": 0, "type": "int", "collation": "binary"}
      ]
    },
    "nodes": [],
    "relationships": [
      {
        "type": "KNOWS",
        "start": {"id": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}},
        "end": {"id": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}}
      }
    ],
    "created": [{"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}],
    "onMatch": [
      {
        "kind": "property",
        "key": "seen",
        "value": {"k": "lit", "value": 1, "type": "int"},
        "relationship": {"type": {"k": "lit", "value": "KNOWS", "type": "text"}, "id": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}}
      }
    ],
    "onCreate": [
      {
        "kind": "property",
        "key": "since",
        "value": {"k": "lit", "value": 1941, "type": "int"},
        "relationship": {"type": {"k": "lit", "value": "KNOWS", "type": "text"}, "id": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}}
      }
    ]
  },
  "returning": [{"name": "from"}, {"name": "to"}, {"name": "knows"}]
}
```

| from | to | knows |
|---|---|---|
| 0 | 1 | 0 |
| 0 | 2 | 4 |
| 0 | 2 | 4 |

The second row for Grace matched what the first made, so `onMatch` marked it `seen` too:

```json
{
  "kind": "query",
  "plan": {"op": "scan", "table": "knows", "columns": [-1, 0, 1, 2]},
  "columns": [{"name": "rowid"}, {"name": "start"}, {"name": "end"}, {"name": "props"}]
}
```

| rowid | start | end | props |
|---|---|---|---|
| 0 | 0 | 1 | {"seen":1,"since":1936} |
| 1 | 1 | 2 | {"since":1944} |
| 2 | 1 | 3 | {"since":1950} |
| 3 | 2 | 3 | {"since":1960} |
| 4 | 0 | 2 | {"seen":1,"since":1941} |

A `match` that adds a column, without the `created` column for it:

<!-- docs:error SMALT_PLAN -->
```json
{
  "kind": "write",
  "plan": {
    "op": "graphMerge",
    "graph": "social",
    "id": 1,
    "input": {"op": "values", "types": ["int"], "rows": [[{"k": "lit", "value": 0, "type": "int"}]]},
    "match": {
      "op": "project",
      "input": {"op": "working", "id": 1, "types": ["int", "int"]},
      "exprs": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ]
    },
    "nodes": [],
    "relationships": [],
    "created": [],
    "onMatch": [],
    "onCreate": []
  }
}
```

## Demo

A Person for each name, found by its `name` property or made, with `key` on the name so the engine matches every row
in one query. A node found gets `seen`, one made gets `new`; Bo is made once.

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
    "onMatch": [{"kind": "property", "key": "seen", "value": {"k": "lit", "value": 1, "type": "int"}, "node": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}}],
    "onCreate": [{"kind": "property", "key": "new", "value": {"k": "lit", "value": 1, "type": "int"}, "node": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}}],
    "key": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}]
  },
  "returning": [{"name": "name"}, {"name": "id"}]
}
```

| name | id |
|---|---|
| Ada | 0 |
| Bo | 4 |
| Bo | 4 |

```json
{
  "kind": "query",
  "plan": {"op": "scan", "table": "node", "columns": [0, 1]},
  "columns": [{"name": "id"}, {"name": "props"}]
}
```

| id | props |
|---|---|
| 0 | {"born":1815,"name":"Ada","seen":1} |
| 1 | {"born":1912,"name":"Alan"} |
| 2 | {"born":1906,"name":"Grace"} |
| 3 | {"born":1930,"name":"Edsger"} |
| 4 | {"name":"Bo","new":1,"seen":1} |

## See also

- [`working`](./working): the rows `match` reads
- [`graphCreate`](./graphCreate), [`graphSet`](./graphSet): what a merge makes and sets
- [Writing a property graph](../graph-writes)
- [Operations](./)
