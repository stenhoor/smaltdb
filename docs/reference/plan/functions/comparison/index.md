---
description: 'Comparisons in SQLite''s order and within one kind, NULL-safe equality, membership and truth.'
---

# Comparison and logic functions

The engine's comparison operations ([ADR 0016](../../../../adr/0016-plan-api-for-every-language.md)). Each gives a truth
value, so a plan uses it as a [`filter`](../../operations/filter)'s predicate, a [`join`](../../operations/join)'s
condition or a column. A language picks the one that gives its syntax its meaning: SQL's `<` is `cmp_lt`, Cypher's is
`cmp_lt_kind`.

- **Truth values.** The result is 0 or 1 while a plan runs. Declared `bool`, a call gives `true` / `false` in results;
  declared `int`, 1 / 0, as SQL's comparisons do ([truth values](../../types#truth-values)).
- **NULL.** `cmp_eq` to `cmp_ge` and the `_kind` comparisons give NULL when an operand is NULL. `cmp_is` and
  `cmp_is_not` treat NULL as a value and are never NULL. `in_list` follows SQL's `IN`, and `truth_not` keeps NULL.
- **Order.** `cmp_eq` to `cmp_ge`, `cmp_is` and `in_list` compare values of every kind in SQLite's storage-class order:
  numbers, then text, then blobs; an `int` and a `real` compare by value. NaN equals NaN and sorts after every number
  ([ADR 0018](../../../../adr/0018-bool-and-nan.md)). The `_kind` comparisons order only two numbers or two texts, and
  give NULL for any other pair.
- **Text.** A comparison compares text by the call's `collation`, `binary` when it has none
  ([collations](../../collations)); `in_list` by the collation its first argument carries. The `_kind` comparisons take
  only `binary`.
- **No conversions.** None applies affinity: `1` and `'1'` are not equal. A language that wants SQLite's affinity wraps
  an operand in [`affinity_numeric`](../conversion/affinity_numeric) or [`affinity_text`](../conversion/affinity_text).

The logic of truth values, `and`, `or` and `not`, are expressions: [`and`](../../expressions/and),
[`or`](../../expressions/or), [`not`](../../expressions/not), [`isNull`](../../expressions/isNull).

## Functions {#functions}

- [`cmp_eq`](./cmp_eq): Whether two values are equal, in SQLite's order: NULL when either is NULL.
- [`cmp_ne`](./cmp_ne): Whether two values differ, in SQLite's order: NULL when either is NULL.
- [`cmp_lt`](./cmp_lt): Whether the first value is less than the second, in SQLite's order of every kind.
- [`cmp_le`](./cmp_le): Whether the first value is less than or equal to the second, in SQLite's order of every kind.
- [`cmp_gt`](./cmp_gt): Whether the first value is greater than the second, in SQLite's order of every kind.
- [`cmp_ge`](./cmp_ge): Whether the first value is greater than or equal to the second, in SQLite's order of every kind.
- [`cmp_lt_kind`](./cmp_lt_kind): Whether the first value is less than the second, for two numbers or two texts; NULL for anything else.
- [`cmp_le_kind`](./cmp_le_kind): Whether the first value is less than or equal to the second, for two numbers or two texts; NULL for anything else.
- [`cmp_gt_kind`](./cmp_gt_kind): Whether the first value is greater than the second, for two numbers or two texts; NULL for anything else.
- [`cmp_ge_kind`](./cmp_ge_kind): Whether the first value is greater than or equal to the second, for two numbers or two texts; NULL for anything else.
- [`cmp_is`](./cmp_is): Whether two values are equal, NULL equal to NULL: never NULL.
- [`cmp_is_not`](./cmp_is_not): Whether two values differ, NULL equal to NULL: never NULL.
- [`in_list`](./in_list): Whether a value equals one of the others: true, false or NULL.
- [`truth_not`](./truth_not): The truth value of a value, negated: true for false, false for true, NULL for NULL.
