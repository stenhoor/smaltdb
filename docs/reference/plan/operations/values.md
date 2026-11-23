---
description: 'Rows given in the plan: expressions over no columns, or columns of data.'
---

# values

```railroad
values
row
value-column
typed-array
```

Rows given in the plan: expressions over no columns, or columns of data. A plan that needs a row of constants, a small
table written inline, or data from the application reads it with `values`.

## Fields

| Field | Type | |
|---|---|---|
| `rows` | rows of expressions | The rows, each a list of one expression per column. An expression reads no columns: [literals](../expressions/lit), [parameters](../expressions/param), calls and subqueries over them. Empty when the values are given as `columns`. |
| `types` | [types](../types) | One type per column. |
| `columns` | [value columns](#value-columns) | Optional: the values as data, one column per type, all of one length. `rows` must then be empty. |

## Output

One column for each of `types`, of that type.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | A row doesn't have one expression per type, an expression reads a column, `columns` doesn't have one column per type, its columns differ in length, `rows` is not empty beside them, a value is not one a column can hold, a null bitmap is too short, or a typed array's tag is unknown. |
| `SMALT_MISMATCH` | A text value in a column of dates or times doesn't read as one. |

## Notes

- `"rows": []` with no `columns` gives no rows. `"rows": [[]]` with `"types": []` gives one row of no columns: what a
  query without a table reads from.
- The rows' values are not converted to `types`, and not checked against them: `types` is what the plan states, so
  give each column a type its every value has (or `any`).
- Values given as `columns` are read where they are: the engine makes no row of expressions for them.

### Value columns {#value-columns}

A column of `columns` is one of the following ([values as columns](../values#columns)):

- **An array of values**, as JSON writes them: numbers, text, `null`, `true` and `false` (a `bool` column), and the
  tagged values `{"$bigint": …}`, `{"$blob": …}` and `{"$real": …}` ([values](../values)). In a `date`, `datetime`,
  `time` or `duration` column, a text value is read as the text results give (`2026-11-02`), and a number as the
  value underneath (days for a `date`, µs for the others). A `list<…>` column holds JSON arrays; a `struct<…>` column
  objects by field name, or arrays by position; a `map<text, …>` column objects.
- **A typed array**, `{"$typed": tag, "data": […]}`, numbers in a packed form. The tags are `f64` and `f32`
  (floating point; `"NaN"`, `"Infinity"` and `"-Infinity"` as strings), `i32`, `i16`, `i8`, `u32` and `u16`
  (integers), and `i64` (integers beyond 2^53, each as a string of digits). A `date` column may be an `i32` of days.
- **Either of them with a null bitmap**, `{"data": …, "nulls": {"$blob": …}}`: bit `i % 8` of byte `i >> 3` is set
  when value `i` is NULL, as results carry them. A typed array has no NULL of its own.

A typed array crosses to the engine's worker as binary data beside the plan's JSON ([running
plans](../../engine/running#through-the-client)). From TypeScript, `plan.fromColumns` makes the operation from
JavaScript typed arrays and arrays.

## Examples

Two rows of expressions:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "rows": [
      [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "call", "fn": "upper", "args": [{"k": "lit", "value": "kiwi", "type": "text"}], "type": "text"}
      ],
      [{"k": "lit", "value": 2, "type": "int"}, {"k": "lit", "value": null, "type": "text"}]
    ],
    "types": ["int", "text"]
  },
  "columns": [{"name": "n"}, {"name": "word"}]
}
```

| n | word |
|---|---|
| 1 | KIWI |
| 2 | NULL |

The same kind of data given as columns: a typed array of integers, one of floats with a NaN, and an array of dates
as text:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "rows": [],
    "types": ["int", "real", "date"],
    "columns": [
      {"$typed": "i32", "data": [1, 2, 3]},
      {"$typed": "f64", "data": [0.5, "NaN", 2.25]},
      ["2026-11-02", "2026-11-03", null]
    ]
  },
  "columns": [{"name": "id"}, {"name": "x"}, {"name": "day"}]
}
```

| id | x | day |
|---|---|---|
| 1 | 0.5 | 2026-11-02 |
| 2 | NaN | 2026-11-03 |
| 3 | 2.25 | NULL |

A null bitmap: byte `0x02` sets bit 1, so the second value is NULL:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "rows": [],
    "types": ["int", "list<text>"],
    "columns": [{"data": {"$typed": "i16", "data": [7, 0, 9]}, "nulls": {"$blob": "02"}}, [["a", "b"], [], null]]
  },
  "columns": [{"name": "n"}, {"name": "tags"}]
}
```

| n | tags |
|---|---|
| 7 | ["a","b"] |
| NULL | [] |
| 9 | NULL |

Columns of different lengths:

<!-- docs:error SMALT_PLAN -->
```json
{"op": "values", "rows": [], "types": ["int", "text"], "columns": [[1, 2], ["a"]]}
```

## Demo

Prices given by the application, joined to the fruit they name:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "join",
      "kind": "inner",
      "inputs": [
        {"op": "scan", "table": "fruit", "columns": [0, 1]},
        {
          "op": "values",
          "rows": [],
          "types": ["int", "real"],
          "columns": [{"$typed": "i32", "data": [1, 4]}, {"$typed": "f64", "data": [0.45, 2.9]}]
        }
      ],
      "on": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "col", "input": 1, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "type": "bool"},
      "ordered": true
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "real", "collation": "binary"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "new_price"}]
}
```

| name | new_price |
|---|---|
| apple | 0.45 |
| cherry | 2.9 |

## See also

- [`scan`](./scan), [`source`](./source): rows from a table, or from a table function
- [`lit`](../expressions/lit), [`param`](../expressions/param)
- [Types](../types), [values](../values)
- [Operations](./)
