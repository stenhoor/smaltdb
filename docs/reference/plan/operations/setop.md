---
description: 'The union, intersection or difference of two inputs'' rows.'
---

# setop

```railroad
setop
```

The union, intersection or difference of two inputs' rows: SQL's `UNION`, `UNION ALL`, `INTERSECT` and `EXCEPT`.

## Fields

| Field | Type | |
|---|---|---|
| `kind` | `"union"`, `"unionAll"`, `"intersect"` or `"except"` | Which rows to give: see below. |
| `inputs` | two operations | The first input, then the second. They must have as many columns as each other. |
| `collations` | [collations](../collations) | One per column: how its text values compare. See the notes for what the engine reads. |

| Kind | Rows |
|---|---|
| `union` | Each row of either input, once. |
| `unionAll` | Every row of the first input, then every row of the second, duplicates and all. |
| `intersect` | Each row of the first input that the second has too, once. |
| `except` | Each row of the first input that the second doesn't have, once. |

## Output

The first input's columns.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | There are not two inputs, they differ in their number of columns, or the kind is unknown. |

## Notes

- Rows are equal when each of their columns is, and NULLs are equal to each other here. `union`, `intersect` and
  `except` give each row once, also when one input holds it twice.
- `unionAll` gives the first input's rows in their order, then the second's ([order](../order)). The other kinds'
  order is not defined: sort above them for one.
- The inputs' columns are not converted to each other's types: a column may hold the first input's values of one type
  and the second's of another.
- At present the engine compares text by the collation each column of the first input carries
  ([`carries`](../meaning-fields#carries-and-affinity)), `binary` where it carries none, and does not read
  `collations`.

## Examples

Two lists of colors, each kind in turn. `union`:

<!-- docs:unordered -->
```json
{
  "kind": "query",
  "plan": {
    "op": "setop",
    "kind": "union",
    "inputs": [
      {"op": "values", "rows": [], "types": ["text"], "columns": [["red", "green", "red", null]]},
      {"op": "values", "rows": [], "types": ["text"], "columns": [["green", "blue", null]]}
    ],
    "collations": ["binary"]
  },
  "columns": [{"name": "color"}]
}
```

| color |
|---|
| red |
| green |
| NULL |
| blue |

`unionAll`, in order:

```json
{
  "kind": "query",
  "plan": {
    "op": "setop",
    "kind": "unionAll",
    "inputs": [
      {"op": "values", "rows": [], "types": ["text"], "columns": [["red", "green", "red", null]]},
      {"op": "values", "rows": [], "types": ["text"], "columns": [["green", "blue", null]]}
    ],
    "collations": ["binary"]
  },
  "columns": [{"name": "color"}]
}
```

| color |
|---|
| red |
| green |
| red |
| NULL |
| green |
| blue |
| NULL |

`intersect`:

<!-- docs:unordered -->
```json
{
  "kind": "query",
  "plan": {
    "op": "setop",
    "kind": "intersect",
    "inputs": [
      {"op": "values", "rows": [], "types": ["text"], "columns": [["red", "green", "red", null]]},
      {"op": "values", "rows": [], "types": ["text"], "columns": [["green", "blue", null]]}
    ],
    "collations": ["binary"]
  },
  "columns": [{"name": "color"}]
}
```

| color |
|---|
| green |
| NULL |

`except`:

<!-- docs:unordered -->
```json
{
  "kind": "query",
  "plan": {
    "op": "setop",
    "kind": "except",
    "inputs": [
      {"op": "values", "rows": [], "types": ["text"], "columns": [["red", "green", "red", null]]},
      {"op": "values", "rows": [], "types": ["text"], "columns": [["green", "blue", null]]}
    ],
    "collations": ["binary"]
  },
  "columns": [{"name": "color"}]
}
```

| color |
|---|
| red |

Inputs of one and two columns:

<!-- docs:error SMALT_PLAN -->
```json
{
  "op": "setop",
  "kind": "union",
  "inputs": [{"op": "scan", "table": "fruit", "columns": [1]}, {"op": "scan", "table": "fruit", "columns": [1, 2]}],
  "collations": ["binary"]
}
```

## Demo

The fruit that are green or were ordered on 2026-11-05, by id:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "setop",
      "kind": "union",
      "inputs": [
        {
          "op": "project",
          "input": {
            "op": "filter",
            "input": {"op": "scan", "table": "fruit", "columns": [0, 2]},
            "pred": {"k": "call", "fn": "cmp_eq", "args": [
              {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
              {"k": "lit", "value": "green", "type": "text"}
            ], "type": "bool"}
          },
          "exprs": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}]
        },
        {
          "op": "project",
          "input": {
            "op": "filter",
            "input": {"op": "scan", "table": "orders", "columns": [1, 3]},
            "pred": {"k": "call", "fn": "cmp_eq", "args": [
              {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"},
              {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-05", "type": "text"}], "type": "date"}
            ], "type": "bool"}
          },
          "exprs": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}]
        }
      ],
      "collations": ["binary"]
    },
    "keys": [
      {
        "expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        "desc": false,
        "nullsFirst": true,
        "collation": "binary"
      }
    ]
  },
  "columns": [{"name": "fruit"}]
}
```

| fruit |
|---|
| 1 |
| 2 |
| 3 |
| 5 |

## See also

- [`distinct`](./distinct): one row of each set of equal rows of one input
- [`join`](./join): rows of two inputs side by side
- [Operations](./)
