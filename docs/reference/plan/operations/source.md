---
description: 'The rows of a table function, a virtual table or an external table.'
---

# source

```railroad
source
```

The rows of a table function, a virtual table or an external table: rows the engine makes, or reads from outside its
tables, when the plan runs.

## Fields

| Field | Type | |
|---|---|---|
| `kind` | `"function"`, `"virtual"` or `"external"` | What `name` names: a table function, a virtual table (`information_schema.*`), or an external table. |
| `name` | string | Its name. A function's name is taken in any case. |
| `schema` | string | Optional: the schema the name is in (`"information_schema"` for its tables). |
| `args` | expressions | The arguments, in order. As the right input of a [`join`](./join), they may read the left input's columns: the source is then read again for each left row (a lateral source). Otherwise they read no columns. |
| `named` | object of expressions | Optional: arguments by name, for a function that takes them (a plugin's `read_csv`, say). |
| `types` | [types](../types) | One type per column the source gives: as many as it has. |

## Output

The source's columns, one for each of `types`, of that type.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | `types` doesn't have one type per column of the source, or an argument reads a column it can't. |
| `SMALT_ERROR` | There is no table function of that name, or a function is given the wrong number of arguments. |
| `SMALT_MISMATCH` | An argument is not of a kind the function takes: `range`'s not whole numbers, `list_elements`' not a list. |
| `SMALT_RANGE` | `range` is given a step of 0. |

## Notes

- Rows come in no promised order. `range` and `list_elements` give theirs in order.
- The engine's own table functions:
  - **`range(start, stop [, step])`**: the integers from `start` to `stop`, both included, `step` apart (1 when left
    out; a negative step counts down). One column, `int`. The rows are made as they are read, so a long range takes
    no memory. A NULL argument gives no rows, and so does a `stop` that the steps never reach (`range(3, 1)`).
  - **`list_elements(list [, emptyAsNull [, keepNulls]])`**: one row for each element of a list, holding the element
    and its position (from 0), in order. Two columns: the element (give the list's element type) and the position
    (`int`). A NULL list and an empty one give no rows, unless `keepNulls` (for a NULL list) or `emptyAsNull` (for an
    empty one) is true: then one row, a NULL element at position 0. [`explode`](./explode) is a join with it.
- The `pragma_*` functions (`pragma_table_info`, …) give a pragma's rows, each column typed `any`. Plugins add table
  functions of their own.

## Examples

The integers from 1 to 10, 3 apart:

```json
{
  "kind": "query",
  "plan": {"op": "source", "kind": "function", "name": "range", "args": [
    {"k": "lit", "value": 1, "type": "int"},
    {"k": "lit", "value": 10, "type": "int"},
    {"k": "lit", "value": 3, "type": "int"}
  ], "types": ["int"]},
  "columns": [{"name": "value"}]
}
```

| value |
|---|
| 1 |
| 4 |
| 7 |
| 10 |

Counting down:

```json
{"op": "source", "kind": "function", "name": "range", "args": [
  {"k": "lit", "value": 3, "type": "int"},
  {"k": "lit", "value": 1, "type": "int"},
  {"k": "lit", "value": -1, "type": "int"}
], "types": ["int"]}
```

| column1 |
|---|
| 3 |
| 2 |
| 1 |

The elements of a list, and an empty list kept as one row:

```json
{
  "kind": "query",
  "plan": {"op": "source", "kind": "function", "name": "list_elements", "args": [
    {"k": "call", "fn": "list_of", "args": [
      {"k": "lit", "value": "fig", "type": "text"},
      {"k": "lit", "value": "kiwi", "type": "text"}
    ], "type": "list<text>"}
  ], "types": ["text", "int"]},
  "columns": [{"name": "element"}, {"name": "position"}]
}
```

| element | position |
|---|---|
| fig | 0 |
| kiwi | 1 |

```json
{
  "kind": "query",
  "plan": {"op": "source", "kind": "function", "name": "list_elements", "args": [
    {"k": "call", "fn": "list_of", "args": [], "type": "list<text>"},
    {"k": "lit", "value": 1, "type": "bool"}
  ], "types": ["text", "int"]},
  "columns": [{"name": "element"}, {"name": "position"}]
}
```

| element | position |
|---|---|
| NULL | 0 |

A step of 0:

<!-- docs:error SMALT_RANGE -->
```json
{"op": "source", "kind": "function", "name": "range", "args": [
  {"k": "lit", "value": 1, "type": "int"},
  {"k": "lit", "value": 5, "type": "int"},
  {"k": "lit", "value": 0, "type": "int"}
], "types": ["int"]}
```

`range` has one column, not two:

<!-- docs:error SMALT_PLAN -->
```json
{"op": "source", "kind": "function", "name": "range", "args": [
  {"k": "lit", "value": 1, "type": "int"},
  {"k": "lit", "value": 5, "type": "int"}
], "types": ["int", "int"]}
```

## Demo

Each basket's items, one row per item, as a lateral source: the function's argument reads the left input's `items`.
A left join keeps the baskets with no items:

```json
{
  "kind": "query",
  "plan": {
    "op": "join",
    "kind": "left",
    "inputs": [
      {"op": "scan", "table": "baskets", "columns": [1, 2]},
      {"op": "source", "kind": "function", "name": "list_elements", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "list<text>", "collation": "binary"}
      ], "types": ["text", "int"]}
    ],
    "ordered": true
  },
  "columns": [{"name": "owner"}, {"name": "items"}, {"name": "item"}, {"name": "position"}]
}
```

| owner | items | item | position |
|---|---|---|---|
| Ada | ["apple","pear"] | apple | 0 |
| Ada | ["apple","pear"] | pear | 1 |
| Alan | ["plum"] | plum | 0 |
| Grace | [] | NULL | NULL |
| Edsger | NULL | NULL | NULL |

## See also

- [`explode`](./explode): a list column's elements as rows
- [`values`](./values), [`scan`](./scan)
- [`join`](./join)
- [Operations](./)
