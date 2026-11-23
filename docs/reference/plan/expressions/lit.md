---
description: 'A constant value, with its type.'
---

# lit

```railroad
lit
value
blob
```

A constant value, with its type. The value is NULL, a number, text, or one of the forms JSON can't write directly: a
64-bit integer beyond JavaScript's safe range, a blob, or a real that isn't finite.

## Fields

| Field | Type | |
|---|---|---|
| `value` | [value](../values) | The value. |
| `type` | [type](../types) | Its type. |

and the [meaning fields](../meaning-fields) of an expression.

## Value

`value`, in every row.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | `value` isn't one of the forms below (a JSON `true`, an array or another object). |

## Notes

- **JSON forms.** A JSON number, string or `null` is itself. The others are objects of one field:

  | Form | Value |
  |---|---|
  | `{"$bigint": "4611686018427387904"}` | An integer beyond ±(2^53 − 1), written in full as text. |
  | `{"$blob": "00ff"}` | A blob, its bytes in hexadecimal. |
  | `{"$real": "NaN"}`, `{"$real": "Infinity"}`, `{"$real": "-Infinity"}` | A real that isn't finite. |

- `type` says how to read the value: a `bool` is `1` or `0` (`true` and `false` in results), a `date` a number of
  days since 1970-01-01, a `datetime` or `time` µs (see [types](../types)). The value isn't converted to `type`, nor
  checked against it.
- A list, struct or map has no literal form: build one with [`list_of`](../functions/list/list_of),
  [`struct_of`](../functions/list/struct_of) or `map_of`, or pass it as a [parameter](./param).
- A literal NULL takes the type the place needs (`{"k": "lit", "value": null, "type": "int"}`), or `null`.

## Examples

Each JSON form:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "blob", "real", "real", "bool", "date", "text"],
    "rows": [[
      {"k": "lit", "value": {"$bigint": "4611686018427387904"}, "type": "int"},
      {"k": "lit", "value": {"$blob": "00ff"}, "type": "blob"},
      {"k": "lit", "value": {"$real": "NaN"}, "type": "real"},
      {"k": "lit", "value": {"$real": "-Infinity"}, "type": "real"},
      {"k": "lit", "value": 1, "type": "bool"},
      {"k": "lit", "value": 20000, "type": "date"},
      {"k": "lit", "value": null, "type": "text"}
    ]]
  },
  "columns": [{"name": "big"}, {"name": "bytes"}, {"name": "nan"}, {"name": "low"}, {"name": "yes"}, {"name": "day"}, {"name": "none"}]
}
```

| big | bytes | nan | low | yes | day | none |
|---|---|---|---|---|---|---|
| 4611686018427387904 | x'00ff' | NaN | -Infinity | true | 2024-10-04 | NULL |

A JSON array is not a value:

<!-- docs:error SMALT_PLAN -->
```json
{"op": "values", "types": ["list<int>"], "rows": [[{"k": "lit", "value": [1, 2], "type": "list<int>"}]]}
```

## Demo

The fruit that cost more than 1:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
      "pred": {"k": "call", "fn": "cmp_gt", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
        {"k": "lit", "value": 1, "type": "real"}
      ], "type": "bool"}
    },
    "exprs": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}]
  },
  "columns": [{"name": "name"}]
}
```

| name |
|---|
| plum |
| cherry |

## See also

- [`param`](./param): a value given when the statement runs
- [Values](../values), [Types](../types)
- [Expressions](./)
