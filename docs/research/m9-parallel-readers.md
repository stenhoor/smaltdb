# M9: parallel readers everywhere, measurements

Measurements for [ADR 0021](../adr/0021-parallel-readers-everywhere.md), one section per step.

## Step 1: readers that read through the owner (2026-11-08)

**Setup.** The browser client test (`test/browser/client-test.ts`) on Chromium 153 in a 4-core container, five runs
of each mode, each in a fresh browser context (an empty OPFS). The table is 600,000 rows of `big` (about 12 MB). Three
readers and the owner. Median in ms, with the range.

| Workload | No readers (`'off'`: Firefox and Safari today) | Readers with shared handles (Chromium today) | Readers through the owner (`'proxy'`) |
|---|---|---|---|
| 8 queries one after another, first run | 192 (176–215) | 193 (182–199) | 185 (185–221) |
| 8 queries at once, first run (cold readers) | 157 (149–179) | 204 (177–225) | **310 (307–331)** |
| 8 queries at once, warm, round 1 | 151 (145–159) | 92 (87–98) | 107 (106–151) |
| 8 queries at once, warm, round 2 | 152 (149–155) | 90 (81–105) | 94 (87–107) |
| Large aggregate | 152 on the owner | 41 as morsels | 44 as morsels |
| Prepared lookup round trip (µs) | 91 | 93 | 98 (ranges overlap) |

**Warm, readers through the owner pay off:** 8 concurrent queries 1.4–1.6× faster than the owner alone, and a large
aggregate 3.5× faster, close to readers with their own handles.

**Cold, they don't yet.** The first burst of 8 concurrent queries is 2× slower than the owner alone (non-overlapping
ranges). Counting the requests shows why: on its first query each reader made about 195 requests, reading 12 MB
through the owner, and waited 230–280 ms for them. Each reader fills its own cache with the same pages, so three
readers read 36 MB through one worker, one request at a time. Answering readers before each of the owner's own file
reads (so a reader never waits behind a stretch of the owner's I/O) did not change this: the cost is the volume, not
the owner being busy.

**Decision.** Step 1 ships with these readers off by default (`parallelReaders: 'proxy'` turns them on); the browser
test runs the client test with them on every browser. Step 2's shared page cache reads each page once for every
reader, which is what the cold case needs; it turns them on by default when it measures no slower than the owner
alone when cold.
