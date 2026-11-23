---
description: 'The type of a value under `any`, as text.'
---

# any_type

```ebnf
any_type ::= '"fn": "any_type"' ', "args": [' X ']'
```

The type of a value under `any`, as text: `null`, `int`, `real`, `text`, `blob`, `bool`, or a list, struct or map
type such as `list<int>`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | `any` | The value. |

## Returns

`text`. Never NULL: a NULL value gives `null`.

## Errors

None.

## Notes

- A number is `int` when it is a whole number, else `real`: a whole-number `real` under `any` gives `int`.
- Give it a value typed `any`. A value whose type the plan knows reaches it as the engine holds that type (a `bool`
  as an integer, a list as a blob), so it isn't read as a typed value: `any_type` of an expression typed `bool` or
  `list<int>` gives `int` and `blob`.
- [`typeof`](../general/typeof) gives SQLite's storage class instead (`integer`, `real`, `text`, `blob`, `null`), and
  `blob` for a typed value.

## Examples

The function over each element of a list of mixed types, with [`each`](../../expressions/each): its elements are
values under `any`, `1`, `'a'`, a `bool`, NULL, a `list<int>` and a `map<text, int>`:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<text>"],
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
        "body": {"k": "call", "fn": "any_type", "args": [{"k": "element", "part": "value", "depth": 0, "type": "any"}], "type": "text"},
        "type": "list<text>"}
    ]]
  },
  "columns": [{"name": "any_type"}]
}
```

| any_type |
|---|
| ["int","text","bool","null","list<int>","map<text, int>"] |

## Demo

The types of each person's properties, the values of a `map<text, any>`:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "node", "columns": [0, 1]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "each", "list": {"k": "call", "fn": "map_values", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "map<text, any>", "collation": "binary"}], "type": "list<any>"},
        "mode": "map",
        "body": {"k": "call", "fn": "any_type", "args": [{"k": "element", "part": "value", "depth": 0, "type": "any"}], "type": "text"},
        "type": "list<text>"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "types"}]
}
```

| id | types |
|---|---|
| 0 | ["int","text"] |
| 1 | ["int","text"] |
| 2 | ["int","text"] |
| 3 | ["int","text"] |

## See also

- [`any_bool`](./any_bool), [`any_list`](./any_list), [`any_map`](./any_map)
- [Values under any](./)
- [`call`](../../expressions/call): how a plan calls a function
