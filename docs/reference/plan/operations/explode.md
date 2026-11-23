---
description: 'One row for each element of a list column.'
---

# explode

```railroad
explode
also-column
```

One row for each element of a list column: each input row's columns, with the list's place holding the element.
Other list columns can be exploded with it, element by element.

## Fields

| Field | Type | |
|---|---|---|
| `input` | operation | The rows whose lists to explode. |
| `column` | integer | The list column, by position. |
| `type` | [type](../types) | Its type, `list<T>`. |
| `also` | `{column, type}` list | Optional: more list columns exploded with `column`, zipped by position: each row takes their elements at the same position. Each must have as many elements as `column`'s list. |
| `position` | boolean | Optional: add a last column holding each element's position, from 0. |
| `emptyAsNull` | boolean | Optional: an empty list gives one row whose element is NULL, instead of none. |
| `keepNulls` | boolean | Optional: `false` gives a NULL list no row, instead of one whose element is NULL. |

## Output

The input's columns, with `column` and each `also` column holding their elements (type `T`), then, with `position`,
the position (`int`).

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | `column` or an `also` column is not one of the input's, a type is not a list type, or a column is exploded twice. |
| `SMALT_RANGE` | A row's zipped lists are not as long as each other. A NULL list is as long only as another NULL. |

## Notes

- Rows come in the input's order, and each row's elements in the list's order.
- As Polars' `explode`: an empty list gives no row and a NULL list one row with NULL, unless `emptyAsNull` or
  `keepNulls: false` say otherwise.
- With `position`, the row with NULL that an empty or NULL list gives has position 0.
- The [`each`](../expressions/each) expression works on a list without making rows of it.

## Examples

The items of each basket, with their positions. Grace's empty basket gives no row, and Edsger's NULL one a row with
NULL:

```json
{
  "kind": "query",
  "plan": {
    "op": "explode",
    "input": {"op": "scan", "table": "baskets", "columns": [1, 2]},
    "column": 1,
    "type": "list<text>",
    "position": true
  },
  "columns": [{"name": "owner"}, {"name": "item"}, {"name": "pos"}]
}
```

| owner | item | pos |
|---|---|---|
| Ada | apple | 0 |
| Ada | pear | 1 |
| Alan | plum | 0 |
| Edsger | NULL | 0 |

With `emptyAsNull` and `keepNulls: false`, it is the other way round:

```json
{
  "kind": "query",
  "plan": {
    "op": "explode",
    "input": {"op": "scan", "table": "baskets", "columns": [1, 2]},
    "column": 1,
    "type": "list<text>",
    "emptyAsNull": true,
    "keepNulls": false
  },
  "columns": [{"name": "owner"}, {"name": "item"}]
}
```

| owner | item |
|---|---|
| Ada | apple |
| Ada | pear |
| Alan | plum |
| Grace | NULL |

Lists zipped by position must be as long as each other:

<!-- docs:error SMALT_RANGE -->
```json
{
  "op": "explode",
  "input": {
    "op": "values",
    "types": ["list<int>", "list<int>"],
    "rows": [[
      {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": 2, "type": "int"}], "type": "list<int>"},
      {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 3, "type": "int"}], "type": "list<int>"}
    ]]
  },
  "column": 0,
  "type": "list<int>",
  "also": [{"column": 1, "type": "list<int>"}]
}
```

## Demo

Each basket's items with their counts, zipped, and the fruit's price for each:

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
          "op": "explode",
          "input": {"op": "scan", "table": "baskets", "columns": [1, 2, 3]},
          "column": 1,
          "type": "list<text>",
          "also": [{"column": 2, "type": "list<int>"}]
        },
        {"op": "scan", "table": "fruit", "columns": [1, 3]}
      ],
      "on": {
        "k": "call",
        "fn": "cmp_eq",
        "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
          {"k": "col", "input": 1, "index": 0, "depth": 0, "type": "text", "collation": "binary"}
        ],
        "type": "bool"
      },
      "ordered": true
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "col", "input": 0, "index": 4, "depth": 0, "type": "real", "collation": "binary"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "item"}, {"name": "n"}, {"name": "price"}]
}
```

| owner | item | n | price |
|---|---|---|---|
| Ada | apple | 2 | 0.5 |
| Ada | pear | 1 | 0.75 |
| Alan | plum | 6 | 1.25 |

## See also

- [`each`](../expressions/each): a list's elements, inside an expression
- [`unpivot`](./unpivot): columns turned into rows
- [Operations](./)
