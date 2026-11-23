---
description: 'The value of the first branch whose condition is true, else the `else` value.'
---

# case

```railroad
case
when
```

The value of the first branch whose condition is true, else the `else` value: SQL's searched `CASE`.

## Fields

| Field | Type | |
|---|---|---|
| `whens` | branches | The branches, in order, each `{"when": condition, "then": value}`. May be empty. |
| `else` | expression | The value when no condition is true. A language without an `ELSE` gives a NULL [literal](./lit). |
| `type` | [type](../types) | The type of the value. |

and the [meaning fields](../meaning-fields) of an expression.

## Value

The `then` of the first branch whose `when` is true; `else` when none is (a condition that is false or NULL doesn't
choose its branch).

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | `else` is missing, or a branch isn't an object of a `when` and a `then`. |

## Notes

- Conditions are read in order, and only the chosen value is evaluated: an error in a branch not taken (a
  [`raise_error`](../functions/general/raise_error)) isn't raised.
- A condition is true when it is a non-zero number; text reads as a number (`'2'` is true).
- `type` is what the plan states; the engine doesn't check the branches' values against it. Give branches of one
  type, or convert them.
- A simple `CASE x WHEN v …` is a searched one whose conditions compare `x` with each `v`
  ([`cmp_eq`](../functions/comparison/cmp_eq)).
- [`iif`](../functions/general/iif) is the same choice as a function.

## Examples

The first true branch, a NULL condition, and no branches:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text"],
    "rows": [[
      {"k": "case", "whens": [
        {"when": {"k": "lit", "value": 0, "type": "bool"}, "then": {"k": "lit", "value": "a", "type": "text"}},
        {"when": {"k": "lit", "value": 1, "type": "bool"}, "then": {"k": "lit", "value": "b", "type": "text"}}
      ], "else": {"k": "lit", "value": "c", "type": "text"}, "type": "text"},
      {"k": "case", "whens": [
        {"when": {"k": "lit", "value": null, "type": "bool"}, "then": {"k": "lit", "value": "a", "type": "text"}}
      ], "else": {"k": "lit", "value": "c", "type": "text"}, "type": "text"},
      {"k": "case", "whens": [], "else": {"k": "lit", "value": null, "type": "text"}, "type": "text"}
    ]]
  },
  "columns": [{"name": "second"}, {"name": "null_when"}, {"name": "no_branch"}]
}
```

| second | null_when | no_branch |
|---|---|---|
| b | c | NULL |

## Demo

Each fruit's price band:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "case", "whens": [
        {"when": {"k": "call", "fn": "cmp_lt", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
          {"k": "lit", "value": 0.5, "type": "real"}
        ], "type": "bool"}, "then": {"k": "lit", "value": "cheap", "type": "text"}},
        {"when": {"k": "call", "fn": "cmp_lt", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
          {"k": "lit", "value": 2, "type": "real"}
        ], "type": "bool"}, "then": {"k": "lit", "value": "fair", "type": "text"}}
      ], "else": {"k": "lit", "value": "dear", "type": "text"}, "type": "text"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "band"}]
}
```

| name | band |
|---|---|
| apple | fair |
| pear | fair |
| plum | fair |
| cherry | dear |
| lime | cheap |

## See also

- [`iif`](../functions/general/iif), [`coalesce`](../functions/general/coalesce)
- [`and`](./and), [`or`](./or)
- [Expressions](./)
