# Quick start

This tutorial builds the data layer of a small task list: projects, tasks, a few queries, an update in a transaction, an index and a report. Each step shows the SQL and then the same step from TypeScript. The SQL blocks on this page run in order, so you can follow them in any SQL session; the result tables are what the engine returns.

You need smaltdb installed (see [getting started](./getting-started)).

## 1. Open a database

```ts
import { open } from 'smaltdb';

const db = await open('tasks'); // created in OPFS on first use
```

Every method on `db` returns a promise. The rest of this page uses this `db`.

## 2. Create tables

```sql
CREATE TABLE projects(
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE tasks(
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title      TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  estimate   REAL
);
```

`db.exec()` runs a script of several statements when you pass no parameters:

```ts
await db.exec(`
  CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
  CREATE TABLE IF NOT EXISTS tasks(
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    estimate REAL
  );
`);
```

Columns are typed strictly by default: a `TEXT` value in an `INTEGER` column is an error, not a silent conversion. See [tables and schema](./schema).

## 3. Insert rows

```sql
INSERT INTO projects(name) VALUES ('Website'), ('Garden');
INSERT INTO tasks(project_id, title, estimate) VALUES
  (1, 'Write the landing page', 3),
  (1, 'Pick a font', 0.5),
  (1, 'Set up hosting', 2),
  (2, 'Buy seeds', 1),
  (2, 'Build a raised bed', 6);
SELECT id, project_id, title, done, estimate FROM tasks;
```

| id | project_id | title | done | estimate |
|---|---|---|---|---|
| 1 | 1 | Write the landing page | 0 | 3 |
| 2 | 1 | Pick a font | 0 | 0.5 |
| 3 | 1 | Set up hosting | 0 | 2 |
| 4 | 2 | Buy seeds | 0 | 1 |
| 5 | 2 | Build a raised bed | 0 | 6 |

From TypeScript, pass values as parameters instead of building SQL strings. `exec()` returns the number of changed rows and the rowid of the last insert:

```ts
const { lastInsertRowid } = await db.exec('INSERT INTO projects(name) VALUES (?)', ['Website']);
await db.exec('INSERT INTO tasks(project_id, title, estimate) VALUES (:project, :title, :estimate)', {
  project: lastInsertRowid,
  title: 'Write the landing page',
  estimate: 3,
});
```

`?` placeholders take an array; `:name`, `@name` and `$name` placeholders take an object. See [parameters](./queries#parameters).

## 4. Query

```sql
SELECT p.name AS project, t.title, t.estimate
FROM tasks t JOIN projects p ON p.id = t.project_id
WHERE t.done = 0 AND t.estimate >= 2
ORDER BY t.estimate DESC;
```

| project | title | estimate |
|---|---|---|
| Garden | Build a raised bed | 6 |
| Website | Write the landing page | 3 |
| Website | Set up hosting | 2 |

`db.query()` returns one object per row, keyed by column name. The type argument describes the row; it is not checked at run time.

```ts
interface OpenTask {
  project: string;
  title: string;
  estimate: number | null;
}

const openTasks = await db.query<OpenTask>(
  `SELECT p.name AS project, t.title, t.estimate
   FROM tasks t JOIN projects p ON p.id = t.project_id
   WHERE t.done = 0 AND t.estimate >= ?
   ORDER BY t.estimate DESC`,
  [2],
);
for (const task of openTasks) console.log(`${task.project}: ${task.title}`);
```

## 5. Update in a transaction

Finishing the landing page also means hosting is set up. Both changes should happen together or not at all:

```sql
BEGIN;
UPDATE tasks SET done = 1 WHERE id = 1;
UPDATE tasks SET done = 1, estimate = 0 WHERE id = 3;
COMMIT;
SELECT id, title, done, estimate FROM tasks WHERE project_id = 1;
```

| id | title | done | estimate |
|---|---|---|---|
| 1 | Write the landing page | 1 | 3 |
| 2 | Pick a font | 0 | 0.5 |
| 3 | Set up hosting | 1 | 0 |

From TypeScript, `db.transaction()` commits when the callback returns and rolls back when it throws. Run the statements on the `tx` handle it passes in:

```ts
await db.transaction(async (tx) => {
  await tx.exec('UPDATE tasks SET done = 1 WHERE id = ?', [1]);
  const r = await tx.exec('UPDATE tasks SET done = 1, estimate = 0 WHERE id = ?', [3]);
  if (r.changes !== 1) throw new Error('task 3 is missing'); // rolls back both updates
});
```

See [transactions](./transactions) for the details.

## 6. Aggregate

A report per project: how many tasks, how many are done, and the remaining estimate.

```sql
SELECT p.name AS project,
       count(*) AS tasks,
       sum(t.done) AS done,
       total(CASE WHEN t.done = 0 THEN t.estimate END) AS remaining
FROM projects p JOIN tasks t ON t.project_id = p.id
GROUP BY p.name
ORDER BY p.name;
```

| project | tasks | done | remaining |
|---|---|---|---|
| Garden | 2 | 0 | 7 |
| Website | 3 | 2 | 0.5 |

For charts and number crunching, ask for columns instead of row objects. Numeric columns without NULLs arrive as `Float64Array`:

```ts
const report = await db.query(
  `SELECT p.name AS project, count(*) AS tasks
   FROM projects p JOIN tasks t ON t.project_id = p.id
   GROUP BY p.name ORDER BY p.name`,
  undefined,
  { rowMode: 'columnar' },
);
console.log(report.data.project); // ['Garden', 'Website']
console.log(report.data.tasks); // Float64Array [2, 3]
```

## 7. Add an index

Listing a project's open tasks filters on `project_id` and `done`. While the table is small, reading all of it is the cheapest plan. To see an index pay off, add 98 more projects and 10,000 tasks:

```sql
WITH RECURSIVE n(i) AS (SELECT 3 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
INSERT INTO projects(id, name) SELECT i, 'Project ' || i FROM n;
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
INSERT INTO tasks(project_id, title) SELECT 3 + i % 98, 'Task ' || i FROM n;
EXPLAIN QUERY PLAN SELECT title FROM tasks WHERE project_id = 42 AND done = 0;
```

| id | parent | notused | detail |
|---|---|---|---|
| 1 | 0 | 0 | SCAN tasks (fused scan + filter) |

`SCAN` means every row is read. Now create an index on the two filtered columns:

```sql
CREATE INDEX tasks_by_project ON tasks(project_id, done);
EXPLAIN QUERY PLAN SELECT title FROM tasks WHERE project_id = 42 AND done = 0;
```

| id | parent | notused | detail |
|---|---|---|---|
| 1 | 0 | 0 | SEARCH tasks USING INDEX tasks_by_project (=?,=?) |

`SEARCH … USING INDEX` means the engine looks the rows up in the index. The planner decides per query, from the table sizes, whether an index is worth it. See [indexes and performance](./indexes-and-performance).

## 8. Close

```ts
await db.close();
```

The data stays in OPFS. The next `open('tasks')` in this origin finds it again.

## Where next

- [Queries](./queries): result shapes, prepared statements, streaming, how values map between JavaScript and SQL.
- [Import and export](./import-export): load CSV or JSON, export query results, with the `@smaltdb/io` plugin.
- [Errors](./errors): error codes and what to retry.
- [SQL reference](../reference/sql/).
