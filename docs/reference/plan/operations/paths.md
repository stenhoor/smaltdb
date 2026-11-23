---
description: 'The paths through a graph from each input row''s node, along relationship tables.'
---

# paths

```railroad
paths
path-edges
path-selector
```

The paths through a graph from each input row's node, along relationship tables: tables whose rows each join two
nodes, a start and an end column. Each path is a row.

## Fields

| Field | Type | |
|---|---|---|
| `input` | operation | The rows to start from. |
| `start` | integer | The input column holding each path's first node. |
| `edges` | `{table, db?, start, end}` list | The tables whose rows are the relationships, and their start and end columns, by position. At least one. A path may take a relationship of any of them. |
| `direction` | `"out"`, `"in"` or `"both"` | Which way a relationship is followed: from its start to its end, from its end to its start, or either way. |
| `minHops` | integer | Optional: the fewest relationships a path has. Default 1; 0 gives each start its empty path too. |
| `maxHops` | integer | Optional: the most relationships a path has. Default: no limit. |
| `mode` | `"walk"`, `"trail"`, `"acyclic"` or `"simple"` | Optional: what a path may repeat. `walk` (the default) anything; `trail` no relationship; `acyclic` no node; `simple` no node, except that the last may be the first, which ends the path. |
| `selector` | [path-selector](#selector) | Optional: which of an input row's paths to each last node it keeps. Default `"all"`. |
| `target` | integer | Optional: an input column holding a node: only the paths that end there (none for NULL). |

## Output

The input's columns, then the path's last node (`int`), its length in hops (`int`), and the path
(`list<struct<edge int, rowid int, from int, to int>>`): for each hop, the position of its table in `edges`, the
relationship's rowid, and the nodes it went from and to, in the direction the path went.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | `start` or `target` is not an input column; `edges` is empty, names a table that doesn't exist or a column it hasn't; `maxHops` is below `minHops`; or a `walk` has no `maxHops` and its selector is not `any` or `anyShortest`. |

## Notes

- A NULL start has no paths.
- Rows keep the input's order, and an input row's paths come shortest first. Paths as long as each other come in no
  promised order.
- A `walk` can go round a cycle forever, so it needs `maxHops`, unless its selector keeps one path per node (`any`,
  `anyShortest`). The other modes end by themselves.
- `any` and `anyShortest` keep one path per node, and cost about as much as reaching each node once. The other
  selectors enumerate paths, which can grow exponentially with `maxHops` on a dense graph. With `target`, a search
  for one path per node stops when it reaches the target.
- Each step looks up the relationships at a path's last node: give each table an index on its `start` column (for
  `out`), its `end` column (`in`), or both.
- The engine runs it as an [`iterate`](./iterate), which `EXPLAIN` shows. One path per node over the edge tables of a
  [property graph](../../engine/schema#property-graphs) is a breadth-first search the engine runs itself; which of two
  paths as short it keeps is not part of the operation's meaning.
- Over a property graph, [`relationships`](./relationships) reads a hop as a join; a path from `paths` can be deleted
  with [`graphDelete`](./graphDelete).

### path-selector {#selector}

```railroad
path-selector
```

`"all"` every path; `"any"` one path to each last node; `"anyShortest"` one of the shortest to each; `"allShortest"`
all the shortest to each; `{"shortest": k}` the `k` shortest to each, ties broken arbitrarily.

## Examples

The examples follow the `knows` table, the `KNOWS` relationships of the sample graph: `start` is column 0, `end`
column 1. One shortest path from Ada (node 0) to each node she reaches:

<!-- docs:unordered -->
```json
{
  "kind": "query",
  "plan": {
    "op": "paths",
    "input": {"op": "values", "types": ["int"], "rows": [[{"k": "lit", "value": 0, "type": "int"}]]},
    "start": 0,
    "edges": [{"table": "knows", "start": 0, "end": 1}],
    "direction": "out",
    "selector": "anyShortest"
  },
  "columns": [{"name": "from"}, {"name": "to"}, {"name": "hops"}, {"name": "path"}]
}
```

| from | to | hops | path |
|---|---|---|---|
| 0 | 1 | 1 | [{"edge":0,"rowid":0,"from":0,"to":1}] |
| 0 | 2 | 2 | [{"edge":0,"rowid":0,"from":0,"to":1},{"edge":0,"rowid":1,"from":1,"to":2}] |
| 0 | 3 | 2 | [{"edge":0,"rowid":0,"from":0,"to":1},{"edge":0,"rowid":2,"from":1,"to":3}] |

Every path from Ada to Edsger (node 3), named by the input's second column:

```json
{
  "kind": "query",
  "plan": {
    "op": "paths",
    "input": {"op": "values", "types": ["int", "int"], "rows": [[{"k": "lit", "value": 0, "type": "int"}, {"k": "lit", "value": 3, "type": "int"}]]},
    "start": 0,
    "edges": [{"table": "knows", "start": 0, "end": 1}],
    "direction": "out",
    "mode": "acyclic",
    "target": 1
  },
  "columns": [{"name": "from"}, {"name": "target"}, {"name": "to"}, {"name": "hops"}, {"name": "path"}]
}
```

| from | target | to | hops | path |
|---|---|---|---|---|
| 0 | 3 | 3 | 2 | [{"edge":0,"rowid":0,"from":0,"to":1},{"edge":0,"rowid":2,"from":1,"to":3}] |
| 0 | 3 | 3 | 3 | [{"edge":0,"rowid":0,"from":0,"to":1},{"edge":0,"rowid":1,"from":1,"to":2},{"edge":0,"rowid":3,"from":2,"to":3}] |

Backwards from Edsger, with the empty path (`minHops` 0) and at most one hop. A NULL start has no paths:

<!-- docs:unordered -->
```json
{
  "kind": "query",
  "plan": {
    "op": "paths",
    "input": {"op": "values", "types": ["int"], "rows": [[{"k": "lit", "value": 3, "type": "int"}], [{"k": "lit", "value": null, "type": "int"}]]},
    "start": 0,
    "edges": [{"table": "knows", "start": 0, "end": 1}],
    "direction": "in",
    "minHops": 0,
    "maxHops": 1
  },
  "columns": [{"name": "from"}, {"name": "to"}, {"name": "hops"}, {"name": "path"}]
}
```

| from | to | hops | path |
|---|---|---|---|
| 3 | 3 | 0 | [] |
| 3 | 1 | 1 | [{"edge":0,"rowid":2,"from":3,"to":1}] |
| 3 | 2 | 1 | [{"edge":0,"rowid":3,"from":3,"to":2}] |

A walk with no end:

<!-- docs:error SMALT_PLAN -->
```json
{
  "op": "paths",
  "input": {"op": "values", "types": ["int"], "rows": [[{"k": "lit", "value": 0, "type": "int"}]]},
  "start": 0,
  "edges": [{"table": "knows", "start": 0, "end": 1}],
  "direction": "both"
}
```

## Demo

How many `KNOWS` hops each person is from Ada, either way, by name. With `minHops` 0, Ada is 0 hops from herself:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "project",
      "input": {
        "op": "join",
        "kind": "inner",
        "inputs": [
          {
            "op": "paths",
            "input": {"op": "values", "types": ["int"], "rows": [[{"k": "lit", "value": 0, "type": "int"}]]},
            "start": 0,
            "edges": [{"table": "knows", "start": 0, "end": 1}],
            "direction": "both",
            "minHops": 0,
            "selector": "anyShortest"
          },
          {"op": "scan", "table": "node", "columns": [0, 1]}
        ],
        "on": {
          "k": "call",
          "fn": "cmp_eq",
          "args": [
            {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
            {"k": "col", "input": 1, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
          ],
          "type": "bool"
        }
      },
      "exprs": [
        {"k": "call", "fn": "map_get", "args": [{"k": "col", "input": 0, "index": 5, "depth": 0, "type": "map<text, any>", "collation": "binary"}, {"k": "lit", "value": "name", "type": "text"}], "type": "text"},
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"},
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "hops"}]
}
```

| name | hops |
|---|---|
| Ada | 0 |
| Alan | 1 |
| Edsger | 2 |
| Grace | 2 |

## See also

- [`iterate`](./iterate): the recursive query `paths` runs as
- [`relationships`](./relationships): a property graph's relationships as a relation
- [`graphDelete`](./graphDelete): deletes a path's relationships and nodes
- [Operations](./)
