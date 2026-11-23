---
description: 'Whether a text matches a LIKE pattern, ignoring the case of ASCII letters.'
---

# like

```ebnf
like ::= '"fn": "like"' ', "args": [' TEXT ',' PATTERN (',' ESCAPE)? ']'
```

Whether all of `TEXT` matches `PATTERN`, SQL's `LIKE`. In the pattern, `%` matches any run of characters (none too),
`_` matches exactly one character (code point), and every other character matches itself, ignoring the case of ASCII
letters. It is an operation: SQL's `x LIKE p ESCAPE e` is `like` with `x`, `p` and `e`.

## Parameters

| Argument | Type | |
|---|---|---|
| `TEXT` | `text` | The text to test. A number is taken as its text. |
| `PATTERN` | `text` | The pattern. A number is taken as its text. |
| `ESCAPE` | `text` | Optional: one character that makes the character after it in the pattern match itself, so `!%` matches a `%`. |

## Returns

`bool`. NULL when any argument is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_ERROR` | `ESCAPE` is not exactly one character. |

## Notes

- The case rule: `A` to `Z` match `a` to `z`, and no other letters fold: `Ä` doesn't match `ä`. The call's collation
  doesn't change it. An escaped letter folds the same way: `!a` matches `A`. [`glob`](./glob) is case-sensitive.
- The text comes first, then the pattern, in the order of the operator `TEXT LIKE PATTERN`.
- Without `ESCAPE`, no character escapes: `\` is an ordinary character.
- A pattern that is only text tests equality ignoring ASCII case; [`starts_with`](./starts_with) and
  [`contains`](./contains) test parts case-sensitively.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool", "bool", "bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "like", "args": [
        {"k": "lit", "value": "Apple", "type": "text"},
        {"k": "lit", "value": "ap%", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "like", "args": [
        {"k": "lit", "value": "apple", "type": "text"},
        {"k": "lit", "value": "a_ple", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "like", "args": [
        {"k": "lit", "value": "Äpple", "type": "text"},
        {"k": "lit", "value": "äp%", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "like", "args": [
        {"k": "lit", "value": "10%", "type": "text"},
        {"k": "lit", "value": "10!%", "type": "text"},
        {"k": "lit", "value": "!", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "like", "args": [
        {"k": "lit", "value": "10x", "type": "text"},
        {"k": "lit", "value": "10!%", "type": "text"},
        {"k": "lit", "value": "!", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "like", "args": [
        {"k": "lit", "value": 12.5, "type": "real"},
        {"k": "lit", "value": "%.5", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "like", "args": [
        {"k": "lit", "value": null, "type": "text"},
        {"k": "lit", "value": "%", "type": "text"}
      ], "type": "bool"}
    ]]
  },
  "columns": [
    {"name": "ascii_case"},
    {"name": "one"},
    {"name": "other_case"},
    {"name": "escaped"},
    {"name": "not_escaped"},
    {"name": "number"},
    {"name": "null"}
  ]
}
```

| ascii_case | one | other_case | escaped | not_escaped | number | null |
|---|---|---|---|---|---|---|
| true | true | false | true | false | true | NULL |

An escape of more than one character is an error:

<!-- docs:error SMALT_ERROR -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool"],
    "rows": [[
      {"k": "call", "fn": "like", "args": [
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": "!!", "type": "text"}
      ], "type": "bool"}
    ]]
  },
  "columns": [{"name": "bad_escape"}]
}
```

## Demo

The fruit whose names have a `p` that is not their last character:

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "scan", "table": "fruit", "columns": [1]},
    "pred": {"k": "call", "fn": "like", "args": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "lit", "value": "%p_%", "type": "text"}
    ], "type": "bool"}
  },
  "columns": [{"name": "name"}]
}
```

| name |
|---|
| apple |
| pear |
| plum |

## See also

- [`glob`](./glob), [`regex_match`](./regex_match), [`starts_with`](./starts_with)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
