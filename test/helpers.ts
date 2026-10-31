import { MemoryVfs } from '../src/engine/vfs/memory.js';
import { Pager, type PagerOptions } from '../src/engine/storage/pager.js';

/** Deterministic PRNG (mulberry32) so failures reproduce. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function openMemoryPager(options: PagerOptions = {}, vfs = new MemoryVfs(), path = 'test.db') {
  const file = vfs.openSync(path);
  return { vfs, pager: Pager.open(file, options), reopen: (opts: PagerOptions = options) => Pager.open(vfs.openSync(path), opts) };
}

export const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
