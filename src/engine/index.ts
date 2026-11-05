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
export { Database, PreparedStatement, Statement, PlanStatement, RowCursor, type RunResult, type QueryResult, type BindParams, type DatabaseOptions } from './database.js';
export * as plan from './plan/public.js';
export type { PlanStatementInput, PlanColumn } from './plan/statement.js';
export { parse, parseOne, SqlSyntaxError } from './sql/parser.js';
export { registerLanguage, type SmaltLanguage, type LanguageStatement, type ObjectReference } from './plan/language.js';
// smaltdb's databases read SQL: this entry point registers it (ADR 0015 step 9).
import './sql/register.js';
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
  type RandomFile,
  type SourceHandler,
  type SourceTarget,
  type SourceContext,
  type OpenedFile,
  type ListedFile,
  type AskError,
  type StaticType,
  type Zone,
} from './plugin.js';
