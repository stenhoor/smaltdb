---
description: 'Appends its input''s rows to a table, or one row of defaults; handles conflicts.'
---

# append

```railroad
append
upsert
column-set
conflict-action
```

Appends its input's rows to a table (SQL's `INSERT`), or one row of defaults. `upserts` and `onConflict` say what a
row that conflicts with one there does.

## Fields

| Field | Type | |
|---|---|---|
| `table` | string | The table to write. |
| `db` | `"main"` or `"temp"` | The table's schema. |
| `input` | operation or `null` | The rows to append, one column for each of `columns`. `null`: one row, every column its default. |
| `columns` | integers | The table columns the input's columns go to, in order; `-1` is the rowid. The others take their defaults. |
| `upserts` | [upserts](#upsert) | What a row that conflicts on a constraint does instead (SQL's `ON CONFLICT … DO`). May be empty. |
| `onConflict` | [conflict action](#conflict-action) | Optional: the action for every constraint, in place of each constraint's own (SQL's `INSERT OR …`). |
| `returning` | expressions | Optional: what to give back for each row written, as expressions over it: the table's columns, then its rowid. |

## Output

One row for each row appended or updated by an upsert, with a column for each of `returning`; none without it.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | The table doesn't exist, a column is not one of its, the input gives a different number of columns from `columns`, or `onConflict` is not a conflict action. |
| `SMALT_CONSTRAINT_PRIMARYKEY`, `SMALT_CONSTRAINT_UNIQUE`, `SMALT_CONSTRAINT_NOTNULL`, … | A row breaks a constraint whose action makes it an error. |

## Notes

- A plan that holds an `append` is a `write` statement's ([statements](../statements/write)). Its `returning` names the
  result's columns; the result also says how many rows changed.
- Values are converted to the columns' types as the table's columns take them ([conversions](../conversions)).
- An `append`'s input may not hold a write of a property graph
  ([the order a plan that writes a graph runs in](../graph-writes#order)).

### upsert {#upsert}

```railroad
upsert
```

`target` names the constraint: an index of the table by its position, `-1` its integer primary key (the rowid), or
`null` any. Without `update`, a conflicting row is not appended (`DO NOTHING`). With it, the row there is updated:
each of `sets` assigns `value` to the table's column `column`, and `where` (optional) limits the update to rows for
which it is true. Their expressions read the row there (the table's columns, then its rowid), then the row that
was to be appended (likewise: SQL's `excluded`). For a table of 5 columns, the row there is columns 0 to 4 and its
rowid 5; the proposed row's columns are 6 to 10.

### conflict-action {#conflict-action}

```railroad
conflict-action
```

`"abort"`, `"fail"` and `"rollback"` make the conflict an error, as SQLite's `ABORT`, `FAIL` and `ROLLBACK` do;
`"ignore"` skips the row; `"replace"` deletes the rows the new one conflicts with, then appends it.

## Examples

Two fruit, giving back what was written. The `id` column is the table's integer primary key, so it is the rowid:

```json
{
  "kind": "write",
  "plan": {
    "op": "append",
    "table": "fruit",
    "db": "main",
    "input": {
      "op": "values",
      "types": ["int", "text", "int"],
      "rows": [
        [{"k": "lit", "value": 6, "type": "int"}, {"k": "lit", "value": "fig", "type": "text"}, {"k": "lit", "value": 12, "type": "int"}],
        [{"k": "lit", "value": 7, "type": "int"}, {"k": "lit", "value": "kiwi", "type": "text"}, {"k": "lit", "value": 3, "type": "int"}]
      ]
    },
    "columns": [0, 1, 4],
    "upserts": [],
    "returning": [
      {"k": "col", "input": 0, "index": 5, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 4, "depth": 0, "type": "int", "collation": "binary"}
    ]
  },
  "returning": [{"name": "rowid"}, {"name": "name"}, {"name": "color"}, {"name": "qty"}]
}
```

| rowid | name | color | qty |
|---|---|---|---|
| 6 | fig | NULL | 12 |
| 7 | kiwi | NULL | 3 |

A fruit whose id is taken:

<!-- docs:error SMALT_CONSTRAINT_PRIMARYKEY -->
```json
{
  "kind": "write",
  "plan": {
    "op": "append",
    "table": "fruit",
    "db": "main",
    "input": {
      "op": "values",
      "types": ["int", "text"],
      "rows": [[{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": "quince", "type": "text"}]]
    },
    "columns": [0, 1],
    "upserts": []
  }
}
```

The same with `onConflict` `"ignore"`: the row with the taken id is skipped, and the other appended.

```json
{
  "kind": "write",
  "plan": {
    "op": "append",
    "table": "fruit",
    "db": "main",
    "onConflict": "ignore",
    "input": {
      "op": "values",
      "types": ["int", "text"],
      "rows": [
        [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": "quince", "type": "text"}],
        [{"k": "lit", "value": 8, "type": "int"}, {"k": "lit", "value": "date", "type": "text"}]
      ]
    },
    "columns": [0, 1],
    "upserts": [],
    "returning": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"}]
  },
  "returning": [{"name": "name"}]
}
```

| name |
|---|
| date |

## Demo

A delivery: 5 apples and 2 lemons. Apple is there already, so the upsert on the primary key adds the new stock to
its `qty` (the row there's column 4, plus the proposed row's, column 10); lemon is appended.

```json
{
  "kind": "write",
  "plan": {
    "op": "append",
    "table": "fruit",
    "db": "main",
    "input": {
      "op": "values",
      "types": ["int", "text", "int"],
      "rows": [
        [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": "apple", "type": "text"}, {"k": "lit", "value": 5, "type": "int"}],
        [{"k": "lit", "value": 9, "type": "int"}, {"k": "lit", "value": "lemon", "type": "text"}, {"k": "lit", "value": 2, "type": "int"}]
      ]
    },
    "columns": [0, 1, 4],
    "upserts": [
      {
        "target": -1,
        "update": {
          "sets": [
            {
              "column": 4,
              "value": {
                "k": "call",
                "fn": "add",
                "args": [
                  {"k": "col", "input": 0, "index": 4, "depth": 0, "type": "int", "collation": "binary"},
                  {"k": "col", "input": 0, "index": 10, "depth": 0, "type": "int", "collation": "binary"}
                ],
                "type": "int"
              }
            }
          ]
        }
      }
    ],
    "returning": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 4, "depth": 0, "type": "int", "collation": "binary"}
    ]
  },
  "returning": [{"name": "name"}, {"name": "qty"}]
}
```

| name | qty |
|---|---|
| apple | 15 |
| lemon | 2 |

The table after the writes on this page:

```json
{
  "kind": "query",
  "plan": {"op": "scan", "table": "fruit", "columns": [0, 1, 4]},
  "columns": [{"name": "id"}, {"name": "name"}, {"name": "qty"}]
}
```

| id | name | qty |
|---|---|---|
| 1 | apple | 15 |
| 2 | pear | 4 |
| 3 | plum | NULL |
| 4 | cherry | 25 |
| 5 | lime | 0 |
| 6 | fig | 12 |
| 7 | kiwi | 3 |
| 8 | date | NULL |
| 9 | lemon | 2 |

## See also

- [`update`](./update), [`delete`](./delete): the other writes of a table
- [Statements](../statements/write): the `write` statement
- [Operations](./)
