---
description: 'A value under `any` as a `bool` when it is one, else NULL.'
---

# any_bool

```ebnf
any_bool ::= '"fn": "any_bool"' ', "args": [' X ']'
```

A value under `any` as a `bool` when it is one, else NULL. A typed `bool` is not the integer `1` or `0`: this
reads one back as a `bool`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | `any` | The value. |

## Returns

`bool`. NULL when `X` isn't a `bool` (an integer `1` included) or is NULL.

## Errors

None.

## Notes

- Give it a value typed `any`. A value whose type the plan knows reaches it as the engine holds that type (a `bool`
  as an integer, a list as a blob), so it isn't read as a typed value: `any_bool` of an expression typed `bool` or
  `list<int>` gives NULL.

## Examples

The function over each element of a list of mixed types, with [`each`](../../expressions/each): its elements are
values under `any`, `1`, `'a'`, a `bool`, NULL, a `list<int>` and a `map<text, int>`:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<bool>"],
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
        "body": {"k": "call", "fn": "any_bool", "args": [{"k": "element", "part": "value", "depth": 0, "type": "any"}], "type": "bool"},
        "type": "list<bool>"}
    ]]
  },
  "columns": [{"name": "any_bool"}]
}
```

| any_bool |
|---|
| [null,null,true,null,null,null] |

## Demo

A map of mixed values for each fruit, whether it is red and its stock, then the truth value read back from it: the
stock is an integer, not a `bool`, so it gives NULL:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 2, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "any_bool", "args": [{"k": "call", "fn": "map_get", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "red", "type": "text"},
          {"k": "call", "fn": "cmp_eq", "args": [
            {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
            {"k": "lit", "value": "red", "type": "text"}
          ], "type": "bool"},
          {"k": "lit", "value": "qty", "type": "text"},
          {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
        ], "type": "map<text, any>"},
        {"k": "lit", "value": "red", "type": "text"}
      ], "type": "any"}], "type": "bool"},
      {"k": "call", "fn": "any_bool", "args": [{"k": "call", "fn": "map_get", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "red", "type": "text"},
          {"k": "call", "fn": "cmp_eq", "args": [
            {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
            {"k": "lit", "value": "red", "type": "text"}
          ], "type": "bool"},
          {"k": "lit", "value": "qty", "type": "text"},
          {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
        ], "type": "map<text, any>"},
        {"k": "lit", "value": "qty", "type": "text"}
      ], "type": "any"}], "type": "bool"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "red"}, {"name": "qty"}]
}
```

| name | red | qty |
|---|---|---|
| apple | true | NULL |
| pear | false | NULL |
| plum | false | NULL |
| cherry | true | NULL |
| lime | false | NULL |

## See also

- [`any_type`](./any_type), [`any_list`](./any_list), [`any_map`](./any_map)
- [Values under any](./)
- [`call`](../../expressions/call): how a plan calls a function
