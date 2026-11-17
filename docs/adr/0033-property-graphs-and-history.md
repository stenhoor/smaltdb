# ADR 0033: Property graphs and version history in smaltdb

- **Status:** accepted (2026-11-17), with the owner's decisions from two interviews (2026-11-14 and 2026-11-17) below.
  Section 5's impact review stands; work starts with step 0.
- **Date:** 2026-11-14
- **Research:** [Graphs on the plan API](../research/graph-on-plans.md) (G1–G6, measurements and sizes) and
  [Pluggable storage engines](../research/pluggable-engines.md)
- **Builds on:** [ADR 0016](0016-plan-api-for-every-language.md) (one plan for every language),
  [ADR 0020](0020-lists-and-structs.md) (lists, structs, and maps as `list<struct<key, value>>`),
  [ADR 0009](0009-concurrency.md) and [ADR 0021](0021-parallel-readers-everywhere.md) (concurrency),
  [ADR 0028](0028-pluggable-storage-engines.md) (deferred: graph needs plan work, not a new storage engine)
- **Amended by:** [ADR 0038](0038-map-type.md) (the catch-all column is a `map<text, any>`)
- **Affects:** smaltkit (the renderer, timeline and GraphJSON move there), smaltcy ([its ADR 0001](https://github.com/stenhoor/smaltcy/blob/main/docs/adr/0001-smaltcy.md) and
  [ADR 0002](https://github.com/stenhoor/smaltcy/blob/main/docs/adr/0002-graph-history.md)), smaltql, smaltdf, smaltts

## Context

smaltcy is a graph database for the browser that speaks Cypher. Today it has its own engine, its own graph plan and its
own in-memory stores, and keeps a graph's history (`AT VERSION`, `AT TIME`). Its ADR 0001 says durable storage comes
from smaltdb. The owner asked what it would take to integrate it into smaltdb with a unified plan language and updated
storage and indexing, and decided the questions below in an interview (2026-11-14).

smaltdb's research note found that one plan can serve both relational and graph queries: graph patterns are joins, and
variable-length paths are recursion, as SQL:2023's property graphs (SQL/PGQ) define them. What the plan lacks is
additive: G1 (a planner bug), G2 (keyed `iterate`), G3 (`loop`), G4 (a property graph in the catalog) and G5
(`paths`). None of them has been built (checked against `main`, `7de6429`).

smaltdb has no version history. Its write-ahead log holds page images and is truncated at each checkpoint, so it can't
serve as history.

## Decision

### The owner's decisions (2026-11-14)

| # | Question | Decision |
|---|---|---|
| 1 | What runs Cypher | **smaltdb only.** smaltcy becomes a language package, as smaltql is: a parser and a compiler to smaltdb plans. Its own engine and stores go once the work here is done |
| 2 | Until then | **smaltcy keeps its own engine and in-memory model, unchanged,** until the smaltdb work is complete |
| 3 | Plan language | **One:** smaltdb's, extended additively with graph operations |
| 4 | Node properties | **A table per label:** declared, typed columns, plus one catch-all column for properties that aren't declared |
| 5 | Nodes with several labels | **Configurable per label:** by default a row in the primary label's table and an entry in a label index; a label can instead keep its own copy of the row |
| 6 | Relationships | **A table per type:** start and end node columns, declared properties and a catch-all column |
| 7 | Indexes | B+tree indexes on properties, and on relationship endpoints in both directions. An adjacency index only if benchmarks ask for one |
| 8 | Version history | **Required from day one, opt-in** per table or graph. **Two methods** are built and benchmarked: a history table, and a commit log. The default is chosen from the benchmarks |
| 9 | Timing | Catalog and file-format changes land **before smaltdb's 1.0 format freeze** |
| 10 | Review | The plan is reviewed for performance, compatibility and breaking changes before it is built (section 5) |

### The owner's decisions (2026-11-17)

| # | Question | Decision |
|---|---|---|
| 11 | A label or relationship type with no table yet | **Created on first use** by the engine, with the node id (or endpoints) and the catch-all column. Columns can be declared later; values move from the catch-all into them |
| 12 | Who keeps a graph's invariants (node ids unique across the graph, the label index, per-label copies, history) | **The engine,** on every write to a graph's tables, whichever language makes it. A write to a table outside a graph costs nothing extra (a per-table flag) |
| 13 | Where Cypher's meaning and smaltdb's differ (section 5.4) | **Cypher's meaning.** smaltcy's compiler keeps it: checking division, guarded comparisons, Cypher's null and type order, and the function mappings |
| 14 | Who reads the past | **Every language:** history is an `asOf` in plans, which smaltcy (`AT VERSION`, `AT TIME`) and smaltql both use, on any table that opted in |
| 15 | The catch-all column | **A new, general map type,** `map<text, any>`, for every language: [ADR 0038](0038-map-type.md), which amends ADR 0020 |
| 16 | Retention | **Keep everything by default;** an explicit command drops versions older than a point (smaltcy's `forget(v)`, ADR 0002 there) |
| 17 | Version numbers | **The database's commit ids** (gaps allowed when other tables change). Author and message are optional on any transaction, in every language |
| 18 | Per-label copies | **Kept;** the engine updates and deletes them with the node (they can't be foreign-key targets) |
| 19 | Timing | **Next** on the roadmap, before M8.5 and M8.4, since it changes the file format |
| 20 | Who does what | This work's smaltdb steps (0–7) are done in smaltdb; smaltcy's compiler and switch (steps 8–9) in smaltcy |
| 21 | What stays in smaltcy | **The Cypher parser and compiler only.** The GPU renderer, the timeline widget and GraphJSON import and export move to smaltkit |
| 22 | This ADR's number | 0033 stays |

### The catch-all column

The first interview asked for a new map type; this ADR first proposed following ADR 0020 instead (a map as
`list<struct<key, value>>`). The owner chose a general map type (decision 15). [ADR 0038](0038-map-type.md) follows ADR
0020's own pattern: a static type over encoded bytes with a `MAP` storage type in format 4, which is unreleased. So it
needs no new run-time value kind and no new record tag.

## 1. The plan: additive operations

All additions are optional fields or new operations. Under ADR 0016 that needs no `PLAN_FORMAT_VERSION` bump:
`unpivot`, `pivot`, `asof`, `sample` and `explode` were added the same way. Plans that smaltql, smaltdf and smaltts
build today keep their meaning.

| Item | What | Where it lands |
|---|---|---|
| G1 | The recursive step's join order: cost the working rows at about one row, not `SUBQUERY_ROWS = 1000` (`exec/planner.ts:361`) | planner |
| G2 | `iterate` gains optional `key` (columns to deduplicate on: first seen wins, or the lowest with `order`) and `maxDepth` | plan, `RecursiveCte` |
| G4 | Schema operations `createPropertyGraph` and `dropPropertyGraph`, and a catalog record | plan schema ops, catalog |
| G5 | A `paths` operation: start set, edge table and endpoint columns, direction, hop range, path mode (walk, trail, acyclic, simple), selector (any, any shortest, all shortest, shortest k); the path as `list<struct>`. Lowered to G2's `iterate` at first | plan, normalizer |
| G3 | `loop`, a set-at-a-time fixpoint, for graph algorithms (PageRank, components) | later, when wanted |
| H1 | `asOf` on a scan (a commit id or a time): reads a history-enabled table as it was (decision 14) | plan, planner |
| M | The `map<text, V>` type and its operations ([ADR 0038](0038-map-type.md)) | types, functions |

Functions Cypher needs that SQL users would use too (`split`, `range` as a table function, `starts_with`, `ends_with`,
`contains`) are added to the engine. Cypher-only ones (`labels`, `type`, `startNode` …) are built by smaltcy's compiler
from columns, not added to the engine.

## 2. Storage

- **A property graph** is a catalog record that names its node tables (one per label), edge tables (one per type), each
  table's key and endpoint columns, and the label index. Languages bind against it, as views are bound (ADR 0016). SQL
  sees the same tables.
- **Node tables:** declared columns, a `props map<text, any>` catch-all ([ADR 0038](0038-map-type.md)), and an integer
  node id. Node ids are unique across a graph's tables, so a relationship's endpoint names one node whatever its label.
- **Tables made on first use** (decision 11): a label or type that has no table gets one, with the id (or endpoints) and
  the catch-all, inside the writing transaction, and is added to the graph's record.
- **The engine keeps the invariants** (decision 12): node ids from the graph's sequence, the label index, per-label
  copies and history, on writes from any language.
- **Several labels:** smaltdb's indexes produce exactly one key per row (`indexKey`, `exec/write.ts:153-175`), so the
  label index is a table of `(node, label)` rows with a unique B+tree index on `(label, node)`, kept with the node. As
  built (step 3), it is an ordinary table of the graph, `<graph>_labels`, that every language can read; the engine checks
  its writes. A label set to keep its own copy (`copy: true`) gets a row in its table too, kept in step on every write:
  the node's id and the columns the two tables share by name. Copies are written by the engine only.
- **Edge tables:** `start` and `end` node ids, declared columns, the catch-all, and B+tree indexes on `(start, end)` and
  `(end, start)`. A node that lives in one table can be a foreign key target (`ON DELETE CASCADE` gives `DETACH
  DELETE`).

## 3. Version history

Opt-in per table or graph, set when it is created. Two methods are built behind one switch, then benchmarked:

| | (a) History table | (b) Commit log |
|---|---|---|
| How | An update or delete moves the old row into a history table with `valid_from` and `valid_to` commit ids | Each insert, update and delete appends a change to a log; a past version is rebuilt by undoing changes |
| Current reads | Unchanged | Unchanged |
| Reads of the past | An index lookup on the commit range | Proportional to the changes undone; needs periodic snapshots to stay bounded |
| Writes | About 2× on updates and deletes, none extra on inserts | One extra append per change |
| Relation to planned work | Like SQL:2011 system-versioned tables | The same idea as the roadmap's `track_changes` ("Sync groundwork"): **design them as one** |

- **Reading the past:** an `asOf` (commit id or time) in plans, for every language (decision 14).
- **Retention:** everything is kept until an explicit command drops versions older than a point (decision 16).
- **Versions are commit ids** for the whole database; each commit can carry an author and a message (decision 17).

Both need a **durable 64-bit commit id** and a **commit time**. smaltdb has neither: the header's change counter is
32-bit and wraps (`storage/pager.ts:760`), and the 64-bit checkpoint LSN slot is unused (`storage/format.ts:54`).
History applies to local row tables. Columnar tables, materialized views and external tables are out of scope for the
first version (section 5.2).

**As built (step 6), in parts:**

1. **Commit metadata** (done): `begin` and `commit` take an optional `author` and `message`. A commit that changes
   something and carries either records them, with its id and time, in the system table `smalt_commits` (rowid = commit
   id), in the same transaction. The pager fixes a transaction's commit id and time the first time it is asked
   (`nextCommit`), so what is recorded is what the header gets. A commit without them writes nothing extra.
2. **History tables, method (a)** (done): `history: 'versions'` on a table, set when it is created. A system table per
   table holds closed versions (the row, its rowid, `valid_from`, `valid_to`), and a small one holds each current row's
   `valid_from`, so the table itself and its reads don't change. Inserts write one small row more; updates and deletes
   write a version and change the small row. Every commit that writes such a table records itself in `smalt_commits`,
   so a time maps to a commit. `asOf` on a `scan` (a commit id or a time) is rewritten into the current rows that
   existed then and the versions valid then.
3. **Method (b), the commit log** (done): `history: 'log'`. Each insert, update and delete appends the operation, the rowid,
   the commit and the row before it. A past state is the current rows untouched since, and for the others the row
   before their first change after it (none if that change was the insert): no replay, one pass over the log since.
   The same log serves `track_changes`.
4. **Forgetting and graphs** (done): an explicit command (`forget`) drops versions older than a commit and records
   the limit (`smalt_history`), below which `asOf` is an error, checked when the statement runs. A property graph can
   turn history on for all its tables.
4a. **ALTER TABLE on history tables** (next): their history tables follow added, renamed and dropped columns; refused
   until then.
5. **Step 7** benchmarks both and picks the default.

## 4. Cypher on smaltdb

smaltcy's parser stays. Its binder is rewritten to produce smaltdb plans against a property graph, keeping Cypher's
meaning where it differs from smaltdb's (decision 13):
- patterns become joins on the endpoint indexes, variable-length and shortest paths become `paths`;
- relationship uniqueness within a `MATCH` becomes filters, or a visited set in `paths`;
- `MERGE`, `SET n = map`, `SET n += map`, `REMOVE` and `DETACH DELETE` become writes on the graph's tables;
- nodes, relationships and paths in results are built by the compiler from ids and columns.

smaltcy's own engine stays until this is complete (decision 2). Until the switch, smaltcy's Cypher test suites run
against both engines, and their results are compared.

## 5. Impact review

From reading the code of smaltdb (`7de6429`), smaltql, smaltdf, smaltts and smaltcy on 2026-11-14. Nothing was built or
benchmarked. Each finding cites the code; findings marked *(inferred)* need confirming when the work is done.

### 5.1 Performance

| Change | Effect on databases that don't use graphs or history | Effect when used |
|---|---|---|
| G1 | Faster recursive queries: unbounded reachability measured 49 s, against 139 ms with the right order (research note, section 4) | Same |
| G2, G5 | None, if the optional fields are checked once when the operator is built, not per row *(inferred)* | `key` with "lowest wins" needs a heap that can lower a key; the current one breaks ties by sequence only (`exec/operators.ts:2114-2125`) |
| Graph tables | None | Each relationship insert writes 3 B+trees (the row and two endpoint indexes); a node with *n* labels writes *n* label-index entries, or *n* rows with per-label copies |
| Catch-all column | None | Undeclared properties are decoded from a blob to be read, and can't be indexed except by an expression index on one key |
| History | One branch per write, on a per-table flag, as foreign keys are checked today (`exec/write.ts:296-320`) | (a): about 2× writes on updates and deletes. (b): one append per change, and slow reads of the far past without snapshots. Both grow the file until a retention policy removes old versions |
| Codegen | None: codegen only specializes numeric types (`exec/codegen.ts:95-97`); lists and structs already take the generic path | Same |

**Benchmarks required before history's default is chosen and before step 7 ships:** writes (insert, update, delete),
current reads, reads of the recent past and of the far past, file growth, on smaltdb's micro-benchmarks
(`bench/micro`) and in the browser; and smaltcy's own benchmarks (`docs/research/benchmarks.md` there) run on both
engines.

### 5.2 Compatibility and breaking changes in smaltdb

1. **Older engines would ignore the new records (must fix first).** The header's minor version is written but never
   read (`storage/pager.ts:222-241`; only the major is checked, `:1040`). An older 4.x engine opening a file with a
   property graph or history record skips the unknown catalog kind (`database.ts:1119-1130`) and can still write to
   the graph's tables, without maintaining the label index, the edge indexes' integrity or the history. **Step 0**
   makes the engine refuse to write (or to open) a file that needs features it doesn't know: a "required features"
   field in the header or the catalog, read on open. Format 4.0 is unreleased (`docs/STORAGE_FORMAT.md:229`), so this
   can land within 4.x before any release carries graph records.
2. **G1 changes the order of unordered recursive results.** The executor queues rows in the order a step produces them
   (`exec/operators.ts:2025-2030`), so a different join order in the step changes the order of rows a recursive query
   returns without `ORDER BY`, and which rows a `LIMIT` keeps. ADR 0016 leaves that order undefined, so it is within
   the contract, but differential tests against SQLite (`test/differential*.test.ts`) and smaltql's sqllogictest run
   may need `ORDER BY` or order-insensitive comparison. Keep the fix narrow: cost the working rows only.
3. **New operations meet switches with no `default`.** A new op must be added to: the `PlanOp` union
   (`plan/ops.ts:111`), the validator (`plan/validate.ts:249`; unknown ops are rejected, `:553`), the printer
   (`plan/print.ts:62`), `outputTypes` (`plan/output.ts:15`, whose `default` returns `[]`: a missing case gives wrong
   types silently), `planWidth` (`exec/planner.ts:2615`), `supportedLeaf`/`supportedPlan` (`:2779`), the normalizer
   (`exec/plan-normalize.ts:54`, `:600`) and `needsRewrite` (`database.ts:5620`, which lists the operations the normalizer lowers: `paths` must be added there). The schema-op dispatch
   (`database.ts:1663-1670`) has no `default` and returns `undefined` for an unknown op. **Step 0 adds exhaustiveness
   checks** (`never`) to these switches so a missing case fails to compile.
4. **The public plan API's comment says version 0** (`plan/public.ts:5`); the constant is 1 (`plan/types.ts:12`). Fix
   it with the first plan change.
5. **Indexes give one key per row.** No multi-entry or list-element index exists, so the label index is a table of its
   own (section 2), not an index on a list column.
6. **No MVCC.** Sessions run one at a time, and parallel readers get snapshots by refreshing from the WAL (ADR 0009,
   ADR 0021). History must be written in the same transaction as the change; reading the past reads the history
   tables, not old pages. `docs/ARCHITECTURE.md:71` says "MVCC", which overstates what exists, and should be corrected.
7. **Columnar tables, materialized views, external tables.** History is limited to local row tables at first. A
   materialized view over a versioned table would need its sources' history to show a past state; out of scope.
8. **Plugin API v1** (ADR 0013) covers formats, sources and methods only. Nothing here changes it.
9. **No breaking change to existing functions or plans.** Every addition is optional or new; no existing function,
   type, comparison, sort order or result changes, except the unordered row order in item 2.

### 5.3 Compatibility for smaltql, smaltdf and smaltts

- **smaltql** builds `iterate` plans (`src/frontend/select.ts:546-556`); its `resolveRefs` switch (`:1501`) has no
  `default`, which matters only if it starts emitting `paths`. Its sqllogictest run is the check for item 5.2.2.
- **smaltdf** builds no plans: it compiles to SQL and goes through smaltql (`src/compile.ts:1`). Unaffected.
- **smaltts** switches over its own node kinds, not plan ops, and keeps its own `StorageType` (`src/spec.ts:13`).
  Unaffected; it can use graphs later through new typed calls.
- None of the three has an exhaustive check over plan ops or types that a new op would break at compile time.

### 5.4 Breaking changes for smaltcy's users

Moving smaltcy onto smaltdb changes behaviour. These are breaking, so the switch is a **new major version of
smaltcy**, with its own migration notes. The owner decided Cypher's meaning is kept (decision 13): where the Plan
column offers "or document", the compiler keeps Cypher's behaviour. Only what can't be kept (the API, exports, error
codes, ids) is documented in its "Where it differs" page.

| Area | smaltcy today | On smaltdb | Plan |
|---|---|---|---|
| API | Synchronous: `open()`, `run`, `query`, `transaction(fn)` (`src/index.ts:66-113`) | Asynchronous: `open()` returns a promise, the engine runs in a worker (`src/client/index.ts:190`) | Breaking. smaltcy's worker client (`connect()`) is already asynchronous and is the model |
| Exports | `MemoryStore`, `CsrStore`, `GraphEngine`, `GraphPlan`, `registerFunction` | Gone (decision 1) | Breaking |
| Results | `{kind:'node', id, labels, properties}`, paths | Rows of values | The compiler and a decode layer rebuild nodes, relationships and paths |
| Ids | Store integers | Node ids from the graph's id column | Same shape; values may differ after reload |
| Error codes | `SMALTCY_*` | `SMALT_*` (`engine/errors.ts:128`) | Map, or document the change |
| Integers | Doubles; integers exact to 2⁵³ | 64-bit integers | Better; document |
| Division by zero | Error (`SMALTCY_TYPE`) | `NULL` | Compiler emits a checking division, or document |
| Booleans | Their own type; `true = 1` is false | Stored as 0 and 1, so `true = 1` | Compiler keeps Cypher's rule where it matters, or document |
| Comparing types | `1 < 'a'` is `null` | A total order: `1 < 'a'` is true | Compiler guards comparisons, or document |
| `ORDER BY` | Nulls last; Cypher's type order | Nulls first by default, another type order | Compiler sets `nullsFirst` per key; mixed-type order documented |
| Lists with `null` | `[1, null] = [1, null]` is `null` | Byte equality: true *(inferred)* | Document |
| Functions | — | `substring` 1-based; `log` is log10; `trim` spaces only; `sum` of nothing `NULL`; `stDev` of one value `NULL`; `collect` keeps nulls; `toInteger('12abc')` is 12; `=~` finds rather than matches | The compiler maps each to Cypher's meaning (`ln`, `+1`, `total`, `list_drop_nulls`, anchored patterns …) |
| History | `AT VERSION`, `AT TIME`, `version()`, `commits()`, `commit()`, `history()`, `Graph.at/diff`, author and message per commit, the timeline | Section 3 | Kept, on whichever method is chosen. Versions become the database's commit ids, with gaps (decision 17); the timeline moves to smaltkit |
| Files | `GraphJSON` export and import | Moves to smaltkit (decision 21) | Kept: the way to move a graph from the old engine to the new |
| Drawing | The WebGPU renderer | Moves to smaltkit (decision 21) | smaltcy's users import it from smaltkit |

## 6. Steps

| Step | Repository | What | After |
|---|---|---|---|
| 0 | smaltdb | Format safety: refuse files that need unknown features; reserve a durable 64-bit commit id and commit time in the header; exhaustiveness checks on op switches; fix `plan/public.ts` | — |
| 1 | smaltdb | G1, narrow; differential and sqllogictest runs adjusted for order | — |
| 2 | smaltdb | G2: `key`, `maxDepth`, a heap that lowers keys | 1 |
| 2a | smaltdb | The map type ([ADR 0038](0038-map-type.md)) | 0 |
| 3 | smaltdb | G4: the property graph record and schema ops; node and edge table conventions; tables made on first use; the label index table; per-label copies; the engine's invariants on writes from any language | 0, 2a |
| 4 | smaltdb | G5: `paths`, lowered to `iterate`; path modes and selectors | 2, 3 |
| 5 | smaltdb | Engine functions SQL can use too: `split`, `range`, `starts_with`, `ends_with`, `contains` | — |
| 6 | smaltdb | History: the opt-in switch, both methods, `asOf` in plans, commit author and message, the explicit cleanup; designed with `track_changes` | 0 |
| 6a | smaltql | SQL reads the past (`FOR SYSTEM_TIME AS OF`, or the syntax its ADR picks) | 6 |
| 7 | smaltdb | Benchmarks of section 5.1; history's default chosen and recorded here | 6 |
| 8 | smaltcy | The compiler to smaltdb plans, beside its own engine; both run the Cypher suites and are compared | 3, 4, 5 |
| 9 | smaltcy | Switch to smaltdb: a new major version, migration notes, its own engine removed | 7, 8, 10 |
| 10 | smaltkit, smaltcy | The renderer, timeline widget and GraphJSON import and export move to smaltkit | — |
| — | smaltdb | G3 `loop`, when graph algorithms are wanted | 2 |

Steps 0 to 7 land before the 1.0 format freeze (decision 9).

## Questions answered (2026-11-17)

The five open questions of 2026-11-14 are decisions 15 (the catch-all column), 13 (Cypher's meaning), 16 (retention),
18 (per-label copies) and 22 (the number) above.

## Consequences

- One engine and one plan language for the whole family; graph data is visible to SQL, dataframes and the typed API.
- smaltdb gains graph operations and version history that every language can use, at no cost to databases that don't
  use them, if the per-table flags and the step 0 checks are kept.
- smaltcy's users get durable storage and history on disk, and a breaking change to an asynchronous API at the switch.
- Until step 9, smaltcy is unchanged.
