---
description: 'Values in a plan''s JSON: literals, the tagged forms of bigints, blobs and non-finite reals, and values given as columns.'
---

# Values in JSON

A plan holds values in three places: a [`lit`](./expressions/lit)'s `value`, a [`pivot`](./operations/pivot)'s
`values`, and the columns of a [`values`](./operations/values) operation given as data. JSON has numbers, strings and
`null`; the values it can't hold are written as tagged objects, one key each.

```railroad
value
blob
```

| Value | JSON |
|---|---|
| NULL | `null` |
| an integer within ±(2^53 − 1), a real | a number: `42`, `0.5` |
| an integer beyond 2^53 | `{"$bigint": "9007199254740993"}` |
| NaN, Infinity, -Infinity | `{"$real": "NaN"}`, `{"$real": "Infinity"}`, `{"$real": "-Infinity"}` |
| text | a string |
| a blob | `{"$blob": "00ff"}`: its bytes in hex |

A number is an `int` or a `real` by the type the `lit` states (`{"value": 2, "type": "real"}` is the real 2). A
literal can't be a JSON `true` or `false`, a list or an object: a truth value is `1` or `0` of type `bool`, and a
list, struct or map is made by a call ([`list_of`](./functions/list/list_of),
[`struct_of`](./functions/list/struct_of), [`map_of`](./functions/map/map_of)), or comes in as a
[parameter](./expressions/param). Dates and times are made from text by a call: `cast_date`, `cast_datetime`,
`cast_time` ([conversions](./conversions)).

`plan.planToJSON(plan)` writes a plan in this form, and `plan.planFromJSON(text)` reads it.

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "blob", "real", "real", "bool"],
    "rows": [[
      {"k": "lit", "value": {"$bigint": "9007199254740993"}, "type": "int"},
      {"k": "lit", "value": {"$blob": "00ff"}, "type": "blob"},
      {"k": "lit", "value": {"$real": "NaN"}, "type": "real"},
      {"k": "lit", "value": {"$real": "-Infinity"}, "type": "real"},
      {"k": "lit", "value": 1, "type": "bool"}
    ]]
  },
  "columns": [{"name": "big"}, {"name": "blob"}, {"name": "nan"}, {"name": "minus infinity"}, {"name": "true"}]
}
```

| big | blob | nan | minus infinity | true |
|---|---|---|---|---|
| 9007199254740993 | x'00ff' | NaN | -Infinity | true |

## Values as columns {#columns}

A [`values`](./operations/values) operation may give its rows as data instead of expressions: `columns`, one per
type, all of one length, with `rows` empty. The engine reads the values where they are, with no expression per value,
which is how a language hands it a dataframe.

```railroad
value-column
typed-array
```

A column is:

- **an array of values**: JSON values, and in JavaScript also `true` / `false` (a `bool` column), `Date`s, arrays and
  objects (a list, struct or map column: arrays by position or objects by field name for a struct);
- **a typed array**: `{"$typed": "f64", "data": […]}`, with `f64`, `f32`, `i32`, `i16`, `i8`, `u32`, `u16` or `i64`
  (its numbers as strings); in JavaScript, the typed array itself (`Float64Array` …, `Uint8Array` too);
- either, with **a null bitmap**: `{"data": …, "nulls": {"$blob": "…"}}`, bit `i % 8` of byte `i >> 3` set when value
  `i` is NULL, as results carry them.

NaN in a float column is NaN, a value of `real` that sorts after every number
([ADR 0018](../../adr/0018-bool-and-nan.md)). A column typed `date` holds days (an `i32` column, say), one typed
`datetime`, `time` or `duration` µs; an array may also hold JavaScript `Date`s, or the text results give, which
parses (or is an error). Through the client, typed arrays cross to the worker as binary data beside the plan's JSON
([running plans](../engine/running#through-the-client)).

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "rows": [],
    "types": ["int", "real", "text", "bool", "int"],
    "columns": [
      {"$typed": "i32", "data": [1, 2, 3]},
      {"data": {"$typed": "f64", "data": [1.5, 0, 2]}, "nulls": {"$blob": "02"}},
      ["a", null, "c"],
      [1, 0, null],
      {"$typed": "i64", "data": ["9007199254740993", "1", "-2"]}
    ]
  },
  "columns": [{"name": "i32"}, {"name": "f64"}, {"name": "text"}, {"name": "bool"}, {"name": "i64"}]
}
```

| i32 | f64 | text | bool | i64 |
|---|---|---|---|---|
| 1 | 1.5 | a | true | 9007199254740993 |
| 2 | NULL | NULL | false | 1 |
| 3 | 2 | c | NULL | -2 |

The null bitmap `02` (bit 1 set) makes the second value of the `f64` column NULL.

Columns of different lengths:

<!-- docs:error SMALT_PLAN -->
```json
{"op": "values", "rows": [], "types": ["int", "int"], "columns": [[1, 2], [1]]}
```

## Parameters

A statement's parameters ([`param`](./expressions/param)) are values given when it runs, not in its JSON:
`queryPlan(stmt, [1, 'a'])`. A parameter read as a list, struct or map takes a JavaScript array or object
([running plans](../engine/running#parameters)).

## See also

- [Types](./types)
- [`lit`](./expressions/lit), [`values`](./operations/values)
