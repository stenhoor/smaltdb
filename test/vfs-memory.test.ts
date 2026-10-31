import { describe, expect, it } from 'vitest';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

describe('MemoryVfs', () => {
  it('reads, writes, extends, truncates, and persists across reopen', async () => {
    const vfs = new MemoryVfs();
    const f = await vfs.open('a.db');
    expect(f.size()).toBe(0);
    f.write(new Uint8Array([1, 2, 3]), 10);
    expect(f.size()).toBe(13);
    const buf = new Uint8Array(5);
    expect(f.read(buf, 9)).toBe(4);
    expect([...buf]).toEqual([0, 1, 2, 3, 0]);
    f.truncate(11);
    expect(f.size()).toBe(11);
    f.close();
    expect(() => f.size()).toThrow();
    const g = await vfs.open('a.db', { create: false });
    expect(g.size()).toBe(11);
    expect(await vfs.exists('a.db')).toBe(true);
    await vfs.delete('a.db');
    expect(await vfs.exists('a.db')).toBe(false);
    await expect(vfs.open('a.db', { create: false })).rejects.toThrow(/no such file/);
  });
});
