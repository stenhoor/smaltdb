import { BTree } from '../../../src/engine/storage/btree.js';
import { KeyEncoder } from '../../../src/engine/storage/key-codec.js';
import { Pager } from '../../../src/engine/storage/pager.js';
import { OpfsVfs } from '../../../src/engine/vfs/opfs.js';
import { type Adapter, valueFor } from '../adapter.js';

/**
 * smaltdb M0: the storage layer only (B+tree keyed by encoded integer, value = UTF-8 text).
 * No SQL layer yet, so these numbers are a lower bound on engine cost, not a like-for-like SQL comparison.
 */
export class SmaltdbAdapter implements Adapter {
  readonly name = 'smaltdb (M0 storage layer)';
  readonly config = 'OPFS sync handle, 8 KiB pages, 64 MiB cache, synchronous=full (flush per commit), no WAL yet';
  private vfs = new OpfsVfs({ rootDir: 'smaltdb-bench' });
  private pager!: Pager;
  private tree!: BTree;
  private enc = new KeyEncoder();
  private te = new TextEncoder();

  async open(): Promise<void> {
    await this.vfs.delete('bench.db');
    const file = await this.vfs.open('bench.db');
    this.pager = Pager.open(file, { pageSize: 8192, cacheSizeBytes: 64 * 1024 * 1024 });
    this.tree = new BTree(this.pager, BTree.create(this.pager));
    this.pager.commit();
  }

  private key(k: number): Uint8Array {
    return this.enc.reset().add(k).finish();
  }

  async bulkInsert(n: number): Promise<void> {
    for (let k = 0; k < n; k++) this.tree.put(this.key(k), this.te.encode(valueFor(k)));
    this.pager.commit();
  }

  async pointLookups(keys: Int32Array): Promise<number> {
    let found = 0;
    for (let i = 0; i < keys.length; i++) if (this.tree.get(this.key(keys[i])) !== undefined) found++;
    return found;
  }

  async scanCount(): Promise<number> {
    return this.tree.count();
  }

  async scanValues(): Promise<number> {
    const c = this.tree.cursor();
    let total = 0;
    for (let ok = c.first(); ok; ok = c.next()) total += c.value().length;
    c.close();
    return total;
  }

  async smallTxns(start: number, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      this.tree.put(this.key(start + i), this.te.encode(valueFor(start + i)));
      this.pager.commit();
    }
  }

  async close(): Promise<void> {
    this.pager.close();
    await this.vfs.delete('bench.db');
  }
}
