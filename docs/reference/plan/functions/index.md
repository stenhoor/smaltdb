---
description: 'The functions a plan can call: the engine''s scalar functions and operations, its aggregates and window functions.'
---

# Functions

A plan calls a function by name. A scalar function is the `fn` of a [`call`](../expressions/call) expression. An
aggregate is a call of an [`aggregate`](../operations/aggregate) or [`pivot`](../operations/pivot) operation, or of
an [`each`](../expressions/each) over a list. A window function is a call of a [`window`](../operations/window)
operation, as an aggregate may be too.

```railroad
call
agg-call
window-call
```

Each function's page has a syntax diagram of its `fn` and `args`. The names in capitals are its arguments, each an
expression:

```ebnf
substr ::= '"fn": "substr"' ', "args": [' TEXT ',' START (',' LENGTH)? ']'
```

The call around them gives the `type` of its value: the type the function's page names, or the one the plan needs
where a function can give several (`coalesce`, `max`).

## Rules they share

- **NULL in, NULL out.** A function given a NULL argument gives NULL, unless its page says otherwise.
- **Operations and functions.** The engine's operations (comparisons, arithmetic, conversions: `cmp_eq`, `add`,
  `cast_integer`, …) are named for what they do ([ADR 0016](../../../adr/0016-plan-api-for-every-language.md)), so a
  language picks the one that gives its syntax its meaning: SQL divides with `div_trunc`, smaltdf with `div_float`.
  Most named functions behave as SQLite's of the same name.
- **Types.** A function takes values of any type unless its page says which. Functions of dates and times, lists and
  maps take the types they name, and a plan that gives them another is refused when it is compiled
  (`SMALT_MISMATCH`). Text and numbers convert as SQLite converts them.
- **The catalog lists them** with the number of arguments each takes and its result type: `db.catalog.functions()`
  ([the catalog](../../engine/catalog#functions)). A plugin can register more.
- **Collations.** A function that compares text (`cmp_eq`, `in_list`, `min`, …) compares by the call's `collation`,
  `binary` when it has none. The collation an argument [carries](../meaning-fields) doesn't change it: a language
  reads that to choose the call's.

## Groups

| Group | |
|---|---|
| [Comparison and logic](./comparison/) | Comparisons in SQLite's order and within one kind, NULL-safe equality, membership, truth |
| [Arithmetic](./arithmetic/) | Addition to division, in SQLite's meaning and checked, floor and float forms; bit operations |
| [Math](./math/) | Rounding, powers, logarithms and trigonometry |
| [Conversion](./conversion/) | SQLite's CAST, strict conversions, dates and times from text, affinity |
| [Text](./text/) | Case, trimming, searching, slicing, formatting, patterns and regular expressions |
| [Dates and times](./temporal/) | Parts, construction, parsing, formatting, truncation, offsets and time zones of `date`, `datetime` and `time` values |
| [Date and time text](./datetime/) | SQLite's date and time functions, over text and numbers |
| [Lists and structs](./list/) | Building lists and structs, reading, slicing, sorting, set operations and statistics over lists |
| [Maps](./map/) | Building maps, reading keys and values, merging |
| [Values under any](./any/) | The type of a value under `any`, and its truth value, list or map |
| [General](./general/) | NULL handling, choice, least and greatest, randomness, errors |
| [Database state](./database/) | Changes made, the last rowid, the engine's version, history |
| [Aggregate](./aggregate/) | Functions over a group of rows: counts, sums, extremes, statistics, lists and text |
| [Window](./window/) | Ranking and navigation over a window's rows |

## Sample data

The examples on these pages run on the [sample data](../sample-data): each starts from it, in a database of its own.
