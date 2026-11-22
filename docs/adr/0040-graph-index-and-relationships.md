# ADR 0040: A graph index in memory, and relationships as a relation

- **Status:** merged by the owner in [#276](https://github.com/stenhoor/smaltdb/pull/276) (2026-11-20), which this
  record takes as its acceptance. The questions at the end got no separate answer, so each step follows the record's
  own proposal and says so in its pull request. Steps 2a, 2c and 2b are built (section 5). The numbers in the Context
  come from a spike that was measured and thrown away (2026-11-20).
- **Date:** 2026-11-20
- **Builds on:** [ADR 0033](0033-property-graphs-and-history.md): its decision 7 ("An adjacency index only if benchmarks
  ask for one") and section 4 ("patterns become joins"), and G6 of the
  [research note](../research/graph-on-plans.md). It differs from that note's section 5 on one point (section 1 below).
- **For:** [stenhoor/smaltdb#274](https://github.com/stenhoor/smaltdb/issues/274), and smaltcy's
  [ADR 0004](https://github.com/stenhoor/smaltcy/blob/main/docs/adr/0004-cypher-on-smaltdb.md), "The bar for switching":
  smaltdb at least as fast as smaltcy's in-memory engine on every query and write of its benchmarks.

## Context

### Where the benchmarks stand

smaltcy `51f6b80` and smaltdb `28069bc` (the merges of `096037b` and `1c2fce8`, where this table was measured; the
trees are the same), 20,008 nodes and 60,025 relationships, the method of smaltcy's `docs/research/benchmarks.md`. A
ratio is smaltdb's time over smaltcy's; the bar is 1.00 or less.

| Query | The same text every run | Statements that differ: a literal, a parameter |
|---|---|---|
| 1 hop | 1.89x | 0.91x, 0.84x |
| 2 hops | 2.58x | 1.22x, 1.29x |
| 3 hops | 2.94x | 2.02x, 2.00x |
| Variable length 1..3 | 1.05x | 0.96x, 0.97x |
| Shortest path | 0.95x | 0.62x, 0.96x |
| Shortest path, 5 hops | 1.36x | |
| Shortest path, directed | | 1.50x, 1.63x |
| Shortest path, directed, no path | 1.91x | |
| Shortest path, no path | 2.53x | 2.29x, 2.81x |
| Triangles | 2.24x | |

Scans over properties (label scan and filter 2.31x, group by city 2.62x) and writes (up to 116x) are later steps of the
issue and not this record's subject.

### What a hop costs today

- A relationship's endpoints are read from the edge table's B+tree indexes on `(start, end)` and `(end, start)`: one
  descent per node, per direction and per type.
- smaltcy lowers a hop that may go either way to an `iterate` of depth 1: a recursive step with two branches, one for
  each way a join can read the edge table. Its rows are queued and read back.
- A directed hop is a join, but it fetches each relationship's row: the plan's scan of the edge table lists the
  property column, though the query reads no relationship's property. Three directed hops, prepared: 8.86 ms against
  smaltcy's 2.68 ms (3.30x).

### The spike

A few hundred lines in the engine, not committed: each edge table's relationships kept in memory as lists per node,
built from the table and rebuilt after any write (so it measured reads only).

**1. The lists as an access path, under the plans smaltcy makes today.** The planner reads a relationship's endpoints
from the lists where it would use an endpoint index.

| Query | The same text: before, with | A literal: before, with | A parameter: before, with |
|---|---|---|---|
| 1 hop | 1.89x, 1.29x | 0.91x, 0.81x | 0.84x, 1.06x |
| 2 hops | 2.58x, 1.43x | 1.22x, 0.90x | 1.29x, 0.77x |
| 3 hops | 2.94x, 1.56x | 2.02x, 1.18x | 2.00x, 1.23x |
| Variable length 1..3 | 1.05x, 0.56x | 0.96x, 0.61x | 0.97x, 0.69x |
| Shortest path | 0.95x, 0.87x | 0.62x, 0.40x | 0.96x, 0.63x |
| Shortest path, 5 hops | 1.36x, 0.78x | | |
| Shortest path, directed | | 1.50x, 1.06x | 1.63x, 1.08x |
| Shortest path, directed, no path | 1.91x, 1.56x | | |
| Shortest path, no path | 2.53x, 1.14x | 2.29x, 1.18x | 2.81x, 1.20x |
| Triangles | 2.24x, 2.20x | | |

Variable length and the shortest paths that exist come under the bar; the directed ones and those with no path don't
yet (1.06x to 1.56x). Hops get nearly twice as fast and stay over the bar: what is left is the `iterate` around each
hop, not the lookups. Triangles don't change: their hops are directed, and fetch the row.

**2. Hops as one join each.** Operator trees built by hand from the engine's own operators, over the same lists, with
the start node found through its prepared plan. Milliseconds, lowest median of 15 rounds:

| | smaltcy | Today's plan on the lists | Nested loop joins over a leaf that gives the relationships at a node | A dedicated expand operator |
|---|---|---|---|---|
| 1 hop | 0.044 | 0.026 | 0.005 | 0.005 |
| 2 hops | 0.426 | 0.567 | 0.036 | 0.040 |
| 3 hops | 5.112 | 8.530 | 0.393 | 0.453 |

The hand-built trees leave out what a statement adds around its plan (a seek by name, whole, is 1.04x of smaltcy's
today). With one join per hop, the engine's ordinary nested loop join runs 2 and 3 hops in less than a tenth of
smaltcy's time, and a dedicated operator is no faster than it.

**3. Costs, by hand** (the layout of section 1, outside the engine):

| | |
|---|---|
| Building both directions for the 60,025 relationships from their endpoint indexes | 19.7 ms |
| Keeping both lists for one new relationship | 309 ns (in a statement that creates 1,000, smaltcy takes 1,700 ns for each and smaltdb 20,900 ns today) |
| For one deleted relationship | 300 ns |
| Memory | 47 bytes per relationship, the table by node included, with blocks that double as they fill |

## Decision

### 1. A graph index

Each property graph gets a **graph index**: its relationships in memory, by node.

- **What it holds.** Per direction (out, in), each node's relationships as entries of three 32-bit integers: the type
  (its position among the graph's edge tables), the node at the other end, and the relationship's rowid. A node's
  entries are sorted by type, other node and rowid, which is the order the endpoint indexes give. So a type is a range
  found by binary search, "is there a relationship from a to b" is a binary search, and a plan returns the same rows in
  the same order with or without the index. It also holds, per type, how many relationships there are and how many
  nodes have one, for the planner's estimates.
- **Layout.** A node's entries are one block in a pooled array, found through a table by node id that is made in pages,
  so ids need not be dense. A long list is kept in chunks of at most 1,024 entries, so adding a relationship to a node
  that has a million moves one chunk, not the list.
- **Derived, not stored.** It is built from the edge tables' endpoint indexes on first use and is never written to the
  file. The tables and their B+trees stay the storage, so the file format, commits, the WAL, recovery, snapshots and
  history are untouched. This is where it differs from the research note's section 5, which describes a graph *store*
  that "must live in pager pages": this is an index over the store there is, and keeping it in pages is a later
  question (section 5 below).
- **Kept by the engine** as rows are written, by the graph rules that already see every write to a graph's tables
  (`exec/graph-rules.ts`), whichever language writes. A statement reads its own writes, as it does from a B+tree.
- **Dropped, and built again on next use,** when it can no longer be trusted: a rollback (of a statement, a savepoint
  or a transaction) that undoes a change to it; another connection's commit (the pager's change counter moved, as the
  columnar caches check); a change to the graph's tables or definition. Rollbacks could keep it with an undo log; that
  is built if a workload asks.
- **Where it lives.** On the engine that writes. A statement that reads it runs there and is not handed to a reader
  worker, as statements that read memory-resident objects aren't (`usesMemoryObjects`). Reader workers, `asOf` reads
  and graphs it can't hold run the same plans on the B+trees (section 3).
- **Limits.** Node ids and rowids from 0 to 2^31 - 1, and a memory limit (`graphIndexMem`, 256 MB unless set; 0 turns
  the index off). A graph outside either is not indexed.

### 2. What reads it

**2.1 Edge tables.** For an edge table of a property graph, a condition `start = x` or `end = x` (and the other
endpoint, if given) can be answered from the index. The planner offers it beside the endpoint indexes and costs it
lower; it stands for the endpoint index where a plan names one. Other columns of the row are fetched by rowid. No plan
changes: SQL joins, the lowering of `paths` and smaltcy's present plans get table 1's times.

**2.2 `relationships`, a new plan operation.** A leaf: the relationships of a graph, as a relation.

| Field | |
|---|---|
| `graph` | The property graph |
| `direction` | `out`: each relationship once, at its start. `in`: once, at its end. `both`: at each end (a loop once) |
| `types` | Only these relationship types; all of the graph's when left out |
| `asOf` | As a scan's (ADR 0033, H1) |

| Column | |
|---|---|
| `node` | The node the relationship is at |
| `other` | The node at its other end |
| `type` | Its type's name |
| `id` | Its rowid in its type's table |
| `outgoing` | Whether `node` is its start |
| `props` | Its catch-all properties (read from its row when a plan uses them) |

It is a source like a table, in a join region the planner already orders by cost: read whole, or by `node = x`, or by
`node = x and other = y`. Built, it is also read by `other = x` alone (2026-11-20): a pattern can be bound at either
end, and with that a language need not turn the operation round to suit the planner's join order. A hop is then one join, whatever its direction and however many types it allows, and a
pattern is one join region. Which relationships a pattern may repeat stays a condition the language writes (Cypher: no
relationship twice in a match), as it is today.

This keeps ADR 0033's model, patterns are joins, and gives the join the one thing it lacked: a relation that reads a
relationship from either end. smaltcy's compiler emits it for hops and drops its `iterate` hops and the splitting of a
pattern into branches.

**2.3 `paths`.** Its lowering gets 2.1 at once. Over a property graph's edge tables it also gets a search of its own
for the selectors `any` and `anyShortest`: breadth-first, keeping the first path found to each node, reading each
node's relationships in the endpoint indexes' order. And `paths` gains an optional `target` column: only paths that
end at that node, so the search stops when it reaches it. Elsewhere `target` is a filter on the lowering.

Corrected 2026-11-20: this section first said the search "picks the path the lowering picks". Building it showed that
the lowering has no one answer: which of two paths as short it keeps follows how its planner reads the edge table (by
rowid on a small table, by the endpoint index on a large one), and `paths` never specified it. The search's answer is
fixed, and is the same with and without the index.

### 3. Without the index

Every plan means the same and returns the same rows. `relationships`, 2.1's scan and the search of `paths` read the
endpoint indexes of each type's table. An operator chooses when it opens, so a prepared statement stays valid when the
index comes or goes.

A test setting checks the index against the tables after every write, and runs every read with and without it,
comparing rows in order. smaltdb's graph tests and smaltcy's differential suite run with it.

### 4. No `match` operation

The review on the issue (2026-11-20) recommended a `match` plan operation with a planner of its own, as its step 3, and
the owner approved it. Table 2 says it isn't needed for speed: the ordinary join is as fast as a dedicated operator
once a hop is one join. A pattern operation would add a second planner and move smaltcy's pattern semantics into the
engine, for no measured gain. It stays possible, as the adjacency index was in ADR 0033: when measurements ask.

### 5. Steps and gates

The issue's step numbers. Each is its own pull request, measured with smaltcy's three benchmarks, and merged only if
it meets its gate.

| Step | What | Gate |
|---|---|---|
| 2a | smaltdb: the graph index (build, upkeep, drop rules, limits, the test setting) and 2.1 | Variable length, shortest path and its 5 hops at or under smaltcy; 1 to 3 hops faster than today; no write slower |
| 2b | smaltdb: `relationships`. smaltcy: emits it for hops, after adding to its benchmarks directed hops, a hop to a labelled node and a hop filtered on a relationship's property | 1 to 3 hops, triangles and the added cases at or under smaltcy, as the same text, with a literal and with a parameter; no read slower |
| 2c | smaltdb: `paths` on the index, and `target`. smaltcy: gives the target | Variable length and every shortest-path case at or under smaltcy |
| 3 | Was the `match` operation: not built (section 4) | |
| 4 | Writes, starting with a spike on creating 1,000 nodes | Every write at or under smaltcy, or the numbers why not, for the owner to decide |
| 5 | Properties kept in memory, by column (its own record first) | Every read at or under smaltcy, the label scan and filter and group by city among them |

If 2b's hop to a labelled node is over the bar, the index also holds each node's labels, measured then.

**Built since** (2026-11-20; the same benchmarks; the commits named are the branches as they were measured, before
they were rebased onto `main`):

| | Before, then with 2a: `claude/graph-index` (`8904484`) | With 2c too: `claude/graph-paths` (`95189f6`), smaltcy `claude/shortest-path-target` (`e0dffcb`) |
|---|---|---|
| The same text: variable length 1..3 | 1.05x, 0.58x | 0.63x |
| The same text: shortest path | 0.95x, 0.89x | 0.88x |
| The same text: shortest path, 5 hops | 1.36x, 0.86x | 0.16x |
| The same text: shortest path, directed, no path | 1.91x, 1.55x | 1.20x (0.033 ms against 0.029) |
| The same text: shortest path, no path | 2.53x, 1.25x | 0.25x |
| The same text: 1, 2 and 3 hops | 1.89x, 2.58x, 2.94x; 1.28x, 1.51x, 1.68x | 1.32x, 1.58x, 1.59x |
| Statements that differ (a literal and a parameter): shortest path | 0.62x and 0.96x, 0.49x and 0.67x | 0.13x and 0.18x |
| Statements that differ: shortest path, directed | 1.50x and 1.63x, 1.13x and 1.22x | 1.03x and 0.90x |
| Statements that differ: shortest path, no path | 2.29x and 2.81x, 1.28x and 1.24x | 0.28x and 0.29x |

- **2a meets its gate.** No write is slower with the index kept (in turns against a database with none: 0.98x to
  1.04x; deleting 1,000 nodes 0.84x). In the engine the index builds in 13.9 ms for the 60,025 relationships and 191.5
  ms for 599,834, and takes 39 to 55 bytes per relationship.
- **2c misses its gate by two statements of under 0.15 ms** (1.20x and 1.03x above). Their time is the statement's
  fixed cost, not the search: of smaltdb's 32.0 µs for the directed search with no path, the prepared statement is
  9.4 µs, turning the Cypher into its plan is 13.2 µs (smaltcy's engine does that too), and finding the kept statement
  by its shape is the rest. The seek by name is the same case (1.04x). That cost is smaltcy's to cut, in its own step.
- **2b meets its gate but for two of the added cases** (smaltcy's `docs/research/benchmarks.md`, "Hops as
  relationships"; smaltdb's time over smaltcy's, with 2c and then with 2b). The same text: 1 hop 1.32x to 0.96x, 2 hops
  1.58x to 0.85x, 3 hops 1.59x to 0.85x, 1 hop directed 2.39x to 1.03x, 3 hops directed 2.55x to 0.66x, triangles
  2.09x to 0.90x. With a literal and a parameter every hop is under: 3 hops 0.74x and 0.76x, 3 hops directed 0.58x and
  0.64x. With [#278](https://github.com/stenhoor/smaltdb/pull/278) too (a nested plan's projection leaves out what
  nothing reads) the same text gives 1 hop 0.79x, 2 hops 0.35x, 3 hops 0.30x. Still over:
  - **2 hops to a label** (2.26x; 1.30x and 1.12x): each far node's label is a probe of the label index's B+tree,
    about a microsecond for each of 1,505 nodes. The provision above applies: the index also holds each node's labels
    (next bullet).
  - **2 hops filtered on a relationship's property** (2.86x; 1.38x and 1.36x): each relationship's row is fetched for
    one property. That is step 5's subject.
- **The index holds labels too** (the provision above, built after 2b): a set of nodes per label, from the graph's
  label index table, kept by that table's writer and dropped with the lists. A plan that asks whether one node has
  one label is answered from it. With it, on 2b: 2 hops to a label 2.26x to 0.47x (0.369 ms against 0.740), with a
  literal and a parameter 0.44x and 0.50x. The planner also now scans a label's nodes from the node table and checks
  the label for each in memory, where it read the label's entries and fetched each node's row: label scan and filter
  2.18x to 1.02x (4.48 to 2.11 ms), group by city 2.69x to 1.65x (53.7 to 37.4 ms). The other queries did not move.
- Their pull requests come in the steps' order of building: 2a (#279), then 2c on it (#280), then 2b (#281), then
  the labels.
- **A label's nodes are read from its set** (added 2026-11-21, after ADR 0041's steps; it is step 1 of what ADR 0042
  proposes, [#292](https://github.com/stenhoor/smaltdb/pull/292), and stands without the rest of it). No benchmark
  read a small label. A statement that finds a node of a label of a few hundred nodes by a property that has no
  index read the label's entries from the label index's B+tree, looked each node's row up and filtered it: 3.7x to
  4.6x smaltcy's time for 401 nodes. For 3,000 nodes, more than the planner counts in an index, it scanned the node
  table: 8.4x to 9.1x. Now:
  - the label's entries come from its set in the graph index (`GraphLabelEntries`), in the index's order;
  - the planner takes a label's count from its set, however many nodes it has;
  - where an inner join then finds each node's row through the property maps (ADR 0041), the label's scan first
    asks them whether the row can pass the plan's conditions on its props, checked on the map's bytes where they
    lie, and gives only the nodes that can. A node that fails costs a step in the set and that check.

  Measured against smaltcy (smaltdb's time over smaltcy's, the engines in turns, three runs of `main` and then of
  this), each statement another value of `MATCH (n:Bench {i: …}) RETURN n.i`:

  | Nodes of the label | `main` | With this |
  |---|---|---|
  | 50 | 1.28x, 1.27x, 0.96x | 0.73x, 0.85x, 0.87x |
  | 401 | 4.61x, 3.80x, 3.70x | 0.82x, 0.77x, 0.81x |
  | 801 | 5.76x, 6.03x, 5.60x | 0.82x, 0.86x, 0.80x |
  | 3,000 | 8.82x, 8.44x, 9.10x | 0.77x, 0.68x, 0.66x |

  Other reads through a label, on smaltcy's network of 20,000 people with a label of 401 nodes and one of 3,000
  added (two runs each): a range of a property of the small label 2.30x and 2.62x to 0.70x and 0.64x, its nodes
  counted 1.92x and 1.94x to 0.94x and 0.91x, a hop from one of its nodes 2.90x and 2.90x to 0.78x and 0.76x, a node
  with two labels by a property 1.96x and 2.12x to 0.93x and 1.00x, an `OPTIONAL MATCH` of one 1.75x and 1.58x to
  0.42x and 0.44x; a range of the larger label 4.70x and 3.96x to 0.51x and 0.47x. smaltcy's three benchmarks did not
  move (two runs of each), but for deleting one node of a label of some 440, which finds its node this way: with the
  value in the text 9.52x and 7.63x to 2.20x and 2.57x (0.247 and 0.215 ms to 0.057 and 0.058), as a parameter 8.47x
  and 8.16x to 2.47x and 2.39x.

  Found here and still over the bar, or at it: every node of the small label returned (3.06x and 2.60x to 2.41x and
  2.19x), the larger label's nodes counted (2.97x and 2.91x to 1.12x and 1.12x), the nodes with two labels counted
  (1.49x and 1.47x to 0.95x and 1.07x) and a label of 8 nodes returned (1.26x and 1.18x; 1.21x and 1.27x with this,
  15 µs against 13). In each, every node's row is still asked for through the join, a node at a time. The first
  read of a label reads each of its nodes' rows from the table: the maps know a row once it was read by its rowid.
  The planner's costs were left as they are: it reads a label's nodes this way where it read the label's entries
  before, and where the label's own count, lower than the statistics' number for a label, now makes that cheaper
  than scanning the node table.
- **The graph's rules ask the index, and a plan run inside a statement gives its writers back** (added 2026-11-21,
  beside ADR 0042's steps: it changes no plan). One statement that deletes 1,000 nodes was the write furthest from
  the bar, 26x to 29x smaltcy's time. Each node's row is deleted after the engine has kept the graph's rules for it
  (ADR 0033): it asks whether a relationship starts or ends at the node, with a plan for each edge table and end,
  and deletes the node's label entries with another. In a profile of that statement on `main`, this was 57% of the
  time: the plans that ask for relationships 10%, and making a `TableWriter` for the label index 16%, since a
  writer taken inside a statement stayed taken until the statement ended, and each node's plan made its own. Now:
  - the rule asks the graph's index whether the node has a relationship of each type at each end
    (`GraphIndexes.connected`: a seek in the node's list), and runs its plans only where the graph isn't indexed
    and for an id the index holds no node for. A node is refused for the same table and end as before;
  - the writers a plan takes are free again when the plan ends (`Database.internalPlan`), so the next node's plan
    takes the same writer. This holds for every plan the engine runs inside a statement, a foreign key's actions
    too: one statement that deletes 60 rows whose children go with them wrote through 61 writers and writes
    through 2. A plan that writes the table a statement or plan that has not ended is writing still makes its own.

  Measured against smaltcy (smaltdb's time over smaltcy's on its network of 20,000 people, `main` and this in
  turns): deleting 1,000 nodes in `bench/writes.ts`, three runs, 26.04x, 28.87x and 29.00x to 17.27x, 18.72x and
  20.39x (13.4, 12.6 and 12.1 ms to 9.7, 8.7 and 9.1); in `bench/vary.ts`, two runs, 19.70x and 20.30x to 15.00x
  and 15.30x (15.3 and 15.3 ms to 9.8 and 9.8). The other writes and the reads stayed within the spread between
  runs. In the engine alone, 1,000 nodes with a label entry and no relationship deleted inside one transaction
  (three runs in turns, µs a node): by one statement 12.1, 9.1 and 8.7 to 4.6, 4.8 and 4.6; by a statement for
  each node, the lowest of 25 rounds, 6.6, 6.7 and 6.6 to 6.1, 6.2 and 6.0. In the profile the rules are now 43% of
  the delete, 37% of it the label entries' own delete from their B+tree and its two indexes: rows written as the
  statement runs, which is what ADR 0042's step 4 changes.

  A table that keeps history and is written by such plans lost a history row where two of a statement's plans
  each made a writer: every writer of the table had its own writer for the history table, with its own idea of
  that table's last row. With one writer for the plans the rows are kept (`test/history-log.test.ts`). The same
  loss remains where the plans write the table their statement is writing (a foreign key from a table that keeps
  history to itself): it is on `main` before this, and is not fixed here.

  **2026-11-22: fixed.** A history table has one writer, whichever writer of its table reports to it
  (`Database.historyWriter`). Before, one statement that deleted two rows of such a table and the four rows under
  them kept 4 of the 6 history rows due, and the history row of the next statement, which deleted one row more,
  replaced an earlier one: 4 of 7 kept, by both methods (`test/history-log.test.ts`).

Later, each only with its own measurement: the index shared with reader workers, an undo log for rollbacks, the index
kept in pager pages so opening a large graph doesn't wait for a build, and whether a graph's edge tables still need
both endpoint B+trees once the index exists (step 4 asks this: a relationship is three B+tree writes today).

## Consequences

- Graph queries on the writing engine read relationships from memory; storage, the file format and durability don't
  change.
- Memory: 47 bytes per relationship as measured by hand, under a limit. Opening costs nothing; the first statement
  that reads a graph builds its index (19.7 ms for 60,025 relationships by hand; a million would take about a third of
  a second if it grows in proportion, which is an assumption until measured).
- A write to an edge table also updates two lists (309 ns by hand). A rollback that undid such a write costs a rebuild
  at the next read.
- Reader workers and `asOf` reads run graph plans at today's speed until the index is shared with them. Graph reads
  therefore don't run in parallel yet.
- One new plan operation and one new optional field, both additive (ADR 0016): no plan format change, and nothing
  changes for smaltql, smaltdf, smaltts or the plugins. smaltcy moves its pin and changes its compiler in 2b and 2c.
- Databases without property graphs pay nothing: the index hangs off the graph rules' per-table check.

## Questions for the owner

1. **`relationships` and joins instead of a `match` operation** (section 4): a change from what the review recommended
   and the owner approved, on table 2's evidence. Agreed?
2. **Graph reads stay on the writing engine** until the index is shared with reader workers, so they run one at a time.
   Acceptable for now, with sharing as a later measured step?
3. **The memory limit:** 256 MB by default, above which a graph runs on the B+trees. A different default?
