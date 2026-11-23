---
description: 'Whether every non-NULL element of a list is true.'
---

# list_all

```ebnf
list_all ::= '"fn": "list_all"' ', "args": [' LIST ']'
```

Whether every non-NULL element of a list is true. A list with no such element gives true.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<bool>`, or another list | The list. Each element is taken as its truth value, as a `filter` takes one: a number is true when it isn't 0, text by the number it starts with. |

## Returns

`bool`. NULL when `LIST` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |

## Notes

- NULL elements are passed over: `[true, NULL]` gives true. [`list_any`](./list_any) is its counterpart.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "list_all", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "bool"},
          {"k": "lit", "value": 1, "type": "bool"}
        ], "type": "list<bool>"}
      ], "type": "bool"},
      {"k": "call", "fn": "list_all", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "bool"},
          {"k": "lit", "value": 0, "type": "bool"}
        ], "type": "list<bool>"}
      ], "type": "bool"},
      {"k": "call", "fn": "list_all", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "bool"},
          {"k": "lit", "value": null, "type": "bool"}
        ], "type": "list<bool>"}
      ], "type": "bool"},
      {"k": "call", "fn": "list_all", "args": [{"k": "call", "fn": "list_of", "args": [], "type": "list<bool>"}], "type": "bool"},
      {"k": "call", "fn": "list_all", "args": [{"k": "lit", "value": null, "type": "list<bool>"}], "type": "bool"}
    ]]
  },
  "columns": [{"name": "all_true"}, {"name": "one_false"}, {"name": "with_null"}, {"name": "empty"}, {"name": "null"}]
}
```

| all_true | one_false | with_null | empty | null |
|---|---|---|---|---|
| true | false | true | true | NULL |

## Demo

Whether every count in each basket is more than 1. An [`each`](../../expressions/each) makes the list of truth values:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [0, 1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "list_all", "args": [
        {
          "k": "each",
          "list": {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "list<int>", "collation": "binary"},
          "mode": "map",
          "body": {"k": "call", "fn": "cmp_gt", "args": [
            {"k": "element", "part": "value", "depth": 0, "type": "int"},
            {"k": "lit", "value": 1, "type": "int"}
          ], "type": "bool"},
          "type": "list<bool>"
        }
      ], "type": "bool"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "all_over_1"}]
}
```

| owner | all_over_1 |
|---|---|
| Ada | false |
| Alan | true |
| Grace | true |
| Edsger | NULL |

## See also

- [`list_any`](./list_any), [`list_contains`](./list_contains)
- [`each`](../../expressions/each)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
