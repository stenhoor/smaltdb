# Graphs on the plan API

**Question (owner, 2026-11-11):** to what extent can the plan API support a graph-based representation of data rather
than a relational one, and is there a way to a unified plan that supports both?

**Short answer.** The plan is relational algebra with a fixpoint operator, and that already covers a large part of
what graph queries need. Graph pattern queries compile to joins, and variable-length paths compile to recursion. That
is how SQL:2023's property-graph queries (SQL/PGQ) define them. What the plan cannot express today:
- shortest-path semantics that visit each node once;
- whole-graph algorithms such as PageRank or connected components, which need one step over the whole frontier at a
  time;
- a graph as a catalog object.

All three can be added to the plan as additive changes. So the answer is one unified plan, extended, rather than a
second engine. The probe also found a planner bug that makes unbounded traversals hundreds of times slower than they
should be (section 4).

## 1. What the plan API is today

A plan (`src/engine/plan/ops.ts`) is a tree of positional relational operations:
- **Sources:** `scan`, `source` (table functions, virtual and external tables) and `values`.
- **Row operations:** `filter`, `project`, `join` (`inner`, `left`, `right`, `full`, `semi`, `anti`, `cross`,
  `asof`), `setop`, `sort`, `limit`, `aggregate`, `window`, `distinct`, `sample`, `pivot`, `unpivot` and `explode`.
- **Writes:** `append`, `update` and `delete`.
- **Recursion:** `iterate` with `working`.

Expressions are columns, literals, parameters, calls to the engine's operations, `case`, casts, logic and subqueries.
Types include `list<T>` and `struct<…>` (ADR 0020), with `list_*` operations, `implode` and `explode`.

**Recursion runs one row at a time** (`RecursiveCte` in `exec/operators.ts`), as SQLite does:
- `init` seeds a queue.
- Each step takes one row from the queue as the working table and runs the steps on it.
- `distinct` (UNION) drops rows already seen, comparing the whole row.
- An `order` turns the queue into a priority queue.
- `limit` stops the walk.

The physical planner chooses join order and access paths by cost (ADR 0005). A join on an indexed column becomes an
index lookup.

## 2. Graph workloads, one by one

| Workload | Today | How |
|---|---|---|
| **Property-graph data** (nodes and edges with labels and properties) | Yes, as tables | A node table per label, and edge tables with `src` / `dst` foreign keys. Multi-label nodes can use a `list<text>` column. Properties need declared columns or `ANY` columns: there is no map or JSON type, and tables are STRICT. |
| **A graph as a named object** | No | The catalog has tables, views, materialized views, indexes and external tables, but nothing that says "these tables form graph G". SQL/PGQ's `CREATE PROPERTY GRAPH` is that object. |
| **Fixed-length patterns** (`(a)-[]->(b)-[]->(c)`) | Yes | Joins. The cost-based planner orders them and uses an index on `edge(src)` for each hop. Measured: 1, 2 and 3 hops from one node in 4–7 ms (section 4). |
| **Cyclic patterns** (triangles, cliques) | Yes, without the best algorithm | As joins. Pairwise joins can produce far more intermediate rows than the result for cyclic patterns. Graph engines use worst-case optimal (multiway) joins there. Not measured. |
| **Variable-length paths and reachability** (`-[*1..k]->`, `*`) | Yes | `iterate` joins the working row to the edges. Bounded walks are fast; **unbounded ones hit a planner bug** (section 4). |
| **Path modes** (GQL / SQL/PGQ `WALK`, `TRAIL`, `ACYCLIC`, `SIMPLE`) and returning the path | Partly | A path can be built in a `list<…>` or text column and checked each step. That costs O(path length) per step, and there's no built-in mode. |
| **Unweighted shortest paths** (`ANY SHORTEST`, `ALL SHORTEST`) | Partly | A depth-bounded walk plus `min(depth)` per node. The walk enumerates (node, depth) states instead of visiting each node once, because deduplication compares the whole row. |
| **Weighted shortest paths** (Dijkstra) | Partly | An `order` on the cost gives a priority queue. But deduplication on the whole row (node, cost) revisits nodes: in the probe, 4,621 states for 3,871 nodes. "Settle each node once" can't be expressed. |
| **Graph algorithms** (PageRank, connected components, centrality, community detection) | No | They need rounds over the whole frontier, often with an aggregate and a convergence test. `iterate` runs one working row at a time, so an aggregate in a step sees one row's expansion, not the round. And plugins can only add table functions backed by file formats, not functions over the engine's tables. |
| **Graph updates** (create or delete nodes and edges) | Yes | Writes, with foreign keys. `ON DELETE CASCADE` removes a node's edges. |
| **Graph-shaped results** (paths, subgraphs) | Yes | `list<struct<…>>` columns (ADR 0020). |
| **Adjacency access** | B-tree, O(log n) per hop | An index on `edge(src)` (and `edge(dst)` for incoming edges). There's no direct adjacency structure like a native graph database's. A CSR-like layout is possible as a columnar materialized view of `implode(dst)` per node, read with `explode`. |

## 3. Can one plan serve both? Yes, as additive extensions

The literature and recent systems agree:
- Graph pattern queries are relational joins.
- Path queries are recursion, plus path semantics.
- SQL:2023 (part 16, SQL/PGQ) defines property graphs as views over tables, queried with `GRAPH_TABLE(… MATCH …)`.

So the unified plan is this plan, with these additions in the order they pay off:

1. **G1, fix recursive-step join order** (bug, section 4). Without it, every unbounded traversal is slow.
2. **G2, keyed `iterate`:**
   - an optional `key` (column indexes) to deduplicate on instead of the whole row: first seen wins, and with
     `order`, the lowest wins;
   - an optional `maxDepth`.

   This gives BFS shortest paths (visit each node once) and Dijkstra (priority queue plus settle once). It's an
   additive plan field.
3. **G3, a set-at-a-time fixpoint operation** (`loop`):
   - each round reads all of the previous round's rows and may aggregate;
   - it stops when a round changes nothing, when a predicate holds, or after N rounds.

   This gives PageRank, connected components (label propagation), and semi-naive Datalog-style rules. A new operation,
   additive.
4. **G4, a property graph in the catalog:**
   - a stored object that names node and edge tables, their labels, keys and endpoint columns;
   - like SQL/PGQ's `CREATE PROPERTY GRAPH`, and language-neutral, as views are (ADR 0016).

   Every language binds against it, so the data stays in one store and SQL and graph queries see the same rows. It's
   one new kind of catalog record.
5. **G5, a `paths` operation:**
   - a start set, an edge source with endpoint columns, a direction and a hop range;
   - a path mode (walk, trail, acyclic, simple) and a selector (any, any shortest, all shortest, shortest k);
   - output: the path as a `list<struct>`.

   At first it can lower to G2's `iterate`. Being its own operation lets the planner later pick graph algorithms
   (bidirectional BFS, visited bitsets) and estimate costs, the way `join` lets it pick hash or index joins.
6. **G6, physical work, when measurements ask for it:**
   - degree statistics in `ANALYZE`, for path cost estimates;
   - an adjacency (CSR) structure as an index kind or columnar materialized view;
   - a worst-case optimal multiway join for cyclic patterns.

**Languages.** A graph query language is another language on the plan (ADR 0015), exactly as smaltdf is:
- a GQL/Cypher-style package;
- graph frames in smaltdf;
- SQL/PGQ's `GRAPH_TABLE` in smaltql, which mixes graph patterns into ordinary SQL;
- typed path calls in smaltts.

None of them needs storage of its own.

**What stays relational:** storage. Nodes and edges are rows, hops are index lookups, not pointer chasing. For the
data sizes smaltdb targets (up to about 1 GB), a B-tree lookup per hop is a few microseconds; the probe's 3-hop
neighbourhood (1,000 paths) took 5 ms. A native graph store would only pay off for very deep traversals over very
large graphs, which is outside smaltdb's goals.

## 4. Measurements (2026-11-11)

A probe in Node on `main` (`e082eeb`), with SQL from the pinned smaltql:
- 10,000 nodes and 100,000 directed edges (10 out-edges per node);
- an index on `edge(src)`, and `ANALYZE` run.

The probe was a scratch test and was not committed.

| Query | Time | Rows |
|---|---|---|
| 1 hop from one node (join) | 6.7 ms | 10 |
| 2 hops (join) | 3.7 ms | 100 |
| 3 hops (join; plan: three `SEARCH edge USING INDEX edge_src`) | 4.6 ms | 1,000 |
| Reachability, unbounded: `WITH RECURSIVE r(n) AS (SELECT 1 UNION SELECT e.dst FROM r JOIN edge e ON e.src = r.n)` | **48,978 ms** | 10,000 |
| The same with `CROSS JOIN` | **48,954 ms** | 10,000 |
| The same, carrying a column filtered with an always-true `WHERE r.d < 1000` | 139 ms | 10,000 |
| Depth ≤ 3, UNION on (node, depth) | 12 ms | 1,111 |
| BFS minimum depth (depth ≤ 4, then `GROUP BY n`) | 61 ms | 10,000 nodes |
| Simple paths of length ≤ 3, cycle check on a text path | 8.8 ms | 1,111 |
| Weighted, `ORDER BY` cost, UNION on (node, cost) | 35 ms | 4,621 states for 3,871 nodes |
| Aggregate in a recursive step (depth ≤ 2) | 1.9 ms | 111: one working row's group, not the round's |

**The planner bug.** With no filter on the recursive side, `EXPLAIN QUERY PLAN` gives:

```
RECURSIVE CTE r (UNION)
  SCAN edge (fused scan + filter)
  SCAN r (recursive step)
```

That plan scans all 100,000 edges for each of the 10,000 working rows, about 10⁹ rows. With any filter on the working
side, it becomes `SCAN r (recursive step)` then `SEARCH edge USING INDEX edge_src (=?)`, as it should: a working
table has one row per step. `CROSS JOIN` does not force the order either. This is G1, and it is worth an issue of its
own.

## 5. A native graph store beside B+trees and columnar storage

**Yes, all three can run under the one plan, because storage is physical, not logical.** The precedent is columnar
storage (M5, M7):
- A table chooses its storage (`TableDef.storage: 'row' | 'columnar'`, `WITH (storage = 'columnar')`).
- Plans never mention it: `scan`, `join` and `aggregate` read the same either way.
- The physical planner branches on it (`isColumnar(table)`: columnar scans, zone maps, fused pipelines).

A graph store would follow the same pattern:
- **Where it plugs in:** a third storage kind for edge tables (`storage: 'graph'`), or an adjacency index kind on an
  ordinary edge table, holding each node's neighbours together (CSR segments).
- **What the planner gains:** physical operators ("expand neighbours", traversals from G5's `paths`), chosen by cost
  where a plan joins on an edge's endpoints or asks for paths. The logical plan doesn't change, so a query can mix
  graph, columnar and B+tree tables, because every store still yields rows.
- **What it must keep:** like columnar segments, it must live in pager pages, not files of its own. Then atomic
  commits, the WAL, crash recovery, snapshots and M9's parallel readers come for free, as they did for columnar
  storage.

## 6. How big the graph items are

**Recent precedent.** Recent plan operations each took 60–110 lines of source, plus about 60 lines of tests, in one
PR each:

| Operation | Source lines | Test lines |
|---|---|---|
| `unpivot` | 62 | 61 |
| `pivot` | 74 | 57 |
| `asof` join | 109 | 61 |
| `sample` | 99 | 69 |

They're small because normalization rewrites each into existing operations, so no new executor code is needed. Two of
the graph items do need new execution.

**Estimates** (source lines in this repository; tests about the same again):

| Item | Plan API | Execution and planner | Catalog | Estimate | PRs |
|---|---|---|---|---|---|
| G1 recursive join order (bug) | none | cost of the working side | none | 20–50 | 1 |
| G2 keyed `iterate` (`key`, `maxDepth`) | 2 optional fields: ops, build, validate, print | `RecursiveCte`: deduplicate on the key, keep the best with `order` | none | 120–160 | 1 |
| G3 `loop`, a set-at-a-time fixpoint | 1 operation | a new operator that keeps each round (spilling when large), a convergence test and a round limit; planner support | none | 350–450 | 1–2 |
| G4 property graph | 2 schema operations (create, drop) | none | a stored record, loading, `information_schema`, `BindContext`, dependencies (a table in a graph can't be dropped) | 300–400 | 1, plus a format bump |
| G5 `paths` | 1 operation: modes and selectors | lowered to G2's `iterate`; the path as `list<struct>` | none | 250–350 | 1–2 |
| **G1–G5 in the engine** | | | | **about 1,000–1,400**, plus tests of about the same | **5–7** |

So G3, G4 and G5 are each 3–5 times a recent operation. The whole set is about 3–4 times ADR 0016 step 10's four
operations together (344 lines of source).

**Outside this repository:**
- **A graph language:**
  - SQL/PGQ's `GRAPH_TABLE … MATCH` in smaltql: the parser, binding patterns to joins and `paths`, and DDL for
    property graphs. Likely 1,000–2,000 lines.
  - A separate GQL/Cypher-style package: more than that, as it needs its own parser and result shapes.
- **A native graph store (section 5)** is the large piece. Columnar storage is about 1,100 lines of storage code
  (`storage/columnar.ts`, `exec/columnar-table.ts`, `exec/zones.ts`), plus its scans and pipelines in the planner
  and code generation. A CSR adjacency store with a delta for updates would be comparable: about 1,500–2,500 lines.
  It should come only when measurements show B+tree hops are too slow, which they are not at smaltdb's sizes
  (section 4).

## 7. Recommendations

1. **Fix G1 now, independently of any graph work.** It affects every recursive query that joins a large table, in
   any language.
2. If graph support is wanted, **start with G2 and G4.** Together they give pattern matching and shortest paths over
   the existing storage. A language (SQL/PGQ in smaltql, or a GQL/Cypher-style package) can then be built on them.
3. **G3 when graph analytics are wanted.** It is also the general "iterate until convergence" operation that smaltdf
   would use.
4. **G5 and G6 only when measurements show the lowered forms are too slow.**

Each step is additive to plan format and catalog. G4 adds a catalog record, which is a format change, so it should
land before the 1.0 freeze if it is going to.
