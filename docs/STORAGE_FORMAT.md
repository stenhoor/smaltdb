# Storage Format

> Status: draft. This is our own format, deliberately **not** SQLite-file compatible (ADR 0001).
> Row B+trees ship in v1. Columnar segments come in a later milestone.

## 1. Files in OPFS

```
/smaltdb/<dbname>/
   main.db        page file (fixed-size pages)
   main.wal       write-ahead log
   main.lock      (optional) marker for crash detection
   temp/          spill files for sorts and hash joins
```

## 2. Pages

> Implemented in M0: `src/engine/storage/format.ts`, `pager.ts`, `btree.ts`.

- Fixed page size, **default 8 KiB**. Any power of two from 512 B to 64 KiB is accepted; sizes below 4 KiB are meant for tests.
  OPFS throughput improves with larger I/O, so we may default to 16 KiB after benchmarking.
- Every page = `[24-byte page header | body | reserved trailer]`. The trailer is `reservedBytes` long
  (database header field, default 4). Its last 4 bytes hold a **CRC-32C** of the rest of the page. Checksums are
  verified on every read from storage (pager option `verifyChecksums`, default on). A larger trailer is reserved for future
  encryption, to hold the AES-GCM nonce and tag via WebCrypto. Encryption is not in v1.
- Multi-byte page fields are little-endian. Keys are big-endian (memcmp-comparable).

### Page header (24 bytes, little-endian)

| Offset | Size | Field |
|---|---|---|
| 0 | u8 | page type |
| 1 | u8 | flags |
| 2 | u16 | cell count |
| 4 | u16 | content start (first byte of the cell content area) |
| 6 | u16 | fragmented free bytes inside the content area |
| 8 | u32 | interior: rightmost child · leaf: next sibling · overflow / freelist trunk: next page |
| 12 | u32 | leaf: previous sibling |
| 16 | u64 | LSN of the last modification (used from M2) |

### Page 0: database header (first 128 bytes)

| Offset | Size | Field |
|---|---|---|
| 0 | 8 | magic `"smaltdb\0"` |
| 8 | u16 / u16 | format version major / minor (currently 1.0) |
| 12 | u32 | page size |
| 16 | u8 | reserved trailer bytes per page |
| 17 | u8 | flags |
| 20 | u32 | page count |
| 24 | u32 | freelist head trunk page |
| 28 | u32 | freelist page count (trunks + entries) |
| 32 | u32 | schema cookie |
| 36 | u32 | change counter (incremented every commit) |
| 40 | u32 | catalog root page |
| 48 | u64 | last checkpoint LSN |
| 56–127 | | reserved (encryption salt and KDF parameters, application id, …) |

### Page types

| Type | Purpose |
|---|---|
| `BTREE_INTERIOR` / `BTREE_LEAF` | Table and index B+trees |
| `OVERFLOW` | Large values that don't fit a cell (TEXT, BLOB) |
| `FREELIST_TRUNK` | Free page tracking |
| `COLUMN_SEGMENT` | (M7) column chunk for analytical tables |
| `STATS` | Persisted histograms and sketches |

## 3. Tables: clustered B+tree (row store)

- Each table is a B+tree keyed by `rowid` (an int64). A `WITHOUT ROWID` table is keyed by its primary key, as in SQLite.
- Leaf pages hold **slotted records**:
  - A slot directory sits at the page tail and the cells grow from the head. Records are found by binary search on the slot directory.
  - **Record format**: a null bitmap, then fixed-width columns at fixed offsets, then a variable-width offset table, then variable data.
    Unlike SQLite's varint serial types, fixed offsets let the executor decode a single column without parsing the whole record.
  - Records carry the schema version so `ALTER TABLE ADD COLUMN` can be lazy.
- Interior pages store **suffix-truncated** separator keys: the shortest prefix that separates two leaves.
- **Leaf sibling pointers** support fast range scans in both directions.

### B+tree pages (implemented in M0)

Pages are slotted: a u16 slot directory grows up from the 24-byte header, and cell content grows down from the end of the usable area.

```
leaf cell:      u16 keyLen | u8 flags | u32 valueLen | key | value                (inline)
                u16 keyLen | u8 flags | u32 valueLen | key | u32 firstOverflowPage (flags & 1)
interior cell:  u32 child | u16 keyLen | key
```

- An interior page with cells `(k0,c0)…(kn-1,cn-1)` and right pointer `r`: child `ci` holds keys `< ki`, and `r` holds keys `>= kn-1`.
- Cells larger than `(usable − 24)/4 − 2` bytes move their value to an **overflow chain**, so at least 4 cells always fit on a page.
  Each overflow page holds `usable − 24` bytes of payload after its header, and `PH_RIGHT` links to the next page.
- The root page number never changes. A root split moves the root's content into two new children.
- Deletes merge a page with a sibling when it falls below 1/4 full and the two fit together. M0 does not redistribute
  cells between siblings.
- `BTree.checkIntegrity()` verifies order, bounds, depth, sibling links, space accounting, and overflow chains.
  It will back `PRAGMA integrity_check`.

## 4. Indexes

- Secondary indexes are B+trees on `(key columns…, rowid)`. Keys use a **memcmp-comparable encoding**
  (order-preserving byte strings), so a key comparison is a single `Uint8Array` compare loop.
- Supported: composite, unique, partial (`WHERE`), and expression indexes. Covering indexes are supported through `INCLUDE` columns, which is a non-SQLite extension.

## 5. Columnar segments (milestone M7)

For analytical (scan-heavy) tables, `CREATE TABLE … WITH (storage = 'column')` would use this layout:
- Rows are grouped into **row groups** of about 64K rows. Each column of a row group is a chunk spread over one or more pages.
- Encodings: plain, dictionary, RLE, bit-packing, frame-of-reference, and delta.
- Every chunk stores **zone maps** (min/max/null count), so the planner can skip whole row groups.
- Writes go to a row-oriented delta store, which a background step compacts into column segments.

## 6. Write-ahead log and durability

> **M0 status:** commit writes pages in place and then the header. This is durable (flushed) but **not crash-atomic**.
> The WAL below arrives in M2 and replaces the in-place write-back.

- **Physical page WAL** (like SQLite WAL mode): committed pages are appended to `main.wal` with a commit frame.
- Readers use a WAL index (an in-memory hash of page → latest frame ≤ their snapshot LSN). This gives snapshot isolation for free.
- **Group commit**: several transactions committing in the same tick share one `flush()`.
- **Checkpoint**: copies pages back to `main.db` once the WAL passes N MiB, or when the engine is idle.
- Durability levels (`PRAGMA synchronous`): **`full` (default)** flushes on every commit, `normal` flushes on checkpoint, and `off` never flushes.
- Recovery: on open, scan the WAL, validate frame checksums, and replay up to the last valid commit frame.

## 7. Buffer pool and "memory cached" mode

- The buffer pool is one large `ArrayBuffer` (or a `SharedArrayBuffer` when cross-origin isolated) divided into page frames.
  Frames are preallocated, so fetching a page allocates nothing.
- Replacement: **M0 uses CLOCK** with **no-steal**: dirty pages are never evicted before commit. If every frame is
  pinned or dirty, the pool temporarily grows past its budget and shrinks back after commit. CLOCK-Pro (scan-resistant)
  and ring buffers for large scans come later. With the WAL (M2), dirty pages can spill.
- Commit writes dirty pages sorted by page number and coalesces consecutive pages into writes of up to 1 MiB.
  This made bulk loads about 3.5× faster on OPFS.
- Cache modes, per database or per table:
  - `opfs` (default): pages are loaded on demand.
  - `memory-cached`: the whole database is loaded at open time and writes go through to OPFS.
  - `memory-only`: no OPFS at all. Useful for temp tables, tests, and ephemeral data.
- A `PRAGMA cache_size` budget applies, plus a hard limit that respects device memory hints.

## 8. Free space and vacuum

- A freelist of trunk pages (implemented in M0). Each trunk stores the next trunk in `PH_RIGHT`, an entry count in the
  cell-count field, and up to `(usable − 24)/4` free page numbers as u32s. Allocation pops an entry, or reuses an
  empty trunk, before extending the file.
- `VACUUM` rewrites the file compactly. An optional `auto_vacuum=incremental` mode exists.

## 9. Format versioning

- A format version in the header. Engines refuse to write newer major versions, and minor versions must be backward compatible.
- Logical import/export in v1: **CSV and JSON/NDJSON**. Later: SQL dump, SQLite file import, Arrow/Parquet.
