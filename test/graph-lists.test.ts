/** The lists of a graph index (ADR 0040, exec/graph-lists.ts), against a model: sorted arrays per node. */
import { describe, expect, it } from 'vitest';
import { CHUNK, GraphLists, ListCursor } from '../src/engine/exec/graph-lists.js';

type Entry = [type: number, other: number, rowid: number];
const order = (a: Entry, b: Entry): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** A small deterministic generator, so a failure repeats. */
function random(seed: number): (n: number) => number {
  let s = seed;
  return (n) => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s % n;
  };
}

function read(lists: GraphLists, node: number, type?: number, other?: number): Entry[] {
  const c = new ListCursor();
  const out: Entry[] = [];
  lists.seek(c, node, type ?? 0, other ?? 0);
  while (c.i < c.end || c.more()) {
    if (type !== undefined && c.a[c.i] !== type) break;
    if (other !== undefined && c.a[c.i + 1] !== other) break;
    out.push([c.a[c.i]!, c.a[c.i + 1]!, c.a[c.i + 2]!]);
    c.i += 3;
  }
  return out;
}

function expectSame(lists: GraphLists, model: Map<number, Entry[]>): void {
  let entries = 0;
  let nodes = 0;
  for (const [node, list] of model) {
    expect(read(lists, node), `node ${node}`).toEqual(list);
    entries += list.length;
    if (list.length) nodes++;
  }
  expect(lists.entries).toBe(entries);
  expect(lists.nodes).toBe(nodes);
  const all: [number, ...Entry][] = [];
  lists.forEach((node, type, other, rowid) => void all.push([node, type, other, rowid]));
  const want = [...model].sort((a, b) => a[0] - b[0]).flatMap(([node, list]) => list.map((e) => [node, ...e]));
  expect(all).toEqual(want);
}

describe('graph lists', () => {
  it('has nothing for a node without relationships', () => {
    const lists = new GraphLists();
    expect(read(lists, 0)).toEqual([]);
    expect(read(lists, 5_000_000, 2)).toEqual([]);
    expect(lists.has(7, 0, 1, 1)).toBe(false);
    expect(lists.remove(7, 0, 1, 1)).toBe(false);
    expect(lists.bytes()).toBe(0);
  });

  it('keeps each list sorted by type, other node and rowid', () => {
    const lists = new GraphLists();
    const model = new Map<number, Entry[]>();
    const rnd = random(7);
    for (let i = 0; i < 20_000; i++) {
      const node = rnd(300);
      const e: Entry = [rnd(4), rnd(500), i];
      lists.add(node, ...e);
      const list = model.get(node) ?? [];
      list.push(e);
      model.set(node, list);
    }
    for (const list of model.values()) list.sort(order);
    expectSame(lists, model);
  });

  it('reads one type of a node, and one other node of a type', () => {
    const lists = new GraphLists();
    const all: Entry[] = [];
    const rnd = random(11);
    for (let i = 0; i < 6_000; i++) {
      const e: Entry = [rnd(5), rnd(40), i];
      all.push(e);
      lists.add(9, ...e);
    }
    all.sort(order);
    for (let type = 0; type < 6; type++) {
      expect(read(lists, 9, type)).toEqual(all.filter((e) => e[0] === type));
      for (const other of [0, 1, 17, 39, 40]) expect(read(lists, 9, type, other)).toEqual(all.filter((e) => e[0] === type && e[1] === other));
    }
    for (const e of all.slice(0, 200)) expect(lists.has(9, ...e)).toBe(true);
    expect(lists.has(9, 5, 0, 0)).toBe(false);
    expect(lists.has(9, 0, 0, 1_000_000)).toBe(false);
  });

  it('removes entries, down to none, and reuses the space', () => {
    const lists = new GraphLists();
    const model = new Map<number, Entry[]>();
    const rnd = random(3);
    const added: [number, Entry][] = [];
    for (let i = 0; i < 30_000; i++) {
      // Node 1 is a hub, with a list of many chunks.
      const node = rnd(3) === 0 ? 1 : rnd(200);
      const e: Entry = [rnd(3), rnd(2_000), i];
      lists.add(node, ...e);
      added.push([node, e]);
      (model.get(node) ?? model.set(node, []).get(node)!).push(e);
    }
    for (const list of model.values()) list.sort(order);
    expectSame(lists, model);
    expect(model.get(1)!.length).toBeGreaterThan(4 * CHUNK);
    const bytes = lists.bytes();

    // Remove two thirds, in an order of its own.
    const gone = added.filter((_, i) => i % 3 !== 0).sort((a, b) => ((a[1][2] * 7919) % 30_011) - ((b[1][2] * 7919) % 30_011));
    for (const [node, e] of gone) {
      expect(lists.remove(node, ...e)).toBe(true);
      const list = model.get(node)!;
      list.splice(list.findIndex((x) => x[2] === e[2]), 1);
    }
    expect(lists.remove(gone[0]![0], ...gone[0]![1])).toBe(false);
    expectSame(lists, model);

    // Put them back: no more memory than before.
    for (const [node, e] of gone) {
      lists.add(node, ...e);
      model.get(node)!.push(e);
    }
    for (const list of model.values()) list.sort(order);
    expectSame(lists, model);
    expect(lists.bytes()).toBeLessThanOrEqual(bytes * 1.25);

    for (const [node, e] of added) expect(lists.remove(node, ...e)).toBe(true);
    expect(lists.entries).toBe(0);
    expect(lists.nodes).toBe(0);
    for (const node of model.keys()) expect(read(lists, node)).toEqual([]);
  });

  it('appends in order, filling its blocks', () => {
    const lists = new GraphLists();
    const model = new Map<number, Entry[]>();
    // As a build reads the endpoint indexes: type after type, each in (node, other, rowid) order.
    let rowid = 0;
    for (let type = 0; type < 3; type++) {
      for (let node = 0; node < 50; node++) {
        const n = node === 4 ? 3 * CHUNK + 17 : node % 7;
        for (let k = 0; k < n; k++) {
          const e: Entry = [type, k >> 1, rowid++];
          lists.append(node, ...e);
          (model.get(node) ?? model.set(node, []).get(node)!).push(e);
        }
      }
    }
    expectSame(lists, model);
    // Then it takes adds and removes as any list.
    lists.add(4, 1, 0, 5_000_000);
    model.get(4)!.push([1, 0, 5_000_000]);
    model.get(4)!.sort(order);
    expect(lists.remove(4, 0, 0, model.get(4)![0]![2])).toBe(true);
    model.get(4)!.shift();
    expectSame(lists, model);
  });

  it('takes node ids that are far apart', () => {
    const lists = new GraphLists();
    const nodes = [0, 1, 4095, 4096, 1_000_000, 2 ** 31 - 1];
    for (const node of nodes) lists.add(node, 1, node, 2 ** 31 - 1);
    for (const node of nodes) expect(read(lists, node)).toEqual([[1, node, 2 ** 31 - 1]]);
    expect(read(lists, 4097)).toEqual([]);
    expect(lists.nodes).toBe(nodes.length);
    // A page of heads per stretch of ids in use, not a table up to the largest id.
    expect(lists.bytes()).toBeLessThan(4 * 1024 * 1024);
  });
});
