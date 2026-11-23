---
description: 'Inside an `each`, the element, or its position.'
---

# element

```railroad
element
```

Inside an [`each`](./each), the element the body is reading, or its position in the list from 0.

## Fields

| Field | Type | |
|---|---|---|
| `part` | `"value"` or `"position"` | The element itself, or its position from 0. |
| `depth` | integer | Which `each`: 0 the innermost around the expression, 1 the one around that, and so on. |
| `type` | [type](../types) | The type of the value: the list's element type for `value`, `int` for `position`. |

and the [meaning fields](../meaning-fields) of an expression.

## Value

The element of the `each` `depth` levels out that its body is reading now, or its position.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | There is no `each` `depth` levels out; `part` is unknown; or it is in the body of an `agg`, outside its aggregates' arguments. |

## Notes

- An `agg` reads the elements in its aggregates' arguments and filters; its body reads the aggregates' results
  ([`eachAgg`](./eachAgg)), not the elements.
- A nested plan ([`subquery`](./subquery)) inside a body starts afresh: it has no `each` around it.

## Examples

Positions, and an inner `each` reading the outer one's position with `depth` 1:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<int>", "list<list<int>>"],
    "rows": [[
      {"k": "each", "list": {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": "a", "type": "text"}, {"k": "lit", "value": "b", "type": "text"}], "type": "list<text>"},
        "mode": "map", "body": {"k": "element", "part": "position", "depth": 0, "type": "int"}, "type": "list<int>"},
      {"k": "each", "list": {"k": "call", "fn": "list_of", "args": [
          {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": 2, "type": "int"}], "type": "list<int>"},
          {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 3, "type": "int"}], "type": "list<int>"}
        ], "type": "list<list<int>>"},
        "mode": "map", "body": {"k": "each", "list": {"k": "element", "part": "value", "depth": 0, "type": "list<int>"},
          "mode": "map", "body": {"k": "call", "fn": "add", "args": [
            {"k": "call", "fn": "mul", "args": [{"k": "element", "part": "position", "depth": 1, "type": "int"}, {"k": "lit", "value": 100, "type": "int"}], "type": "int"},
            {"k": "element", "part": "value", "depth": 0, "type": "int"}
          ], "type": "int"}, "type": "list<int>"},
        "type": "list<list<int>>"}
    ]]
  },
  "columns": [{"name": "positions"}, {"name": "nested"}]
}
```

| positions | nested |
|---|---|
| [0,1] | [[1,2],[103]] |

Outside an `each`:

<!-- docs:error SMALT_PLAN -->
```json
{"op": "values", "types": ["int"], "rows": [[{"k": "element", "part": "value", "depth": 0, "type": "int"}]]}
```

## Demo

The counts in each basket larger than the length of its owner's name: the body compares each element with a column
of its row:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [1, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "each", "list": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "list<int>", "collation": "binary"},
        "mode": "filter", "body": {"k": "call", "fn": "cmp_gt", "args": [
          {"k": "element", "part": "value", "depth": 0, "type": "int"},
          {"k": "call", "fn": "length", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}], "type": "int"}
        ], "type": "bool"},
        "type": "list<int>"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "large"}]
}
```

| owner | large |
|---|---|
| Ada | [] |
| Alan | [6] |
| Grace | [] |
| Edsger | NULL |

## See also

- [`each`](./each), [`eachAgg`](./eachAgg)
- [Expressions](./)
