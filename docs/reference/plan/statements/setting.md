---
description: 'Reads a setting, or sets it, as SQL''s PRAGMA.'
---

# setting

```railroad
setting-statement
```

Reads a setting, or sets it, as SQL's PRAGMA: the settings that change what a statement means or how it is planned.

## Fields

| Field | Type | |
|---|---|---|
| `name` | string | The setting: a PRAGMA name SQLite has (`foreign_keys`) or one of the engine's own (`work_mem`). |
| `schema` | string | Optional: the schema a setting of one applies to (`main`, `temp`). |
| `value` | [expression](../expressions/) | Optional: the value to set, an expression over constants and parameters. Without it, the setting is read. |

## Result

Read: one row, a column named for the setting, with its value. Set: no rows.

## Errors

| Code | When |
|---|---|
| `SMALT_UNSUPPORTED` | The engine has no setting of that name. |

## Notes

- The settings a statement's planning reads are on the [catalog](../../engine/catalog): `foreign_keys`, `work_mem`
  (the memory an operation may use before it spills, in bytes), and whether materialized views may answer queries and
  aggregates run in parallel workers.
- A setting holds for the database from then on, not for one statement.

## Examples

```json
{"kind": "setting", "name": "foreign_keys"}
```

| foreign_keys |
|---|
| 1 |

A setting the engine doesn't have:

<!-- docs:error SMALT_UNSUPPORTED -->
```json
{"kind": "setting", "name": "no_such_setting"}
```

## Demo

Foreign keys turned off, by a parameter, then read back:

<!-- docs:params [0] -->
```json
{"kind": "setting", "name": "foreign_keys", "value": {"k": "param", "index": 0, "type": "int"}}
```

```json
{"kind": "setting", "name": "foreign_keys"}
```

| foreign_keys |
|---|
| 0 |

## See also

- [The catalog's settings](../../engine/catalog)
- [Statements](./)
