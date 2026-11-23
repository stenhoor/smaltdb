---
description: 'A group''s values as a list, in the group''s order, NULLs included.'
---

# implode

```ebnf
implode ::= '"fn": "implode"' ', "args": [' X ']'
```

The values of `X` in a group, as a list: one element per row, in the order of the group's rows, NULLs included ([ADR
0020](../../../../adr/0020-lists-and-structs.md)). An aggregate: a call in an
[`aggregate`](../../operations/aggregate)'s `aggs` (or a [`window`](../../operations/window)'s `calls`, over a frame).
The opposite of an [`explode`](../../operations/explode).

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. |

## Returns

`list<T>`, where `T` is the type of `X` (`list<any>` for a NULL literal). An empty list `[]` for a group with no rows;
never NULL.

## Errors

None.

## Notes

- The elements come in the order of the group's rows, as the aggregate's input gives them: sort the input to choose it.
- With `distinct`, each different value once, and no NULL.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "values",
      "types": ["int"],
      "rows": [
        [{"k": "lit", "value": 3, "type": "int"}],
        [{"k": "lit", "value": null, "type": "int"}],
        [{"k": "lit", "value": 1, "type": "int"}],
        [{"k": "lit", "value": 3, "type": "int"}]
      ]
    },
    "keys": [],
    "aggs": [
      {"fn": "implode", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "list<int>"},
      {"fn": "implode", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": true, "collation": "binary", "type": "list<int>"},
      {"fn": "implode", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": false, "filter": {"k": "lit", "value": 0, "type": "bool"}, "collation": "binary", "type": "list<int>"}
    ],
    "carry": []
  },
  "columns": [{"name": "values"}, {"name": "distinct"}, {"name": "no rows"}]
}
```

| values | distinct | no rows |
|---|---|---|
| [3,null,1,3] | [3,1] | [] |

## Demo

The fruit ordered each day, in order:

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "scan",
      "table": "orders",
      "columns": [0, 1, 2, 3]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "date", "collation": "binary"}, "collation": "binary"}
    ],
    "aggs": [
      {"fn": "implode", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "list<int>"}
    ],
    "carry": [],
    "ordered": "first"
  },
  "columns": [{"name": "day"}, {"name": "fruit"}]
}
```

| day | fruit |
|---|---|
| 2026-11-02 | [1,2] |
| 2026-11-03 | [1] |
| 2026-11-04 | [4] |
| 2026-11-05 | [3,1] |

## See also

- [`group_concat`](./group_concat), [`min_list`](./min_list), [`explode`](../../operations/explode), [`list_of`](../list/list_of)
- [Aggregate functions](./)
