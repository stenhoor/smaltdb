---
description: 'The plan types: what the engine knows of a value ahead of time, and how list, struct and map types are written.'
---

# Types

Every expression and every column of a plan has a static type: what the engine knows of its values ahead of time,
which it uses to pick specialized code. A value of any type may be NULL. A type is a JSON string.

```railroad
type
type-name
```

| Type | Values |
|---|---|
| `int` | 64-bit integers: JavaScript numbers within ±(2^53 − 1), `bigint` beyond |
| `real` | 64-bit floating point, NaN included ([ADR 0018](../../adr/0018-bool-and-nan.md)) |
| `num` | `int` or `real`, not known until run time |
| `text` | strings |
| `blob` | `Uint8Array` |
| `bool` | truth values: 0 and 1 while a plan runs (an integer to every operation), `true` and `false` in results |
| `date` | calendar dates: days since 1970-01-01 while a plan runs, text such as `2026-11-07` in results ([ADR 0019](../../adr/0019-dates-and-times.md)) |
| `datetime` | dates and times: µs since 1970-01-01 00:00:00 (a `bigint` beyond 2^53: after 2255 or before 1685), text such as `2026-11-07 12:30:00.500` in results |
| `time` | times of day: µs since midnight, text such as `12:30:00` in results |
| `duration` | spans of time: µs, ISO 8601 text such as `P1DT2H` in results |
| `list<T>` | lists of `T` values, nested to any depth (`list<list<int>>`): blobs while a plan runs, JavaScript arrays in results ([ADR 0020](../../adr/0020-lists-and-structs.md)) |
| `struct<name T, …>` | named fields in order (`struct<x real, y real>`): blobs while a plan runs, JavaScript objects in results |
| `map<text, T>` | text keys to `T` values: blobs of the entries sorted by key, so equal maps are equal values; JavaScript objects in results ([ADR 0038](../../adr/0038-map-type.md)) |
| `null` | only NULL |
| `any` | not known until run time; a `bool`, list, struct or map there keeps its type ([ADR 0039](../../adr/0039-typed-values-under-any.md)) |

Type names are lower case. In a list, struct or map type, a space after a comma is optional
(`struct<x real,y real>` is `struct<x real, y real>`), and a map's keys are always `text`. Another name is refused:
`SMALT_PLAN`.

## Where types are written

- A [`lit`](./expressions/lit), a [`param`](./expressions/param), a [`col`](./expressions/col), a
  [`call`](./expressions/call) and most other expressions state their type. A `call` declares the type of its value:
  for a function that can give several (`coalesce`, `max`), the one the plan needs.
- [`values`](./operations/values), [`source`](./operations/source) and [`working`](./operations/working) list the
  types of their columns; a [`scan`](./operations/scan) gives the types of the table's columns.
- A query's [`columns`](./statements/query) may restate them; by default they are the plan's.

The engine trusts the types a plan states. A `col` typed `text` over an integer column reads the integer, and code
chosen for text may then treat it as text: state the types the plan's inputs give.

## Truth values

A comparison or a logic expression gives 0 or 1 (or NULL). A language says how its results show them by the type it
declares: a `call` declared `bool` (`cmp_gt` … `"type": "bool"`), or a logic node of type `bool` (the default), gives
`true` / `false` in results; declared `int`, it gives 1 / 0, as SQL's do. Left to the engine, they are `bool`: the
catalog gives `bool` as the result of the comparisons, `truth_not`, `like`, `glob`, `in_list` and `regex_match`. An
[`inSubquery`](./expressions/inSubquery) has no `type` and gives `int`.

## Example

A value of each kind, and the types the result gives them:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "int", "struct<name text, score real>", "list<int>", "map<text, int>", "datetime", "duration"],
    "rows": [[
      {"k": "call", "fn": "cmp_gt", "args": [{"k": "lit", "value": 2, "type": "int"}, {"k": "lit", "value": 1, "type": "int"}], "type": "bool"},
      {"k": "call", "fn": "cmp_gt", "args": [{"k": "lit", "value": 2, "type": "int"}, {"k": "lit", "value": 1, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "struct_of", "args": [{"k": "lit", "value": "a", "type": "text"}, {"k": "lit", "value": 2.5, "type": "real"}], "type": "struct<name text, score real>"},
      {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": 2, "type": "int"}], "type": "list<int>"},
      {"k": "call", "fn": "map_of", "args": [{"k": "lit", "value": "k", "type": "text"}, {"k": "lit", "value": 1, "type": "int"}], "type": "map<text, int>"},
      {"k": "call", "fn": "cast_datetime", "args": [{"k": "lit", "value": "2026-11-07 12:30:00.5", "type": "text"}], "type": "datetime"},
      {"k": "call", "fn": "sub", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-07", "type": "text"}], "type": "date"},
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-01", "type": "text"}], "type": "date"}
      ], "type": "duration"}
    ]]
  },
  "columns": [{"name": "bool"}, {"name": "int"}, {"name": "struct"}, {"name": "list"}, {"name": "map"}, {"name": "datetime"}, {"name": "duration"}]
}
```

| bool | int | struct | list | map | datetime | duration |
|---|---|---|---|---|---|---|
| true | 1 | {"name":"a","score":2.5} | [1,2] | {"k":1} | 2026-11-07 12:30:00.500 | P6D |

A type the engine doesn't know:

<!-- docs:error SMALT_PLAN -->
```json
{"op": "values", "types": ["integer"], "rows": [[{"k": "lit", "value": 1, "type": "int"}]]}
```

## See also

- [Conversions](./conversions): how a value of one type becomes one of another
- [Values in JSON](./values): literals of each type
- `isPlanTypeName(t)` and `parseNested(t)` in `smaltdb/plan` check and read a type name
