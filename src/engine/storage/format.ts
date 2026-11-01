/**
 * On-disk format constants. See docs/STORAGE_FORMAT.md.
 *
 * Every page = [24-byte page header | body ... | reserved trailer]. The trailer is
 * `reservedBytes` long (default 4) and its last 4 bytes hold the CRC-32C of everything before.
 * Page 0 instead starts with the database header (DB_HEADER_SIZE bytes).
 * Multi-byte page fields are little-endian; index keys are big-endian (memcmp-comparable).
 */

export const FORMAT_MAJOR = 3;
export const FORMAT_MINOR = 0;
export const MAGIC = new Uint8Array([0x73, 0x6d, 0x61, 0x6c, 0x74, 0x64, 0x62, 0x00]); // "smaltdb\0"

export const MIN_PAGE_SIZE = 512;
export const MAX_PAGE_SIZE = 65536;
export const DEFAULT_PAGE_SIZE = 8192;
export const DEFAULT_RESERVED_BYTES = 4;

export const PageType = {
  Free: 0,
  BTreeInterior: 2,
  BTreeLeaf: 5,
  Overflow: 8,
  FreelistTrunk: 9,
} as const;

// ---- page header (all non-header pages) ----
export const PAGE_HEADER_SIZE = 24;
export const PH_TYPE = 0; // u8
export const PH_FLAGS = 1; // u8
export const PH_CELL_COUNT = 2; // u16
export const PH_CONTENT_START = 4; // u16 (offset of first byte of cell content area)
export const PH_FRAG_BYTES = 6; // u16 (bytes in holes inside the content area)
export const PH_RIGHT = 8; // u32 (interior: rightmost child; leaf: next sibling; overflow/trunk: next page)
export const PH_PREV = 12; // u32 (leaf: previous sibling)
export const PH_FREEBLOCK = 16; // u16 (b-tree pages: offset of the first free block, 0 = none; format 3)
// bytes 18..23: reserved (zero)

// ---- database header (page 0) ----
export const DB_HEADER_SIZE = 128;
export const DH_MAGIC = 0; // 8 bytes
export const DH_FORMAT_MAJOR = 8; // u16
export const DH_FORMAT_MINOR = 10; // u16
export const DH_PAGE_SIZE = 12; // u32
export const DH_RESERVED_BYTES = 16; // u8
export const DH_FLAGS = 17; // u8
export const DH_PAGE_COUNT = 20; // u32
export const DH_FREELIST_HEAD = 24; // u32
export const DH_FREELIST_COUNT = 28; // u32
export const DH_SCHEMA_COOKIE = 32; // u32
export const DH_CHANGE_COUNTER = 36; // u32
export const DH_CATALOG_ROOT = 40; // u32
export const DH_CHECKPOINT_LSN = 48; // u64
// 56..127 reserved (future: encryption salt/KDF params, application id, ...)
