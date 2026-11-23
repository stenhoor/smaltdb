---
description: 'The least of the lists a group''s rows make of its arguments.'
---

# min_list

```ebnf
min_list ::= '"fn": "min_list"' ', "args": [' X (',' X)* ']'
```

The least of the lists that a group's rows make of the arguments: what `min` of [`list_of`](../list/list_of)`(X, …)`
gives, without a list made for every row. So it gives the values of the row that is first by the first argument, then
the second, and so on. An aggregate: a call in an [`aggregate`](../../operations/aggregate)'s `aggs` (or a
[`window`](../../operations/window)'s `calls`, over a frame).

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | A value of the row's list: one or more. |

## Returns

`list<T>` when every argument has the type `T`, else `list<any>`, whose elements keep their types. NULL when the group
has no rows.

## Errors

None.

## Notes

- Lists compare element by element, in the engine's order of values; a NULL element comes before any other value, so a
  row is not skipped for a NULL.
- Of rows whose lists are equal, the first is kept: the same list either way.
- `distinct` doesn't change the result.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "values",
      "types": ["int", "text"],
      "rows": [
        [{"k": "lit", "value": 2, "type": "int"}, {"k": "lit", "value": "b", "type": "text"}],
        [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": "z", "type": "text"}],
        [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": "y", "type": "text"}],
        [{"k": "lit", "value": null, "type": "int"}, {"k": "lit", "value": "a", "type": "text"}]
      ]
    },
    "keys": [],
    "aggs": [
      {"fn": "min_list", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "list<any>"},
      {"fn": "min_list", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"}
      ], "star": false, "distinct": false, "filter": {"k": "call", "fn": "cmp_ge", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "bool"}, "collation": "binary", "type": "list<any>"},
      {"fn": "min_list", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "filter": {"k": "lit", "value": 0, "type": "bool"}, "collation": "binary", "type": "list<int>"}
    ],
    "carry": []
  },
  "columns": [{"name": "least"}, {"name": "without NULL"}, {"name": "no rows"}]
}
```

| least | without NULL | no rows |
|---|---|---|
| [null,"a"] | [1,"y"] | NULL |

## Demo

The cheapest fruit of each colour, with its price:

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "scan",
      "table": "fruit",
      "columns": [0, 1, 2, 3, 4]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "text", "collation": "binary"}, "collation": "binary"}
    ],
    "aggs": [
      {"fn": "min_list", "args": [
        {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "real", "collation": "binary"},
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "list<any>"}
    ],
    "carry": [],
    "ordered": "first"
  },
  "columns": [{"name": "color"}, {"name": "cheapest"}]
}
```

| color | cheapest |
|---|---|
| red | [0.5,"apple"] |
| green | [0.4,"lime"] |
| purple | [1.25,"plum"] |

## See also

- [`min`](./min), [`first`](./first), [`implode`](./implode)
- [Aggregate functions](./)
