---
description: 'The elements of a list without repeats, the first of each, in order.'
---

# list_unique

```ebnf
list_unique ::= '"fn": "list_unique"' ', "args": [' LIST ']'
```

The elements of a list without repeats: the first of each set of equal elements, in the list's order.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<T>` | The list. |

## Returns

`list<T>`, the list's type. NULL when `LIST` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |

## Notes

- Elements are equal as SQLite compares them, by the `binary` collation: `1` and `1.0` are one value; `'a'` and `'A'`
  are two. NULL elements are one value.
- [`list_n_unique`](./list_n_unique) counts the distinct elements.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<int>", "list<text>", "list<int>"],
    "rows": [[
      {"k": "call", "fn": "list_unique", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_unique", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": null, "type": "text"},
          {"k": "lit", "value": "A", "type": "text"},
          {"k": "lit", "value": null, "type": "text"},
          {"k": "lit", "value": "a", "type": "text"}
        ], "type": "list<text>"}
      ], "type": "list<text>"},
      {"k": "call", "fn": "list_unique", "args": [{"k": "lit", "value": null, "type": "list<int>"}], "type": "list<int>"}
    ]]
  },
  "columns": [{"name": "ints"}, {"name": "nulls"}, {"name": "null"}]
}
```

| ints | nulls | null |
|---|---|---|
| [2,1,3] | ["a",null,"A"] | NULL |

## Demo

The fruit colours, each once, from the list of every fruit's colour:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "aggregate",
      "input": {"op": "scan", "table": "fruit", "columns": [2]},
      "keys": [],
      "aggs": [
        {
          "fn": "implode",
          "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}],
          "star": false,
          "distinct": false,
          "collation": "binary",
          "type": "list<text>"
        }
      ],
      "carry": []
    },
    "exprs": [
      {"k": "call", "fn": "list_unique", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "list<text>", "collation": "binary"}
      ], "type": "list<text>"}
    ]
  },
  "columns": [{"name": "colors"}]
}
```

| colors |
|---|
| ["red","green","purple"] |

## See also

- [`list_n_unique`](./list_n_unique), [`list_union`](./list_union), [`list_sort`](./list_sort)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
