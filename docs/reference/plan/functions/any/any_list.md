---
description: 'A list under `any` as a `list<any>`, else NULL.'
---

# any_list

```ebnf
any_list ::= '"fn": "any_list"' ', "args": [' X ']'
```

A list under `any` as a `list<any>`, else NULL. Its elements keep their types, as values under `any`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | `any` | The value. |

## Returns

`list<any>`. NULL when `X` isn't a list or is NULL.

## Errors

None.

## Notes

- Give it a value typed `any`. A value whose type the plan knows reaches it as the engine holds that type (a `bool`
  as an integer, a list as a blob), so it isn't read as a typed value: `any_list` of an expression typed `bool` or
  `list<int>` gives NULL.
- The result is a list the [list functions](../list/) take.

## Examples

The function over each element of a list of mixed types, with [`each`](../../expressions/each): its elements are
values under `any`, `1`, `'a'`, a `bool`, NULL, a `list<int>` and a `map<text, int>`:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<list<any>>"],
    "rows": [[
      {"k": "each", "list": {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 1, "type": "bool"},
          {"k": "lit", "value": null, "type": "null"},
          {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": 2, "type": "int"}], "type": "list<int>"},
          {"k": "call", "fn": "map_of", "args": [{"k": "lit", "value": "k", "type": "text"}, {"k": "lit", "value": 1, "type": "int"}], "type": "map<text, int>"}
        ], "type": "list<any>"},
        "mode": "map",
        "body": {"k": "call", "fn": "any_list", "args": [{"k": "element", "part": "value", "depth": 0, "type": "any"}], "type": "list<any>"},
        "type": "list<list<any>>"}
    ]]
  },
  "columns": [{"name": "any_list"}]
}
```

| any_list |
|---|
| [null,null,null,null,[1,2],null] |

## Demo

Each basket as a map of mixed values, its items and its owner, then the items read back as a list. The owner is text,
not a list:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [1, 2]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "any_list", "args": [{"k": "call", "fn": "map_get", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "items", "type": "text"},
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "list<text>", "collation": "binary"},
          {"k": "lit", "value": "owner", "type": "text"},
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}
        ], "type": "map<text, any>"},
        {"k": "lit", "value": "items", "type": "text"}
      ], "type": "any"}], "type": "list<any>"},
      {"k": "call", "fn": "any_list", "args": [{"k": "call", "fn": "map_get", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "items", "type": "text"},
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "list<text>", "collation": "binary"},
          {"k": "lit", "value": "owner", "type": "text"},
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}
        ], "type": "map<text, any>"},
        {"k": "lit", "value": "owner", "type": "text"}
      ], "type": "any"}], "type": "list<any>"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "items"}, {"name": "not_a_list"}]
}
```

| owner | items | not_a_list |
|---|---|---|
| Ada | ["apple","pear"] | NULL |
| Alan | ["plum"] | NULL |
| Grace | [] | NULL |
| Edsger | NULL | NULL |

## See also

- [`any_type`](./any_type), [`any_bool`](./any_bool), [`any_map`](./any_map)
- [Values under any](./)
- [`call`](../../expressions/call): how a plan calls a function
