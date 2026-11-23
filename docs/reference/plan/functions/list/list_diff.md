---
description: 'Each element of a list of numbers less the one some places before it.'
---

# list_diff

```ebnf
list_diff ::= '"fn": "list_diff"' ', "args": [' LIST (',' N)? ']'
```

Each element of a list of numbers less the one `N` places before it, as Polars' `diff`. The first `N` places have none
before them and are NULL.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<int>`, `list<real>`, `list<num>`, `list<bool>` or `list<any>` | The list, of numbers. |
| `N` | `int` | Optional: how many places back. Left out, 1; negative takes the element `-N` places after. |

## Returns

`list<int>` for a list of `int` or `bool`, else the list's type. NULL when `LIST` or `N` is NULL; an element is NULL
where either number is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `LIST` isn't typed as a list of numbers (when the plan is compiled), an element isn't a number, or `N` isn't an integer. |

## Notes

- Integers subtract exactly, beyond 2^53 too.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<int>", "list<int>", "list<int>", "list<real>", "list<int>"],
    "rows": [[
      {"k": "call", "fn": "list_diff", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"},
          {"k": "lit", "value": 9, "type": "int"},
          {"k": "lit", "value": 16, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_diff", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"},
          {"k": "lit", "value": 9, "type": "int"},
          {"k": "lit", "value": 16, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_diff", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"},
          {"k": "lit", "value": 9, "type": "int"},
          {"k": "lit", "value": 16, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": -1, "type": "int"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_diff", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1.5, "type": "real"},
          {"k": "lit", "value": null, "type": "real"},
          {"k": "lit", "value": 4, "type": "real"}
        ], "type": "list<real>"}
      ], "type": "list<real>"},
      {"k": "call", "fn": "list_diff", "args": [{"k": "lit", "value": null, "type": "list<int>"}], "type": "list<int>"}
    ]]
  },
  "columns": [{"name": "steps"}, {"name": "two_back"}, {"name": "ahead"}, {"name": "with_null"}, {"name": "null"}]
}
```

| steps | two_back | ahead | with_null | null |
|---|---|---|---|---|
| [null,3,5,7] | [null,null,8,12] | [-3,-5,-7,null] | [null,null,null] | NULL |

A list of text is refused:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<int>"],
    "rows": [[
      {"k": "call", "fn": "list_diff", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": "b", "type": "text"}
        ], "type": "list<text>"}
      ], "type": "list<int>"}
    ]]
  },
  "columns": [{"name": "d"}]
}
```

## Demo

The prices of the fruit, in order of id, and each one's change from the one before:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "aggregate",
      "input": {"op": "scan", "table": "fruit", "columns": [3]},
      "keys": [],
      "aggs": [
        {
          "fn": "implode",
          "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "real", "collation": "binary"}],
          "star": false,
          "distinct": false,
          "collation": "binary",
          "type": "list<real>"
        }
      ],
      "carry": []
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "list<real>", "collation": "binary"},
      {"k": "call", "fn": "list_diff", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "list<real>", "collation": "binary"}
      ], "type": "list<real>"}
    ]
  },
  "columns": [{"name": "price"}, {"name": "change"}]
}
```

| price | change |
|---|---|
| [0.5,0.75,1.25,3,0.4] | [null,0.25,0.5,1.75,-2.6] |

## See also

- [`list_shift`](./list_shift), [`list_sum`](./list_sum)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
