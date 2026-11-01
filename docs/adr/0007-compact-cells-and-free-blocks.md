# ADR 0007: Varint leaf cell headers and per-page free blocks (format 3)

- **Status:** accepted
- **Date:** 2026-11-01

## Context

After the compact key encoding (ADR 0006), most of an index entry was fixed overhead: a 7-byte
leaf cell header (u16 key length, u8 flags, u32 value length) and a 2-byte slot. An `a(b)` entry
was about 16 bytes, against about 12 for SQLite. Index entries have empty values and table rows
are short, so the header was mostly zeros.

UPDATE and DELETE also compacted whole pages often. A freed cell in the middle of the content
area was only counted as fragment bytes. The next insert into a full page then rewrote the whole
page, even when the hole would have fit the new cell. This was 6% of an UPDATE before this change,
and 20% once smaller cells packed more of them into each page.

## Decisions

1. **Leaf cell header:** `varint keyLength`, then `varint (valueLength × 2 + overflow)`.
   - Varints are 7 bits per byte, least significant first, high bit set when more bytes follow.
   - An index entry's header is 2 bytes; a table row's is usually 2 or 3 bytes.
   - The overflow flag is the low bit of the first value byte, so decoders check it without
     parsing further.
   - Readers use a fast path when both fields are 1 byte. Key positions are passed as one packed
     number (offset × 65536 + length) instead of shared variables.
   - Interior cells are unchanged (u32 child, u16 key length, key); there are few of them.
2. **Free blocks.**
   - *Freeing:* a freed cell of 4 or more bytes inside the content area becomes a free block
     (`u16 next, u16 size`) on a per-page list. The page header's bytes 16–17, previously the
     unused LSN field, hold the list head.
   - *Allocating:* inserts use the gap between the slots and the content first, then the first
     free block that fits (taking its end), and compact the page only as a last resort.
   - *Accounting:* the existing free-byte counter covers free blocks and smaller fragments alike,
     so the free-space accounting is unchanged. The integrity check validates the list.
3. **Format major version 3.**

## Consequences

- **Sizes** (200k rows, 8 KiB pages, SQLite in brackets):
  - table: 1,427 → 1,307 pages (628);
  - `a(b)`: 397 → 275 pages (263);
  - `a(d, c)`: 455 → 332 (463);
  - `a(lower(e))`: 478 → 355 (286).

  The table stays about 2× SQLite's because of fixed-width integers in the record format,
  deferred to the columnar work.
- **Speed** (Node, in memory, A/B on the same build):
  - equality lookups ×10k: 81 → 73 ms;
  - expression lookups: 137 → 121 ms;
  - composite lookups: 33 → 29 ms;
  - UPDATE of 10k rows: 89 → 73–77 ms.
- **First attempt:** it parsed headers through shared module variables and parsed each entry
  twice. That made lookups about 20% slower than format 2. Packing the key position into a return
  value and loading each key once fixed it.
