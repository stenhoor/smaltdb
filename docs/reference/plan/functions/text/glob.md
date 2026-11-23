---
description: 'Whether a text matches a GLOB pattern, case-sensitively.'
---

# glob

```ebnf
glob ::= '"fn": "glob"' ', "args": [' TEXT ',' PATTERN (',' ESCAPE)? ']'
```

Whether all of `TEXT` matches `PATTERN`, SQL's `GLOB`. In the pattern, `*` matches any run of characters (none too),
`?` matches exactly one character (code point), `[…]` matches one character of a set, and every other character
matches itself, case-sensitively. It is an operation: SQL's `x GLOB p` is `glob` with `x` and `p`.

A set lists characters and ranges: `[a-c]` matches `a`, `b` or `c`; `[^a-c]` matches any other character. A `]` first
in the set is one of its characters: `[]]` matches `]`. A `*` or `?` in a set matches itself.

## Parameters

| Argument | Type | |
|---|---|---|
| `TEXT` | `text` | The text to test. A number is taken as its text. |
| `PATTERN` | `text` | The pattern. A number is taken as its text. |
| `ESCAPE` | `text` | Optional: one character that makes the character after it in the pattern match itself, so `!*` matches a `*`. |

## Returns

`bool`. NULL when any argument is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_ERROR` | `ESCAPE` is not exactly one character. |

## Notes

- Characters compare by code point: case matters, and the call's collation doesn't change it. Ranges compare code
  points too.
- Without `ESCAPE`, a set escapes a wildcard: `[*]` matches a `*`.
- The text comes first, then the pattern, in the order of the operator `TEXT GLOB PATTERN`.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool", "bool", "bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "glob", "args": [
        {"k": "lit", "value": "Apple", "type": "text"},
        {"k": "lit", "value": "A*", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "glob", "args": [
        {"k": "lit", "value": "apple", "type": "text"},
        {"k": "lit", "value": "A*", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "glob", "args": [
        {"k": "lit", "value": "apple", "type": "text"},
        {"k": "lit", "value": "?pple", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "glob", "args": [
        {"k": "lit", "value": "apple", "type": "text"},
        {"k": "lit", "value": "[a-c]*", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "glob", "args": [
        {"k": "lit", "value": "apple", "type": "text"},
        {"k": "lit", "value": "[^a-c]*", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "glob", "args": [
        {"k": "lit", "value": "a*", "type": "text"},
        {"k": "lit", "value": "a[*]", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "glob", "args": [
        {"k": "lit", "value": null, "type": "text"},
        {"k": "lit", "value": "*", "type": "text"}
      ], "type": "bool"}
    ]]
  },
  "columns": [
    {"name": "case"},
    {"name": "other_case"},
    {"name": "one"},
    {"name": "set"},
    {"name": "not_set"},
    {"name": "star"},
    {"name": "null"}
  ]
}
```

| case | other_case | one | set | not_set | star | null |
|---|---|---|---|---|---|---|
| true | false | true | true | false | true | NULL |

With an escape character:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "glob", "args": [
        {"k": "lit", "value": "a*", "type": "text"},
        {"k": "lit", "value": "a!*", "type": "text"},
        {"k": "lit", "value": "!", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "glob", "args": [
        {"k": "lit", "value": "ab", "type": "text"},
        {"k": "lit", "value": "a!*", "type": "text"},
        {"k": "lit", "value": "!", "type": "text"}
      ], "type": "bool"}
    ]]
  },
  "columns": [{"name": "escaped"}, {"name": "not_escaped"}]
}
```

| escaped | not_escaped |
|---|---|
| true | false |

## Demo

The fruit whose names start with a letter from `l` to `p` and end in a vowel:

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "scan", "table": "fruit", "columns": [1]},
    "pred": {"k": "call", "fn": "glob", "args": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "lit", "value": "[l-p]*[aeiou]", "type": "text"}
    ], "type": "bool"}
  },
  "columns": [{"name": "name"}]
}
```

| name |
|---|
| lime |

## See also

- [`like`](./like), [`regex_match`](./regex_match)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
