# ADR 0042: A graph's writes: run by smaltdb, in memory first, the tables written behind

- **Status:** proposed, for the owner to accept, change or refuse. Nothing of it is built. The numbers in the Context
  come from a spike that was measured and thrown away (2026-11-21); what is an estimate is marked as one.
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
