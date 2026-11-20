# ADR 0041: Properties in the graph index, and what else the reads over the bar need

- **Status:** proposed, for the owner's review (2026-11-20). Section 1 is built and in review
  ([#283](https://github.com/stenhoor/smaltdb/pull/283)); nothing else here is built. The numbers marked "by hand" come
  from a spike that was measured and thrown away.
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
  properties. With the maps held, the column is a view of the map's bytes.
- **A node found by its id.** A plan that seeks a node table by rowid and reads only its id and its `props` gets one
  more access path beside the rowid lookup, as the label check did in #282: `SEARCH <table> USING GRAPH INDEX
  (rowid=?)`. The node is there if the index has its row, and its `props` is a view of the bytes. A plan that reads
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
- Memory: one more copy of every property map of an indexed graph whose properties are read by id, 1.6 MB for the
  benchmark's graph, under the lists' limit and let go before them.
- A write to a node or edge table with a `props` column also copies the row's map. Measured when built; the gate is
  no write slower.
- The first statement that reads a table's properties by id scans that table once.
- Reader workers and `asOf` reads run as today, as with the lists (ADR 0040).
- Nothing changes for smaltql, smaltdf, smaltts or the plugins. smaltcy changes a few lines for 5a and nothing for
  5b to 5d.

## Questions for the owner

1. **By row, not by column** (section 2): a change from ADR 0040's wording, on the measurements above. Agreed?
2. **The memory:** a second copy of the graph's property maps, under the same limit as the lists (256 MB by
   default), given up first. Acceptable, or its own limit?
