---
description: 'An expression over each element of a list: a new list, the elements that pass, or aggregates.'
---

# each

```railroad
each
agg-call
```

An expression over each element of a list ([ADR 0031](../../../adr/0031-processing-lists-and-structs.md)): a new list
(`map`), the elements that pass a test (`filter`), or aggregates of the elements (`agg`). The body reads the element
with [`element`](./element), and the row's columns as any expression does.

## Fields

| Field | Type | |
|---|---|---|
| `list` | expression | The list: typed `list<…>` or `any`. |
| `mode` | `"map"`, `"filter"` or `"agg"` | What the `each` gives. |
| `body` | expression | `map`: each element's new value. `filter`: whether to keep the element. `agg`: the value, over the aggregates' results ([`eachAgg`](./eachAgg)). |
| `aggs` | aggregate calls | `agg` only: the aggregates run over the elements, as an [`aggregate`](../operations/aggregate)'s calls. Their arguments read the element. |
| `type` | [type](../types) | The type of the value: `map` a list type (`list<int>`), `filter` the list's own type, `agg` the body's type. |

and the [meaning fields](../meaning-fields) of an expression.

## Value

- `map`: the list of `body` for each element, in order.
- `filter`: the elements whose `body` is true, in order. A NULL or false body drops the element.
- `agg`: `body`, read once, over the results of `aggs` run over the elements.

A NULL list gives NULL. An empty list gives `[]` (`map`, `filter`), or the aggregates of no rows (`agg`: `count` 0,
`sum` NULL).

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | `list` isn't typed as a list or `any`; `mode` is unknown; `map` isn't typed as a list, or `filter` not as its list's type; `aggs` is given to a `map` or `filter`, or is missing from an `agg`; an aggregate is unknown or takes other arguments. |

## Notes

- `each` expressions nest: an inner one's body reads an outer one's element with `depth` 1
  ([`element`](./element)).
- A [`subquery`](./subquery) inside the body doesn't read the elements.
- The list is decoded once for each row, and the body compiled once: nothing runs per element as a plan.
- An aggregate of an `agg` takes `distinct` and `filter` as an `aggregate`'s does.

## Examples

Each mode over one list:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<int>", "list<int>", "int"],
    "rows": [[
      {"k": "each", "list": {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 3, "type": "int"}, {"k": "lit", "value": null, "type": "int"}, {"k": "lit", "value": 8, "type": "int"}], "type": "list<int>"},
        "mode": "map", "body": {"k": "call", "fn": "mul", "args": [{"k": "element", "part": "value", "depth": 0, "type": "int"}, {"k": "lit", "value": 2, "type": "int"}], "type": "int"},
        "type": "list<int>"},
      {"k": "each", "list": {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 3, "type": "int"}, {"k": "lit", "value": null, "type": "int"}, {"k": "lit", "value": 8, "type": "int"}], "type": "list<int>"},
        "mode": "filter", "body": {"k": "call", "fn": "cmp_gt", "args": [{"k": "element", "part": "value", "depth": 0, "type": "int"}, {"k": "lit", "value": 4, "type": "int"}], "type": "bool"},
        "type": "list<int>"},
      {"k": "each", "list": {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 3, "type": "int"}, {"k": "lit", "value": null, "type": "int"}, {"k": "lit", "value": 8, "type": "int"}], "type": "list<int>"},
        "mode": "agg", "body": {"k": "eachAgg", "index": 0, "depth": 0, "type": "int"},
        "aggs": [{"fn": "sum", "args": [{"k": "element", "part": "value", "depth": 0, "type": "int"}], "star": false, "distinct": false, "collation": "binary", "type": "int"}],
        "type": "int"}
    ]]
  },
  "columns": [{"name": "doubled"}, {"name": "large"}, {"name": "total"}]
}
```

| doubled | large | total |
|---|---|---|
| [6,null,16] | [8] | 11 |

A `filter` gives its list's type:

<!-- docs:error SMALT_PLAN -->
```json
{
  "op": "values",
  "types": ["list<text>"],
  "rows": [[
    {"k": "each", "list": {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "list<int>"},
      "mode": "filter", "body": {"k": "lit", "value": 1, "type": "bool"}, "type": "list<text>"}
  ]]
}
```

## Demo

Each basket's items other than pears, and its counts times ten. Grace's empty lists give `[]`, Edsger's NULL ones NULL:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "each", "list": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "list<text>", "collation": "binary"},
        "mode": "filter", "body": {"k": "call", "fn": "cmp_ne", "args": [
          {"k": "element", "part": "value", "depth": 0, "type": "text"},
          {"k": "lit", "value": "pear", "type": "text"}
        ], "type": "bool"},
        "type": "list<text>"},
      {"k": "each", "list": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "list<int>", "collation": "binary"},
        "mode": "map", "body": {"k": "call", "fn": "mul", "args": [
          {"k": "element", "part": "value", "depth": 0, "type": "int"},
          {"k": "lit", "value": 10, "type": "int"}
        ], "type": "int"},
        "type": "list<int>"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "items"}, {"name": "counts"}]
}
```

| owner | items | counts |
|---|---|---|
| Ada | ["apple"] | [20,10] |
| Alan | ["plum"] | [60] |
| Grace | [] | [] |
| Edsger | NULL | NULL |

## See also

- [`element`](./element), [`eachAgg`](./eachAgg)
- [`explode`](../operations/explode): a row for each element
- [List functions](../functions/list/)
- [Expressions](./)
