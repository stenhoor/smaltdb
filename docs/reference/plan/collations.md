---
description: 'How text compares and sorts: binary, nocase and rtrim, named on every comparison, sort and grouping.'
---

# Collations

A collation is how text compares and sorts. A plan names one wherever text is compared: on a comparison
[`call`](./expressions/call), a sort key, a grouping key, a partition, a [`distinct`](./operations/distinct) column,
a [`setop`](./operations/setop) column, and on a [`col`](./expressions/col) (the collation of the column it reads).

```railroad
collation
```

| Collation | Text compares |
|---|---|
| `binary` | by its bytes (UTF-8): `B` sorts before `a` |
| `nocase` | ignoring the case of ASCII letters: `apple` equals `APPLE`, but `Ä` doesn't equal `ä` |
| `rtrim` | ignoring trailing spaces: `apple  ` equals `apple` |

A collation applies to text only: numbers, blobs and other values compare as they always do.

## Where a plan names one

| Where | Field | Without it |
|---|---|---|
| A comparison, `in_list`, `min`, `max` and the other functions that compare | the call's `collation` | `binary` |
| A [sort key](./operations/sort) | `collation` | required |
| A grouping key of an [`aggregate`](./operations/aggregate) or [`pivot`](./operations/pivot), a [`window`](./operations/window)'s partition | `collation` | required |
| An aggregate call (`min`, `max`, `group_concat` …) | `collation` | required |
| [`distinct`](./operations/distinct), [`setop`](./operations/setop), [`iterate`](./operations/iterate) | `collations`, one per column | required |
| A [`col`](./expressions/col) | `collation`: the column's own | required |
| A [`subquery`](./expressions/subquery) or [`inSubquery`](./expressions/inSubquery) | `collation` | required |

An aggregate call, and [`in_list`](./functions/comparison/in_list), are the exceptions: they compare by the collation
their first argument [carries](./meaning-fields), whatever the call's `collation` says (see their pages). Otherwise,
a comparison compares by its own `collation` and nothing else: the collation of a `col` it reads, and the one an
operand [carries](./meaning-fields), don't change it. They tell a language which collation to put on the comparisons
it builds, as SQL's rules choose one from its operands.

Another name is refused: `SMALT_PLAN`. A language with other collations (Unicode-aware ones) needs the engine to have
them first.

## Examples

The same comparisons, by each collation:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "cmp_eq", "args": [{"k": "lit", "value": "Apple", "type": "text"}, {"k": "lit", "value": "apple", "type": "text"}], "type": "bool", "collation": "binary"},
      {"k": "call", "fn": "cmp_eq", "args": [{"k": "lit", "value": "Apple", "type": "text"}, {"k": "lit", "value": "apple", "type": "text"}], "type": "bool", "collation": "nocase"},
      {"k": "call", "fn": "cmp_eq", "args": [{"k": "lit", "value": "Äpfel", "type": "text"}, {"k": "lit", "value": "äpfel", "type": "text"}], "type": "bool", "collation": "nocase"},
      {"k": "call", "fn": "cmp_eq", "args": [{"k": "lit", "value": "apple  ", "type": "text"}, {"k": "lit", "value": "apple", "type": "text"}], "type": "bool", "collation": "rtrim"}
    ]]
  },
  "columns": [{"name": "binary"}, {"name": "nocase"}, {"name": "nocase, not ASCII"}, {"name": "rtrim"}]
}
```

| binary | nocase | nocase, not ASCII | rtrim |
|---|---|---|---|
| false | true | false | true |

Sorting by `binary` puts every upper-case letter before every lower-case one. By `nocase`, `a` and `A` are equal, and
keep the order they came in:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "project",
      "input": {"op": "values", "types": ["text"], "rows": [
        [{"k": "lit", "value": "b", "type": "text"}], [{"k": "lit", "value": "B", "type": "text"}],
        [{"k": "lit", "value": "a", "type": "text"}], [{"k": "lit", "value": "A", "type": "text"}]
      ]},
      "exprs": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "nocase"}
    ]
  },
  "columns": [{"name": "letter"}]
}
```

| letter |
|---|
| a |
| A |
| b |
| B |

Grouping by `nocase` puts `Red` with `red`. After an `append` of a fruit whose colour is written `Red`:

```json
{
  "kind": "write",
  "plan": {
    "op": "append",
    "table": "fruit",
    "db": "main",
    "input": {"op": "values", "types": ["text", "text"], "rows": [[{"k": "lit", "value": "radish", "type": "text"}, {"k": "lit", "value": "Red", "type": "text"}]]},
    "columns": [1, 2],
    "upserts": []
  }
}
```

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "aggregate",
      "input": {"op": "scan", "table": "fruit", "columns": [2]},
      "keys": [{"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}, "collation": "nocase"}],
      "aggs": [{"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"}],
      "carry": []
    },
    "keys": [{"expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}, "desc": true, "nullsFirst": false, "collation": "binary"}]
  },
  "columns": [{"name": "color"}, {"name": "fruit"}]
}
```

| color | fruit |
|---|---|
| red | 3 |
| green | 2 |
| purple | 1 |

A group's key is the value of one of its rows: here `red`.

## See also

- [Types](./types)
- [`cmp_eq`](./functions/comparison/cmp_eq) and the other [comparisons](./functions/comparison/)
- [Meaning fields](./meaning-fields): `carries`
