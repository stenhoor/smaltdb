---
description: 'The truth value of a value, negated: true for false, false for true, NULL for NULL.'
---

# truth_not

```ebnf
truth_not ::= '"fn": "truth_not"' ', "args": [' X ']'
```

True when `X` is false, false when it is true, NULL when it is NULL: SQL's `NOT`, as a function. A value of any type has
a truth value: a number is true when it isn't zero, and text and blobs take the number they begin with.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value to negate. |

## Returns

`bool`: true or false (1 or 0 declared `int`). NULL when `X` is NULL.

## Errors

None.

## Notes

- Text is true when it begins with a non-zero number (`'1x'`), and false otherwise (`'abc'`), as in SQLite.
- NaN is not zero, so it is true and `truth_not` gives false.
- The [`not`](../../expressions/not) expression gives the same values.
- The call's declared `type` says how results show the value: `bool` gives `true` / `false`, `int` gives 1 / 0 (as SQL's
  comparisons do). The value is 0 or 1 either way while the plan runs ([truth values](../../types#truth-values)).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool", "bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "truth_not", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "bool"},
      {"k": "call", "fn": "truth_not", "args": [{"k": "lit", "value": 2, "type": "int"}], "type": "bool"},
      {"k": "call", "fn": "truth_not", "args": [{"k": "lit", "value": 0.5, "type": "real"}], "type": "bool"},
      {"k": "call", "fn": "truth_not", "args": [{"k": "lit", "value": "abc", "type": "text"}], "type": "bool"},
      {"k": "call", "fn": "truth_not", "args": [{"k": "lit", "value": "1x", "type": "text"}], "type": "bool"},
      {"k": "call", "fn": "truth_not", "args": [{"k": "lit", "value": null, "type": "int"}], "type": "bool"}
    ]]
  },
  "columns": [{"name": "zero"}, {"name": "two"}, {"name": "half"}, {"name": "abc"}, {"name": "one_x"}, {"name": "null"}]
}
```

| zero | two | half | abc | one_x | null |
|---|---|---|---|---|---|
| true | false | false | true | false | NULL |

## Demo

The fruit that do not have more than 5 in stock. Plum's stock is NULL, so is the negation, and the filter drops it:

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "pred": {"k": "call", "fn": "truth_not", "args": [
      {"k": "call", "fn": "cmp_gt", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 5, "type": "int"}
      ], "type": "bool"}
    ], "type": "bool"}
  },
  "columns": [{"name": "name"}, {"name": "qty"}]
}
```

| name | qty |
|---|---|
| pear | 4 |
| lime | 0 |

## See also

- [`not`](../../expressions/not), [`and`](../../expressions/and), [`or`](../../expressions/or)
- [`any_bool`](../any/any_bool)
- [Comparison functions](./)
