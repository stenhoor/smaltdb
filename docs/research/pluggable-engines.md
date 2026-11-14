# Pluggable storage engines

**Question (owner, 2026-11-11):** can B+tree, columnar and graph storage become pluggable components that the plan
API reaches, with engines offering support for specific plan operations, so future data engines can be added?

**Short answer.** Yes. The plan already separates *what* from *how*: plans never name storage, and the physical
planner decides. What's missing is an interface between the planner and storage:
- Today that boundary is a closed set (`storage: 'row' | 'columnar'`), with columnar handling spread through the
  engine.
- The design is two interfaces, one for **table engines** and one for **index engines**, each declaring what it can
  do, and the planner asking it per query which parts of a plan it can take over.
- Every engine stores its data in the shared pager's pages, so transactions, the WAL, recovery, snapshots and
  parallel readers stay the engine's, not each plugin's.

The work is mostly a refactor of today's two storage kinds onto that interface, and it must cost no measurable
performance before a third engine is added.

## 1. Where things stand

- **Plans are storage-free.** `scan`, `join`, `aggregate` and the rest name tables, never their storage (ADR 0014,
  ADR 0016).
- **Storage is a closed choice per table:** `TableDef.storage: 'row' | 'columnar'`. The physical planner branches on
  it (`isColumnar(table)`).
- **Columnar handling is spread out, not behind an interface.** References to it in the source:

  | File | References |
  |---|---|
  | `database.ts` (writes, DDL, materialized views, statistics) | 83 |
  | `exec/planner.ts` (access paths, zone maps, morsels) | 27 |
  | `exec/operators.ts` | 15 |
  | `catalog/schema.ts` | 10 |
  | plus code generation, the catalog and validation | a few each |

- **The B+tree is the substrate:** row tables, every secondary index, the catalog itself, statistics and
  materialized-view metadata.
- **One plug point exists for data, external formats** (plugin API v1, ADR 0012 and 0013):
  - a `FormatReader` declares `pushdown`;
  - it then receives the statement's `projection` and per-block filters (`blockFilters`), and can skip what isn't
    needed (Parquet row groups).

  That is a small version of what this note proposes: an engine that says what it can do, and gets the parts of a
  query that fit.

Comparable designs:
- **Postgres:** table access methods and index access methods as separate interfaces, and foreign-data wrappers
  that claim scans, joins and aggregates through path callbacks.
- **Apache Calcite:** adapters whose planner rules push operations into a data source.

## 2. The design

### 2.1 Two kinds of engine

| | Table engine | Index engine |
|---|---|---|
| **Holds** | a table's rows | a secondary access structure over a table's rows |
| **Today** | `row` (B+tree), `columnar` | B+tree indexes (including expression and partial indexes) |
| **Future** | graph edge store, time series, append-only log | adjacency (CSR) for graph traversal, vectors (nearest neighbours), full text, spatial (R-tree) |

Most "new data engines" are index engines: they answer a kind of question fast over rows stored as usual. Splitting
the two keeps new engines small.

### 2.2 The substrate is shared

Engines don't get files. They get the **page store**: allocate, free, read, mark dirty, and page images in a
transaction. That is how columnar segments already work (M5).

So for every engine:
- one commit is atomic across all engines;
- the WAL and crash recovery are the engine's, not the plugin's;
- snapshots, checkpoints and M9's parallel readers (shared block cache, shared WAL index) work unchanged;
- spill files and memory-resident objects (M7) are offered the same way.

A plugin can't corrupt durability by getting its own file handling wrong, because it has none.

### 2.3 What an engine declares

**Statically, once:**
- name, version, and on-disk format version, which is recorded in the catalog per table or index;
- writes: none, append-only, or full; and whether rows can be fetched by rowid;
- orderings it can produce (for example rowid order, or key order);
- the options it accepts in `WITH (…)`, which it validates itself;
- maintenance it needs: compaction, rebuild on open (as `location = 'memory'` objects are), integrity check,
  statistics.

**Per query, by negotiation.** The physical planner offers each engine the part of a plan over its table. The
engine answers with what it takes, what is left over, and what that costs:

```ts
interface Claim {
  /** What the engine takes over: the scan, plus any of these it can do itself. */
  filter?: PlanExpr[];        // predicates it evaluates (or uses to skip data): zone maps, an index range
  project?: number[];         // columns it reads (it may leave out the rest)
  aggregate?: AggregateSpec;  // grouping and aggregates it computes: columnar sums over segments
  order?: SortKey[];          // an order it returns rows in
  limit?: number;             // a limit it applies itself: top-k from a vector index
  operation?: PlanOp;         // a whole operation it runs: `paths` on a graph store, `asof` on a time-series store
  residual: PlanExpr[];       // what the engine core still evaluates on the rows it returns
  rows: number; cost: number; // estimates, in the planner's units
}
```

The planner weighs the claims against its own plans (scan plus filter, index lookups, hash joins) by cost, as it
weighs access paths today. "Engines offering support for specific plan operations" is exactly this:
- a graph engine claims `paths`, and joins on an edge's endpoints;
- a vector index claims `ORDER BY distance(…) LIMIT k`;
- a full-text index claims a `match(…)` predicate;
- a columnar engine claims filters with zone maps, and aggregates over segments.

**Expressions keep one meaning.** Engines receive plan expressions, which carry their types, collations and
conversions (ADR 0016 section 2):
- An engine may evaluate a predicate natively, such as a range on its key or a zone-map test.
- Otherwise it calls the engine core's compiler (`compilePlanExpr`), so SQL's semantics are never reimplemented in a
  plugin.
- A claimed predicate must give the same rows as the residual would. Section 4 covers how that is enforced.

### 2.4 What an engine executes

- **Reads:** batches of columns (the shape the client protocol and columnar pipelines already use), plus fetching a
  row by rowid where the engine supports it. A batch boundary keeps the cost of the abstraction per batch, not per
  row.
- **Writes:**
  - insert, update and delete by rowid, inside the core's transaction and savepoints;
  - constraints stay in the core: NOT NULL, CHECK and foreign keys;
  - unique keys are an index engine's job, as now.
- **DDL:** create, drop, truncate. `ALTER TABLE` operations are offered to the engine, which may refuse one it can't
  do in place; the core then rebuilds, or fails with `SMALT_UNSUPPORTED`.
- **Maintenance:** checkpoint and idle hooks (columnar compaction today), integrity check, statistics for `ANALYZE`
  (row counts, distinct values, histograms, degree distributions for graphs).

### 2.5 How engines are installed

- **Built-in:**
  - `row`, the B+tree, which the catalog itself needs and which stays in the core;
  - `columnar`, which can stay built in but move behind the same interface.
- **Plugins:**
  - additions to the plugin host: `host.addTableEngine(engine)` and `host.addIndexEngine(engine)`;
  - additive to plugin API version 1 (ADR 0013) if the interface is stable by then, else plugin API version 2;
  - a worker entry installs them like any plugin (`defineWorker({ plugins })`), and parallel readers get the same.
- **Tables and indexes name their engine:** `WITH (storage = 'graph')` and `CREATE INDEX … USING adjacency`, as plan
  data and in each language. A database whose tables need an engine that isn't installed opens, but reading those
  tables fails with `SMALT_PLUGIN_MISSING`, as external formats do today.

## 3. Path there

Each step is a separate PR. Steps 1 and 2 prove the interface on today's engines before any plugin depends on it.

1. **E1: the table-engine interface, inside the core.**
   - Move columnar handling behind it: the 83 references in `database.ts` and those in the planner and operators.
   - Move row tables behind it too.
   - Gate: the storage and browser benchmarks show no regression (compared with `bench/results/`), and the full test
     suite plus sqllogictest stay green. This is the largest step.
2. **E2: negotiation in the physical planner.** Claims for filters, projections, aggregates, order and limits; today's
   columnar zone maps and fused aggregates become columnar's claims. Gate: the plan-shape corpus (ADR 0014 step 2)
   and the benchmarks are unchanged.
3. **E3: the index-engine interface,** with B+tree indexes behind it.
4. **E4: plugin entry points** (`addTableEngine`, `addIndexEngine`): an ADR, and a test engine in
   `test/plugins.test.ts`, as for formats.
5. **E5: the first new engine as a plugin.** The adjacency index for graph traversal would claim G5's `paths` (see
   [Graphs on the plan API](./graph-on-plans.md)). Or a vector index, if that is wanted sooner.

**Rough size:**
- E1 is a refactor of roughly 2,000–3,000 lines touched, mostly moved rather than new.
- E2 and E3 are about 800–1,200 new lines each.
- E4 is small: about 300 lines plus the ADR.
- New engines are then sized by their own data structures (a CSR adjacency index: about 1,500–2,500 lines, like
  columnar storage) rather than by integration work.

## 4. Risks and how to meet them

- **Performance.** An interface can cost the hot paths: fused pipelines, point lookups, prepared statements.
  - Batches amortize calls.
  - Built-in engines can keep their specialized code generation behind the interface.
  - E1 and E2 land only with benchmark parity.
- **Correctness of claims.** A claimed filter or aggregate must equal the core's.
  - A differential test runs every plan in the corpus twice, with negotiation on and off, and compares the rows.
  - Every engine plugin runs it, as a conformance suite (`test/plugins.test.ts` already checks the format and source
    interfaces with test plugins).
- **Format stability at 1.0.**
  - The file format freezes the catalog record that names an engine and its format version.
  - Each engine versions its own pages.
  - A database records which engines and versions it needs, so a missing or older plugin is refused cleanly, not
    misread.
- **Plugin trust.** An engine runs inside the engine worker with access to the page store. Plugins already run there
  (ADR 0012). The page-store interface limits an engine to its own pages, which the core allocates and records, so
  one engine can't overwrite another's or the catalog's.
- **Scope.** This is a significant change to the core: [ADR 0028](../adr/0028-pluggable-storage-engines.md) proposes it, with the owner's
  decisions:
  - whether columnar moves to a plugin or stays built in;
  - plugin API v1 additive or v2;
  - whether to do it before or after 1.0. Before is better: the catalog's engine record is a format change.

## 5. Graph, and relational and graph together (owner's question, 2026-11-14)

**Yes. The design supports graph storage, and hybrid relational/graph use falls out of it rather than needing its own
mode.** The pieces are already named: the plan extensions G1–G5 in [Graphs on the plan API](./graph-on-plans.md), and
engines E1–E5 here.

- **A graph is a view of tables.** G4's property-graph object names vertex and edge tables. The rows stay ordinary
  rows, so the same data is read relationally (`scan`, `join`, `aggregate`) and as a graph (G5's `paths`), in one plan
  and one transaction. A path's result is rows too, so it joins back to any table.
- **The usual shape is an index engine.** An adjacency index (CSR) over an ordinary edge table:
  - The edge rows stay in a B+tree or columnar table, so relational queries over edges work unchanged.
  - The index claims `paths` and joins on an edge's endpoints.
  - Writes are ordinary inserts, updates and deletes, and the index follows them in the same transaction.

  That is hybrid by construction.
- **A graph table engine is the other option.** It suits large, read-mostly graphs, where the edges live only in CSR
  segments. It must still serve plain scans (every table engine does), so relational queries over its edges keep
  working, only without the B+tree's point lookups.

**What the interfaces must guarantee for hybrid use.** All of it is in section 2:
- claims for a whole operation (`operation: paths`) and for joins on endpoints;
- index engines over any table engine that fetches by rowid, columnar included;
- statistics an engine reports for costing (degree distributions for graphs);
- one commit across every engine.

**What pluggability doesn't provide.** Graph queries need G1–G5 in the plan API first: G1 is a planner bug in recursive
joins, and G2–G5 are new plan operations and a catalog object. Those are plan work in the core. An engine can only
make a plan operation fast; it can't add one. So the graph track is: G1–G5 in the core, E1–E4 for the interfaces, then
the adjacency index as E5.

## 6. Beyond table storage and indexes: what else should be a plugin (owner's question, 2026-11-14)

Table storage and indexes are the right first pair: they are where new data engines differ. But they are not the
only components a future engine needs, and some components should never be plugins.

### What is pluggable today

| Component | How | Since |
|---|---|---|
| Languages (SQL, and smaltdf's DataFrames) | `registerLanguage`, `defineWorker({ languages })` | ADR 0015 |
| External formats, table functions, sources, connection types, methods | `host.addFormat`, `addTableFunction`, `addSource`, `addConnectionType`, `addMethod` | ADR 0012, 0013 |

### Candidates

| Component | Today | Recommendation |
|---|---|---|
| **Functions** (scalar, aggregate, window) | Two fixed maps in `exec/functions.ts` (`scalarFunctions`, `aggregateFunctions`, 983 lines). No plugin can add one | **Yes, first.** New engines come with functions: a vector index needs `distance(…)`, full text needs `match(…)`, geo needs `st_within(…)`. An index engine claims predicates on its own functions (section 2.3). Small: a registry, purity and determinism flags, the result type, and the generic call path in code generation (built-ins stay inlined). About 300–500 lines |
| **Types and collations** | Closed: `PlanType` (`StaticType`), and three collations (`binary`, `nocase`, `rtrim`) hard-coded in `values.ts` and the key codec | **Yes, after functions, as extension types.** A name over an existing physical type (a vector over `list<real>` or a blob; a geometry over a blob), with its functions and conversions. That needs no record-format change. A plugin collation must also supply its key encoding, or indexes can't order by it (ICU and locale collations). About 800–1,200 lines; collations are the costly part |
| **File system (VFS)** | The `Vfs` / `VfsFile` interface exists (`vfs/types.ts`, synchronous file operations), but the worker runtime always opens OPFS (`worker-runtime.ts`) | **Yes, small.** A VFS option in `defineWorker`. Uses: encryption at rest (a VFS that wraps another and encrypts pages), an IndexedDB fallback, test and Node backends. The WAL, checksums and parallel readers sit above it and don't change. About 100–200 lines |
| **Change feed** | None. Commits aren't observable outside the engine | **Later, as a core feature that plugins subscribe to.** For sync and replication, and live updates in smaltui and smaltbi. The core emits committed changes per table; plugins read them and never write through them. About 400–600 lines, with the sync work that needs it |
| Compression and encodings in columnar segments | Inside the columnar engine | **Part of the columnar engine,** not a plugin kind of its own. Once columnar is behind the engine interface (E1), its codecs are its own business |
| Spill and memory policy | Core (M7) | **No for now.** A setting, not a plugin |

### What stays in the core

- **The pager, WAL, transactions, recovery, snapshots and parallel readers.** Durability lives in one place. This is
  why engines get pages, not files (section 2.2).
- **The catalog and the file format,** including the record of which engines a database needs.
- **The planner, optimizer and cost model.** Engines take part through claims and statistics (section 2.3). Letting
  plugins add optimizer rules (Calcite-style) can be revisited after 1.0, once claims have proven themselves: a bad
  rule breaks every query, not only one engine's.
- **Plan operations and the operators that run them.** A new operation, such as `paths`, is a plan change, decided in
  an ADR and built in the core; engines then accelerate it.
- **Constraints:** NOT NULL, CHECK and foreign keys. Unique keys stay an index engine's job.
- **The worker protocol and the client.**

### Order

1. **Functions,** since engines need them. Its own small ADR, additive to plugin API v1.
2. **ADR 0028's E1–E4** (table and index engines).
3. **The VFS option,** at any time. It is independent and small.
4. **Extension types and collations,** after functions, and before 1.0 if a type must reach the file format.
5. **The change feed,** with the sync work that needs it.

ADR 0028 can stay about storage and indexes. Functions and extension types are a second, smaller decision, and are
better kept in an ADR of their own, so each can be accepted or deferred separately.
