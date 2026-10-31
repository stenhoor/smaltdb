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

- Fixed page size, **default 8 KiB** (configurable at creation: 4–64 KiB). OPFS throughput improves with larger I/O,
  so we may default to 16 KiB after benchmarking.
- Every page has a 24-byte header: `page_type u8 | flags u8 | free_offset u16 | cell_count u16 | lsn u64 | checksum u32 | reserved`.
- Header and page-tail bytes are reserved for a future encryption nonce and auth tag (AES-GCM through WebCrypto). Encryption is not in v1.
- Checksum: xxHash32 or CRC32C over the page. It is verified on read when `PRAGMA checksum=on`.
- **Page 0** is the database header: magic `"smaltdb\0"`, format version, page size, the freelist root, catalog root pages, the schema cookie, and the last checkpoint LSN.

### Page types

| Type | Purpose |
|---|---|
| `BTREE_INTERIOR` / `BTREE_LEAF` | Table and index B+trees |
| `OVERFLOW` | Large values that don't fit a cell (TEXT, BLOB) |
| `FREELIST_TRUNK` | Free page tracking |
| `COLUMN_SEGMENT` | (optional) column chunk for analytical tables **[Q-2]** |
| `STATS` | Persisted histograms and sketches |

## 3. Tables: clustered B+tree (row store)

- Each table is a B+tree keyed by `rowid` (an int64). A `WITHOUT ROWID` table is keyed by its primary key, as in SQLite.
- Leaf pages hold **slotted records**:
  - A slot directory sits at the page tail and the cells grow from the head. Records are found by binary search on the slot directory.
  - **Record format**: a null bitmap, then fixed-width columns at fixed offsets, then a variable-width offset table, then variable data.
    Unlike SQLite's varint serial types, fixed offsets let the executor decode a single column without parsing the whole record.
  - Records carry the schema version so `ALTER TABLE ADD COLUMN` can be lazy.
- Interior pages store separator keys with prefix compression.
- **Leaf sibling pointers** support fast range scans in both directions.

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

- **Physical page WAL** (like SQLite WAL mode): committed pages are appended to `main.wal` with a commit frame.
- Readers use a WAL index (an in-memory hash of page → latest frame ≤ their snapshot LSN). This gives snapshot isolation for free.
- **Group commit**: several transactions committing in the same tick share one `flush()`.
- **Checkpoint**: copies pages back to `main.db` once the WAL passes N MiB, or when the engine is idle.
- Durability levels (`PRAGMA synchronous`): **`full` (default)** flushes on every commit, `normal` flushes on checkpoint, and `off` never flushes.
- Recovery: on open, scan the WAL, validate frame checksums, and replay up to the last valid commit frame.

## 7. Buffer pool and "memory cached" mode

- The buffer pool is one large `ArrayBuffer` (or a `SharedArrayBuffer` when cross-origin isolated) divided into page frames.
- Replacement: CLOCK-Pro (scan-resistant). Large sequential scans use a ring buffer so they don't pollute the cache.
- Cache modes, per database or per table:
  - `opfs` (default): pages are loaded on demand.
  - `memory-cached`: the whole database is loaded at open time and writes go through to OPFS.
  - `memory-only`: no OPFS at all. Useful for temp tables, tests, and ephemeral data.
- A `PRAGMA cache_size` budget applies, plus a hard limit that respects device memory hints.

## 8. Free space and vacuum

- A freelist of trunk and leaf pages.
- `VACUUM` rewrites the file compactly. An optional `auto_vacuum=incremental` mode exists.

## 9. Format versioning

- A format version in the header. Engines refuse to write newer major versions, and minor versions must be backward compatible.
- Logical import/export in v1: **CSV and JSON/NDJSON**. Later: SQL dump, SQLite file import, Arrow/Parquet.
