---
description: 'Whether a value equals one of the others: true, false or NULL.'
---

# in_list

```ebnf
in_list ::= '"fn": "in_list"' ', "args": [' X (',' VALUE)* ']'
```

Whether `X` equals one of the `VALUE`s, each compared as [`cmp_eq`](./cmp_eq) compares: SQL's `X IN (…)`. True when one
is equal; else NULL when `X` or a `VALUE` is NULL; else false.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value to look for. |
| `VALUE` | any | The values to look among, any number of them (none gives false). |

## Returns

`bool`: true or false (1 or 0 declared `int`). NULL when `X` is NULL and there is a `VALUE`, or when no `VALUE` equals
`X` and one is NULL.

## Errors

None.

## Notes

- No affinity is applied: `1` is not in `('1')`, nor `'1'` in `(1)`.
- The call's `collation` is not read. Text compares by the collation `X` [carries](../../meaning-fields), `binary` when
  it carries none; with `VALUE`s that aren't constants, each comparison takes the collation its two operands carry, as
  SQLite's `=` would.
- With no `VALUE`, the result is false, even for a NULL `X` (SQLite's `NULL IN ()`).
- A list of constants is turned into a hash set once; other lists are compared value by value.
- NOT IN is [`truth_not`](./truth_not) or a [`not`](../../expressions/not) around the call. For membership in a
  `list<…>` value, see [`list_contains`](../list/list_contains); in a nested plan's rows,
  [`inSubquery`](../../expressions/inSubquery).
- The call's declared `type` says how results show the value: `bool` gives `true` / `false`, `int` gives 1 / 0 (as SQL's
  comparisons do). The value is 0 or 1 either way while the plan runs ([truth values](../../types#truth-values)).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool", "bool", "bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "in_list", "args": [
        {"k": "lit", "value": 2, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "bool"},
      {"k": "call", "fn": "in_list", "args": [
        {"k": "lit", "value": 5, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "bool"},
      {"k": "call", "fn": "in_list", "args": [
        {"k": "lit", "value": 5, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "bool"},
      {"k": "call", "fn": "in_list", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "bool"},
      {"k": "call", "fn": "in_list", "args": [
        {"k": "lit", "value": null, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "bool"},
      {"k": "call", "fn": "in_list", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": "1", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "in_list", "args": [{"k": "lit", "value": null, "type": "int"}], "type": "bool"}
    ]]
  },
  "columns": [
    {"name": "found"},
    {"name": "not_found"},
    {"name": "null_value"},
    {"name": "found_too"},
    {"name": "null_x"},
    {"name": "text"},
    {"name": "none"}
  ]
}
```

| found | not_found | null_value | found_too | null_x | text | none |
|---|---|---|---|---|---|---|
| true | false | NULL | true | NULL | false | false |

## Demo

The red and purple fruit:

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 2]},
    "pred": {"k": "call", "fn": "in_list", "args": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "lit", "value": "red", "type": "text"},
      {"k": "lit", "value": "purple", "type": "text"}
    ], "type": "bool"}
  },
  "columns": [{"name": "name"}, {"name": "color"}]
}
```

| name | color |
|---|---|
| apple | red |
| plum | purple |
| cherry | red |

## See also

- [`cmp_eq`](./cmp_eq), [`list_contains`](../list/list_contains)
- [`inSubquery`](../../expressions/inSubquery)
- [Comparison functions](./)
