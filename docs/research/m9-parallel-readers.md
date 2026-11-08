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

**Firefox and WebKit (CI, one run each).** The browser tests' timings from CI on this PR (Playwright 1.64.1 in its
Docker image, 4 cores; neither browser has `readwrite-unsafe`, so without `'proxy'` every query runs on the owner).
One run, so only large differences count.

| Workload | Firefox: owner alone | Firefox: through the owner | WebKit: owner alone | WebKit: through the owner |
|---|---|---|---|---|
| 8 queries at once, first run | 215 | 239 | 412 | 495 |
| 8 queries at once, warm (two rounds) | 216, 217 | 125, 150 | 385, 397 | 297, 283 |
| Large aggregate (owner / morsels) | 87 | 83 | 60 | 82 |
| Prepared lookup round trip (µs) | 201 | 185 | 161 | 171 |

- **Warm:** 1.4–1.7× faster on Firefox, 1.3–1.4× on WebKit.
- **Cold:** 1.1× slower on Firefox, 1.2× on WebKit (Chromium: 2×).
- **Morsels:** no gain on Firefox, and 1.4× slower than the owner alone on WebKit, where the owner's aggregate is
  fast. Step 4's routing has to take this into account per browser, not only whether readers exist.

## Step 2: the shared block cache (2026-11-08)

A cache of 64 KiB file blocks in a `SharedArrayBuffer` (`vfs/shared-cache.ts`), twice the owner's page cache by
default (32 MiB), filled by the owner from its own reads of the database file and from the blocks it sends readers.
Readers look blocks up without locks and ask the owner only on a miss.

**The cache alone did not help at first:** the cold burst stayed at 326 ms (321–393). Counting showed why: the three
readers scan the same table at the same time, each missing on the same block before any of them had filled it (about
10 hits in 190 reads per reader). Two changes fixed that:

- **Read-ahead:** a miss right after the previous run asks for a run twice as long, up to 1 MiB (16 blocks). A scan
  of the 12 MB table takes about a dozen round trips instead of 180.
- **The owner answers from the cache** when another reader's request has just filled the blocks asked for, instead
  of reading the file again.
- And each reader keeps the last part block it got (the log's end, which the shared cache never holds) until its
  next snapshot: a second reader's cold query then asks the owner 4 times (three sizes and that block), not about 10.

Chromium, same setup as step 1 (five runs each, median and range in ms):

| Workload | Owner alone | Shared handles | Through the owner, step 1 | Through the owner, step 2 |
|---|---|---|---|---|
| 8 queries at once, first run | 150 (145–167) | 200 (184–211) | 310 (307–331) | 196 (160–226) |
| 8 queries at once, warm (two rounds) | 144, 148 | 91, 81 | 107, 94 | 96, 87 |
| Large aggregate (owner / morsels) | 167 | 46 | 44 | 42 |
| Prepared lookup round trip (µs) | 96 | 91 | 98 | 96 |

**Readers through the owner now match readers with their own handles** (Chromium's default since M6), cold and warm.
Both are still slower than the owner alone on a first burst (1.3×, ranges barely overlapping): the cost of fresh
readers (opening, loading the schema, compiling each query once), not of reading through the owner.

**Firefox and WebKit (CI on #173, one run each)**, readers through the owner against the owner alone:

| Workload | Firefox: owner alone | Firefox: through the owner | WebKit: owner alone | WebKit: through the owner |
|---|---|---|---|---|
| 8 queries at once, first run | 220 | **190** | 396 | 444 |
| 8 queries at once, warm (two rounds) | 221, 222 | 127, 158 | 352, 364 | 352, 278 |
| Large aggregate (owner / morsels) | 96 | 102 | 63 | 90 |
| Prepared lookup round trip (µs) | 211 | 202 | 166 | 174 |

Cold, the burst is now 1.16× faster than the owner alone on Firefox (it was 1.1× slower in step 1) and 1.1× slower
on WebKit (1.2×). Warm, 1.4–1.75× faster on Firefox; on WebKit the same, then 1.3× faster. Morsels still don't pay on
either.

## Step 4, first decisions (2026-11-08)

The owner chose, from the numbers above: readers that read through the owner are on by default where readers cannot
open the files themselves, and they take no morsels (ADR 0021, decision 5). The browser test checks both: every
isolated browser starts readers, and a large aggregate stays on the owner with readers that read through it.

**More samples (CI on #174, 2026-11-08).** With readers through the owner on by default, Firefox and WebKit have no
owner-only run left in the browser test, so each run is compared with the same 8 queries run one after another on the
owner (serial, all on the owner). Two workflow runs, each running the client test twice (by default, and with
`'proxy'`; on these browsers both use readers through the owner); ms.

| Sample | Firefox cold: at once / serial | Firefox warm: at once (two rounds) / serial | WebKit cold | WebKit warm |
|---|---|---|---|---|
| Run 1, default | 203 / 228 | 143, 162 / 217 | 315 / 365 | 233, 217 / 281 |
| Run 1, `'proxy'` | 189 / 231 | 125, 160 / 212 | 321 / 375 | 244, 232 / 287 |
| Run 2, default | 112 / 122 | 81, 78 / 116 | 388 / 466 | 290, 258 / 339 |
| Run 2, `'proxy'` | 111 / 126 | 75, 91 / 117 | 403 / 428 | 334, 308 / 346 |

In every sample, cold, the concurrent burst beat the same queries run one after another (Firefox 0.82–0.92 of the
serial time, WebKit 0.83–0.94). Warm, concurrent queries took 0.59–0.78 of the serial time on Firefox and 0.76–0.97 on
WebKit. The machines differ between runs (Firefox's second run was twice as fast), so compare within a row. In the
owner-only runs of steps 1 and 2, the burst took 0.88–0.97 of the serial time (Firefox 0.96–0.97, WebKit 0.88–0.89),
so cold, readers are a small gain on Firefox and about even on WebKit; warm is where they pay.

## Step 3: the shared WAL index (2026-11-08)

**Measured first.** A browser benchmark on Chromium with readers through the owner (`parallelReaders: 'proxy'`): a
200,000-row table, 10 rounds of 8 concurrent queries (three aggregates and a point lookup, twice), with 0, 10 or 100
small commits on the owner before each round. Temporary instrumentation timed each reader's snapshot refresh against
its whole query.

| Commits before each round | Refresh per reader query | Share of reader query time |
|---|---|---|
| 0 | 3.8 ms | 18% |
| 10 | 4.5 ms | 22% |
| 100 | 8.0 ms | 17% |

With nothing new, a refresh still asked the owner for the log's size, and waited for an owner busy with its own
queries; with commits, it also read and checksummed every new frame through the owner.

**With the shared WAL index** (the owner publishes its log's index in shared memory; ADR 0021, decision 4), same
benchmark, two runs:

| Commits before each round | Refresh per reader query | Share of reader query time |
|---|---|---|
| 0 | 0.01 ms | 0.1% |
| 10 | 1.6 ms | 11% |
| 100 | 2.1–2.2 ms | 3% |

A round of 8 concurrent queries with no commits went from about 51 ms (42–60) to about 40 ms (35–62). With commits, a
refresh still reads the database header page from the end of the log (one round trip), which is most of what is left.
