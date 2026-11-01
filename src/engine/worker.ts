/// <reference lib="webworker" />
/**
 * Engine worker entry point. Owns the database file (OPFS sync access handles are only available
 * in dedicated workers) and executes requests sequentially.
 */
import { type BindParams, Database, type RowCursor, type Statement } from './database.js';
import { exportCSV, exportJSON, importCSV, importJSON } from './io/import-export.js';
import { SmaltError } from './errors.js';
import { detectCapabilities } from './vfs/capabilities.js';
import { OpfsVfs } from './vfs/opfs.js';
import { type Request, type Response, encodeColumns } from '../shared/protocol.js';
import type { SqlValue } from './values.js';

let db: Database | null = null;
const statements = new Map<number, Statement>();
let nextStmt = 1;

const post = (msg: Response, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(msg, transfer);

function streamCursor(id: number, cursor: RowCursor, batchSize: number): void {
  post({ id, kind: 'columns', columns: cursor.columns });
  const width = cursor.columns.length;
  for (;;) {
    const cols: SqlValue[][] = Array.from({ length: width }, () => []);
    const n = cursor.nextBatch(batchSize, cols);
    if (n === 0) break;
    const { cols: wire, transfer } = encodeColumns(cols, n);
    post({ id, kind: 'batch', length: n, cols: wire }, transfer);
    if (n < batchSize) break;
  }
  cursor.close();
  post({ id, kind: 'done' });
}

function requireDb(): Database {
  if (!db) throw new SmaltError('SMALT_MISUSE', 'database is not open');
  return db;
}

async function handle(req: Request): Promise<void> {
  const { id } = req;
  switch (req.op) {
    case 'open': {
      if (db) throw new SmaltError('SMALT_MISUSE', 'database already open in this worker');
      const options = { pageSize: req.pageSize, cacheSizeBytes: req.cacheSizeBytes, syncOnCommit: req.syncOnCommit };
      db = req.storage === 'memory' || req.name === ':memory:' ? Database.openMemory(options) : await Database.open(new OpfsVfs(), `${req.name}.db`, options);
      post({ id, kind: 'ok', capabilities: detectCapabilities() });
      return;
    }
    case 'exec': {
      const d = requireDb();
      if (req.params !== undefined) {
        const r = d.run(req.sql, req.params as BindParams);
        post({ id, kind: 'ok', changes: r.changes, lastInsertRowid: r.lastInsertRowid });
      } else {
        d.exec(req.sql);
        post({ id, kind: 'ok', changes: d.changes(), lastInsertRowid: d.lastInsertRowid() });
      }
      return;
    }
    case 'query': {
      const st = requireDb().prepare(req.sql);
      streamCursor(id, st.cursor(req.params as BindParams | undefined), req.batchSize ?? 4096);
      return;
    }
    case 'prepare': {
      const st = requireDb().prepare(req.sql);
      const sid = nextStmt++;
      statements.set(sid, st);
      post({ id, kind: 'ok', stmt: sid, columns: st.columns, paramCount: st.paramCount });
      return;
    }
    case 'stmtRun': {
      const st = statements.get(req.stmt);
      if (!st) throw new SmaltError('SMALT_MISUSE', 'statement is finalized');
      const r = st.run(req.params as BindParams | undefined);
      post({ id, kind: 'ok', changes: r.changes, lastInsertRowid: r.lastInsertRowid });
      return;
    }
    case 'stmtQuery': {
      const st = statements.get(req.stmt);
      if (!st) throw new SmaltError('SMALT_MISUSE', 'statement is finalized');
      streamCursor(id, st.cursor(req.params as BindParams | undefined), req.batchSize ?? 4096);
      return;
    }
    case 'finalize':
      statements.delete(req.stmt);
      post({ id, kind: 'ok' });
      return;
    case 'import': {
      const d = requireDb();
      const text = new TextDecoder().decode(req.data);
      const r = req.format === 'csv' ? importCSV(d, req.table, text, req.options) : importJSON(d, req.table, text, req.options);
      post({ id, kind: 'ok', changes: r.rows });
      return;
    }
    case 'export': {
      const d = requireDb();
      const params = req.params as SqlValue[] | Record<string, SqlValue> | undefined;
      const text = req.format === 'csv' ? exportCSV(d, req.sql, params, req.options) : exportJSON(d, req.sql, params, req.options);
      post({ id, kind: 'ok', text });
      return;
    }
    case 'close':
      statements.clear();
      db?.close();
      db = null;
      post({ id, kind: 'ok' });
      return;
  }
}

// Requests are processed strictly in order (open is async; everything else is synchronous).
let chain: Promise<void> = Promise.resolve();
self.onmessage = (e: MessageEvent<Request>) => {
  const req = e.data;
  chain = chain.then(() =>
    handle(req).catch((err: unknown) => {
      const code = err instanceof SmaltError ? err.code : 'SMALT_INTERNAL';
      // Some engines (WebKit) raise DOMExceptions with an empty message: keep the name then.
      post({ id: req.id, kind: 'error', code, message: err instanceof Error ? err.message || err.name : String(err) });
    }),
  );
};
