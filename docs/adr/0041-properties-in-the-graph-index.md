# ADR 0041: Properties in the graph index, and what else the reads over the bar need

- **Status:** merged 2026-11-20 ([#284](https://github.com/stenhoor/smaltdb/pull/284)) without answers to its two
  questions, so the steps follow what it proposes. Built: sections 1 and 2, and the first two of section 3; see
  [As built](#as-built) for the pull requests, what they measured and where they differ from the text. The numbers
  marked "by hand" come from a spike that was measured and thrown away.
- **Date:** 2026-11-20
- **Builds on:** [ADR 0040](0040-graph-index-and-relationships.md), whose step 5 is "Properties kept in memory, by
  column (its own record first)": this is that record, and it differs from that line on one point (section 2).
  [ADR 0038](0038-map-type.md) (maps, and one key read without decoding the rest) and
  [ADR 0033](0033-property-graphs-and-history.md) (a graph's tables and their `props` column).
- **For:** [stenhoor/smaltdb#274](https://github.com/stenhoor/smaltdb/issues/274): smaltdb at least as fast as
  smaltcy's in-memory engine on every query and write of its benchmarks.

## Context

### Where the reads stand

smaltdb `57f0e94` (steps 2a, 2b and 2c of ADR 0040, the labels in the graph index, #278), smaltcy with that pin
(stenhoor/smaltcy#29), 20,008 nodes and 60,025 relationships, the method of smaltcy's `docs/research/benchmarks.md`.
A ratio is smaltdb's time over smaltcy's; the bar is 1.00 or less. The reads still over it:

| Query | The same text every run | Statements that differ: a literal, a parameter |
|---|---|---|
| 2 hops, filtered on a relationship's property | 2.64x | 1.40x, 1.45x |
| Group by city | 1.72x | |
| Label scan and filter | 1.01x | 2.63x, 1.64x |
| Seek by name | 1.05x | 1.20x, 1.11x |
| Shortest path with a direction | 1.16x (no path) | 1.05x, 0.97x |

Every other read is under it (0.12x to 0.84x). The last two rows are statements of under 0.1 ms whose time is finding
the kept statement, a question already with the owner in #274; this record is about the first three. Writes are step 4.

### The spike: where the three spend their time

Each query's prepared statement under a CPU profile, then run again with one cost taken out by hand.

| Query | Its time | Reading a property from a row fetched by id | The comparison or check on a property | The plan's own shape |
|---|---|---|---|---|
| Label scan and filter, 19 people in 20 passing | 10.8 ms | none: it scans the table | 6.0 ms: the conjunct run for every row that passes | 1.1 ms decoding the property map (after section 1, only for an output nothing reads); 1.6 ms the label check, the projection and the count |
| 2 hops, relationship filter | 1.80 ms | 0.81 ms: 1,610 relationship rows, 505 ns each | 0.68 ms | 0.31 ms |
| Group by city | 33.5 ms | 7.1 to 7.5 ms: 20,000 person rows, 354 ns each | 2 to 4 ms: `avg`'s check that its argument is a number | 10.5 to 11.7 ms keeping the groups in the order of their first row; about 5 ms in three projections one above the other |

So "properties kept in memory" is one of three causes, and for the label scan it is not a cause at all:

1. **A property compared with a number is a CASE of three reads.** Cypher's `p.age > 20.5` is NULL unless `p.age` is a
   number, and `cmp_gt` ranks values of every kind, so smaltcy tests the kind and then compares. A generated scan
   already rules rows out on the stored bytes, but every row that passes still runs the CASE.
2. **A row is fetched for one property.** A relationship's row for `r.since`, a person's row for `p.age`: a descent
   of the table's B+tree and a copy of the map for each.
3. **The plan's shape.** Groups in the order of their first row are computed by numbering the rows (a window),
   making a list of the sort keys for each row, taking a `min` over those lists and sorting the groups. Projections
   one above the other each copy the row.

### What a read of one property costs

By hand, on the benchmark's network: `age` read for each of 20,008 nodes by id, in id order and in a shuffled order.

| How | In id order | Shuffled |
|---|---|---|
| Today: the row found in the table's B+tree by its id, then `map_get` | 388 ns | 746 ns |
| The node's map kept in memory as stored: a view of its bytes, the key found and decoded | 46 ns | 48 ns |
| The same, the key found in place (no view) | 22 ns | 26 ns |
| The same, the key compared on the bytes (a filter) | 29 ns | 34 ns |
| The property kept in memory by column | 6 ns | 6 ns |

Memory, by hand: the nodes' maps as stored 0.89 MB, by column about 1.19 MB (three keys); the relationships' maps
0.67 MB, by column about 0.54 MB (one key).

### What the two fixes are worth, by hand

- **The comparison as one operation** (section 1, built): the label scan with a literal and a parameter 2.63x and
  1.64x to 1.04x and 0.72x; with the same text 1.01x to 0.57x. The relationship filter 2.64x to 1.78x, and with a
  literal and a parameter to 0.99x and 0.97x.
- **A relationship's properties read from memory** (a cache put into the scan for the measurement, on top of the
  first): the relationship filter 1.12 ms to 0.29 ms against smaltcy's 0.62: 1.66x to 0.44x.
- **A node's row read from memory** (the same kind of cache in the rowid lookup): group by city 33.5 ms to 26.0.
  Then without the order of the groups 15.9, and with a plain `avg` 13.6, against smaltcy's 13.3 to 14.0 in those
  runs. Of the 13.6 that are left, about a third is the three projections.

## Decision

### 1. A comparison within one kind is one operation (built, #283)

`cmp_lt_kind`, `cmp_le_kind`, `cmp_gt_kind`, `cmp_ge_kind`: two numbers, neither NaN, or two texts by their bytes;
NULL for anything else. Where a conjunct is one of them on `map_get(m, 'k')` against a number or text, a generated
scan decides it on the map's stored bytes: the conjunct is not run for the rows the check saw, and the map is not
decoded for it. smaltcy emits it for an ordering comparison of a property with a number or a string. Measured in its
pull request: 20,000 rows counted, 6.85 ms as the CASE and 0.64 ms as the operation.

### 2. The graph index holds properties as they are stored, by row

For each node table and each edge table of an indexed graph that names a `props` column (ADR 0033: a
`map<text, …>`), the graph's index also holds each row's map as the table stores it: the map's bytes, a table's maps
in one buffer, with where each row's begins and ends, by rowid.

- **Built** for a table on the first read of its properties through the index, by one scan of the table. A graph
  whose plans read no property by id builds nothing.
- **Kept** by the table's writer, as the lists and the labels are: an insert or an update appends the row's map and
  points the row at it, a delete clears the row. The bytes a row no longer points at are counted, and a buffer that
  is more than half such bytes is written again without them.
- **Dropped** with the lists, by their rules: a rollback that may have undone a change, another connection's commit,
  a change to the graph's tables.
- **Under the lists' limit** (`graphIndexMem`). Over it the properties are let go first and the lists and labels
  stay, so hops keep their speed and properties are read from the tables.
- **Checked** by the test setting ADR 0040 added: after every write the maps held are compared with the tables, and
  every read that used them is run again without the index and must give the same rows.

What reads it:

- **`relationships`' `props` column.** Today the relationship's row is fetched by rowid when a plan reads its
  properties. With the maps held, the column is the map's bytes from memory (a copy of them: see
  [As built](#as-built)).
- **A node found by its id.** A plan that seeks a node table by rowid and reads only its id and its `props` gets one
  more access path beside the rowid lookup, as the label check did in #282: `SEARCH <table> USING GRAPH INDEX
  (rowid=?)`. The node is there if the index has its row, and its `props` is the bytes from memory. A plan that reads
  another column, a table without a `props` column and a graph that isn't indexed run the rowid lookup, as today.
- **Not scans.** A scan of a node or edge table reads its pages, where a generated scan checks a key of a map on the
  stored bytes at 32 ns a row (section 1's 0.64 ms for 20,000 rows).

What a plan reads is the stored map, so `map_get`, `map_contains_key`, the comparisons of section 1 and every other
map operation work on it as they do on a row's. There is no new plan operation and no change to plans: the planner
picks the path, and smaltcy changes nothing.

**By row, not by column.** ADR 0040's table said "by column". By column a read is 6 ns where by row it is 22 to 48,
and today it is 388 to 746. On group by city's 20,000 reads that difference is under a millisecond of a query that
takes 13 with everything else here done. By column needs a column for each key found in the data, a kind for each
value (properties are `any`), the planner turning `map_get(props, 'k')` into a column read, and upkeep by key on
every write. By row needs none of those: it is a copy of bytes. By column stays possible later on the same hooks, if
a measurement asks for it.

### 3. What else the spike found

Each is the engine's own, for any plan, and each is its own pull request, measured before it is kept:

- **Groups in the order of their first row, kept by the aggregate.** The hash aggregate keeps each group's least
  sort keys as it reads its rows (numbers compared as numbers) and gives its groups in that order, where today the
  plan numbers the rows, makes a list for each and takes a `min` over the lists. What a plan asks for and what it
  gets do not change. Up to 10.5 to 11.7 ms of group by city.
- **A projection of columns and constants merged into the one above it,** so that three projections one above the
  other are one, and #278 then leaves out what nothing reads. About 5 ms of group by city.
- **The columns of an output nothing reads are not decoded** (the limitation #278 names). 1.1 ms of the label scan.
- **`IN` over text literals as a lookup in a set,** which is what `avg`'s and `sum`'s check of a property's kind
  is. Part of the 2 to 4 ms of group by city.

### 4. Steps and gates

Each is its own pull request from `main`, one at a time, measured with smaltcy's three benchmarks.

| Step | What | Gate |
|---|---|---|
| 5a | Section 1 (#283), and smaltcy emitting it | The label scan and the relationship filter faster in the three ways they are measured; no read slower. Measured above |
| 5b | Section 2: the graph index holds properties | The relationship filter at or under smaltcy with the same text, a literal and a parameter; group by city faster; no write slower with the index kept than with indexes off; the build's time and the memory reported |
| 5c | Groups' first-row order kept by the aggregate | Group by city faster; a grouped aggregate that asks for no order no slower |
| 5d | The other two of section 3 | Each faster on the plans it changes and no slower on the others |

Step 5's own gate is ADR 0040's: every read at or under smaltcy. If group by city is still over after 5b to 5d, the
pull request that finds it says what is left, measured.

## Consequences

- Reads of a relationship's or a node's properties by id come from memory on the writing engine; storage, the file
  format and durability don't change.
- Memory: one more copy of the property map of every row of an indexed graph that is read by id, under the lists'
  limit and let go before them. (As proposed: of every row of a table whose properties are read by id, 1.6 MB for
  the benchmark's graph. See [As built](#as-built).)
- A write to a node or edge table with a `props` column copies the row's map again where the index knows the row
  and its props change. (As proposed: every write copies it.)
- A row's first read by id costs more than it did, once; no table is scanned. (As proposed: the first statement
  that reads a table's properties by id scans that table once.)
- Reader workers and `asOf` reads run as today, as with the lists (ADR 0040).
- Nothing changes for smaltql, smaltdf, smaltts or the plugins. smaltcy changes a few lines for 5a. For 5b it
  changes two tests that asserted a seek of a property's index on a label of 17 nodes, which the planner now reads
  from the graph index. (As proposed: nothing for 5b to 5d.)

## Questions for the owner

1. **By row, not by column** (section 2): a change from ADR 0040's wording, on the measurements above. Agreed?
2. **The memory:** a second copy of the graph's property maps, under the same limit as the lists (256 MB by
   default), given up first. Acceptable, or its own limit?

Neither was answered before this record was merged. Step 5b is built as proposed on both: by row, and under the
lists' limit, given up first.

## As built

Added 2026-11-21, with step 5b. Each number says what it compares:

- **Against smaltcy:** smaltdb's time over the time of smaltcy's in-memory engine, on the same Cypher and the same
  network (20,008 nodes, 60,025 relationships), the engines taking turns, from smaltcy's benchmarks. This is the bar:
  1.00x or less.
- **Against `main`:** smaltdb with the change over smaltdb `main` without it, on the statements smaltcy keeps for its
  17 benchmark queries, prepared on both, the two taking turns. It says what one change did, and nothing about
  smaltcy.

| Step | Pull requests | Measured |
|---|---|---|
| 5a | [#283](https://github.com/stenhoor/smaltdb/pull/283), stenhoor/smaltcy#30 | Against smaltcy: label scan and filter 1.01x to 0.57x, with a literal and a parameter 2.63x and 1.64x to 0.95x and 0.67x. Relationship filter 2.64x to 1.87x, with a literal and a parameter 1.40x and 1.45x to 1.05x and 1.09x |
| Section 3, projections | [#285](https://github.com/stenhoor/smaltdb/pull/285) | Against `main`: group by city 0.87x and 0.88x |
| 5c | [#286](https://github.com/stenhoor/smaltdb/pull/286) | Against `main`: group by city 0.74x and 0.75x |
| 5b | [#287](https://github.com/stenhoor/smaltdb/pull/287) | Below |
| 5d, the columns of an output nothing reads | The pull request that adds this row | Below |

### Step 5b: where it differs from section 2

A first build did what section 2 says: a table's maps read in by one scan on the first read through the index, and
every write to such a table copied into them. It was measured and changed in three ways. The reads it speeds up read
the same either way (against `main`: relationship filter 0.32x, group by city 0.69x to 0.71x, triangles 0.60x to
0.63x on the first build; 0.34x, 0.70x and 0.62x to 0.64x on the one kept).

1. **A row's map is remembered when the row is first read by its rowid. No table is read in.** Reading in the
   node table's maps took 25.8 ms for 20,008 rows (the median of five; 19.2 to 50.7), and an edge table's 12.2 ms for
   40,025. One lookup of one node paid for the whole table, and so did the first read after every rollback that
   undid a property. As built, a row the index doesn't know is found by the table's rowid lookup, as before, and
   known from then on; the index holds the rows that were asked for.
2. **A write follows only a row the index knows, and only where its props change.** A new row is not read in, and a
   deleted row is forgotten. Copying every written row's map cost 3% on creating 1,000 nodes and 1.5% on merging
   1,000 new ones (means of eight runs, the first build with its maps against the same build without them).
3. **A rollback makes the index forget the rows it remembers, where the transaction wrote a table of theirs or
   remembered a row.** The maps keep their memory, and their rows are read again as they are asked for. Any other
   rollback leaves them.

Two more points the text left open:

- **A reader gets a copy of the row's map, not a view.** A view measured 8% to 11% faster on the relationship filter
  and on triangles and 1% to 2% on group by city (against the first build with copies). It is not taken: a view is
  a window on the index's own buffer, and a value that reached a caller through one (a result's bytes, or a part of
  a map that an operation gives without copying) would let the caller change what the index holds. A row decoded
  from a page is a copy for the same reason.
- **Which plans read a row by its rowid from the index** is decided when the plan is made, from the columns its scan
  names: its `props`, and nothing else but its id. So the planner never costs as a read from memory a lookup that
  must fetch the row. smaltql's scans name every column of a table, so SQL reads this way only a table whose columns
  are its id and its `props`. The path is costed as a read from memory, so on a label of a few nodes the planner now
  reads the label's nodes by id where it sought a property's index (with 17 nodes of the label; not with 117).

### Step 5b: measured against its gate

- **The relationship filter, against smaltcy:** 0.60x to 0.66x with the same text (three runs); with a literal and a
  parameter 0.84x and 0.76x, then 0.76x and 0.72x (two runs). It was 1.87x, and 1.05x and 1.09x.
- **Group by city, against smaltcy:** 0.87x, 0.87x and 0.93x (three runs). It was 1.85x. Against `main`: 24.1 to
  16.4 ms and 24.7 to 17.4 ms (0.70x).
- **The other reads, against `main`:** triangles 0.62x and 0.64x. Thirteen statements run the same plan and read
  0.96x to 1.08x in the two runs; the one that read 1.08x read 0.96x to 1.04x in eight runs of it alone.
- **Writes, the build with its maps against the same build without them** (smaltcy's nine write cases, eight runs):
  each case's mean is 0.98x to 1.03x. With the index kept against graph indexes off, the gate as it was worded: 0.85x
  to 1.01x.
- **A row's first read** costs more than a read without the maps, once: with the maps just cleared, group by city
  took 26.3 to 27.2 ms against 23.8 to 25.2 ms without maps, and 15.2 to 16.1 ms on every run after; the
  relationship filter 1.47 to 1.59 ms against 1.19 to 1.27 ms, and 0.41 to 0.45 ms after.
- **Memory:** the lists and labels take 3.29 MB. The 20,008 node rows group by city reads take 1.23 MB more, and the
  1,594 relationship rows the relationship filter reads 0.52 MB, most of it the pages of offsets their rowids fall on.

Still over the bar after 5b, against smaltcy: seek by name (1.04x to 1.08x) and a shortest path with a direction and
no path (1.17x to 1.19x), each under 0.04 ms, whose time is finding the kept statement; and the label scan with a
literal in the text, at parity (1.07x and 0.99x in two full runs; this change does not touch its plan). Section 3
has what is left in it: the columns of an output nothing reads.

### Step 5d: a column nothing reads is not decoded

Added 2026-11-21. Section 3's third item, and more than it names: the label scan's property map was copied out of
the page for every row that passed because two things read it, an output nothing reads and the scan's own
condition, which the generated scan decides on the row's bytes.

- **What is built.** An expression marks the columns it reads as it is compiled, and a table's row is decoded for
  the readers its columns have when its scan first opens. Two kinds of reader can be gone by then: an output a
  nested plan's projection leaves out (#278), and a conjunct that a generated scan decides in its own code. A row
  loader decodes the columns that still have a reader, and a generated scan gives the plan only those
  (docs/QUERY_ENGINE.md, "A column nothing reads is not decoded").
- **A node found by its id** (section 2's scan) follows it. Where nothing reads the node's props, a row the graph
  index knows is there, and no copy of its props is made; a row it doesn't know is looked up in the table, and its
  props are read from the lookup's row. A first build looked every such row up in the table, and the triangles took
  6.4 to 9.5 ms (1.50x): the index had been answering for them.
- **Not in it:** `IN` over text literals as a set, the other item of this step.

Measured against the commit before it (`1d28327`, step 5b), on the statements smaltcy keeps, prepared on both
builds, the two taking turns (the commit before first, then this change first). The gate: faster on the plans it
changes, no slower on the others.

| Statement | The commit before first | This change first |
|---|---|---|
| Label scan and filter | 1.144 to 0.974 ms (0.86x) | 1.151 to 0.987 ms (0.86x) |
| A label scan that 19 rows in 20 pass | 4.554 to 3.201 ms (0.69x) | 4.496 to 3.145 ms (0.70x) |
| All relationships | 2.773 to 2.408 ms (0.88x) | 2.664 to 2.375 ms (0.88x) |
| Triangles (bounded) | 6.507 to 5.678 ms (0.85x) | 6.331 to 5.515 ms (0.87x) |
| The other fourteen of smaltcy's 17 | 0.99x to 1.09x | 0.91x to 1.04x |

The statement at 1.09x and 0.91x is the variable-length pattern; in six runs of it alone it read 0.91x to 1.07x.

Against smaltcy, with smaltcy `main` (`4e7b43c`, whose kept statements are found by tokens) on a build of this
change: each of the 17 reads with the same text is under the bar in three runs (0.14x to 0.89x). With a literal in
the text the label scan reads 0.75x and 0.72x, where it reads 1.06x and 1.01x on `main` (smaltcy's benchmarks on
the pin `13c4493`, a series of its own). One read is still at the bar or over it: the seek by name with a literal
in the text, 1.08x and 1.05x (0.95x and 0.93x with a parameter; 1.00x and 1.01x on `main` in that series). It is
the first case smaltcy's benchmark times, and its statements run before the code is optimized (smaltcy's
docs/research/benchmarks.md, "A kept statement found by its tokens"). This change does not touch its plan.
