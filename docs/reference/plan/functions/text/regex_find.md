---
description: 'The first match of a regular expression in a text.'
---

# regex_find

```ebnf
regex_find ::= '"fn": "regex_find"' ', "args": [' TEXT ',' PATTERN (',' FLAGS)? ']'
```

The text of the first match of `PATTERN` in `TEXT`, or NULL when it doesn't match.

## Parameters

| Argument | Type | |
|---|---|---|
| `TEXT` | `text` | The text to search. |
| `PATTERN` | `text` | The regular expression. |
| `FLAGS` | `text` | Optional: the flags, among `i`, `m` and `s`. |

## Returns

`text`: the whole match, not a group. NULL when `TEXT` or `PATTERN` is NULL, or there is no match. A pattern that
matches the empty text can give the empty text.

## Errors

| Code | When |
|---|---|
| `SMALT_ERROR` | `PATTERN` is not a valid regular expression, or `FLAGS` has a letter other than `i`, `m` and `s`, or one twice. |

## Notes

- `PATTERN` is a JavaScript regular expression in Unicode mode: `.` matches a whole code point (an emoji too), `\p{L}`
  matches a letter, and an escape that means nothing (`\-` outside a set) is an error.
- `FLAGS` is text of the letters `i` (ignore case), `m` (`^` and `$` match at line breaks too) and `s` (`.` matches a
  line break too), in any order, each at most once. NULL or the empty text means none.
- A pattern or flags that are wrong fail when a row reaches the call, not when the plan is compiled.
- The text is taken as its text when it is a number; a real that is a whole number is written without `.0` (`3`, where
  [`concat`](./concat) writes `3.0`).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "regex_find", "args": [
        {"k": "lit", "value": "order 42 and 7", "type": "text"},
        {"k": "lit", "value": "\\d+", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "regex_find", "args": [
        {"k": "lit", "value": "ABC", "type": "text"},
        {"k": "lit", "value": "b", "type": "text"},
        {"k": "lit", "value": "i", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "regex_find", "args": [
        {"k": "lit", "value": "abc", "type": "text"},
        {"k": "lit", "value": "(b)c", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "regex_find", "args": [
        {"k": "lit", "value": "none", "type": "text"},
        {"k": "lit", "value": "\\d+", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "regex_find", "args": [
        {"k": "lit", "value": null, "type": "text"},
        {"k": "lit", "value": "a", "type": "text"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "digits"}, {"name": "ignore_case"}, {"name": "whole_match"}, {"name": "no_match"}, {"name": "null"}]
}
```

| digits | ignore_case | whole_match | no_match | null |
|---|---|---|---|---|
| 42 | B | bc | NULL | NULL |

A pattern that is not a valid regular expression is an error:

<!-- docs:error SMALT_ERROR -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text"],
    "rows": [[
      {"k": "call", "fn": "regex_find", "args": [
        {"k": "lit", "value": "abc", "type": "text"},
        {"k": "lit", "value": "(b", "type": "text"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "bad_pattern"}]
}
```

## Demo

The first run of vowels in each fruit's name:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "regex_find", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": "[aeiou]+", "type": "text"}
      ], "type": "text"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "vowels"}]
}
```

| name | vowels |
|---|---|
| apple | a |
| pear | ea |
| plum | u |
| cherry | e |
| lime | i |

## See also

- [`regex_match`](./regex_match), [`instr`](./instr), [`substr`](./substr)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
