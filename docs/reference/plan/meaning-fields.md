---
description: 'The optional fields any expression or operation may carry: carries, affinity, inline, decorrelate and origin.'
---

# Meaning fields

Any expression, and any operation, may carry a few optional fields besides its own
([ADR 0016](../../adr/0016-plan-api-for-every-language.md), section 2). A plan that states every collation and
conversion on its calls needs none of them.

```railroad
expr-meaning
carries
affinity
op-meaning
```

| Field | On | |
|---|---|---|
| `carries` | expressions | `{"collation", "from"}`: the collation the value brings to a comparison, and where it came from, `explicit` (stated on the value, SQL's `COLLATE`) or `column` (a column's) |
| `affinity` | expressions | `INTEGER`, `REAL`, `NUMERIC`, `TEXT` or `BLOB`: the conversion a comparison applies to the other operand (SQLite's column affinity) |
| `inline` | expressions | `false`: code generation leaves this expression whole to the general evaluator. The results are the same either way |
| `decorrelate` | operations | `false`: the planner doesn't rewrite the correlated subqueries of this operation into joins. The results are the same either way |
| `origin` | expressions and operations | Where the node came from in the language that built the plan (a SQL text span, a call site): plain JSON data the engine never reads, given back on errors |

## carries and affinity

`carries` and `affinity` describe a value for the comparisons a language builds over it. They don't change what a
comparison call does: a [`cmp_eq`](./functions/comparison/cmp_eq) compares by its own `collation`, and converts an
operand only where the plan calls [`affinity_numeric`](./functions/conversion/affinity_numeric) or
[`affinity_text`](./functions/conversion/affinity_text) on it. A few functions and operations do read `carries`: `in_list`, `min`, `max`, `nullif`, the aggregates,
`inSubquery` and `setop` compare by the collation their first argument or input carries ([collations](./collations)).
A language reads both fields to choose a comparison's collation and conversions:

- `comparisonRule(a, b)` in `smaltdb/language` gives the comparison SQLite's rules make of two operands with these
  fields: the collation (an explicit one first, then a column's, the left operand's before the right's; `binary` with
  none) and the conversion to apply to each side.
- `catalog.describe(expr)` gives what an expression carries, passed up from what it's made of (a cast keeps its
  operand's collation), so a language binding over a view or a stored plan applies its rules to it.

The comparison below compares by `binary`, its own collation, although its left operand carries `nocase`:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "lit", "value": "Apple", "type": "text", "carries": {"collation": "nocase", "from": "explicit"}},
        {"k": "lit", "value": "apple", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "lit", "value": "Apple", "type": "text", "carries": {"collation": "nocase", "from": "explicit"}},
        {"k": "lit", "value": "apple", "type": "text"}
      ], "type": "bool", "collation": "nocase"}
    ]]
  },
  "columns": [{"name": "binary"}, {"name": "nocase"}]
}
```

| binary | nocase |
|---|---|
| false | true |

## origin

An error raised in an expression carries the `origin` of the innermost expression around it that has one; an error
while a write runs (a constraint that fails) carries the origin of the write's operation. It is the error's `origin`
field ([errors](../api/errors)), so a language can point at its own source. Here the conversion fails inside an `add`
whose origin is `{"line": 1, "col": 8}`, and the error carries it:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "op": "values",
  "types": ["int"],
  "rows": [[
    {"k": "call", "fn": "add", "args": [
      {"k": "call", "fn": "cast_integer_strict", "args": [{"k": "lit", "value": "x", "type": "text"}], "type": "int"},
      {"k": "lit", "value": 1, "type": "int"}
    ], "type": "int", "origin": {"line": 1, "col": 8}}
  ]]
}
```

An origin must be plain data: strings, finite numbers, booleans, `null`, and arrays and objects of them
(`SMALT_PLAN` otherwise).

## inline and decorrelate

Both say how the engine runs a plan, never what it gives. SQL marks a SELECT whose views or FROM subqueries it merged
with `decorrelate: false`, since decorrelation reads a subquery as it was written; `inline: false` keeps an
expression from being split or rewritten by optimizations.

## See also

- [Collations](./collations)
- [Writing a language](../engine/languages)
