---
description: 'The relationships of a property graph as one relation, at either end.'
---

# relationships

```railroad
relationships
direction
```

The relationships of a [property graph](../../engine/schema#property-graphs) as one relation, at either end, whatever
tables its relationship types are in. A row is a relationship seen from one of its ends: a hop of a graph pattern is a
join with it.

## Fields

| Field | Type | |
|---|---|---|
| `graph` | string | The property graph's name. |
| `direction` | `"out"`, `"in"` or `"both"` | At which end each relationship is given: `out` once, at its start; `in` once, at its end; `both` at each end, so twice. |
| `types` | strings | Optional: only relationships of these types. Every type of the graph when left out; an empty list gives no rows. |
| `asOf` | [as-of](./scan#as-of) | Optional: read the graph as it was after a commit, as a [`scan`](./scan)'s does. The graph must keep history. |

## Output

| Column | Type | |
|---|---|---|
| `node` | `int` | The node the relationship is at. |
| `other` | `int` | The node at its other end. |
| `type` | `text` | Its type's name, as the graph spells it. |
| `id` | `int` | Its rowid in its type's table. |
| `outgoing` | `bool` | Whether `node` is its start. |
| `props` | `map<text, any>` | Its properties; NULL for a type whose table has no properties column. |

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | The graph doesn't exist, it has no relationship type of a name in `types`, a name is listed twice, or `asOf` reads a graph that keeps no history. |

## Notes

- Rows come in no promised order. A plan that needs one sorts ([order](../order)).
- With `both`, a relationship from a node to itself is given once, as outgoing.
- `types` names are matched exactly, unless the graph was made with `caseSensitive: false`; then in any case.
- **A hop is a join.** A condition on `node`, or on `node` and `other` (in a [`filter`](./filter) or a join's `on`),
  reads only the relationships at that node, or between the two. A pattern of several hops is a join of several
  `relationships`, which the planner orders by cost like any join. `type` and `id` together name a relationship, so a
  pattern that must not repeat one compares them.
- The engine reads the graph's index in memory where it has one, or each type's table through its indexes on its
  endpoints. The rows are the same either way. `props` is read only when the plan reads the column.

## Examples

Every relationship of the graph, once, at its start:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {"op": "relationships", "graph": "social", "direction": "out"},
    "keys": [
      {
        "expr": {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "int", "collation": "binary"},
        "desc": false,
        "nullsFirst": true,
        "collation": "binary"
      }
    ]
  },
  "columns": [{"name": "node"}, {"name": "other"}, {"name": "type"}, {"name": "id"}, {"name": "outgoing"}, {"name": "props"}]
}
```

| node | other | type | id | outgoing | props |
|---|---|---|---|---|---|
| 0 | 1 | KNOWS | 0 | true | {"since":1936} |
| 1 | 2 | KNOWS | 1 | true | {"since":1944} |
| 1 | 3 | KNOWS | 2 | true | {"since":1950} |
| 2 | 3 | KNOWS | 3 | true | {"since":1960} |

The `KNOWS` relationships at node 1 (Alan), either way:

<!-- docs:unordered -->
```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "relationships", "graph": "social", "direction": "both", "types": ["KNOWS"]},
    "pred": {"k": "call", "fn": "cmp_eq", "args": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "lit", "value": 1, "type": "int"}
    ], "type": "bool"}
  },
  "columns": [{"name": "node"}, {"name": "other"}, {"name": "type"}, {"name": "id"}, {"name": "outgoing"}, {"name": "props"}]
}
```

| node | other | type | id | outgoing | props |
|---|---|---|---|---|---|
| 1 | 2 | KNOWS | 1 | true | {"since":1944} |
| 1 | 3 | KNOWS | 2 | true | {"since":1950} |
| 1 | 0 | KNOWS | 0 | false | {"since":1936} |

A type name in the wrong case (the graph is case-sensitive):

<!-- docs:error SMALT_PLAN -->
```json
{"op": "relationships", "graph": "social", "direction": "out", "types": ["knows"]}
```

## Demo

The people two `KNOWS` hops out from node 0 (Ada), and the year of the second hop: one `relationships` per hop, then
the node table for their names:

<!-- docs:unordered -->
```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "join",
      "kind": "inner",
      "inputs": [
        {
          "op": "join",
          "kind": "inner",
          "inputs": [
            {
              "op": "filter",
              "input": {"op": "relationships", "graph": "social", "direction": "out", "types": ["KNOWS"]},
              "pred": {"k": "call", "fn": "cmp_eq", "args": [
                {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
                {"k": "lit", "value": 0, "type": "int"}
              ], "type": "bool"}
            },
            {"op": "relationships", "graph": "social", "direction": "out", "types": ["KNOWS"]}
          ],
          "on": {"k": "call", "fn": "cmp_eq", "args": [
            {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
            {"k": "col", "input": 1, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
          ], "type": "bool"}
        },
        {"op": "scan", "table": "node", "columns": [0, 1]}
      ],
      "on": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "col", "input": 0, "index": 7, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "col", "input": 1, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "type": "bool"}
    },
    "exprs": [
      {"k": "call", "fn": "map_get", "args": [
        {"k": "col", "input": 0, "index": 13, "depth": 0, "type": "map<text, any>", "collation": "binary"},
        {"k": "lit", "value": "name", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "map_get", "args": [
        {"k": "col", "input": 0, "index": 11, "depth": 0, "type": "map<text, any>", "collation": "binary"},
        {"k": "lit", "value": "since", "type": "text"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "since"}]
}
```

| name | since |
|---|---|
| Grace | 1944 |
| Edsger | 1950 |

## See also

- [`paths`](./paths): paths of any length through a graph
- [`join`](./join), [`filter`](./filter)
- [Property graphs](../../engine/schema#property-graphs), [writing a property graph](../graph-writes)
- [Operations](./)
