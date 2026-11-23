---
description: 'Whether a regular expression matches somewhere in a text.'
---

# regex_match

```ebnf
regex_match ::= '"fn": "regex_match"' ', "args": [' TEXT ',' PATTERN (',' FLAGS)? ']'
```

Whether `PATTERN` matches somewhere in `TEXT`. To test the whole text, anchor the pattern with `^` and `$`.

## Parameters

| Argument | Type | |
|---|---|---|
| `TEXT` | `text` | The text to search. |
| `PATTERN` | `text` | The regular expression. |
| `FLAGS` | `text` | Optional: the flags, among `i`, `m` and `s`. |

## Returns

`bool`. NULL when `TEXT` or `PATTERN` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_ERROR` | `PATTERN` is not a valid regular expression, or `FLAGS` has a letter other than `i`, `m` and `s`, or one twice. |

## Notes

- `PATTERN` is a JavaScript regular expression in Unicode mode: `.` matches a whole code point (an emoji too), `\p{L}`
  matches a letter, and an escape that means nothing (`\-` outside a set) is an error.
- `FLAGS` is text of the letters `i` (ignore case), `m` (`^` and `$` match at line breaks too) and `s` (`.` matches a
  line break too), in any order, each at most once. NULL or the empty text means none.
- [`like`](./like) and [`glob`](./glob) match simpler patterns against the whole text.
- A pattern or flags that are wrong fail when a row reaches the call, not when the plan is compiled.
- The text is taken as its text when it is a number; a real that is a whole number is written without `.0` (`3`, where
  [`concat`](./concat) writes `3.0`).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool", "bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "regex_match", "args": [
        {"k": "lit", "value": "Apple", "type": "text"},
        {"k": "lit", "value": "pp", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "regex_match", "args": [
        {"k": "lit", "value": "Apple", "type": "text"},
        {"k": "lit", "value": "^ap", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "regex_match", "args": [
        {"k": "lit", "value": "Apple", "type": "text"},
        {"k": "lit", "value": "^ap", "type": "text"},
        {"k": "lit", "value": "i", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "regex_match", "args": [
        {"k": "lit", "value": "😀", "type": "text"},
        {"k": "lit", "value": "^.$", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "regex_match", "args": [
        {"k": "lit", "value": 12.5, "type": "real"},
        {"k": "lit", "value": "\\.5$", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "regex_match", "args": [
        {"k": "lit", "value": null, "type": "text"},
        {"k": "lit", "value": "a", "type": "text"}
      ], "type": "bool"}
    ]]
  },
  "columns": [
    {"name": "anywhere"},
    {"name": "anchored"},
    {"name": "ignore_case"},
    {"name": "code_point"},
    {"name": "number"},
    {"name": "null"}
  ]
}
```

| anywhere | anchored | ignore_case | code_point | number | null |
|---|---|---|---|---|---|
| true | false | true | true | true | NULL |

The flags `m` and `s` change what `^` and `.` do at a line break:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "regex_match", "args": [
        {"k": "lit", "value": "a\nb", "type": "text"},
        {"k": "lit", "value": "^b", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "regex_match", "args": [
        {"k": "lit", "value": "a\nb", "type": "text"},
        {"k": "lit", "value": "^b", "type": "text"},
        {"k": "lit", "value": "m", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "regex_match", "args": [
        {"k": "lit", "value": "a\nb", "type": "text"},
        {"k": "lit", "value": "a.b", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "regex_match", "args": [
        {"k": "lit", "value": "a\nb", "type": "text"},
        {"k": "lit", "value": "a.b", "type": "text"},
        {"k": "lit", "value": "s", "type": "text"}
      ], "type": "bool"}
    ]]
  },
  "columns": [{"name": "caret"}, {"name": "caret_m"}, {"name": "dot"}, {"name": "dot_s"}]
}
```

| caret | caret_m | dot | dot_s |
|---|---|---|---|
| false | true | false | true |

A flag other than `i`, `m` and `s` is an error:

<!-- docs:error SMALT_ERROR -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool"],
    "rows": [[
      {"k": "call", "fn": "regex_match", "args": [
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": "g", "type": "text"}
      ], "type": "bool"}
    ]]
  },
  "columns": [{"name": "bad_flags"}]
}
```

## Demo

The fruit whose names have a double letter:

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "scan", "table": "fruit", "columns": [1]},
    "pred": {"k": "call", "fn": "regex_match", "args": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "lit", "value": "(\\p{L})\\1", "type": "text"}
    ], "type": "bool"}
  },
  "columns": [{"name": "name"}]
}
```

| name |
|---|
| apple |
| cherry |

## See also

- [`regex_find`](./regex_find), [`regex_replace`](./regex_replace), [`like`](./like), [`glob`](./glob)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
