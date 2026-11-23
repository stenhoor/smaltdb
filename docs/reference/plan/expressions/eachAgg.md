---
description: 'Inside an `each` of mode `agg`, the result of one of its aggregates.'
---

# eachAgg

```railroad
each-agg
```

Inside an [`each`](./each) of mode `agg`, the result of one of its aggregates. The body of an `agg` reads its
aggregates' results with `eachAgg`, and so combines them: a mean as a sum over a count, a range as a maximum less a
minimum.

## Fields

| Field | Type | |
|---|---|---|
| `index` | integer | Which aggregate of the `each`'s `aggs`, from 0. |
| `depth` | integer | Which `each`: 0 the innermost around the expression. |
| `type` | [type](../types) | The aggregate's type. |

and the [meaning fields](../meaning-fields) of an expression.

## Value

The result of aggregate `index` over the list's elements.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | It isn't in the body of an `agg` `depth` levels out (in a `map`'s or `filter`'s body, or in an aggregate's arguments), or that `agg` has no aggregate `index`. |

## Examples

The distinct elements counted, plus the sum of those above 1:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[
      {"k": "each", "list": {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"}, {"k": "lit", "value": 5, "type": "int"}
        ], "type": "list<int>"},
        "mode": "agg",
        "body": {"k": "call", "fn": "add", "args": [
          {"k": "eachAgg", "index": 0, "depth": 0, "type": "int"},
          {"k": "eachAgg", "index": 1, "depth": 0, "type": "int"}
        ], "type": "int"},
        "aggs": [
          {"fn": "count", "args": [{"k": "element", "part": "value", "depth": 0, "type": "int"}], "star": false, "distinct": true, "collation": "binary", "type": "int"},
          {"fn": "sum", "args": [{"k": "element", "part": "value", "depth": 0, "type": "int"}], "star": false, "distinct": false,
            "filter": {"k": "call", "fn": "cmp_gt", "args": [{"k": "element", "part": "value", "depth": 0, "type": "int"}, {"k": "lit", "value": 1, "type": "int"}], "type": "bool"},
            "collation": "binary", "type": "int"}
        ],
        "type": "int"}
    ]]
  },
  "columns": [{"name": "result"}]
}
```

| result |
|---|
| 10 |

An aggregate the `agg` doesn't have:

<!-- docs:error SMALT_PLAN -->
```json
{
  "op": "values",
  "types": ["int"],
  "rows": [[
    {"k": "each", "list": {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "list<int>"},
      "mode": "agg", "body": {"k": "eachAgg", "index": 1, "depth": 0, "type": "int"},
      "aggs": [{"fn": "sum", "args": [{"k": "element", "part": "value", "depth": 0, "type": "int"}], "star": false, "distinct": false, "collation": "binary", "type": "int"}],
      "type": "int"}
  ]]
}
```

## Demo

Each basket's total count and the number of its counts, read from one `agg`:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [1, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "each", "list": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "list<int>", "collation": "binary"},
        "mode": "agg",
        "body": {"k": "call", "fn": "list_of", "args": [
          {"k": "eachAgg", "index": 0, "depth": 0, "type": "int"},
          {"k": "eachAgg", "index": 1, "depth": 0, "type": "int"}
        ], "type": "list<int>"},
        "aggs": [
          {"fn": "sum", "args": [{"k": "element", "part": "value", "depth": 0, "type": "int"}], "star": false, "distinct": false, "collation": "binary", "type": "int"},
          {"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"}
        ],
        "type": "list<int>"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "sum_and_count"}]
}
```

| owner | sum_and_count |
|---|---|
| Ada | [3,2] |
| Alan | [6,1] |
| Grace | [null,0] |
| Edsger | NULL |

## See also

- [`each`](./each), [`element`](./element)
- [Aggregate functions](../functions/aggregate/)
- [Expressions](./)
