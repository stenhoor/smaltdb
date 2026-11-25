# ADR 0042: A graph's writes: run by smaltdb, in memory first, the tables written behind

- **Status:** merged 2026-11-21 ([#292](https://github.com/stenhoor/smaltdb/pull/292)) without answers to its three
  questions, so the steps follow what it proposes. Built: steps 1, 2 and 4, and of step 3 the engine's side; see
  [As built](#as-built) for the pull requests, what they measured and where they differ from the text. The numbers in the Context come from a spike that
  was measured and thrown away (2026-11-21); what is an estimate is marked as one.
- **Date:** 2026-11-21
- **Builds on:** [ADR 0033](0033-property-graphs-and-history.md) (a graph's tables; its step 8, Cypher's writes; its
  decision 12, the engine keeps a graph's rules), [ADR 0040](0040-graph-index-and-relationships.md) (the graph index:
  "derived, not stored"; its step 4, "Writes"), [ADR 0041](0041-properties-in-the-graph-index.md) (properties in the
  index) and [ADR 0015](0015-smaltql.md) (languages register with the engine).
- **For:** [stenhoor/smaltdb#274](https://github.com/stenhoor/smaltdb/issues/274): smaltdb at least as fast as
  smaltcy's in-memory engine on every query and write of its benchmarks. And the owner's two answers there of
  2026-11-21: "Need to keep pushing cost down. Comparison should be equivalent, memory to memory, wal will have to be
  optimized but it will obviously be slower." and "cy produces plans that are executed by db, if it is plan execution
  it belongs on db not cy".

## Context

### Where the writes stand

smaltdb `f383dd4`, smaltcy with [stenhoor/smaltcy#36](https://github.com/stenhoor/smaltcy/pull/36) (open: the
runner's statements kept by shape), 20,008 nodes and 60,025 relationships, the method of smaltcy's
`docs/research/benchmarks.md`. A ratio is smaltdb's time over the time of smaltcy's in-memory engine; the bar is 1.00
or less. Every read of those benchmarks is at or under it. The writes:

| Write | The same text every run (three runs) | Statements that differ: a literal, a parameter (two runs) |
|---|---|---|
| Create 1 node | 3.91x, 3.53x, 4.47x | 3.95x, 4.37x and 4.73x, 5.46x |
| Create 1 relationship | 2.94x, 2.86x, 4.06x | 2.56x, 2.66x and 2.41x, 2.57x |
| Set 1 property by name | 2.42x, 2.42x, 2.40x | 3.57x, 2.50x and 2.02x, 1.98x |
| Merge an existing node | 1.26x, 1.18x, 1.17x | 1.19x, 1.21x and 1.15x, 1.20x |
| Delete 1 node | | 8.37x, 8.66x and 7.64x, 9.47x |
| Create 1,000 nodes | 12.67x, 12.82x, 12.54x | 13.0x, 12.1x and 12.5x, 12.8x |
| Create 1,000 relationships | 9.66x, 10.63x, 9.61x | 8.25x, 8.26x and 8.21x, 9.03x |
| Set 1,000 properties | 13.99x, 12.77x, 12.76x | 14.0x, 14.5x and 12.5x, 13.0x |
| Delete 1,000 nodes | 29.53x, 26.37x, 28.51x | 21.5x, 21.1x and 21.1x, 21.4x |
| Merge 1,000 new nodes | 0.74x, 0.75x, 0.74x | 0.88x, 0.85x and 0.89x, 0.87x |

smaltcy's own times in those runs: creating 1 node 6 to 7 µs; in a statement that writes 1,000, 0.62 to 0.70 µs for
each node created, 0.52 to 0.64 µs for each property set and 0.42 to 0.47 µs for each node deleted.

### How a write runs today

- **smaltcy runs it.** Its write runner (`src/smaltdb/write.ts` there) executes the write's plan row by row and sends
  smaltdb a statement for each thing it does. Creating one node is five: a savepoint, a lookup of the last node id, an
  append of the node's row, an append of its label entry, and the savepoint's release.
- **A node is two rows and three index entries** on ADR 0033's tables: its row in the node table with an entry in each
  property index (one in the benchmark, on `name`), and a row in the label index with its two index entries. A
  relationship is one row and two index entries. Each is written into its B+tree as the statement runs, and the graph
  index is kept beside it.

### The spike

Scratch programs against `f383dd4` in memory, with the benchmark's network loaded. Times are medians; the cases of a
table took turns in one process.

**1. One create, part by part** (µs; 30 batches of 300; two runs):

| | |
|---|---|
| smaltcy: lexing the text | 2.15, 2.09 |
| smaltcy: parsing it (lexing included) | 3.37, 3.19 |
| smaltcy: parsing and binding it to its plan | 4.20, 3.87 |
| smaltcy's path to smaltdb: the plan, then finding the kept write by its shape | 6.17, 5.49 |
| smaltcy's engine: the whole create | 9.44, 8.40 (lowest batch 6.66, 6.00) |
| smaltdb, a kept statement that reads one empty row | 0.24, 0.18 |
| smaltdb, begin and commit with nothing between | 0.49, 0.46 |
| smaltdb, a savepoint and its release with nothing between | 0.84, 0.77 |
| smaltdb, a kept statement that writes one row of two integers to a plain table, its own transaction | 3.43, 3.12 |
| smaltdb, a kept statement that writes a node's row, its own transaction | 5.21, 5.03 |
| smaltdb, a node's row and its label entry, two kept statements between begin and commit | 12.10, 11.00 |

Profiled (one run each, the profiler on): of the plain row's 3.9 µs, 36% is the commit (22% of the statement is one
copy of the file's header, made for every transaction in memory), 13% marking pages changed and keeping their images
for a rollback, 27% writing the row. Of a label entry's 7.6 µs, 27% is its two index entries, 12% the check that it
is unique, 14% the commit, 12% marking pages, 11% its row and 8% the graph's rule on it.

**2. A node's rows, by layout** (µs a node; 20 rounds of 1,000 nodes labelled `Bench` with one property; three runs,
the last column from the second and third). "Storage alone" calls the table's writer for each row inside one
transaction: no statement, no rule, no graph index. For one row a node it encodes the list of labels once (1.83 and
1.91 µs encoding it for every row).

| Layout | A kept statement a node | One kept statement for 1,000 | Storage alone |
|---|---|---|---|
| Today: the node's row and its label entry | 12.28, 12.60, 12.92 | 7.95, 7.87, 7.97 | 5.38 (one run) |
| One row a node, its labels a list in the row, no index | 3.78, 4.01, 3.94 | 1.98, 2.17, 2.08 | 1.46, 1.48 |
| The same with an index on `name` (an entry for every row) | 4.99, 5.55, 5.14 | 3.01, 3.01, 3.29 | |
| A plain row of two integers | 2.85, 3.29, 3.25 | 1.24, 1.19, 1.25 | 0.60, 0.62 |

Also storage alone, on one row a node (one run): a row read and written again with one more property 3.09 µs, a row
deleted 1.12 µs. Encoding a map of one integer property takes 0.41 and 0.39 µs.

**3. The same writes on the graph index's own structures, and nothing written to a table** (µs a node; 40 rounds of
1,000; three runs, with the lowest round in brackets): the label sets and the property maps of ADR 0040 and 0041 as
they are in the source, and a list of the rows still to write.

| | |
|---|---|
| A new node: its label in the set, its map encoded and held, its rows listed | 0.83, 0.44, 0.52 (0.40, 0.37, 0.39) |
| A property set: the map read, encoded again whole with one more key, held, the row listed | 1.79, 1.19, 1.28 (0.92, 0.72, 0.79) |
| A node deleted: its label taken, its map let go, its rows listed | 0.05, 0.03, 0.03 |

### What it says

- **A single write is statements more than rows.** Of the 23 to 27 µs a create takes with smaltcy#36, about 6 is
  smaltcy turning the text into a plan and finding its shape, and the rest is five statements. The rows alone, through
  their writers, are 5.4 µs.
- **No layout of rows written into B+trees as the statement runs reaches smaltcy's time in bulk.** The leanest one
  measured, one row a node with nothing else kept, costs 1.5 µs a node through the storage alone where smaltcy's whole
  create is 0.62 to 0.70; a property set costs 3.1 µs where smaltcy's is 0.52 to 0.64; a delete 1.1 µs where smaltcy's
  is 0.42 to 0.47. A plain row of two integers is 0.6 µs. So fewer or leaner tables do not get there, and this record
  does not propose to change ADR 0033's tables.
- **The graph index's own structures do.** A create on them is at smaltcy's time, most of it encoding the property
  map (0.4 µs), and a delete is far under. A set is over as the spike did it, encoding the whole map again; changing
  the map's bytes in place of that is not measured.
- **Which is what the owner's "memory to memory" says:** smaltcy's engine writes objects in memory, and smaltdb in
  memory writes B+tree pages. To compare like with like, a graph's write has to land in memory.

## Decision (proposed)

### 1. smaltdb runs a graph's writes

Plan operations for writing a property graph. Each passes its input's rows on, with columns for what it made, so a
write can sit in the middle of a plan and a language can read on from it. They are the graph's, not Cypher's: any
language writes a graph with them, and the engine keeps the graph's rules in them (ADR 0033, decision 12).

| Operation | For each row of its input |
|---|---|
| `graphCreate` | Makes nodes (labels; a map of properties) and relationships (a type; its ends, which are columns of the row or nodes it just made; a map of properties). Their ids are the graph's: one more than the largest, for nodes and across the graph's edge tables for relationships. Adds a column for each id |
| `graphSet` | For a node or a relationship the row names: sets or removes a property, replaces its properties with a map or merges a map into them, adds or removes labels |
| `graphDelete` | Deletes the relationships and nodes the row names. A node that still has relationships is an error, or with `detach` they go first |
| `graphMerge` | Runs a plan that reads the graph for the row: if it gives rows, passes them on (after a `graphSet` for each, if given); if none, makes what a `graphCreate` would (and then a `graphSet`, if given) |
| `eager` | Reads all of its input before it passes the first row on: how a language says that what is below must be finished before what is above starts |

- **Row by row.** A write handles its input's rows in order, each before the next is read, and what a row's
  expressions read of the graph is as it is then. So a property set from itself counts up over rows that name one
  node, and a `graphMerge` finds what it made for an earlier row.
- **Reads and writes do not meet inside the engine.** Where a write's input reads the graph's tables, the engine reads
  that input to its end before the write's first row is written, whether the language asked with `eager` or not: no
  scan is open on what is being written.
- **Labels and types a statement may add** are named by the statement, and added (as `alterPropertyGraph` adds them)
  when it starts, inside its transaction: a statement that fails leaves none.
- **What a statement did** comes back with its result: nodes and relationships created and deleted, properties set,
  labels added and removed.
- **Errors** are the engine's, with their code and fields; a language words them (`SmaltLanguage.errorMessage`).

smaltcy then compiles a write to one plan, as it does a read, and its runner goes. A Cypher statement is one smaltdb
statement, so it needs no savepoint of its own, and an id needs no lookup.

### 2. A graph's write lands in memory; its tables are written behind

For a property graph whose index is held (ADR 0040's limits), a write changes the index first: a node's labels and
properties, a relationship's lists and properties. The graph's rules are kept then, against the index. The index
knows which rows it holds that their tables do not have yet, in the order they were written; their values are the
ones it holds.

**The tables are brought up to date:**

- **before anything reads one of them from its B+tree or from one of its indexes:** a scan, a seek, a rule's check,
  another language's statement. That table, then;
- **at commit, when the database has a file,** so the log holds every commit and other connections, tabs and reader
  workers read what was committed, as today;
- **at commit, for a table that keeps history,** whose versions are commits;
- **before the index lets what is pending go** (it is over its limit, or dropped), and when the database is closed or
  copied.

So in a database in memory, a graph that is only read and written through its index never writes a B+tree, which is
what smaltcy's in-memory store does not do either. With a file, a commit writes what it writes today, in one pass in
key order. Rows are written behind through their tables' writers, with the rules already kept.

- **A rollback** (of a statement, a savepoint or a transaction) drops what it wrote from the list. The index is then
  dropped and built again at its next use, as today, after the rows of earlier commits that are still pending are
  written: a rebuild reads the tables. An undo of the index itself stays possible later (ADR 0040, section 1).
- **A graph whose index is not held** (off, over its limit, ids it can't hold, columnar or TEMP tables) is written
  through its tables' writers as the statement runs, as today. Every plan means the same either way.
- **The file format, the log, recovery and snapshots do not change.** ADR 0033's tables stay what a graph is stored
  as, and what SQL and every other language read.

### 3. Reads go on from memory

A plan that reads the graph through its index needs no table brought up to date: a relationship from a node, whether
a node has a label, a row found by its rowid with its properties (every pending row's map is held). Two reads still
go to B+trees today and get an index path first, so that the common writes do not make the next read pay for them:

- **A label's nodes.** The planner reads a small label's entries from the label index's B+tree, then each node by
  its rowid. It is slow on its own account: 371 and 377 µs over 801 nodes where smaltcy takes 70 and 68. The label
  sets give the nodes, and the maps their properties, in one loop. This is step 1 below, and worth building whatever
  becomes of the rest.
- **A seek on a property's index** (`CREATE INDEX FOR (n:L) ON (n.k)` is a B+tree on the node table). It stays a
  B+tree seek, so the node table is brought up to date before it. An index of a property kept in memory is a later
  step, taken if the benchmarks ask.

### 4. Kept statements are smaltdb's

smaltdb keeps statements by their text (64 a database unless set) and plans by theirs. Its entry points that take
text (`query`, `prepare`, `exec`) take SQL only today. Two additions:

- **A statement of any registered language, by its text.** smaltcy registers as a language (ADR 0015), and the entry
  points take a language's name. The language parses and binds a statement once; the engine keeps it by its text, as
  it keeps SQL's. This is where a statement kept by its text lives.
- **A statement whose values differ, by its shape.** smaltcy works a statement's shape out today and holds the
  prepared statement itself (`src/smaltdb/shape.ts` there). Holding it moves to smaltdb: a language's statement may
  carry a key for its shape and the values taken out of it, and the engine keeps what it bound under the key and
  runs it with those values. What the shape of a Cypher statement is stays smaltcy's to say.

### 5. Steps and gates

Each is its own pull request (smaltdb's, then smaltcy's where it has a side), measured with smaltcy's three benchmarks
and merged only if it meets its gate. The step numbers are this record's.

| Step | What | Gate |
|---|---|---|
| 1 | smaltdb: a small label's nodes and their properties read from the index (section 3) | That scan at or under smaltcy's time, with a benchmark case for it in smaltcy; no read slower |
| 2 | smaltdb: the write operations of section 1, run through the tables' writers as the statement runs | smaltcy's write tests give the same through a plan as through its runner; no write slower than with smaltcy#36 |
| 3 | smaltcy: compiles writes to those plans, registers as a language; the runner and its kept statements go (section 4) | Every single write faster than with smaltcy#36; the cases still over the bar listed with their profiles |
| 4 | smaltdb: writes land in the index and the tables are written behind (section 2) | In memory: every write of 1,000 rows at or under smaltcy's time, or the numbers why not. With a file: no write slower than before the step |
| 5 | What is left of a single write: the transaction's own cost (section 1 of the spike), a statement's | Each case at or under the bar, or to the owner with its profile |

**What the steps should give, as sums of the parts measured above. These are estimates, not measurements:**

- After steps 2 and 3, creating 1 node is about 16 µs (2.4x): 4 for the plan, 2 for the shape, and about 10 for
  one statement that writes the two rows (two statements between begin and commit take 11 to 12 today). With the
  same text every run it is about 10 µs (1.5x), since smaltdb finds a statement kept by its text without parsing it.
- After step 4, in memory, about 8 µs with a value that differs (1.2x) and about 2 µs with the same text. In bulk a
  create is the structures' 0.4 to 0.8 µs a node and what the operation itself costs for each row, which step 2
  measures (today's append costs about 0.6 µs a row over the storage alone); a delete is under the bar; a set
  depends on changing a map without encoding it whole, which is not measured.
- A single write whose text differs each time stays the hardest: smaltcy's engine spends 4 of its 6 to 7 µs on the
  text, and smaltdb's path spends those 4 and then finds a statement and runs it.

## Consequences

- Writing a graph becomes part of the plan language: five operations, all additive (ADR 0016). smaltql, smaltdf and
  the plugins change nothing. smaltcy loses its runner and gains a compiler for writes; its tests of writes compare
  rows, counts and the whole graph on both engines after every statement, and hold for either.
- The index stops being only derived: between a write and the next time its table is brought up to date, the index is
  the one place a row is. That is new, and the reason for step 4's own tests: every write run with and without it and
  the tables compared, and ADR 0040's test setting bringing the tables up to date after every statement and comparing
  them with the index.
- A read through a B+tree after writes pays for those writes then, in one pass, where today each write pays as it
  runs. A graph over the index's memory limit is written as today.
- In a database in memory, a commit of graph writes no longer writes pages. Nothing reads them but this connection,
  and what it reads is brought up to date first.
- With a file, durability is what it is today: a commit writes its rows and the log before it returns.

## Questions for the owner

1. **In a database in memory, a graph's tables are brought up to date when something reads them, not at each
   commit** (section 2). This is what puts a write in memory on both sides of the comparison. The other way, at each
   commit in memory too, leaves 1,000 creates at about 5.4 µs a node (8x), the storage's own time. Agreed?
2. **ADR 0033's tables stay as they are** (two rows and three index entries a node). The spike says leaner tables do
   not reach the bar either, so this record leaves them. Agreed, or should a leaner layout be measured further for
   databases with a file?
3. **The order of the steps:** the read first (it stands alone), then the operations and smaltcy's compiler, then the
   tables written behind. Steps 2 and 3 move the execution and by themselves leave bulk writes where they are; step 4
   is what reaches for the bar. The other order is possible: step 4 under the runner as it is. Which first?

## As built

Added 2026-11-22, with step 2. Each number says what it compares:

- **Against smaltcy:** smaltdb's time over the time of smaltcy's in-memory engine, on the same Cypher and the same
  network (20,008 nodes, 60,025 relationships), the engines taking turns, from smaltcy's benchmarks. This is the bar:
  1.00x or less.
- **The runner and one plan:** smaltdb's time for the same Cypher through smaltcy's runner, which sends smaltdb a
  statement for each thing a write does, on smaltdb `main` without the step, and through one plan on the step's
  branch, the two run in turns. It says what the step did, and nothing about smaltcy's engine.

| Step | Pull requests | Measured |
|---|---|---|
| 1 | [#293](https://github.com/stenhoor/smaltdb/pull/293), [#294](https://github.com/stenhoor/smaltdb/pull/294), [#295](https://github.com/stenhoor/smaltdb/pull/295), stenhoor/smaltcy#37 | Against smaltcy, before and after (smaltcy's `docs/research/benchmarks.md`, "Small labels, and nodes deleted"): a node of a small label found by a property 5.14x to 6.69x and 0.75x to 0.86x; one of 8 cities found by a property 1.06x to 1.09x and 0.83x to 0.85x; the 8 cities returned 1.23x to 1.43x and 1.15x to 1.16x, still over the bar; delete 1 node 7.50x to 9.75x and 2.23x to 2.66x |
| 2 | [#297](https://github.com/stenhoor/smaltdb/pull/297) | Below |
| 3 | stenhoor/smaltcy#38 (writes as one plan), [#299](https://github.com/stenhoor/smaltdb/pull/299) (section 4 in the engine); smaltcy registered as a language is to come | Below |
| 4 | The pull request that adds this row | Below |

### Step 2: its gate

**smaltcy's write tests give the same through a plan as through its runner.** A compiler from smaltcy's plans for
writes to the operations of section 1 was written to check it: a prototype of step 3, on smaltcy's branch
`claude/writes-as-plans`, not merged. smaltcy has five test files that run writes on smaltdb (writes, history, kept
writes, statement shapes, and the differential test against its own engine): 609 tests. Through plans 607 pass. The
two that fail read the runner's own statements (how many it sends for a `SET`, and which tables its id lookups
read), which a plan does not have.

**No write slower than with smaltcy#36.** smaltcy's `bench/writes.ts`, the same text every run: smaltdb's time in
ms through the runner on `5388845` and through one plan, three turns.

| Write | Through the runner | Through one plan |
|---|---|---|
| Create 1 node | 0.026, 0.024, 0.024 | 0.019, 0.019, 0.025 |
| Create 1,000 nodes | 8.00, 7.63, 7.95 | 7.36, 7.78, 7.76 |
| Create 1 relationship | 0.041, 0.042, 0.040 | 0.030, 0.031, 0.031 |
| Create 1,000 relationships | 11.81, 11.58, 11.64 | 10.47, 10.98, 10.58 |
| Set 1 property by name | 0.026, 0.026, 0.027 | 0.018, 0.018, 0.018 |
| Set 1,000 properties | 7.16, 7.00, 6.99 | 5.42, 5.86, 5.41 |
| Merge an existing node | 0.012, 0.012, 0.012 | 0.011, 0.011, 0.010 |
| Merge 1,000 new nodes | 9.40, 9.24, 9.26 | 8.98, 8.65, 8.04 |
| Delete 1,000 nodes | 8.39, 8.28, 8.50 | 6.78, 6.72, 6.83 |

By its medians every write is faster through one plan. Turn by turn, create 1 node and create 1,000 nodes each
have one turn of the three slower than the runner's (0.025 ms against 0.024, and 7.78 against 7.63), and the other
writes none. smaltcy's `bench/vary.ts`, statements that differ each time, measured the same way (three turns; the
median of the three, in ms, with a literal and with a parameter):

| Write | Through the runner | Through one plan |
|---|---|---|
| Create 1 node | 0.055 and 0.049 | 0.047 and 0.039 |
| Create 1,000 nodes | 9.63 and 9.60 | 8.26 and 8.55 |
| Create 1 relationship | 0.099 and 0.079 | 0.063 and 0.056 |
| Create 1,000 relationships | 14.54 and 14.53 | 12.55 and 12.58 |
| Set 1 property by name | 0.056 and 0.051 | 0.050 and 0.036 |
| Set 1,000 properties | 8.81 and 8.80 | 5.85 and 5.81 |
| Merge an existing node | 0.019 and 0.018 | 0.017 and 0.016 |
| Merge 1,000 new nodes | 11.93 and 11.88 | 9.20 and 9.56 |
| Delete 1 node | 0.059 and 0.054 | 0.037 and 0.034 |
| Delete 1,000 nodes | 9.54 and 9.60 | 8.13 and 8.34 |

Single turns of that benchmark read up to twice their case's other turns (through one plan, with a literal: set 1
property 0.050, 0.090 and 0.048 ms; delete 1 node 0.034, 0.080 and 0.037), which is why the table gives medians.

**Against smaltcy, through one plan** (`bench/writes.ts`, the same three turns): create 1 node 3.39x, 3.35x, 3.58x;
create 1 relationship 2.15x, 2.27x, 2.38x; set 1 property 1.82x, 1.77x, 1.76x; merge an existing node 1.13x, 1.10x,
1.10x; create 1,000 nodes 11.77x, 11.78x, 11.37x; create 1,000 relationships 8.25x, 8.55x, 8.15x; set 1,000
properties 10.45x, 10.70x, 11.34x; delete 1,000 nodes 16.27x, 14.53x, 15.29x; merge 1,000 new nodes 0.63x, 0.66x,
0.65x. Every write but the last is still over the bar: step 2 moves where a write runs, and steps 3 to 5 are what
reach for the bar.

### Step 2: where it differs from section 1

1. **A write's rows are written all at once where no row could tell.** Section 1 says row by row, which is what a
   plan means. Run that way, a plan's writes of 1,000 rows measured slower than the runner's on every case (create
   1,000 nodes 10.6 and 10.5 ms against the runner's 8.6 and 8.0; delete 1,000 nodes 26.68x and 26.17x against
   smaltcy where the runner's read 18.99x and 19.71x), since the runner already wrote such rows in one statement a
   table. So where nothing above a write, up to an operation that reads all its rows, reads the graph, writes or
   stops early, and what the write computes reads only its row, the engine writes its rows together, a pass over
   each table. The rows and the graph are the same: a test runs random plans both ways and compares them, and rows
   that would not give the same go one by one (a `graphSet` that would write one key of one node twice; a
   `graphCreate` row that names a node a later row makes). One thing is not the same: a statement that would fail
   for more than one reason may report another of them.
2. **`graphMerge`'s plan reads numbered rows, and a plan may say what lets all its rows be matched at once.** Matched
   one row at a time, 1,000 new nodes took 435 and 431 ms (31x smaltcy's time; the runner's 9.1 and 9.4 ms): each
   row's match read the label's nodes, 1,000 times over a label that grows. Inside the match, `working` gives each
   row with its number, and the match gives the number back, so one query can match many rows. `key` is what makes
   that sound: the plan says which values decide a row's matches, and that a row finds what an earlier row made
   exactly when it has that row's values. Without it the engine matches each row when its turn comes.
3. **A label or a type is added when a row first needs it,** not when the statement starts. A statement no row of
   which reaches the write then changes nothing: smaltcy's history tests expect such a statement to make no commit,
   and one that adds a label makes one.
4. **A statement may name the tables of the labels and types it adds** (`tables`), so that what the plan reads after
   a write can name them: a match that reads a label the same statement adds.
5. **A part that writes nothing is not always read to its end first.** Operations at its top that read the graph for
   each row (a nested plan in a `filter`, `project`, `explode` or `unpivot`; `paths`) run when each row's turn
   comes, over the one query below them. Cypher's `WITH x WHERE NOT EXISTS { … } CREATE …` needs it: the second of
   two rows that are the same must find what the first made. No scan is open on a table while it is written either
   way: such an operation's plan for a row is run to its end before the row goes on. Under an `eager` everything is
   read first.
6. **Ids are kept for the connection.** Section 1 says one more than the largest. As built it is one more than the
   largest the graph has had as far as the connection knows: an id is not given again after its node is deleted, nor
   after the statement that took it failed or was rolled back. smaltcy's runner did this with ids its caller kept
   from one statement to the next; without it the ids differed from those of smaltcy's engine after a delete and
   after a statement that failed, and smaltcy's tests compare them.
7. **`graphDelete` also takes lists of nodes, the hops of a path, and a path,** which Cypher deletes.
8. **A language's own errors are expressions that raise** (`raise_error`, with the language's code), in the plan,
   when a row reaches them: Cypher's "Can't create a relationship to NULL". The engine's errors are the tables':
   deleting a node that still has relationships is `SMALT_CONSTRAINT_FOREIGNKEY`, which a language words.
9. **The graph a plan writes** has a node table with a properties column and a label index, as smaltcy lays one
   out. `graphSet` and `graphDelete` find a node by its id in that table; any other graph is refused.

What section 1 says and is as built: the five operations; each passes its rows on with columns for what it made;
the writes go through the tables' writers as the statement runs (appends and updates as plans the engine runs
inside the statement, deletes by rowid through the writer); a statement that fails leaves nothing; what a statement
did comes back with its result (`graph`, also through the worker to the client).

One thing the measurements showed about the planner, not changed here: its estimate of the relationships at a node
is the average over the nodes that have any at that end. For a type that ends at few nodes that is high, and a join
of many nodes with the graph's relationships is then planned as a read of every relationship (a `graphDelete` of
1,000 nodes spent half its time there). The delete reads each node's relationships by a search at the node instead.

### Step 3: three pull requests

Step 3 is smaltcy's as section 5 has it: it compiles writes to plans and registers as a language, and its runner and
its kept statements go. Registering as a language needs section 4 in the engine, which no step names. So the step is
built as three pull requests. The split was made while building it; the owner did not decide it.

1. smaltcy: a statement that writes is compiled to one plan of section 1's operations, and the runner goes
   (stenhoor/smaltcy#38). It needs step 2 alone.
2. smaltdb: section 4 in the engine (the pull request that adds this section).
3. smaltcy: Cypher registered as a language, and what smaltcy keeps by shape gone. It needs the two above, and is
   not built; a prototype of it measured the second (below).

### Step 3: its gate

"Every single write faster than with smaltcy#36; the cases still over the bar listed with their profiles."

**As one plan** (stenhoor/smaltcy#38). Against smaltcy, through the runner (smaltcy `main` on smaltdb `6b5f100`) and
as one plan (on `38118db`), the two in turns, six turns each. The same text every run, the lowest and highest turn:

| Write | Through the runner | As one plan |
|---|---|---|
| Create 1 node | 3.71x to 4.35x | 3.21x to 3.76x |
| Create 1 relationship | 2.89x to 3.96x | 2.20x to 2.49x |
| Set 1 property by name | 2.42x to 2.67x | 1.71x to 1.92x |
| Merge an existing node | 1.15x to 1.24x | 1.01x to 1.11x |

Statements that differ each time, the median of the six turns, with a literal and with a parameter: create 1 node
4.51x and 4.08x through the runner, 3.91x and 3.26x as one plan; create 1 relationship 2.92x and 2.97x, 2.30x and
2.29x; set 1 property 2.21x and 2.33x, 2.02x and 1.81x; merge an existing node 1.10x and 1.10x, 1.00x and 0.99x;
delete 1 node 2.45x and 2.29x, 1.58x and 1.63x. Every single write is faster as one plan, and every one is still
over the bar but the merge of a node that is there, with statements that differ. smaltcy's
`docs/research/benchmarks.md`, "Writes as one plan", has the three benchmarks whole and each write's profile.

**As text, through the language** (the pull request that adds this section). Cypher registered as a language is a
prototype here, written to measure the engine's side: smaltcy's branch `claude/cypher-language-prototype`, not
merged. Its statements carry a shape and a variant (below), and smaltcy's tests of writes and of history on smaltdb
give the same through it (112 tests). What is compared, both against smaltcy and both on this pull request's
source (its first commit, `602de9f`; the one after it changes no statement's run), the two in turns:

- **As one plan:** smaltcy#38's path. For every statement smaltcy compiles the Cypher, finds its shape and runs the
  smaltdb statement it prepared for that shape.
- **As text:** the Cypher goes to `db.query(text, params, { language: 'cypher' })`. smaltdb finds the statement by
  its text, and where the text is new asks the language to parse it and finds it by its shape.

The same text every run (`bench/writes.ts`; four turns each, the lowest and highest):

| Write | As one plan | As text | smaltdb, as one plan and as text (ms) | smaltcy (ms) |
|---|---|---|---|---|
| Create 1 node | 3.22x to 3.48x | 2.00x to 2.16x | 0.020 and 0.017 | 0.007 |
| Create 1,000 nodes | 11.3x to 11.9x | 10.4x to 12.1x | 8.24 and 8.38 | 0.714 |
| Create 1 relationship | 2.10x to 2.34x | 1.29x to 1.39x | 0.033 and 0.021 | 0.014 |
| Create 1,000 relationships | 8.18x to 9.17x | 8.54x to 9.44x | 11.51 and 11.82 | 1.36 |
| Set 1 property by name | 1.72x to 1.79x | 0.93x to 1.00x | 0.019 and 0.011 | 0.011 |
| Set 1,000 properties | 9.38x to 12.2x | 9.97x to 11.3x | 6.03 and 5.74 | 0.595 |
| Merge existing node | 1.04x to 1.13x | 0.45x to 0.49x | 0.011 and 0.005 | 0.010 |
| Merge 1,000 new nodes | 0.64x to 0.68x | 0.62x to 0.69x | 9.56 and 9.66 | 14.63 |
| Delete 1,000 nodes | 14.6x to 16.5x | 14.2x to 16.0x | 7.62 and 7.62 | 0.481 |

Statements that differ each time (`bench/vary.ts`; four turns each, the lowest and highest). With a literal every
text is new; with a parameter the text is the same and its value differs:

| Statement | A literal: as one plan | A literal: as text | A parameter: as one plan | A parameter: as text |
|---|---|---|---|---|
| Seek by name | 0.95x to 1.01x | 0.95x to 1.12x | 0.84x to 0.92x | 0.27x to 0.30x |
| 1 hop | 0.53x to 0.55x | 0.62x to 0.64x | 0.50x to 0.63x | 0.20x to 0.24x |
| 2 hops | 0.38x to 0.41x | 0.39x to 0.42x | 0.39x to 0.41x | 0.22x to 0.23x |
| 3 hops | 0.29x to 0.34x | 0.31x to 0.34x | 0.30x to 0.32x | 0.25x to 0.29x |
| 3 hops, directed | 0.31x to 0.40x | 0.33x to 0.36x | 0.41x to 0.47x | 0.23x to 0.25x |
| 2 hops to a label | 0.26x to 0.29x | 0.24x to 0.30x | 0.23x to 0.27x | 0.17x to 0.19x |
| 2 hops, relationship filter | 0.67x to 0.79x | 0.69x to 0.78x | 0.66x to 0.80x | 0.47x to 0.52x |
| Var-length 1..3, distinct | 0.49x to 0.53x | 0.51x to 0.54x | 0.50x to 0.55x | 0.47x to 0.55x |
| Shortest path | 0.11x to 0.13x | 0.12x to 0.13x | 0.13x to 0.15x | 0.12x to 0.14x |
| Shortest path, directed | 0.89x to 0.94x | 0.87x to 0.90x | 0.56x to 0.77x | 0.26x to 0.39x |
| Shortest path, none | 0.22x to 0.25x | 0.22x to 0.23x | 0.23x to 0.24x | 0.21x to 0.25x |
| Label scan + filter | 0.68x to 0.76x | 0.65x to 0.77x | 0.53x to 0.56x | 0.51x to 0.54x |
| Node of a small label | 0.76x to 1.07x | 0.76x to 0.96x | 0.77x to 0.80x | 0.47x to 0.48x |
| Create 1 node | 3.48x to 3.60x | 3.66x to 3.99x | 2.87x to 3.42x | 2.52x to 2.86x |
| Create 1,000 nodes | 9.99x to 10.8x | 10.3x to 10.9x | 10.2x to 11.3x | 10.1x to 10.9x |
| Create 1 relationship | 2.06x to 2.41x | 1.98x to 2.48x | 2.24x to 2.45x | 1.51x to 1.75x |
| Create 1,000 relationships | 6.10x to 6.97x | 6.62x to 6.79x | 6.39x to 6.79x | 6.13x to 6.89x |
| Set 1 property by name | 1.68x to 2.18x | 1.90x to 2.10x | 1.69x to 2.53x | 1.08x to 1.32x |
| Set 1,000 properties | 9.23x to 9.78x | 9.49x to 9.97x | 9.07x to 9.76x | 8.52x to 9.51x |
| Merge existing node | 0.87x to 1.07x | 0.92x to 1.14x | 0.94x to 1.06x | 0.43x to 0.50x |
| Merge 1,000 new nodes | 0.60x to 0.68x | 0.61x to 0.65x | 0.62x to 0.66x | 0.61x to 0.67x |
| Delete 1 node | 1.43x to 1.69x | 1.36x to 1.72x | 1.47x to 1.65x | 1.00x to 1.10x |
| Delete 1,000 nodes | 10.7x to 13.3x | 11.5x to 12.4x | 11.6x to 13.1x | 11.9x to 12.7x |

The reads with the same text every run (`BENCH_INDEXES=1`; three turns each):

| Query | As one plan | As text | smaltcy, smaltdb as text (ms) |
|---|---|---|---|
| Seek by name | 0.81x to 0.84x | 0.24x to 0.25x | 0.018, 0.005 |
| 1 hop | 0.57x to 0.58x | 0.22x to 0.24x | 0.034, 0.007 |
| 2 hops | 0.29x to 0.30x | 0.25x to 0.26x | 0.336, 0.086 |
| 3 hops | 0.26x to 0.27x | 0.24x to 0.27x | 4.29, 1.13 |
| 1 hop, directed | 0.59x to 0.61x | 0.23x to 0.24x | 0.027, 0.006 |
| 3 hops, directed | 0.24x to 0.25x | 0.24x to 0.24x | 2.20, 0.528 |
| 2 hops to a label | 0.21x to 0.23x | 0.19x to 0.22x | 0.692, 0.139 |
| 2 hops, relationship filter | 0.59x to 0.64x | 0.56x to 0.60x | 0.538, 0.325 |
| Var-length 1..3, distinct | 0.48x to 0.50x | 0.47x to 0.49x | 12.33, 5.82 |
| Shortest path | 0.63x to 0.65x | 0.22x to 0.23x | 0.046, 0.010 |
| Shortest path, 5 hops | 0.15x to 0.15x | 0.14x to 0.16x | 32.20, 4.84 |
| Shortest path, none (out) | 0.85x to 0.87x | 0.27x to 0.30x | 0.029, 0.007 |
| Shortest path, none (all) | 0.20x to 0.23x | 0.20x to 0.22x | 31.90, 7.25 |
| Label scan + filter | 0.46x to 0.47x | 0.44x to 0.44x | 2.03, 0.926 |
| Small label + filter | 0.83x to 0.84x | 0.26x to 0.27x | 0.013, 0.003 |
| Small label | 1.18x to 1.19x | 0.47x to 0.56x | 0.009, 0.004 |
| Group by city | 0.65x to 0.68x | 0.64x to 0.70x | 23.62, 15.58 |
| All relationships | 0.13x to 0.14x | 0.12x to 0.13x | 16.64, 2.17 |
| Triangles (bounded) | 0.40x to 0.41x | 0.40x to 0.40x | 12.20, 5.31 |

What it says:

- **With the same text, and with a parameter, smaltdb compiles no Cypher:** it finds the statement by its text, where
  smaltcy's engine compiles the text on every run. So every single write is faster as text. The same text: create 1
  node 3.22x to 3.48x as one plan and 2.00x to 2.16x as text; create 1 relationship 2.10x to 2.34x and 1.29x to
  1.39x; set 1 property 1.72x to 1.79x and 0.93x to 1.00x; merge a node that is there 1.04x to 1.13x and 0.45x to
  0.49x. With a parameter: create 1 node 2.87x to 3.42x and 2.52x to 2.86x; create 1 relationship 2.24x to 2.45x and
  1.51x to 1.75x; set 1 property 1.69x to 2.53x and 1.08x to 1.32x; delete 1 node 1.47x to 1.65x and 1.00x to 1.10x;
  merge a node that is there 0.94x to 1.06x and 0.43x to 0.50x.
- **Every read is under the bar as text with the same text,** the 8 cities returned among them (1.18x to 1.19x as one
  plan, 0.47x to 0.56x as text), which was the one read over it. Reads whose time is the query itself read the same
  both ways (3 hops, the var-length match, the group by city).
- **With a literal that differs in every statement the two cost the same, or the text a few percent more.** Every
  text is new, so both compile the Cypher and find its shape; as text smaltdb also keeps a statement for the text.
  Measured by itself, the two paths in one process (40 rounds of 200 statements each way, in turns, three runs; as
  text over as one plan, the median of the rounds): create 1 node 1.02x, 1.02x, 1.07x; create 1 relationship 1.00x,
  1.04x, 1.04x; set 1 property 0.92x, 1.02x, 0.98x; merge a node that is there 1.03x, 1.00x, 1.03x; seek by name
  1.02x, 1.01x, 1.05x. In the benchmark's own runs two early cases read higher as text than that: 1 hop 0.62x to
  0.64x against 0.53x to 0.55x, and seek by name up to 1.12x against up to 1.01x. Run alone, 1 hop reads the same on
  both (0.68x, 0.71x, 0.74x as text; 0.71x, 0.77x, 0.68x as one plan), and both paths bind it to the same plan. An
  assumption, not checked: the difference is how warm the code is. In a full run the case before it has run its
  parameter half without compiling any Cypher on the text path, so the code a new text goes through has run half as
  often as on the plan path.
- **The writes of 1,000 rows are where they were:** their time is the rows written, which is step 4's.
- **Still over the bar as text:** create 1 node (2.00x to 2.16x with the same text, 2.52x to 2.86x with a parameter,
  3.66x to 3.99x with a literal), create 1 relationship (1.29x to 1.39x, 1.51x to 1.75x, 1.98x to 2.48x), set 1
  property where its values differ (1.08x to 1.32x with a parameter, 1.90x to 2.10x with a literal), delete 1 node
  with a literal (1.36x to 1.72x), and every write of 1,000 rows but the merge. At the bar, and over it in some
  turns: delete 1 node with a parameter (1.00x to 1.10x), and with a literal the merge of a node that is there
  (0.92x to 1.14x) and the seek by name (0.95x to 1.12x). Each write's profile is in smaltcy's
  `docs/research/benchmarks.md`, "Writes as one plan": with the same text or a parameter, the Cypher's compile and
  the search for its shape are what the text path leaves out, and the smaltdb statement is what is left.

**SQL's own text path** runs through the same code now. Measured on `main` and on this pull request's source, in
turns:

| Statement (µs a statement; a table of 1,000 rows; each turn the median of 7 rounds of 200,000) | `main` (`7ba41fa`), six turns | This pull request, six turns |
|---|---|---|
| `query`, a point lookup by `?` | 0.846, 0.918, 0.974, 1.116, 0.667, 0.949 | 0.706, 0.719, 0.710, 0.703, 1.079, 0.657 |
| `query`, the same by a named parameter | 1.066, 1.427, 1.156, 0.919, 0.807, 0.940 | 0.771, 1.022, 0.785, 0.805, 0.791, 0.755 |
| `run`, an update by key | 4.779, 5.020, 5.184, 5.696, 4.723, 4.926 | 5.049, 5.099, 4.590, 4.894, 4.320, 4.505 |
| A prepared point lookup | 0.637, 0.686, 0.590, 0.902, 0.663, 0.640 | 0.575, 0.638, 0.565, 0.537, 0.837, 0.559 |

No case is slower. The machine's times moved between the turns more than the two differ (five turns taken earlier
that day, on the step's first commit, read level: a point lookup 0.645 to 0.699 on `main` and 0.623 to 0.685 with
one turn at 1.322), so this says no more than that.

### Step 3: where it differs from section 4

1. **The entry points are the engine's own.** `query`, `run`, `exec`, `prepare`, `queryAsync`, `runAsync` and
   `execAsync` take `{ language }` in process. The worker and the client still take SQL and plans: giving them the
   language's name is a pull request of its own.
2. **A shape is a hash and a comparison, not a key.** Section 4 says a statement "may carry a key for its shape".
   smaltcy measured what a key costs: built as a text for each statement it was most of the time of finding a kept
   statement, 6.5 µs for a seek by name against 1.7 µs for a hash and a comparison of the shape's tokens (its ADR
   0004). So a statement carries `shape: { hash, values, same(other) }`: the engine keeps statements by the hash
   and asks `same` to tell shapes with one hash apart. The values taken out are read as the parameters after the
   statement's own.
3. **A statement may bind by its values** (`variant`). smaltcy compiles a comparison with a parameter for the kind
   of the parameter's value (its ADR 0004: "a value of another kind is another statement"), so one text binds to
   one plan for a text and to another for a number. The statement gives a key for its values, the same for values
   it binds the same for, and the engine keeps what it bound for each key (16 a statement). Without this a
   statement with parameters could not be kept by its text.
4. **A language may bind to plan data** (`SmaltLanguage.plans: 'data'`). SQL's binder gives the engine's own terms.
   smaltcy's compiler builds plans as data, as a caller of `preparePlan` does, so the engine receives what such a
   language binds to as it receives those: validated, then put in its own terms.
5. **What a write gives back may be named without its types** (`returning: [{ name }]`): the plan types it. As many
   columns must be described as the plan gives back (`SMALT_PLAN`); until now another number was taken as given.
6. **A parameter may be a list, a struct or a map** in a statement of a language that binds to plan data, given as
   a JS array, object or `Map` as a plan's is. SQL's parameters stay scalars.
7. **`query` gives `graph`,** what a write of a property graph did, with its rows. It gave the columns and rows
   alone.
8. **What is kept:** each language its own `statementCacheSize` texts; four times that many shapes a database, the
   oldest going first.
9. **A text of a kept shape is kept by its text from the second time it comes** (added 2026-11-24, while smaltcy's
   part of the step was built). A statement that runs what another of its shape bound to costs little to make again:
   it is parsed, and nothing is bound. An application's statements of one shape differ in a value, so such a text
   seldom comes twice; kept the first time, each cost an entry among the texts and put another out. So it is kept
   when it comes a second time, which the engine tells from a number made of the shape's hash and the values (256 of
   them remembered; one taken for another keeps a text a run early or late, no more). That text is parsed twice, and
   not after. The first statement of a shape, and a statement with no shape, are kept by their text at once, as
   before. Measured with Cypher given to smaltdb as text (smaltcy's branch `claude/cypher-language`, `24a9c66`), on
   smaltcy's network of 20,008 nodes in memory, the engine before and after in one process, each with a database of
   its own, taking turns in blocks of 100 statements (60 pairs of blocks a run, four runs; a run's figure is the
   median of its pairs' ratios, after over before):

   | Statement | A new text each time (a literal that differs) | The same text | One text, a parameter that differs |
   |---|---|---|---|
   | Seek by name | 0.92x to 0.97x | 0.96x to 1.02x | 0.98x to 1.04x |
   | 1 hop | 0.95x to 1.00x | 1.00x to 1.02x | 0.97x to 1.05x |
   | Node of a small label | 0.95x to 0.98x | 0.98x to 1.02x | 0.99x to 1.00x |
   | Create 1 node | 0.94x to 0.98x | 0.99x to 1.06x | 1.00x to 1.03x |
   | Create 1 relationship | 0.94x to 1.07x | 0.98x to 1.04x | 0.97x to 1.01x |
   | Set 1 property by name | 0.98x to 1.00x | 1.01x to 1.06x | 0.97x to 1.04x |
   | Merge a node that is there | 0.90x to 0.98x | 0.98x to 1.02x | 0.95x to 1.03x |

   The same engine on both sides reads 0.96x to 1.01x (one run). A new text of a kept shape takes less time in every
   run but those of creating a relationship, which spread to both sides of 1.00x. The other two columns do what they
   did: nothing in them is found differently. The two cases that read highest with the same text were run again
   alone, 300 pairs a run: setting a property 1.00x to 1.01x (three runs; 0.99x and 1.01x with the same engine on
   both sides), creating a node 0.94x to 1.00x.

What section 4 says and is as built: a statement of a registered language is found by its text and kept as SQL's
is; a statement whose values differ is found by its shape, and runs what the first of its shape bound to with its
own values; what the shape of a statement is stays its language's to say.

### Step 4: what was built

In a database in memory, a plan that writes a property graph changes the graph's index and not its tables
(`exec/graph-pending.ts`; `docs/QUERY_ENGINE.md`, section 10): a node's props go into the property maps, its labels
into the label sets, a relationship into the lists of its two ends, with the graph's rules kept against the index and
the errors the tables' writers give. Each change goes into a log with its values. A table with changes in the log is
behind: a statement that reads it from its B+tree has the log written to the tables first, through their writers. A
graph that is only read and written through its index writes no table.

### Step 4: its gate

"In memory: every write of 1,000 rows at or under smaltcy's time, or the numbers why not. With a file: no write slower
than before the step."

**In memory, against smaltcy.** smaltcy `main` (`c3303d8`, its writes as one plan) on smaltdb `main` (`8c8d3e1`) and
on this pull request's source, the two in turns. The same text every run (`bench/writes.ts`; four turns each, the
lowest and highest):

| Write | `main` | This pull request | smaltdb, `main` and this (ms) | smaltcy (ms) |
|---|---|---|---|---|
| Create 1 node | 3.38x to 3.60x | 1.59x to 1.76x | 0.021 and 0.011 | 0.007 |
| Create 1,000 nodes | 10.8x to 12.1x | 1.41x to 1.55x | 8.08 and 1.01 | 0.659 |
| Create 1 relationship | 2.06x to 2.36x | 1.33x to 1.54x | 0.030 and 0.020 | 0.013 |
| Create 1,000 relationships | 8.43x to 8.98x | 0.83x to 0.90x | 11.62 and 1.05 | 1.24 |
| Set 1 property by name | 1.73x to 1.80x | 1.18x to 1.26x | 0.019 and 0.012 | 0.010 |
| Set 1,000 properties | 10.8x to 11.4x | 2.18x to 2.56x | 5.76 and 1.34 | 0.561 |
| Merge existing node | 1.08x to 1.10x | 1.09x to 1.13x | 0.011 and 0.011 | 0.010 |
| Merge 1,000 new nodes | 0.61x to 0.68x | 0.12x to 0.13x | 8.88 and 1.69 | 14.19 |
| Delete 1,000 nodes | 15.2x to 17.0x | 1.54x to 1.70x | 7.51 and 0.729 | 0.453 |

Statements that differ each time (`bench/vary.ts`; four turns each), with a literal in the text and with a parameter:

| Write | A literal: `main` | A literal: this | A parameter: `main` | A parameter: this |
|---|---|---|---|---|
| Create 1 node | 3.30x to 3.88x | 2.07x to 2.49x | 3.03x to 3.64x | 2.01x to 2.13x |
| Create 1,000 nodes | 9.51x to 10.6x | 1.68x to 1.78x | 9.95x to 10.5x | 1.61x to 1.78x |
| Create 1 relationship | 2.14x to 2.37x | 1.37x to 1.97x | 2.06x to 2.43x | 1.32x to 1.66x |
| Create 1,000 relationships | 6.45x to 6.93x | 0.90x to 1.06x | 6.37x to 6.72x | 0.91x to 1.03x |
| Set 1 property by name | 1.74x to 1.93x | 1.31x to 1.35x | 1.63x to 2.01x | 1.24x to 1.55x |
| Set 1,000 properties | 9.15x to 9.65x | 6.87x to 7.15x | 8.67x to 9.64x | 6.49x to 6.75x |
| Merge existing node | 0.94x to 1.05x | 1.00x to 1.21x | 1.01x to 1.05x | 1.01x to 1.22x |
| Merge 1,000 new nodes | 0.55x to 0.61x | 0.13x to 0.14x | 0.59x to 0.64x | 0.13x to 0.14x |
| Delete 1 node | 1.22x to 1.51x | 0.96x to 1.07x | 1.26x to 1.58x | 0.99x to 1.09x |
| Delete 1,000 nodes | 12.1x to 12.7x | 2.78x to 3.03x | 12.1x to 12.7x | 2.78x to 2.92x |

- **At or under the bar:** creating 1,000 relationships (0.83x to 0.90x with the same text; 0.90x to 1.06x and 0.91x
  to 1.03x where the statements differ) and merging 1,000 new nodes (0.12x to 0.13x; 0.13x to 0.14x and 0.13x to
  0.14x).
- **Over the bar, with the numbers why** (each statement profiled on this source, the shares are of the statement's
  time under the profiler):
  - **Create 1,000 nodes:** 1.41x to 1.55x (1.01 ms against 0.659); 1.68x to 1.78x and 1.61x to 1.78x where the
    statements differ. Writing the nodes into the index is 12% of the statement and their labels 3%. The rest is what
    the operation does for each row whatever it writes to: the statement's rows (the `UNWIND`) 21%, the nodes'
    property maps 22% (encoding them 14%), the create's own loop over the rows 13%, and smaltcy's compile of the text
    5%.
  - **Set 1,000 properties:** 2.18x to 2.56x (1.34 ms against 0.561). No table is written: the properties are set, and
    taken away again by the benchmark's cleanup, in the index, and what a commit then finds left of the log is
    nothing. Setting the key in each map's bytes is 22% of the statement, putting the map back into the property maps
    10%, the log 3%, the set's own loop over the rows 13%, and reading the 1,000 nodes 19%. Where each statement sets
    another value (6.87x to 7.15x and 6.49x to 6.75x; `main` 9.15x to 9.65x and 8.67x to 9.64x) nothing takes the
    properties away in between, and the statement's read of its nodes is a scan of the node table: it writes the 1,000
    rows of the statement before it to the table first (199 of 200 statements did, 1,000 rows each). Reading a label's
    nodes from the index whatever the label's size, as step 1 does for a small label, would leave that table
    unwritten.
  - **Delete 1,000 nodes:** 1.54x to 1.70x (0.729 ms against 0.453); 2.78x to 3.03x and 2.78x to 2.92x where the
    statements differ. No table is written: the nodes were made in the index and are deleted there. Deleting them in
    the index is 21% of the statement (the log 5%), reading them 25% (6% is the copies of their property maps, which a
    delete does not read), and the commit that takes them out of the log 12%.
- **The single writes** are step 5's. Each that writes is faster than on `main`, and only the delete of a node is at
  the bar: create 1 node 1.59x to 1.76x with the same text (2.07x to 2.49x and 2.01x to 2.13x where the statements
  differ), create 1 relationship 1.33x to 1.54x (1.37x to 1.97x and 1.32x to 1.66x), set 1 property by name 1.18x to
  1.26x (1.31x to 1.35x and 1.24x to 1.55x), delete 1 node 0.96x to 1.07x and 0.99x to 1.09x.
- **The merge of a node that is there writes nothing, and reads a little higher than on `main` where the statements
  differ:** 1.00x to 1.21x against 0.94x to 1.05x with a literal, 1.01x to 1.22x against 1.01x to 1.05x with a
  parameter (1.09x to 1.13x against 1.08x to 1.10x with the same text). Measured alone on smaltdb, another name in
  each statement, five turns each, it took 1.01x to 1.15x of `main`'s time (0.015 and 0.016 ms): up to a microsecond
  or two more in a turn. A profile of the two shows no one place it goes. Three trims of what the step adds to that
  path (a commit with nothing in the log, an internal plan run while no table is behind, a cursor's search past a
  guard) did not measure faster, and are not in.
- **The reads read as on `main`.** Of the 45 read lines of the three benchmarks (19 with the same text, 13 with a
  literal and 13 with a parameter) the ranges on `main` and on this overlap on all but 1: seek by name with the same
  text (0.82x to 0.84x on `main`, 0.85x to 0.88x on this); smaltdb took 0.013 to 0.015 ms for it on `main` and 0.014
  to 0.016 ms on this. The series' tables are in the pull request.

**With a file** (a database over the memory file store: a pager with a write-ahead log), smaltcy's write cases on
smaltdb alone, as one plan; 6 turns each, a turn's time the lowest of the medians of its rounds:

| Case | `main` (ms) | This pull request (ms) | This over `main` |
|---|---|---|---|
| Create 1 node | 0.123 | 0.129 | 0.93x to 1.07x |
| Create 1,000 nodes | 9.12 | 8.99 | 0.95x to 1.05x |
| Create 1 relationship | 0.187 | 0.186 | 0.93x to 1.04x |
| Create 1,000 relationships | 12.36 | 12.04 | 0.90x to 1.05x |
| Set 1 property by name | 0.054 | 0.054 | 0.90x to 1.06x |
| Set 1,000 properties | 6.07 | 6.16 | 0.92x to 1.09x |
| Merge existing node | 0.012 | 0.012 | 0.62x to 1.05x |
| Merge 1,000 new nodes | 9.59 | 9.32 | 0.95x to 1.05x |
| Delete 1,000 nodes | 7.51 | 7.43 | 0.93x to 1.06x |

Every ratio is between 0.62x and 1.09x, and no case is slower in every turn. With a file a graph is written through
its tables as before, so the step adds only its checks to these writes. One case leaned slower in the step's earlier
turns, the merge of 1,000 new nodes, and was measured further: ten more turns, on the source before the step's last
change, gave 0.95x to 1.06x, 1.02x on average.

**A write, then a read.** A table is written when something reads it, so the write's cost can land on a read.
Statements timed together, on smaltdb alone in memory, as one plan (3 turns each):

| Case | `main` (ms) | This pull request (ms) | This over `main` |
|---|---|---|---|
| Create 1 node, a seek by name, delete the node | 0.057 | 0.056 | 0.87x to 1.06x |
| Create 1,000 nodes, a seek by name, delete them | 16.72 | 2.27 | 0.13x to 0.14x |
| Create 1,000 nodes and delete them | 16.37 | 2.14 | 0.12x to 0.14x |
| Set 1 property by name and take it away | 0.038 | 0.027 | 0.67x to 0.96x |
| Set 1,000 properties and take them away | 13.18 | 4.19 | 0.31x to 0.33x |
| Create 1 node, a scan of the node table, delete the node | 5.08 | 2.20 | 0.43x to 0.44x |
| Create 1,000 nodes, a scan of the node table, delete them | 20.34 | 15.44 | 0.72x to 0.78x |
| Set 1,000 properties, a scan of the node table, take them away | 18.49 | 11.92 | 0.59x to 0.69x |
| Create 1 node, then a scan of the node table (the tables up to date before) | 5.08 | 2.21 | 0.40x to 0.46x |
| Create 1,000 nodes, then a scan of the node table (the tables up to date before) | 13.51 | 9.21 | 0.62x to 0.69x |
| A scan of the node table alone | 4.92 | 2.19 | 0.40x to 0.46x |
| A seek by name alone | 0.011 | 0.010 | 0.55x to 0.98x |

Every case takes less time than on `main` or the same. A seek by name writes no table where the nodes made have no
name. A scan of the node table has the tables written, and the cases with one say two things at once. Making 1,000
nodes and then scanning takes 9.21 ms here where the scan alone takes 2.19: 7.0 ms more, most of it the scan writing
the 1,000 nodes to their tables. On `main` the two take 13.51 ms and the scan alone 4.92: 8.6 ms more, the create
writing them as it runs. And the scan alone is faster here after the cases before it, which make and delete nodes many
times: on `main` every one of those nodes was written to the node table and deleted from it, here only those a read of
the table came after. Run without the cases before it the scan takes 1.5 ms on both (two runs each).

**Single writes whose earlier ones are kept** (200 statements one after the other, then what they made is deleted;
smaltdb alone in memory; a statement's time the median of the 200, 3 turns each):

| Case | `main` (ms) | This pull request (ms) | This over `main` |
|---|---|---|---|
| Create 1 relationship from another person each time | 0.052 | 0.036 | 0.60x to 1.00x |
| Create 1 node with another value each time | 0.021 | 0.012 | 0.55x to 0.60x |
| Set 1 property of another person each time | 0.024 | 0.017 | 0.67x to 0.82x |

### Step 4: where it differs from sections 2 and 3

1. **In a database in memory only.** Section 2 has a commit bring the tables up to date when the database has a file,
   and for a table that keeps history. As built, such a graph is not written into its index first at all: its tables
   are written as each statement runs, as before the step. Every row is written before the commit returns either way;
   what a commit could gain is writing them in one pass, and that is not built.
2. **Which graphs.** Section 2 names the graphs whose index is not held. As built, a graph is written into its index
   first when, besides that, its tables are the plain ones a graph is made with (`Database.makeDirect`): a node table
   of an id and `props`, the label index with its unique index, edge tables of a start, an end and `props` or none,
   and no other node table with rows; no history, no copy of a label's nodes, no foreign key and no check on a table;
   no unique index but the label index's; indexes on columns or on a key of `props` only, none partial; no table that
   is in another graph; and no materialized view in the database. What those have in common: something other than the
   graph's own rules decides whether a row may be written, or is told of it, and the tables' writers are where that is
   done. smaltcy's graphs are of the kind that is written into its index first, with or without its indexes on
   properties.
3. **A table that is behind is found by a guard, and the statement runs again.** Section 2 says the tables are brought
   up to date "before anything reads one of them from its B+tree or from one of its indexes". The planner does not say
   which tables a plan will read. So the B+trees of a table with rows in the log are guarded (`BTree.guard`): a search
   of one throws, the database writes the tables and runs the statement again from its start. A statement stopped so
   is remembered, and has the tables written before it runs from then on. A statement that is neither a query nor a
   plan that writes a graph (SQL that writes, a change of the schema) has them written before it starts. A cursor has
   them written before it opens, since it cannot start again once it gave a row.
4. **All the tables, not "that table".** When one table is needed the whole log is written, every graph's. A node, its
   label entries and its relationships are entries of one log, and writing part of it would need each table's rows
   told apart from the rest's at every read. What writing one table alone would save was not measured.
5. **A search of a property's index for a value needs no table, while the nodes in the log have that property as their
   table has it.** Section 3 keeps a seek on a property's index a B+tree seek, "so the node table is brought up to
   date before it". Built so, the step's first series had one write slower than on `main`: creating a relationship
   from a node found by its name, each statement another (3.07x to 4.29x against smaltcy with a literal, where `main`
   read 2.28x to 2.54x; four turns each). Every such statement wrote the rows of the one before it, with code that had
   not run since the graph was loaded: the benchmark's writes before it write no table any more. Measured alone the
   same statements read level with `main` (12 turns each: 0.060 ms the lowest turn on both, 0.068 ms the median on
   both), and level after 1,500 to 2,000 of them in the benchmark's order. So an index on one key of `props` is read
   as it is by a search for a value of that key, while every node in the log has under the key what its row in the
   table has (`DirectGraph.keyClear`): no new node has the key, no change gave a node another value under it, and no
   node of the table that had it was deleted. The index then has every entry for a value that it would have with the
   tables written, and no other. A row it leads to is given with the props the property maps hold for it, since its
   row in the table may be an older one. A narrower rule was measured first, that no node in the log has the key at
   all: it left the next such write slower than on `main` in its place (setting a property of a node found by its
   name, 2.40x to 2.94x against 1.65x to 2.11x with a literal), since a node found by its name has one. A scan of the
   index, a search of it for a range or for no value, and an index of more than the one key have the tables written as
   any read of a table.
6. **Rows that are gone again are never written, and the log does not grow for ever.** Section 2 has the index know
   "which rows it holds that their tables do not have yet, in the order they were written". As built that is a log of
   changes. A node or a relationship deleted before its table had it leaves nothing to write, and a commit takes such
   rows out of the log once their deletes are a quarter of it. A row set several times is written once, with its last
   properties, and not at all when they are what its table has. When the log has grown to twice what was last left of
   it and 1,024 entries more, a commit makes it what is left of it.
7. **A node or a relationship deleted while its table still has its row is marked gone** in the property maps, until
   the table is written: no reader of the maps is given it, and none reads it from the table for them.
8. **A rollback under an open cursor.** A rollback drops what it wrote from the log and the index, as section 2 has
   it, and the rows of earlier commits still in the log are then written before the index is built again. Nothing can
   be written while a cursor is open. So after a rollback that left such rows, with a cursor open, every statement
   fails with `SMALT_BUSY` until the cursors are closed. It takes rows ahead of the tables from before the
   transaction, a cursor opened inside it and a rollback before the cursor is closed.
9. **An index over its limit, a database closed or copied.** An index that holds rows its tables have not is not let
   go. Where a statement leaves it over its limit, the tables are written at the statement's end and it is held to the
   limit then, as before. A database in memory is not copied anywhere, and closing it ends it, so nothing is written
   for either.
10. **The planner counts the rows that are ahead of a table** with the table's, so a plan is the same wherever a
    table's rows are, and is made again when their number has changed fourfold. It reads its statistics and its counts
    of an index's entries from the tables as they are.
11. **A property is set in the map's bytes** (`setMapKey`). Section 5's estimates say a set "depends on changing a map
    without encoding it whole, which is not measured". One key is put into, or taken out of, the encoded map with the
    other entries' bytes copied as they are.
12. **An option turns it off:** `graphWriteBehind: false` (`DatabaseOptions`) writes a graph's tables as each
    statement runs in a database in memory too. The tests use it to compare the two.

What section 2 says and is as built: the write changes the index first, with the graph's rules kept against the index;
the rows are written behind through their tables' writers, with the rules already kept; a graph that is only read and
written through its index never writes a B+tree; the file format, the log, recovery and snapshots do not change; and
every plan means the same either way. The tests the consequences ask for are `test/graph-write-behind.test.ts`: random
statements run on a database that writes behind and on one that does not, with the rows, the errors and the tables
compared after each (6 seeds of each of its two comparisons in the suite, 150 run by hand), and ADR 0040's test
setting writes the tables after every statement that writes and compares them with the index. smaltcy's tests on
smaltdb (1,389, its writes among them, compared with its own engine after every statement) pass on this source with
that setting and without it.

### After step 4: the writes of 1,000 rows

Added 2026-11-24. Step 4 left writes of 1,000 rows over the bar (its gate, above), and smaltcy's benchmark of statements
that differ had more of them. The work on those goes on after the ADR's steps, each change its own pull request,
measured against smaltcy as above (smaltdb's time over the time of smaltcy's in-memory engine on the same Cypher; the
bar is 1.00x). A range is the lowest and the highest of a series' turns, `main` and the change run in turns.

| Change | Pull request | Against smaltcy, `main` and the change |
|---|---|---|
| The log's entries are made by a constructor | [#306](https://github.com/stenhoor/smaltdb/pull/306) | Deleting 1,000 nodes, statements that differ: 1.93x to 2.43x and 1.51x to 1.59x with a literal, 1.98x to 2.46x and 1.49x to 1.54x with a parameter |
| A label's first nodes are read from the index in the order of their ids | [#307](https://github.com/stenhoor/smaltdb/pull/307) | Setting 1,000 properties, statements that differ: 5.66x to 5.93x and 2.33x to 2.44x with a literal, 5.17x to 5.65x and 2.10x to 2.24x with a parameter |
| Setting a key on many rows: the work on each row | [#308](https://github.com/stenhoor/smaltdb/pull/308) | Setting 1,000 properties alone, on `main` with the row above: 2.03x to 2.31x and 1.03x to 1.10x with the same text, 2.05x to 2.23x and 1.25x to 1.30x with a literal, 1.98x to 2.31x and 1.32x to 1.41x with a parameter |
| A write's values that are only picked take no plan | [#309](https://github.com/stenhoor/smaltdb/pull/309) | The statement alone, a parameter that differs: creating 1,000 nodes 1.57x to 1.60x and 1.34x to 1.40x, deleting 1,000 nodes 1.24x to 1.28x and 1.08x to 1.15x, creating 1 node 1.06x to 1.09x and 0.92x to 1.03x |
| Creating and deleting many nodes: the work on each row | [#310](https://github.com/stenhoor/smaltdb/pull/310) | Creating 1,000 nodes: 0.95x to 1.01x and 0.69x to 0.77x with the same text, 1.06x to 1.17x and 0.79x to 0.90x with a parameter, 1.25x to 1.31x and 0.95x to 0.99x with a literal |
| Rows set again and again keep one entry each in the log | [#311](https://github.com/stenhoor/smaltdb/pull/311) | Setting 1,000 properties, statements that differ: 1.17x to 1.22x and 1.09x to 1.12x with a parameter, 1.51x to 1.57x and 1.31x to 1.38x with a literal |
| An ORDER BY without a LIMIT is read in order where that costs less | [#312](https://github.com/stenhoor/smaltdb/pull/312) | Deleting 1,000 nodes alone, a parameter that differs: 1.14x to 1.18x and 1.02x to 1.08x. With the same text: seek by name 0.26x to 0.28x and 0.23x to 0.24x, a small label's nodes 0.49x to 0.51x and 0.41x to 0.42x |
| A graph's next ids are read from its tables' ends only when a page was changed | The pull request that adds this row | Creating 1 node, statements that differ: 1.11x to 1.18x and 0.88x to 0.96x with a parameter, 1.28x to 1.45x and 1.12x to 1.19x with a literal |

1. **The log's entries are made by a constructor** (`exec/graph-pending.ts`, `Entry`). An entry of the log of rows the
   index holds ahead of the tables was an object written out where it is logged. In smaltcy's benchmark of statements
   that differ, deleting 1,000 nodes read 2.3x to 2.6x, and 1.2x to 1.4x when the benchmark ran that case alone: the
   same statements doing the same work (440,000 lookups of the entry that made a node, 9.0 steps each in a list 1,000
   long, counted both ways). A profile of the 440 timed deletes had 573 ms with the case alone and 940 ms at the end of
   the whole benchmark, the lookups (`makerOf`) 3.6 and 173.7 ms of it and the sweep at each commit 37.9 and 199.2 ms.
   Asked of V8 (`%HaveSameMap`), the list's entries had one hidden class with the case alone and two in the whole
   benchmark, by which time the log had held entries of every kind. Made by a constructor that sets every field in one
   order, they have one there too. Which write first gave the entries a second hidden class was not found. Measured with
   `main` at `cb653b1` and smaltcy's branch `claude/statement-templates` (`79bd1e5`), four turns each way: smaltdb's own
   time for the deletes 1.38 to 1.74 ms and 0.94 to 1.19 ms with a literal, 1.27 to 2.29 ms and 0.90 to 1.00 ms with a
   parameter. With the same text every run, and in the reads, no line moved.
2. **A label's first nodes are read from the index in the order of their ids** (`exec/planner.ts`, `orderedJoin`).
   `MATCH (p:Person) WITH p LIMIT 1000 SET p.bench = …` reads the label's first 1,000 nodes by id. Its plan joins the
   node table with the label index and sorts by the node's id, with a LIMIT, and the planner read the node table in the
   order of its rowids, checking each row's label in the index: a scan of a B+tree. So the statement stopped at the
   guard of a table that was behind (above, "where it differs", 3), the tables were written, and it ran again; from then
   on it had them written before it started. Back to back, each such statement wrote the 1,000 rows of the one before it
   first: the tables were written 220 times in 220 statements, 220,000 rows. The benchmark's case with the same text
   every run does not show it: the cleanup between its runs takes the key away again, which leaves no row ahead of the
   tables (they were written twice in 220 statements). Now the planner also reads an ORDER BY with a LIMIT through a
   column the plan's conditions make equal to the ordering column (docs/QUERY_ENGINE.md, "`ORDER BY` read in order"):
   here the label's entries in the index, which come in the order of their nodes, and each node then by
   its rowid from the index's property maps. No table is read, and the tables are not written in the 220 statements,
   either way. Measured with `main` at `39c32e2` and smaltcy's branch `claude/cypher-language` (`44ad602`,
   stenhoor/smaltcy#40), four turns each way for the statements that differ and for the writes with the same text, three
   for the reads:

   | Setting 1,000 properties | `main` | The change | smaltdb's own time (ms), `main` and the change |
   |---|---|---|---|
   | A literal that differs | 5.66x to 5.93x | 2.33x to 2.44x | 6.05 to 6.63, 2.16 to 2.76 |
   | A parameter that differs | 5.17x to 5.65x | 2.10x to 2.24x | 5.52 to 6.66, 1.94 to 2.08 |
   | The same text every run | 1.77x to 2.03x | 1.74x to 2.41x | 1.55, 1.51 (medians) |

   Of the plans of the benchmark's 20 queries, and of what its 10 writes read, two changed: this one and creating 1,000
   relationships from a label's first 1,000 nodes, which reads the same way (0.83x to 0.92x and 0.80x to 0.82x with a
   literal, 0.72x to 0.81x and 0.72x to 0.84x with a parameter, 0.65x to 0.73x and 0.61x to 0.79x with the same text).
   Five other lines of the series' 74 had ranges apart: deleting 1,000 nodes with a literal, a small label with a filter
   and the triangles with the same text (three turns), all three lower; 3 hops with a direction and a literal, and a
   shortest path with a direction and a parameter, both higher. Their plans are the same, and each had ranges that
   overlap when it was run again, four turns each way (the first and the last two alone, the two reads in their
   benchmark). What is left of this statement, 2.1x to 2.4x, is the work of setting the key on each row: the map's bytes
   are copied three times, and the buffer of the maps is rewritten when half of it is dead.
3. **Setting a key on many rows: the work on each row** (`exec/nested-ops.ts`, `setMapKey`; `exec/graph-write.ts`,
   `GraphWrite.set`; `exec/graph-props.ts`, `GraphProps.room`). Three changes to what `SET n.key = value` does for each
   row when it sets many rows at once. A key is set in a map's bytes without a view of the map: the map is copied
   whole, the entries after the key's are moved inside the copy, and the value is written byte by byte. It made a new
   array and copied into it four times, twice through a view of a part of the map, and a view costs more to make than a
   small map does to copy. The SET's all-rows path makes nothing for a row: it made an object with a function to read
   the row's values, an object for the row's target and a text key for the check that no row is written twice. The
   values were all computed ahead and are read where they lie, and the check compares a node's id with the last one
   while the ids rise. And the buffer of the property maps, written again when half of it is dead, is copied in runs
   of rows whose bytes lie one after another, where each row was a copy of its own. Measured with `main` at `39c32e2`,
   which was without change 2, and smaltcy's branch `claude/cypher-language` (`44ad602`), four turns each way for the
   statements that differ and for the writes with the same text, three for the reads:

   | Setting 1,000 properties | `main` | The change | smaltdb's own time (ms), `main` and the change |
   |---|---|---|---|
   | The same text every run | 1.86x to 2.12x | 0.92x to 1.16x | 1.58 to 1.63, 0.83 to 0.88 |
   | A literal that differs | 5.52x to 6.04x | 4.72x to 4.82x | 4.89 to 6.49, 4.00 to 4.84 |
   | A parameter that differs | 4.94x to 5.49x | 4.35x to 4.57x | 4.69 to 5.93, 3.66 to 3.92 |

   Of the other 71 lines none had ranges apart and higher. The statements that differ wait for change 2 there, so the
   case was also run alone on `main` with change 2, and on that with this change, four turns each way: the row of the
   table above. The third of the three does not show in the benchmark, which takes the median statement: the buffer is
   written again in about one statement of twenty. Timed by itself (the maps alone, 20,008 rows of 46 bytes, the first
   1,000 set over and over, ten runs each way), a round of 1,000 sets in which the buffer is written again took 1.38 to
   1.67 ms and 0.53 to 0.67 ms. What was left with statements that differ, 1.25x to 1.41x, was the log of rows ahead
   of the tables: every statement's 1,000 sets doubled it, and it was made its net effect after every second one.
4. **A write's values that are only picked take no plan** (`exec/graph-write.ts`, `picking`; `Evaluator`). A stage of
   a plan that writes ran an internal plan over its rows (section 1) even where it computed nothing. Two kinds of stage
   did. One is a projection above a write whose columns are all columns of its row, parameters or NULL: what a language
   puts above a write to shape its rows, and the projection of no columns above a statement that returns none. The
   other is a write's own values where every one is a column or a parameter: the node a delete names, the ends of a
   relationship, the node a label is set on. They take the values where they lie; a plan read a row's column and a
   parameter as they are given, so nothing was converted on the way. Counted on the engine's runner of internal plans,
   a statement of smaltcy's each: `UNWIND range($from, $to) AS i CREATE (:Bench {i: i})` ran 4 and runs 2, `CREATE
   (:Bench {i: $i})` 4 and 2, `MATCH (n:Bench {batch: $batch}) DETACH DELETE n` 3 and 1, and `MATCH (p:Person) WITH p
   LIMIT 100 SET p.bench = $i` 3 and 2 (a SET keeps the plan for its value, which is wrapped so that it is not computed
   for a NULL node). Measured with `main` at `3e3c8b8` and smaltcy's `main` (`f20703c`), four turns each way for the
   statements that differ and for the writes with the same text, three for the reads. Four writes of the series' 74
   lines had ranges apart, all four lower: deleting 1,000 nodes with the same text (1.38x to 1.52x and 1.23x to 1.34x),
   creating 1,000 nodes with a literal (1.55x to 1.67x and 1.42x to 1.47x), setting 1,000 properties with a parameter
   (1.26x to 1.39x and 1.16x to 1.21x) and setting 1 property by name with the same text (0.40x to 0.44x and 0.36x to
   0.38x). Four reads had ranges apart too, two lower and two higher: a read runs none of the changed code, and the two
   higher overlapped when the reads were run again, four turns each way. The series' turns are wide beside this change,
   so the statements were also run alone, with a parameter that differs, three turns each way:

   | A parameter that differs, the statement alone | `main` | The change | smaltdb's own time (ms), `main` and the change |
   |---|---|---|---|
   | Create 1,000 nodes | 1.57x to 1.60x | 1.34x to 1.40x | 2.26 to 2.43, 1.63 to 1.84 |
   | Delete 1,000 nodes | 1.24x to 1.28x | 1.08x to 1.15x | 1.18 to 1.33, 1.07 to 1.12 |
   | Create 1 node | 1.06x to 1.09x | 0.92x to 1.03x | 0.019 to 0.022, 0.017 to 0.025 |
   | Set 1,000 properties | 1.19x to 1.31x | 1.16x | 0.95 to 1.14, 0.89 to 1.12 |
5. **Creating and deleting many nodes: the work on each row** (`exec/graph-write.ts`, the all-rows paths of
   `graphCreate` and `graphDelete`; `exec/nested-ops.ts`, `map_of`). Three changes. `graphCreate` made an object for
   each row to read the row's values one by one, and decoded each node's property map to count its entries. A node's
   props, computed ahead, are now read where they lie, and their entries are counted on the bytes (`entriesSet`). The
   map is still decoded where a value is NULL, which is no property, and the object is made only where a relationship
   reads its ends and props, or a node's props were not computed ahead. `graphDelete`, where every target is a node
   whose id was computed ahead, reads the ids where they lie: it made an object and called three closures for each row.
   And `map_of` of one pair encodes its key and value as they come: one pair is in key order and has no key twice, so
   no list of entries and no map is made to sort them. The `{i: i}` of `CREATE (:Bench {i: i})` is such a map. Measured
   with `main` at `e6ecabf` and smaltcy's `main` (`bfb8d43`, which reads the numbers of `UNWIND range()` as rows of
   smaltdb's `range`), four turns each way for the statements that differ and for the writes with the same text, three
   for the reads:

   | Creating 1,000 nodes | `main` | The change | smaltdb's own time (ms), `main` and the change |
   |---|---|---|---|
   | The same text every run | 0.95x to 1.01x | 0.69x to 0.77x | 1.19 to 1.28, 0.84 to 0.93 |
   | A parameter that differs | 1.06x to 1.17x | 0.79x to 0.90x | 1.31 to 1.52, 0.99 to 1.07 |
   | A literal that differs | 1.25x to 1.31x | 0.95x to 0.99x | 1.46 to 1.54, 1.04 to 1.12 |

   The statement is under the bar in all three. Eleven of the series' 74 lines had ranges apart and lower: these three;
   merging 1,000 new nodes in its three (0.13x to 0.14x and 0.10x to 0.11x with the same text); creating 1,000
   relationships with statements that differ (0.76x to 0.79x and 0.61x to 0.67x with a literal, 0.70x to 0.77x and
   0.52x to 0.57x with a parameter); creating 1 node with the same text (0.83x, and 0.72x to 0.80x); and two reads with
   the same text (seek by name and 2 hops, three turns), which run none of the changed code. One line was apart and
   higher, a read: 2 hops with a relationship filter and a literal (0.62x to 0.68x and 0.69x to 0.74x). Run again
   alone, four turns each way, it overlapped (0.68x to 0.75x and 0.66x to 0.72x). Deleting 1,000 nodes had ranges that
   overlap in the series in all three modes (1.21x to 1.28x and 1.04x to 1.27x with the same text, 1.21x to 1.39x and
   1.19x to 1.31x with a parameter, 1.37x to 1.54x and 1.23x to 1.37x with a literal). The statements alone, with a
   parameter that differs, three turns each way:

   | A parameter that differs, the statement alone | `main` | The change | smaltdb's own time (ms), `main` and the change |
   |---|---|---|---|
   | Create 1,000 nodes | 1.16x to 1.32x | 0.81x to 0.88x | 1.49 to 1.59, 1.07 to 1.10 |
   | Delete 1,000 nodes | 1.08x to 1.15x | 1.03x to 1.05x | 1.08 to 1.14, 0.98 to 1.02 |
   | Create 1 node | 0.92x to 0.95x | 0.91x to 0.96x | 0.019 to 0.030, 0.017 to 0.018 |

   Still over the bar among the writes of 1,000 rows in this series: deleting 1,000 nodes, and setting 1,000 properties
   with statements that differ (1.09x to 1.27x with a parameter, 1.49x to 1.66x with a literal).
6. **Rows set again and again keep one entry each in the log** (`exec/graph-pending.ts`, `fold`). The log of rows the
   index holds ahead of the tables grew by one entry for every row a committed transaction set, and was made its net
   effect each time it had doubled. At a commit, a set of a row that a committed entry already sets now gives that
   entry its props and leaves the log: what is left of the two is what was left before. The entries are held by rowid,
   in a list for each table of each graph, and the lists are dropped whenever committed entries leave the log or are
   made anew (the tables written, the log swept or made its net effect, a rollback). A log no longer than its slack
   (1,024 entries) is not read: reading a commit's entries when none of their rows was set before took 3% of a
   statement that sets 1,000 rows for the first time (smaltdb's own time 0.77 to 0.82 ms without it and 0.80 to 0.84 ms
   with it, eight turns each way), so nothing is held until a set comes to a log longer than the slack, which is where
   the log was made its net effect before. Rows set back to what their tables have leave entries that say nothing:
   once they are half of the log it is made its net effect, as the doubling did before. Measured with `main` at
   `e6ecabf` and smaltcy's `main` (`bfb8d43`), four turns each way for the statements that differ and for the writes
   with the same text, three for the reads:

   | Setting 1,000 properties | `main` | The change | smaltdb's own time (ms), `main` and the change |
   |---|---|---|---|
   | A parameter that differs | 1.17x to 1.22x | 1.09x to 1.12x | 0.93 to 1.04, 0.88 to 1.05 |
   | A literal that differs | 1.51x to 1.57x | 1.31x to 1.38x | 1.21 to 1.27, 1.09 to 1.14 |
   | The same text every run | 0.84x to 1.07x | 0.82x to 1.03x | 0.65 to 0.69, 0.67 to 0.69 |

   Of the series' 74 lines two had ranges apart, both lower: the first two of the table. With the same text the
   benchmark takes the key away again after each run, so every timed statement sets rows that no entry holds, and
   there is nothing to fold.
7. **An ORDER BY without a LIMIT is read in order where that costs less** (`exec/planner.ts`, `orderWantedOf`;
   docs/QUERY_ENGINE.md, "`ORDER BY` read in order"). A language for graphs sorts what a write reads by
   the nodes' ids, with no LIMIT, so that its rows come in one order, and a label's entries in the graph's index come
   in that order already. The planner costed reading a join in the order of its ORDER BY only where the ORDER BY had a
   literal LIMIT (change 2). It costs it without one too: every row is read then, and the sort alone is saved. Of the
   plans of 35 statements of smaltcy's benchmarks (its 19 reads, and what 16 writes and cleanups read) 11 lose their
   sort, and nothing else changes in any. Measured with `main` at `e6ecabf` and smaltcy's `main` (`bfb8d43`), four
   turns each way for the statements that differ and for the writes with the same text, three for the reads. Three of
   the series' 74 lines had ranges apart and lower: seek by name with the same text (0.26x to 0.28x and 0.23x to
   0.24x), a small label's nodes with the same text (0.49x to 0.51x and 0.41x to 0.42x) and deleting 1,000 nodes with
   a literal (1.34x to 1.49x and 1.26x to 1.33x). Two were apart and higher: 1 hop with the same text, whose plan is
   the same, and creating 1 relationship with a parameter, whose plan lost its sort and nothing else. Both overlapped
   when they were run again (the reads four turns each way, creating 1 relationship alone six). Deleting 1,000 nodes
   alone, a parameter that differs, three turns each way: 1.14x to 1.18x and 1.02x to 1.08x, smaltdb's own time 0.85
   to 0.91 ms and 0.78 to 0.88 ms.
8. **A graph's next ids are read from its tables' ends only when a page was changed** (`database.ts`, `graphIdsOf`). A
   plan that makes a node or a relationship asks the graph for its next ids, and each time it ran they were brought up
   to the graph's tables: a B+tree cursor to the end of every node table for a node's id, of every type's table for a
   relationship's rowid. A graph of smaltcy's has a node table and one more for each label, and its `CREATE (:Bench
   {i: $i})` read the ends of four tables for its one id. The count of page changes (`Pager.writes`) at which the ends
   were read is now kept with the ids, for nodes and for relationships. A row comes to a table, and a table to a
   graph, by a change of a page, so while the count stands the ids kept are the ones the tables would give. A graph
   whose writes land in its index changes no page for a new node or relationship (section 2): its statements read no
   table for their ids until its tables are written. Where a graph's writes go to its tables each statement changes
   pages, and the ends are read as before. Counted by V8's block coverage on a network of 2,000 people, the source
   that statement runs each time went from 74,827 characters to 40,278, in 270 calls and 207. Measured with `main` at
   `7769119` and smaltcy's `main` (`54dedc2`), four turns each way for the statements that differ and for the writes
   with the same text, three for the reads:

   | Creating 1 node | `main` | The change | smaltdb's own time (ms), `main` and the change |
   |---|---|---|---|
   | A parameter that differs | 1.11x to 1.18x | 0.88x to 0.96x | 0.014 to 0.016, 0.010 to 0.012 |
   | A literal that differs | 1.28x to 1.45x | 1.12x to 1.19x | 0.018 to 0.021, 0.013 to 0.015 |
   | The same text every run | 0.71x to 0.79x | 0.65x to 0.73x | 0.005, 0.005 (medians) |

   Of the series' 74 lines three had ranges apart: the first two of the table, lower, and a read higher (1 hop with a
   parameter, 0.20x to 0.25x and 0.26x to 0.28x), which runs none of the changed code. The benchmark of statements
   that differ was run again, four turns each way: 1 hop overlapped (0.19x to 0.23x and 0.19x to 0.25x), and creating
   1 node was apart again (1.09x to 1.24x and 0.91x to 1.01x with a parameter, 1.26x to 1.44x and 1.13x to 1.17x with
   a literal). Creating 1 relationship, which asks for a node's id and a relationship's rowid, had ranges that overlap
   (0.85x to 1.09x and 0.81x to 0.88x with a literal, 0.70x to 0.83x and 0.68x to 0.74x with a parameter). Creating 1
   node is the first write the benchmark runs, and with a literal it is still over the bar.
