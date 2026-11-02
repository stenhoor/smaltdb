// Engine internals (M0: storage layer). The public client API arrives in M1.
export * from './errors.js';
export type { Vfs, VfsFile, OpenOptions } from './vfs/types.js';
export { MemoryVfs } from './vfs/memory.js';
export { OpfsVfs } from './vfs/opfs.js';
export { detectCapabilities, type Capabilities } from './vfs/capabilities.js';
export { Pager, Frame, type PagerOptions, type PagerStats } from './storage/pager.js';
export { BTree, BTreeCursor, type IntegrityReport } from './storage/btree.js';
export { KeyEncoder, encodeKey, decodeKey, Collation, type KeyColumn, type SqlValue } from './storage/key-codec.js';
export { crc32c } from './storage/crc32c.js';
export { Database, Statement, RowCursor, type RunResult, type QueryResult, type BindParams, type DatabaseOptions } from './database.js';
export { parse, parseOne, SqlSyntaxError } from './sql/parser.js';
export {
  PLUGIN_API_VERSION,
  type SmaltPlugin,
  type PluginHost,
  type PluginMethod,
  type MethodContext,
  type ConnectionTypeSpec,
  type FormatReader,
  type FormatRequest,
  type FormatResult,
  type FormatColumn,
  type RandomAccessFile,
  type SourceHandler,
  type SourceTarget,
  type SourceContext,
  type OpenedFile,
  type ListedFile,
  type AskError,
  type Zone,
} from './plugin.js';
