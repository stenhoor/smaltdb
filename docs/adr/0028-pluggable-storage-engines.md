# ADR 0028: Pluggable storage engines

- **Status:** deferred (2026-11-14): closed out for now by the owner. See [Outcome](#outcome-2026-11-14) at the end; the
  proposal below is kept as it was
- **Date:** 2026-11-11
- **Assigned to:** Andrew Beers
- **Research:** [Pluggable storage engines](../research/pluggable-engines.md) (the full design, sizes and comparable
  systems) and [Graphs on the plan API](../research/graph-on-plans.md) (the first new engine it would serve)
- **Builds on:** [ADR 0008](0008-materialized-views-and-columnar-segments.md) and
  [ADR 0010](0010-analytics-and-mixed-storage.md) (columnar storage), [ADR 0012](0012-plugins.md) and
  [ADR 0013](0013-plugin-api-v1.md) (plugins), [ADR 0014](0014-shared-plan-layer.md) and
  [ADR 0016](0016-plan-api-for-every-language.md) (plans), [ADR 0021](0021-parallel-readers-everywhere.md) (parallel
  readers)

## Context

Plans never name storage: `scan`, `join`, `aggregate` and the rest name tables, and the physical planner decides how to
read them. But the boundary between the planner and storage is a closed set, `TableDef.storage: 'row' | 'columnar'`,
and columnar handling is spread through the engine rather than behind an interface (83 references in `database.ts`, 27
in `exec/planner.ts`, 15 in `exec/operators.ts`, 10 in `catalog/schema.ts`).

So adding a storage engine (a graph store, an adjacency index for traversal, a vector index, full text, time series)
means editing the core in many places. The owner asked (2026-11-11) whether B+tree, columnar and graph storage can
become pluggable components the plan API reaches, with engines offering support for specific plan operations, so future
data engines can be added.

The one plug point for data today is external formats: a `FormatReader` declares `pushdown` and receives the
statement's projection and block filters. This ADR generalizes that idea to storage.

## Decision

**The owner's direction (2026-11-11).** smaltdb has one unified plan interface, and its data storage and index
components must be pluggable, so that future updates are integrated in an interoperable fashion. What that means for
this design:

- **One plan interface above storage.** Every language builds the same plans (ADR 0016), and no plan operation names a
  storage or index engine. A new engine adds no language-specific path and no new plan dialect: it serves the plans
  languages already build, through the claims in point 4.
- **Every storage and index component is pluggable, the built-in ones included.** The core reaches row tables, columnar
  tables and B+tree indexes only through the table-engine and index-engine interfaces, exactly as it reaches a plugin's
  engine. Once E1–E3 are done, no storage-specific branch (`isColumnar` and the like) is left in the planner, the
  operators or `database.ts`.
- **Interoperable.** Engines combine without knowing of each other: a table of one engine joins a table of another in
  one plan; any index engine works over any table engine that can fetch rows by rowid; one transaction commits the
  pages of every engine it touched. An engine from a later release or another plugin slots in without changes to the
  core or to the engines already there.

1. **Two kinds of engine.** A **table engine** holds a table's rows (today `row` and `columnar`). An **index engine**
   holds a secondary access structure over a table's rows (today B+tree indexes; later adjacency, vectors, full text,
   spatial). Most new engines are index engines, which keeps them small.
2. **Engines share the page store; they get no files.** An engine allocates, frees, reads and dirties pages inside the
   core's transaction, as columnar segments already do. One commit is atomic across engines, and the WAL, recovery,
   snapshots, checkpoints and parallel readers (ADR 0021) stay the core's. The core allocates and records each
   engine's pages, so one engine cannot write another's or the catalog's.
3. **Engines declare what they can do, statically.** Name, version and on-disk format version (recorded in the catalog
   per table or index); which writes they support (none, append-only, full) and whether rows can be fetched by rowid;
   orderings they produce; the `WITH (…)` options they accept; and the maintenance they need (compaction, rebuild on
   open, integrity check, statistics).
4. **The planner negotiates per query.** It offers each engine the part of a plan over its table; the engine answers
   with a claim: the filters, projection, aggregate, order, limit or whole operation it takes over, the residual the
   core still evaluates, and estimated rows and cost. The planner weighs claims against its own plans by cost, as it
   weighs access paths today. A graph engine claims `paths` and joins on edge endpoints; a vector index claims
   `ORDER BY distance(…) LIMIT k`; columnar claims zone-map filters and segment aggregates.
5. **Expressions keep one meaning.** Engines receive plan expressions with their types, collations and conversions. An
   engine evaluates a predicate natively or through the core's compiler (`compilePlanExpr`); it never reimplements the
   language's semantics. A claimed predicate must give the same rows as its residual would.
6. **Execution is by batches of columns,** plus fetch by rowid where supported, so the interface costs per batch, not per
   row. Writes (insert, update, delete by rowid) run in the core's transactions and savepoints; NOT NULL, CHECK and
   foreign keys stay in the core; unique keys stay an index engine's job. `ALTER TABLE` operations are offered to the
   engine, which may refuse; the core then rebuilds or fails with `SMALT_UNSUPPORTED`.
7. **Installation.** `row` tables and B+tree indexes ship in the core package, because the catalog is stored in them,
   but they are registered through the same interfaces as any other engine. Plugins add engines with
   `host.addTableEngine(engine)` and `host.addIndexEngine(engine)`, installed through `defineWorker({ plugins })` like
   any plugin. Tables and indexes name their engine (`WITH (storage = 'graph')`, `CREATE INDEX … USING adjacency`) as
   plan data and in each language. A database whose tables need a missing engine opens, but reading those tables fails
   with `SMALT_PLUGIN_MISSING`, as external formats do.
8. **Today's engines move behind the interface first,** with performance parity as the gate, before any plugin depends
   on it.

### Steps

Each step is a separate PR.

| Step | What | Gate | Rough size |
|---|---|---|---|
| E1 | The table-engine interface in the core; columnar and row tables behind it | No regression against `bench/results/` (storage and browser benchmarks); full suite and sqllogictest green; no table-storage branches left outside the engines | 2,000–3,000 lines touched, mostly moved |
| E2 | Negotiation in the physical planner; columnar's zone maps and fused aggregates become its claims | Plan-shape corpus (ADR 0014 step 2) and benchmarks unchanged; differential test (negotiation on and off) | 800–1,200 new lines |
| E3 | The index-engine interface, B+tree indexes behind it | As E1, for index branches | 800–1,200 new lines |
| E4 | Plugin entry points `addTableEngine` and `addIndexEngine`, with a test engine in `test/plugins.test.ts` | Conformance suite for engine plugins, including plans that mix the test engine with row and columnar tables and B+tree indexes | about 300 lines |
| E5 | The first new engine as a plugin: the adjacency index claiming `paths` (graph research G5), or a vector index | Its own tests and the conformance suite | 1,500–2,500 lines |

### The owner's decisions

Decided (2026-11-11): one unified plan interface; storage and index components pluggable and interoperable (above).

Open:

1. **Where columnar ships:** it is pluggable either way. Does it stay in the core package, or move to its own plugin
   package, as the formats did (ADR 0012)?
2. **Plugin API:** the engine entry points as an additive change to version 1 (ADR 0013), or a version 2?
3. **Timing:** before or after 1.0? Before is recommended: the catalog record naming a table's engine and format version
   is a file-format change, and the format freezes at 1.0.

## Consequences

- New data engines are sized by their own data structures, not by integration work in the core, and reach every
  language at once through the plan interface.
- Engines interoperate by construction: they meet only in plans, the page store and the core's transaction, so a new
  engine works with the ones already installed.
- Durability stays in one place: an engine plugin can't break transactions, recovery or parallel readers, because it
  has no file handling of its own.
- The core gains an interface on its hottest paths (fused pipelines, point lookups, prepared statements). Batches and
  keeping the built-in engines' specialized code generation behind the interface are meant to make it free; E1 and E2
  land only with benchmark parity, and degradations are reported with numbers.
- Claims can be wrong. Every plan in the corpus runs with negotiation on and off and the rows are compared; every engine
  plugin runs the same test as a conformance suite.
- The file format records which engines and format versions a database needs, so a missing or older plugin is refused
  cleanly, not misread.
- Engine plugins run in the engine worker with page-store access, as plugins already do (ADR 0012); the page-store
  interface confines each to its own pages.
- E1 is the largest refactor since ADR 0016, and it competes with the 1.0 work in [ROADMAP.md](../ROADMAP.md).

## Outcome (2026-11-14)

The owner closed this idea out for now, after the follow-up questions of 2026-11-14 (section 6 of the
[research note](../research/pluggable-engines.md) and the discussion that followed). Nothing in E1–E5 is scheduled.

**Why.**
- **B+tree and columnar storage are enough.** Within smaltdb's target size (about 1 GB, about 10 million rows,
  [ADR 0001](0001-initial-design-decisions.md)) they cover transactional and analytical work. The other layouts
  databases use are variations on them: time series and append-only logs suit columnar storage, and a graph's edges
  are rows.
- **Future growth is new index kinds, not table layouts.** Vector (nearest neighbours), full text, spatial and graph
  adjacency answer questions a B+tree index can't. Each needs the functions or plan operations that use it
  (`distance()`, `match()`, `paths`).
- **Graph doesn't need a new index at this scale.** Ten million edges is a few hundred MB, and a B+tree index on an
  edge table's endpoints (`(src, dst)`, which needs no table read) finds a node's neighbours in microseconds. In
  [Graphs on the plan API](../research/graph-on-plans.md), the slow cases were the plan, not storage: G1, the
  recursive-join bug, made reachability take 49 s against 139 ms. Graph work is G1–G5 in the plan API; an adjacency
  index waits until measurements on real workloads ask for it.
- **A general engine framework costs before it pays.** E1 alone is a 2,000–3,000-line refactor on the hot paths, and an
  interface designed from two engines would likely be wrong for the third. Runtime plugins also cost at call sites
  that see several engine classes (V8 stops specializing them), which batching hides except on point lookups.

**Ways to extend storage, if it is ever needed, fastest first:**

| Option | Performance | When |
|---|---|---|
| 1. Built in, no extension point (as columnar was added) | Fastest: specialized and inlined | The default for the next index kind |
| 2. An internal engine interface, unpublished | As today, if generated code still specializes per engine | Once three engines exist to design it from |
| 3. Engines that contribute generated code to the query's loop | As fast as built in | Only if outside developers must add engines |
| 4. Runtime plugins (the proposal above) | A cost per batch, more on point lookups | Not planned |

**Revisit when** a third engine or index kind is needed (most likely vector search or full text), or when outside
developers need to add their own.

**Recommended, not decided:**
- Before 1.0, reserve a catalog field that records each table's and index's engine name and format version. It is the
  only part that would be costly to add after the file format freezes.
- Plugin-registered functions and a VFS option in `defineWorker` are small, don't touch the hot paths, and stand on
  their own (research note, section 6).
