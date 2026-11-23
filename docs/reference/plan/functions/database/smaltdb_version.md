---
description: 'The version of the smaltdb engine, as text.'
---

# smaltdb_version

```ebnf
smaltdb_version ::= '"fn": "smaltdb_version"' ', "args": []'
```

The version of the smaltdb engine running the plan, as text: the npm package's version, such as `0.9.0`.

## Parameters

None.

## Returns

`text`. Never NULL.

## Errors

None.

## Notes

- The version is the package's, fixed when the engine is built.
- It changes with each release, so the examples show what doesn't: its type, and that it has the form
  `major.minor.patch`.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "bool"],
    "rows": [[
      {"k": "call", "fn": "typeof", "args": [{"k": "call", "fn": "smaltdb_version", "args": [], "type": "text"}], "type": "text"},
      {"k": "call", "fn": "regex_match", "args": [
        {"k": "call", "fn": "smaltdb_version", "args": [], "type": "text"},
        {"k": "lit", "value": "^\\d+\\.\\d+\\.\\d+", "type": "text"}
      ], "type": "bool"}
    ]]
  },
  "columns": [{"name": "type"}, {"name": "semver"}]
}
```

| type | semver |
|---|---|
| text | true |

## Demo

The major version, the number before the first dot, read with `cast_integer` (which reads text's numeric prefix: `0`
for `0.9.0`). It is an integer whatever the release:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text"],
    "rows": [[
      {"k": "call", "fn": "typeof", "args": [
        {"k": "cast", "fn": "cast_integer", "to": "int", "arg": {"k": "call", "fn": "smaltdb_version", "args": [], "type": "text"}}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "major"}]
}
```

| major |
|---|
| integer |

## See also

- [`changes`](./changes), [`history_horizon`](./history_horizon)
- [Database state functions](./)
