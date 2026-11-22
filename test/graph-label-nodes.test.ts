/**
 * A label's nodes read from the graph's index (ADR 0040, section 5; ADR 0042, step 1). A plan that reads the label
 * index for one label's entries gets them from the label's set in memory, in the order the index gives them. Where
 * it then finds each node's row by its rowid in the index's property maps, the label's scan asks first whether the
 * row can pass the plan's conditions on its props, read where the row's map lies, and gives only the nodes that can.
 * Every database here runs with the test setting on (test/setup-sql.ts): a query that reads the index is run again
 * without it, and must give the same rows in the same order.
 */
import { describe, expect, it } from 'vitest';
import { Database, type DatabaseOptions } from '../src/engine/database.js';
import { GraphLabels } from '../src/engine/exec/graph-labels.js';
import { GraphLabelEntries } from '../src/engine/exec/graph-scan.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import type { PlanType } from '../src/engine/plan/types.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import type { SqlValue } from '../src/engine/values.js';

const M = 'map<text, any>' as PlanType;
type Props = Record<string, unknown> | null;

const statement = (db: Database, s: Record<string, unknown>) => db.queryPlan(s as unknown as PlanStatementInput);
const schema = (db: Database, op: Record<string, unknown>): void => void statement(db, { kind: 'schema', op });
const write = (db: Database, plan: PlanOp): void => void statement(db, { kind: 'write', plan });
const column = (name: string, type: string, declaredType = type) => ({ name, declaredType, type, notNull: false, collation: 'binary' });
const KEY = [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }], ofColumn: 0 }];

const NODES = 300;
/** A node's properties as they are loaded: a number, text, a truth value, keys only some have, and nodes with none. */
const props = (i: number): Props => {
  if (i % 11 === 3) return null;
  if (i % 13 === 5) return {};
  return {
    i,
    name: `n${i}`,
    age: i % 9 === 0 ? String(20 + (i % 50)) : i % 10 === 7 ? 20.5 + (i % 50) : 20 + (i % 50),
    flag: i % 2 === 0,
    ...(i % 4 === 0 ? { city: ['Lisbon', 'Oslo', 'Rome'][i % 3] } : {}),
    ...(i % 17 === 0 ? { big: 2n ** 60n + BigInt(i) } : {}),
    ...(i % 19 === 0 ? { title: null } : {}),
    ...(i % 23 === 0 ? { note: 'x'.repeat(5000) } : {}),
  };
};
/** The labels a node has in the label index: two in three are benches, one in five is another thing. */
const isBench = (i: number): boolean => i % 3 !== 0;
const isOther = (i: number): boolean => i % 5 === 0;
const BENCHES = Array.from({ length: NODES }, (_, i) => i).filter(isBench);
/** The graph's labels besides the node table's own. */
const LABELS = ['Bench', 'Other', 'Third', 'Far', 'Many', 'Few', 'Nobody', '7', 'null'];

const addNodes = (db: Database, ids: number[], maps: Props[]): void => write(db, p.append('node', p.fromColumns([ids, maps] as never, ['int', M]), [0, 1]));
const eq = (a: PlanExpr, b: PlanExpr): PlanExpr => p.call('cmp_eq', [a, b], 'bool');
/** Sets the props of the nodes `ids`: the table joined with the values. */
const setProps = (db: Database, ids: number[], maps: Props[]): void => {
  const input = p.filter(p.join('cross', p.scan('node', [-1]), p.fromColumns([ids, maps] as never, ['int', M])), eq(p.col(0, 0, 'int'), p.col(0, 1, 'int')));
  write(db, { op: 'update', table: 'node', db: 'main', input, rowid: 0, sets: [{ column: 1, value: p.col(0, 2, M) }], from: true } as unknown as PlanOp);
};

/**
 * Nodes (id, props) of one table, with their labels in the graph's label index, as a language for graphs lays one
 * out; each node knows the next.
 */
function graph(db: Database): Database {
  schema(db, { op: 'createTable', table: { name: 'node', columns: [column('id', 'INTEGER'), column('props', 'MAP', M)], keys: KEY, checks: [], foreignKeys: [], storage: 'row' }, temp: false, ifNotExists: false });
  db.exec('CREATE TABLE knows(start INTEGER, end INTEGER); CREATE INDEX knows_start ON knows(start, end); CREATE INDEX knows_end ON knows(end, start)');
  // A label of the graph has a table of its own, empty here: which nodes have it is in the label index.
  for (const label of LABELS) db.exec(`CREATE TABLE l_${label}(id INTEGER PRIMARY KEY)`);
  schema(db, {
    op: 'createPropertyGraph',
    ifNotExists: false,
    graph: {
      name: 'g',
      nodes: [{ label: 'Node', table: 'node', id: 'id', props: 'props' }, ...LABELS.map((label) => ({ label, table: `l_${label}`, id: 'id' }))],
      edges: [{ type: 'KNOWS', table: 'knows', start: 'start', end: 'end' }],
    },
  });
  schema(db, { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabelIndex' } });
  const ids = Array.from({ length: NODES }, (_, i) => i);
  addNodes(db, ids, ids.map(props));
  db.exec(`INSERT INTO knows SELECT id, (id + 1) % ${NODES} FROM node`);
  db.exec("INSERT INTO g_labels SELECT id, 'Bench' FROM node WHERE id % 3 <> 0");
  db.exec("INSERT INTO g_labels SELECT id, 'Other' FROM node WHERE id % 5 = 0");
  return db;
}
const open = (options: DatabaseOptions = {}): Database => graph(Database.openMemory(options));
const plan = (db: Database, sql: string, params: unknown[] = []): string => db.query(`EXPLAIN QUERY PLAN ${sql}`, params as never).rows.map((r) => String(r[3])).join('\n');
const explain = (db: Database, op: PlanOp, params: unknown[] = []): string =>
  (db.queryPlan({ kind: 'explain', mode: 'plan', query: { kind: 'query', plan: op } } as unknown as PlanStatementInput, params as never).rows as unknown[][]).map((r) => String(r[3])).join('\n');
/** What ran: each scan's line of EXPLAIN ANALYZE, with the rows the planner expected, the times it opened and the rows it gave. */
const ran = (db: Database, op: PlanOp, params: unknown[] = []): { detail: string; expected: number; loops: number; rows: number }[] =>
  (db.queryPlan({ kind: 'explain', mode: 'analyze', query: { kind: 'query', plan: op } } as unknown as PlanStatementInput, params as never).rows as unknown[][])
    .filter((r) => String(r[2]).startsWith('SEARCH') || String(r[2]).startsWith('SCAN'))
    .map((r) => ({ detail: String(r[2]), expected: Number(r[3]), loops: Number(r[4]), rows: Number(r[5]) }));
const state = (db: Database) => db.graphIndexState.state()[0]!;
const rows = (db: Database, op: PlanOp, params: unknown[] = []): unknown[][] => db.queryPlan(op, params as never).rows as unknown[][];
const ids = (db: Database, op: PlanOp, params: unknown[] = []): unknown[] => rows(db, op, params).map((r) => r[0]);

const LABEL_SCAN = 'SEARCH g_labels USING GRAPH INDEX (label=?)';
const CHECKED = 'SEARCH g_labels USING GRAPH INDEX (label=?) CHECKING node';
const NODE_SCAN = 'SEARCH node USING GRAPH INDEX (rowid=?)';

// The label index (node, label) joined with the node table (id, props): columns 0 to 3.
const NODE = p.col(0, 0, 'int');
const LABEL = p.col(0, 1, 'text');
const ID = p.col(0, 2, 'int');
const PROPS = p.col(0, 3, M);
const get = (k: string): PlanExpr => p.call('map_get', [PROPS, p.lit(k)], 'any');
const cmp = (fn: string, a: PlanExpr, b: PlanExpr, collation?: 'nocase'): PlanExpr => ({ ...p.call(fn, [a, b], 'bool'), ...(collation ? { collation } : {}) }) as PlanExpr;
const joined = (): PlanOp => p.join('cross', p.scan('g_labels', [0, 1]), p.scan('node', [0, 1]));
/** The nodes of a label with their rows; with `pred`, those that pass it. */
const labelled = (label: PlanExpr, pred?: PlanExpr): PlanOp => p.filter(joined(), p.and(eq(LABEL, label), eq(ID, NODE), ...(pred ? [pred] : [])));
const benches = (pred?: PlanExpr): PlanOp => labelled(p.lit('Bench'), pred);
/** The ids of the benches that pass `pred`. */
const found = (pred: PlanExpr, label: PlanExpr = p.lit('Bench')): PlanOp => p.project(labelled(label, pred), [ID]);
const counted = (pred: PlanExpr): PlanOp => p.aggregate(benches(pred), [], [p.agg('count', [], 'int', { star: true })]);
/** `pred` for each bench, evaluated in a projection: no scan reads ahead of that. */
const each = (pred: PlanExpr): PlanOp => p.project(benches(), [ID, pred]);
const passing = (r: unknown[][]): unknown[] => r.filter((x) => x[1] === 1 || x[1] === true).map((x) => x[0]);

describe("a label's nodes", () => {
  it('are read from the graph index, in the order the label index gives them', () => {
    const db = open();
    const sql = "SELECT node FROM g_labels WHERE label = 'Bench'";
    expect(plan(db, sql)).toBe(LABEL_SCAN);
    expect(db.prepare(sql).usesGraphIndex).toBe(true);
    expect(db.query(sql).rows).toEqual(BENCHES.map((i) => [i]));
    expect(db.query("SELECT node, label FROM g_labels WHERE label = 'Other'").rows).toEqual(Array.from({ length: NODES / 5 }, (_, i) => [5 * i, 'Other']));
    expect(db.query("SELECT label, count(*), min(node), max(node) FROM g_labels WHERE label = 'Bench'").rows).toEqual([['Bench', BENCHES.length, 1, NODES - 1]]);
    // A label given as a parameter. One that no node has, or that is not text, has no entries.
    const byLabel = db.prepare('SELECT node FROM g_labels WHERE label = ?');
    expect(byLabel.result(['Other']).rows.length).toBe(NODES / 5);
    for (const label of ['bench', 'Nobody', '', null, 7, 7.5]) expect(byLabel.result([label]).rows, String(label)).toEqual([]);
    expect(state(db)).toMatchObject({ built: true, labels: BENCHES.length + NODES / 5, builds: 1 });
  });

  it('are found at any id, in id order', () => {
    const db = open();
    const far = [301, 31_999, 32_767, 32_768, 32_769, 65_535, 65_536, 1_000_000, 2 ** 31 - 1];
    addNodes(db, far, far.map((i) => ({ i })));
    db.query(`INSERT INTO g_labels SELECT id, 'Far' FROM node WHERE id > ${NODES}`);
    db.exec("INSERT INTO g_labels VALUES (0, 'Far'), (30, 'Far'), (31, 'Far'), (32, 'Far'), (63, 'Far'), (64, 'Far')");
    expect(db.query("SELECT node FROM g_labels WHERE label = 'Far'").rows).toEqual([0, 30, 31, 32, 63, 64, ...far].map((i) => [i]));
    expect(ids(db, found(cmp('cmp_ge', get('i'), p.lit(32_768)), p.lit('Far')))).toEqual(far.filter((i) => i >= 32_768));
  });

  it("leave a plan that reads an entry's rowid to the label index", () => {
    const db = open();
    const sql = "SELECT rowid, node FROM g_labels WHERE label = 'Other'";
    expect(db.query(sql).rows).toEqual(db.query("SELECT rowid, node FROM g_labels NOT INDEXED WHERE label = 'Other' ORDER BY node").rows);
    expect(db.query(sql).rows.length).toBe(NODES / 5);
    const byPlan = p.filter(p.scan('g_labels', [-1, 0, 1]), eq(p.col(0, 2, 'text'), p.lit('Other')));
    expect(rows(db, byPlan)).toEqual(db.query("SELECT rowid, node, label FROM g_labels NOT INDEXED WHERE label = 'Other' ORDER BY node").rows);
  });

  it('leave a plan that reads another column of an entry to the label index and the table', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE n(id INTEGER PRIMARY KEY); CREATE TABLE extra(id INTEGER PRIMARY KEY); CREATE TABLE more(id INTEGER PRIMARY KEY)');
    db.exec('CREATE TABLE labels(node INTEGER NOT NULL, label TEXT NOT NULL, note TEXT); CREATE UNIQUE INDEX labels_label ON labels(label, node); CREATE INDEX labels_node ON labels(node)');
    schema(db, { op: 'createPropertyGraph', ifNotExists: false, graph: { name: 'g', nodes: [{ label: 'N', table: 'n', id: 'id' }, { label: 'Extra', table: 'extra', id: 'id' }, { label: 'More', table: 'more', id: 'id' }], edges: [] } });
    schema(db, { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabelIndex', table: 'labels' } });
    db.exec('WITH RECURSIVE x(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM x WHERE i < 199) INSERT INTO n SELECT i FROM x');
    db.exec("INSERT INTO labels SELECT id, 'More', 'm' || id FROM n; INSERT INTO labels SELECT id, 'Extra', 'e' || id FROM n WHERE id % 50 = 7");
    // A scan that names the node and the label reads the label's set; one that names the note too reads the table.
    const extras = (columns: number[]): PlanOp => p.filter(p.scan('labels', columns), eq(p.col(0, 1, 'text'), p.lit('Extra')));
    expect(explain(db, extras([0, 1]))).toBe('SEARCH labels USING GRAPH INDEX (label=?)');
    expect(rows(db, extras([0, 1]))).toEqual([7, 57, 107, 157].map((i) => [i, 'Extra']));
    expect(explain(db, extras([0, 1, 2]))).not.toContain('GRAPH INDEX');
    expect(rows(db, extras([0, 1, 2]))).toEqual([7, 57, 107, 157].map((i) => [i, 'Extra', `e${i}`]));
  });

  it('are read from the table where the label index is keyed by node first', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE n(id INTEGER PRIMARY KEY); CREATE TABLE extra(id INTEGER PRIMARY KEY); CREATE TABLE more(id INTEGER PRIMARY KEY)');
    db.exec('CREATE TABLE labels(node INTEGER NOT NULL, label TEXT NOT NULL); CREATE UNIQUE INDEX labels_node ON labels(node, label)');
    schema(db, { op: 'createPropertyGraph', ifNotExists: false, graph: { name: 'g', nodes: [{ label: 'N', table: 'n', id: 'id' }, { label: 'Extra', table: 'extra', id: 'id' }, { label: 'More', table: 'more', id: 'id' }], edges: [] } });
    schema(db, { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabelIndex', table: 'labels' } });
    db.exec('WITH RECURSIVE x(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM x WHERE i < 199) INSERT INTO n SELECT i FROM x');
    db.exec("INSERT INTO labels SELECT id, 'More' FROM n; INSERT INTO labels SELECT id, 'Extra' FROM n WHERE id % 50 = 7");
    // The index holds the labels (a node is asked for a label there), and gives a node's labels, not a label's nodes.
    expect(plan(db, "SELECT 1 FROM labels WHERE node = 7 AND label = 'Extra'")).toBe('SEARCH labels USING GRAPH INDEX (node=? AND label=?)');
    expect(plan(db, 'SELECT label FROM labels WHERE node = 7')).toBe('SEARCH labels USING COVERING INDEX labels_node (=?)');
    expect(db.query('SELECT label FROM labels WHERE node = 7').rows).toEqual([['Extra'], ['More']]);
    expect(plan(db, "SELECT node FROM labels WHERE label = 'Extra'")).not.toContain('GRAPH INDEX');
    expect(db.query("SELECT node FROM labels WHERE label = 'Extra'").rows).toEqual([[7], [57], [107], [157]]);
  });

  it('are asked for by the label as the label index compares it', () => {
    const db = open();
    db.exec("INSERT INTO g_labels VALUES (1, '7'), (2, '7'), (8, '7')");
    // A number is compared with the label as text, as the index compares it: the label's set is asked for '7'.
    for (const sql of ["SELECT node FROM g_labels WHERE label = '7'", 'SELECT node FROM g_labels WHERE label = 7', "SELECT node FROM g_labels WHERE '7' = label"]) {
      expect(plan(db, sql), sql).toBe(LABEL_SCAN);
      expect(db.query(sql).rows, sql).toEqual([[1], [2], [8]]);
    }
    const byLabel = db.prepare('SELECT node FROM g_labels WHERE label = ?');
    expect(byLabel.result([7]).rows).toEqual([[1], [2], [8]]);
    // No label is NULL, whatever a label is called.
    db.exec("INSERT INTO g_labels VALUES (3, 'null')");
    expect([byLabel.result(['null']).rows, byLabel.result([null]).rows]).toEqual([[[3]], []]);
    expect(db.query("SELECT node FROM g_labels WHERE label = 'Other' COLLATE NOCASE AND node < 20").rows).toEqual([[0], [5], [10], [15]]);
    expect(db.query("SELECT count(*) FROM g_labels WHERE label = 'other' COLLATE NOCASE").rows).toEqual([[NODES / 5]]);
  });

  it('follow the labels given and taken, and a rollback', () => {
    const db = open();
    const others = (): unknown[] => db.query("SELECT node FROM g_labels WHERE label = 'Other'").rows.map((r) => r[0]);
    const was = others();
    db.exec("INSERT INTO g_labels VALUES (7, 'Other'), (299, 'Other'); DELETE FROM g_labels WHERE node = 10 AND label = 'Other'");
    expect(others()).toEqual([...was.filter((i) => i !== 10), 7, 299].sort((a, b) => (a as number) - (b as number)));
    db.exec("UPDATE g_labels SET label = 'Third' WHERE node = 20 AND label = 'Other'");
    expect([others().includes(20), db.query("SELECT node FROM g_labels WHERE label = 'Third'").rows]).toEqual([false, [[20]]]);
    expect(state(db).builds).toBe(1);
    const now = others();
    db.exec("BEGIN; DELETE FROM g_labels WHERE label = 'Other' AND node < 100; INSERT INTO g_labels VALUES (1, 'Other')");
    expect(others()).toEqual([1, ...now.filter((i) => (i as number) >= 100)]);
    db.exec('ROLLBACK');
    expect(others()).toEqual(now);
    // A label whose last node went has none, and is found again when a node gets it.
    db.exec("DELETE FROM g_labels WHERE label = 'Third'");
    expect(db.query("SELECT node FROM g_labels WHERE label = 'Third'").rows).toEqual([]);
    db.exec("INSERT INTO g_labels VALUES (21, 'Third')");
    expect(db.query("SELECT node FROM g_labels WHERE label = 'Third'").rows).toEqual([[21]]);
  });

  it('go on from after the last node given, in the label as it is then', () => {
    // The scan alone, over a set that is written between two of its rows.
    const labels = new GraphLabels();
    for (const node of [1, 5, 33, 40, 70_000]) labels.add('A', node);
    const access = { decode: [0, 0, 1, 1], rowidReg: -1, tableName: 'l' };
    const unused = { open: () => undefined, next: () => false, close: () => undefined };
    const scan = new GraphLabelEntries(access as never, unused as never, () => labels, { epoch: 1 }, { value: () => 'A', convert: (v) => v }, 0, 1, 'label');
    const r: SqlValue[] = [null, null];
    const next = (): SqlValue => (scan.next() ? r[0]! : null);
    scan.open(r);
    expect([next(), next(), r[1]]).toEqual([1, 5, 'A']);
    // A node that comes after the last one given is given in its place, one that comes before it is not, and one
    // that goes is not given: in the word the scan is in, in a later one, and in a page that was not there.
    for (const node of [3, 7, 34, 39, 100_000]) labels.add('A', node);
    labels.remove('A', 33);
    expect([next(), next(), next()]).toEqual([7, 34, 39]);
    labels.remove('A', 40);
    labels.add('A', 63);
    expect([next(), next(), next(), next(), next()]).toEqual([63, 70_000, 100_000, null, null]);
    // Opened again, it reads the label from its first node.
    scan.open(r);
    expect([next(), next(), next()]).toEqual([1, 3, 5]);
    // A label emptied under the scan ends it; given nodes again, it is read from the first of them.
    for (const node of [1, 3, 5, 7, 34, 39, 63, 70_000, 100_000]) labels.remove('A', node);
    expect([labels.count('A'), next()]).toEqual([0, null]);
    for (const node of [40_000, 200_000, 39_999]) labels.add('A', node);
    scan.open(r);
    expect([next(), next(), next(), next()]).toEqual([39_999, 40_000, 200_000, null]);
  });

  it('read the words between the lowest and the highest node of the label, and no other', () => {
    // The scan over a set whose pages tell which of their words were read.
    const labels = new GraphLabels();
    const read = new Set<number>();
    const told = (page: Uint32Array, at: number): Uint32Array =>
      new Proxy(page, { get: (t, k) => (typeof k === 'string' && /^\d+$/.test(k) ? (read.add(at * 1024 + Number(k)), t[Number(k)]) : Reflect.get(t, k)) });
    // And the set tells how many times a page was asked for.
    let asked = 0;
    const counted = (pages: (Uint32Array | undefined)[]): (Uint32Array | undefined)[] =>
      new Proxy(pages, { get: (t, k) => (typeof k === 'string' && /^-?\d+$/.test(k) ? (asked++, t[Number(k)]) : Reflect.get(t, k)) });
    const source = { setOf: (label: string) => ((set) => set && { ...set, pages: counted(set.pages.map((page, at) => page && told(page, at))), first: set.first, last: set.last })(labels.setOf(label)) };
    const access = { decode: [0, 0, 1, 1], rowidReg: -1, tableName: 'l' };
    const unused = { open: () => undefined, next: () => false, close: () => undefined };
    let label = 'A';
    const scan = new GraphLabelEntries(access as never, unused as never, () => source as never, { epoch: 1 }, { value: () => label, convert: (v) => v }, 0, 1, 'label');
    const r: SqlValue[] = [null, null];
    const all = (of = label): SqlValue[] => {
      const out: SqlValue[] = [];
      label = of;
      read.clear();
      asked = 0;
      scan.open(r);
      while (scan.next()) out.push(r[0]!);
      return out;
    };
    const words = (): number[] => [...read].sort((a, b) => a - b);
    // Eight nodes at the start of a page: its first word.
    for (let node = 0; node < 8; node++) labels.add('A', node);
    expect([all(), words()]).toEqual([[0, 1, 2, 3, 4, 5, 6, 7], [0]]);
    // Nodes in the middle of a page, over three words.
    for (const node of [20_008, 20_040, 20_079]) labels.add('B', node);
    expect([all('B'), words()]).toEqual([[20_008, 20_040, 20_079], [625, 626, 627]]);
    // The last word of a page and the first of the next; then a node four pages on: the pages between are not there.
    for (const node of [32_767, 32_768]) labels.add('C', node);
    expect([all('C'), words()]).toEqual([[32_767, 32_768], [1023, 1024]]);
    labels.add('C', 5 * 32_768 + 1);
    expect([all().length, words().length, words()[0], words().at(-1)]).toEqual([3, 1024 + 2, 1023, 5 * 1024]);
    // A page that is not there is passed in one step: a page is asked for once for each word read, once for each of
    // the three pages between, and once for each row given and for the end.
    expect(asked).toBe(1024 + 2 + 3 + 4);
  });

  it('are counted in the graph index for the plan, however many they are', () => {
    const db = open();
    // 2,000 nodes of a label, more than the planner counts in an index, among 20,000 of another.
    db.exec(`WITH RECURSIVE n(i) AS (SELECT ${NODES} UNION ALL SELECT i + 1 FROM n WHERE i < ${NODES + 19_999}) INSERT INTO node(id) SELECT i FROM n`);
    db.exec(`INSERT INTO g_labels SELECT id, 'Many' FROM node WHERE id >= ${NODES}`);
    db.exec(`INSERT INTO g_labels SELECT id, 'Few' FROM node WHERE id >= ${NODES} AND id % 10 = 0`);
    const scan = (label: string) => ran(db, p.project(p.filter(p.scan('g_labels', [0, 1]), eq(p.col(0, 1, 'text'), p.lit(label))), [p.col(0, 0, 'int')]))[0]!;
    // The label's own count where it is under what the table's statistics give a label (a quarter of the entries).
    expect(scan('Few')).toEqual({ detail: LABEL_SCAN, expected: 2000, loops: 1, rows: 2000 });
    expect(scan('Other')).toEqual({ detail: LABEL_SCAN, expected: NODES / 5, loops: 1, rows: NODES / 5 });
    // A label no node has is planned as one row, as an index with no entry for it is.
    expect(scan('Nobody')).toEqual({ detail: LABEL_SCAN, expected: 1, loops: 1, rows: 0 });
    // A count never raises the estimate: a label with more nodes than that keeps the statistics' number.
    const many = scan('Many');
    expect(many).toMatchObject({ detail: LABEL_SCAN, loops: 1, rows: 20_000 });
    expect(many.expected).toBeGreaterThan(2000);
    expect(many.expected).toBeLessThan(20_000);
    // So the nodes of the smaller label are found by the label.
    expect(explain(db, found(cmp('cmp_eq', get('i'), p.lit(-1)), p.lit('Few')))).toBe(`${CHECKED}\n${NODE_SCAN}`);
  });
});

describe("a label's nodes found in the node table", () => {
  const OPS = ['cmp_eq', 'cmp_ne', 'cmp_lt', 'cmp_le', 'cmp_gt', 'cmp_ge'];
  const KINDS = ['cmp_lt_kind', 'cmp_le_kind', 'cmp_gt_kind', 'cmp_ge_kind'];
  const LITS: SqlValue[] = [30, 31.5, -1, 'n30', 'N30', '30', 'Lisbon', 2n ** 60n + 17n];
  const KEYS = ['i', 'name', 'age', 'city', 'big', 'nope'];

  it('are checked on their props in memory before their row is asked for', () => {
    const db = open();
    const seven = benches(cmp('cmp_eq', get('i'), p.lit(7)));
    expect(explain(db, seven)).toBe(`${CHECKED}\n${NODE_SCAN}`);
    expect(db.preparePlan(seven).usesGraphIndex).toBe(true);
    expect(state(db).props).toBe(0);
    // The first run knows no row: each node of the label is read from the table, and is known from then on.
    expect(ran(db, seven)).toMatchObject([
      { detail: CHECKED, loops: 1, rows: BENCHES.length },
      { detail: NODE_SCAN, loops: BENCHES.length, rows: BENCHES.length },
    ]);
    expect(state(db).props).toBe(BENCHES.length);
    // From then on the label's scan gives the one node whose props can pass, and only its row is asked for.
    for (let again = 0; again < 2; again++) {
      expect(ran(db, seven)).toMatchObject([
        { detail: CHECKED, loops: 1, rows: 1 },
        { detail: NODE_SCAN, loops: 1, rows: 1 },
      ]);
    }
    expect(rows(db, seven)).toEqual([[7, 'Bench', 7, props(7)]]);
    expect(state(db)).toMatchObject({ built: true, props: BENCHES.length, builds: 1 });
    // Each conjunct's conditions are checked: a key that every node has, and the one value of it.
    const both = benches(p.and(p.call('map_contains_key', [PROPS, p.lit('name')], 'bool'), cmp('cmp_eq', get('i'), p.lit(8))));
    expect(ran(db, both)).toMatchObject([{ detail: CHECKED, rows: 1 }, { detail: NODE_SCAN, loops: 1, rows: 1 }]);
    // Without a condition on the props there is nothing to check: every node of the label is given.
    expect(explain(db, benches())).toBe(`${LABEL_SCAN}\n${NODE_SCAN}`);
    expect(rows(db, benches())).toEqual(BENCHES.map((i) => [i, 'Bench', i, props(i)]));
    // A condition on the node's id is none on its props.
    expect(explain(db, benches(cmp('cmp_lt', ID, p.lit(10))))).not.toContain('CHECKING');
    expect(ids(db, p.project(benches(cmp('cmp_lt', ID, p.lit(10))), [ID]))).toEqual([1, 2, 4, 5, 7, 8]);
  });

  it('are the nodes the conjunct keeps, whatever it compares a property with', { timeout: 30_000 }, () => {
    const db = open();
    const preds: PlanExpr[] = [];
    for (const k of KEYS) {
      for (const fn of [...OPS, ...KINDS])
        for (const v of LITS) {
          preds.push(cmp(fn, get(k), p.lit(v)));
          preds.push(cmp(fn, p.lit(v), get(k)));
        }
      preds.push(
        p.not(p.isNull(get(k))),
        { k: 'isNull', arg: get(k), not: true } as PlanExpr,
        p.isNull(get(k)),
        p.call('map_contains_key', [PROPS, p.lit(k)], 'bool'),
        p.not(p.call('map_contains_key', [PROPS, p.lit(k)], 'bool')),
      );
    }
    preds.push(
      cmp('cmp_eq', get('name'), p.lit('N30'), 'nocase'),
      p.and(p.call('map_contains_key', [PROPS, p.lit('city')], 'bool'), cmp('cmp_gt', get('age'), p.lit(30))),
      p.and(cmp('cmp_eq', get('city'), p.lit('Oslo')), cmp('cmp_ge_kind', get('i'), p.lit(100)), cmp('cmp_eq', get('flag'), p.lit(1))),
      cmp('cmp_eq', get('flag'), p.lit(0)),
      p.not(p.isNull(get('title'))),
      p.isNull(get('title')),
      p.call('map_contains_key', [PROPS, p.lit('title')], 'bool'),
      p.caseWhen([{ when: p.call('map_contains_key', [PROPS, p.lit('city')], 'bool'), then: cmp('cmp_ge', get('age'), p.lit(30)) }], 'bool'),
      p.caseWhen([{ when: p.call('map_contains_key', [PROPS, p.lit('city')], 'bool'), then: cmp('cmp_ge', get('age'), p.lit(30)) }], 'bool', p.lit(1)),
      p.or(cmp('cmp_eq', get('name'), p.lit('n31')), cmp('cmp_eq', get('age'), p.lit(30))),
      p.isNull(PROPS),
      p.not(p.isNull(PROPS)),
    );
    const same = (pred: PlanExpr): void => {
      const want = passing(rows(db, each(pred)));
      expect(ids(db, found(pred)), JSON.stringify(pred, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).toEqual(want);
    };
    // With no row known, each is read from the table: the rows read by a transaction that wrote are not known once it
    // is undone.
    preds.forEach((pred, k) => {
      if (k % 9 !== 0) return;
      db.exec('BEGIN');
      addNodes(db, [5000], [null]);
      expect(ids(db, found(pred))).toEqual(passing(rows(db, each(pred))));
      expect(state(db).props).toBe(BENCHES.length);
      db.exec('ROLLBACK');
      expect(state(db).props).toBe(0);
    });
    // With every row of the label known: every conjunct.
    for (const pred of preds) same(pred);
    expect(state(db).props).toBe(BENCHES.length);
    expect(rows(db, counted(preds[0]!))).toEqual([[passing(rows(db, each(preds[0]!))).length]]);
    // A comparison, a key that must be there and an AND of them are conditions the props are checked for; an OR, an
    // IS NULL and a NOT of a key that must be there are not.
    const isChecked = (pred: PlanExpr): boolean => explain(db, found(pred)).includes('CHECKING');
    expect([cmp('cmp_ne', get('age'), p.lit(30)), cmp('cmp_le_kind', p.lit('n30'), get('name')), p.not(p.isNull(get('title'))), p.call('map_contains_key', [PROPS, p.lit('city')], 'bool')].map(isChecked)).toEqual([true, true, true, true]);
    expect(isChecked(p.and(cmp('cmp_eq', get('city'), p.lit('Oslo')), p.isNull(get('big'))))).toBe(true);
    expect([p.isNull(get('age')), p.or(cmp('cmp_eq', get('name'), p.lit('n31')), cmp('cmp_eq', get('age'), p.lit(30))), p.not(p.call('map_contains_key', [PROPS, p.lit('city')], 'bool')), p.isNull(PROPS)].map(isChecked)).toEqual([false, false, false, false]);
  });

  it('are checked against a parameter as against a literal, with the value of each run', { timeout: 30_000 }, () => {
    const db = open();
    const TYPES: PlanType[] = ['any', 'int', 'real', 'num', 'text', 'bool'];
    const VALUES: SqlValue[] = [...LITS, null, NaN, 2 ** 60, 1, 5, 100, 'n45', 'N45', ''];
    // The nodes of the smaller label, each read once so that they are known.
    const others = (pred?: PlanExpr): PlanOp => labelled(p.lit('Other'), pred);
    rows(db, others());
    let checked = 0;
    for (const k of ['i', 'name', 'age'])
      for (const fn of [...OPS, 'cmp_lt_kind', 'cmp_ge_kind'])
        for (const type of TYPES)
          // Either way round, and where the comparison takes a collation, ignoring case: then text is not checked.
          for (const pred of [cmp(fn, get(k), p.param(0, type)), cmp(fn, p.param(0, type), get(k)), ...(OPS.includes(fn) ? [cmp(fn, get(k), p.param(0, type), 'nocase')] : [])]) {
            const all = db.preparePlan(p.project(others(), [ID, pred]));
            const kept = db.preparePlan(p.project(others(pred), [ID]));
            for (const v of VALUES) {
              expect(kept.result([v]).rows.map((r) => r[0]), `${k} ${fn} ${type} ${String(v)}`).toEqual(passing(all.result([v]).rows));
              checked++;
            }
          }
    expect(checked).toBe(3 * (6 * 3 + 2 * 2) * 6 * VALUES.length);
    // One statement, a value each run: the label given as a parameter too.
    const st = db.preparePlan(found(cmp('cmp_eq', get('i'), p.param(0, 'any')), p.param(1, 'text')));
    expect(explain(db, found(cmp('cmp_eq', get('i'), p.param(0, 'any')), p.param(1, 'text')), [7, 'Bench'])).toBe(`${CHECKED}\n${NODE_SCAN}`);
    expect([st.result([7, 'Bench']).rows, st.result([8, 'Bench']).rows, st.result([10, 'Bench']).rows, st.result([10, 'Other']).rows, st.result([9, 'Bench']).rows, st.result(['7', 'Bench']).rows, st.result([7, 'Nobody']).rows]).toEqual([[[7]], [[8]], [[10]], [[10]], [], [], []]);
    // The props are checked against the run's value: one node of the label is given, and its row asked for.
    rows(db, benches());
    const byParam = found(cmp('cmp_eq', get('i'), p.param(0, 'any')), p.param(1, 'text'));
    for (const i of [7, 8, 298]) expect(ran(db, byParam, [i, 'Bench'])).toMatchObject([{ detail: CHECKED, rows: 1 }, { detail: NODE_SCAN, loops: 1, rows: 1 }]);
    // A value the props cannot be checked against (it is compared as text is, and the check is of numbers) leaves
    // every node that has the key to the conjunct.
    expect(ran(db, byParam, [null, 'Bench'])[0]!.rows).toBe(BENCHES.filter((i) => props(i) !== null && 'i' in props(i)!).length);
  });

  it('follow the props written, the nodes that come and go, and a rollback', () => {
    const db = open();
    const sevens = found(cmp('cmp_eq', get('i'), p.lit(7)));
    expect(ids(db, sevens)).toEqual([7]);
    expect(state(db).props).toBe(BENCHES.length);
    // A known row whose props change is checked on its new map; one whose props go has none to pass with.
    setProps(db, [8, 10], [{ i: 7, name: 'eight' }, { i: 7 }]);
    expect(ids(db, sevens)).toEqual([7, 8, 10]);
    db.exec('UPDATE node SET props = NULL WHERE id = 7');
    expect(ids(db, sevens)).toEqual([8, 10]);
    setProps(db, [8], [{ i: 8 }]);
    expect(ids(db, sevens)).toEqual([10]);
    // A node that comes is not known: it is read from the table. One that goes takes its label with it.
    addNodes(db, [1000, 1001], [{ i: 7 }, { i: 7 }]);
    db.exec("INSERT INTO g_labels VALUES (1000, 'Bench')");
    expect(ids(db, sevens)).toEqual([10, 1000]);
    db.exec("INSERT INTO g_labels VALUES (1001, 'Bench'); DELETE FROM knows WHERE start = 10 OR end = 10; DELETE FROM node WHERE id = 10");
    expect(ids(db, sevens)).toEqual([1000, 1001]);
    db.exec("DELETE FROM g_labels WHERE node = 1000 AND label = 'Bench'");
    expect(ids(db, sevens)).toEqual([1001]);
    // Inside a transaction, and after it is undone.
    db.exec('BEGIN');
    setProps(db, [1001, 11], [{ i: 0 }, { i: 7 }]);
    expect(ids(db, sevens)).toEqual([11]);
    db.exec('ROLLBACK');
    expect(ids(db, sevens)).toEqual([1001]);
    db.exec('BEGIN');
    setProps(db, [11], [{ i: 7 }]);
    db.exec('COMMIT');
    expect(ids(db, sevens)).toEqual([11, 1001]);
  });

  it('are read as before where the join is an outer join, or the node is not found by the label', () => {
    const db = open();
    const pred = cmp('cmp_eq', get('i'), p.lit(7));
    // An outer join gives every node of the label, with no row where its props do not pass: none may be left out.
    const on = p.and(eq(p.col(1, 0, 'int'), p.col(0, 0, 'int')), cmp('cmp_eq', p.call('map_get', [p.col(1, 1, M), p.lit('i')], 'any'), p.lit(7)));
    const left = p.filter(p.join('left', p.scan('g_labels', [0, 1]), p.scan('node', [0, 1]), on), eq(LABEL, p.lit('Bench')));
    expect(explain(db, left)).toBe(`LEFT JOIN\n${LABEL_SCAN}\n${NODE_SCAN}`);
    for (let again = 0; again < 2; again++) expect(rows(db, left)).toEqual(BENCHES.map((i) => (i === 7 ? [7, 'Bench', 7, props(7)] : [i, 'Bench', null, null])));
    // A node found by something else than the entry's node is not the label's node: by a sum, and by the label.
    const other = p.filter(joined(), p.and(eq(LABEL, p.lit('Bench')), eq(ID, p.call('add', [NODE, p.lit(3)], 'int')), pred));
    expect(explain(db, other)).not.toContain('CHECKING');
    expect(ids(db, p.project(other, [ID]))).toEqual([7]);
    db.exec("INSERT INTO g_labels VALUES (1, '7'), (2, '7'), (8, '7')");
    const byLabel = p.filter(joined(), p.and(eq(LABEL, p.lit('7')), eq(ID, LABEL), pred));
    expect(explain(db, byLabel)).toBe(`${LABEL_SCAN}\n${NODE_SCAN}`);
    for (let again = 0; again < 2; again++) expect(rows(db, p.project(byLabel, [NODE, ID]))).toEqual([[1, 7], [2, 7], [8, 7]]);
    // A condition that reads a subquery is its filter's alone, beside one the props are checked for or without one.
    const seven = p.scalar(p.values([[p.lit(7)]]), 'int');
    expect(explain(db, benches(cmp('cmp_eq', get('i'), seven)))).not.toContain('CHECKING');
    expect(ids(db, p.project(benches(cmp('cmp_eq', get('i'), seven)), [ID]))).toEqual([7]);
    const both = benches(p.and(cmp('cmp_eq', get('i'), seven), cmp('cmp_lt', get('age'), p.lit(40))));
    expect(explain(db, both)).toContain('CHECKING');
    expect(ids(db, p.project(both, [ID]))).toEqual([7]);
    // Two labels: the second is asked of each node the first gives.
    const two = p.filter(p.join('cross', joined(), p.scan('g_labels', [0, 1])), p.and(eq(LABEL, p.lit('Other')), eq(ID, NODE), eq(p.col(0, 4, 'int'), NODE), eq(p.col(0, 5, 'text'), p.lit('Bench')), cmp('cmp_gt', get('i'), p.lit(250))));
    expect(ids(db, p.project(two, [ID]))).toEqual(BENCHES.filter((i) => isOther(i) && ((props(i) as { i?: number } | null)?.i ?? 0) > 250));
    expect(ids(db, p.project(two, [ID])).length).toBe(5);
  });

  it('are read from the tables with graph indexes off, on a reader, and where the property maps do not fit', async () => {
    const pred = cmp('cmp_ge_kind', get('age'), p.lit(60));
    const want = BENCHES.filter((i) => {
      const m = props(i);
      return m !== null && typeof m.age === 'number' && m.age >= 60;
    });
    expect(want.length).toBeGreaterThan(10);
    const off = open({ graphIndexMem: 0 });
    expect(explain(off, found(pred))).not.toContain('GRAPH INDEX');
    expect(ids(off, found(pred))).toEqual(want);
    const vfs = new MemoryVfs();
    const owner = graph(await Database.open(vfs, 'db', { sharedHandles: true }));
    const reader = await Database.openReader(vfs, 'db');
    expect(explain(owner, found(pred))).toBe(`${CHECKED}\n${NODE_SCAN}`);
    expect(explain(reader, found(pred))).not.toContain('GRAPH INDEX');
    expect([ids(owner, found(pred)), ids(reader, found(pred))]).toEqual([want, want]);
    // Room for the lists and the labels, and not for a page of the nodes' maps: every row is read from the table.
    const lists = open();
    ids(lists, p.project(p.filter(p.scan('g_labels', [0, 1]), eq(p.col(0, 1, 'text'), p.lit('Bench'))), [p.col(0, 0, 'int')]));
    const tight = open({ graphIndexMem: state(lists).bytes + 1024 });
    expect(explain(tight, found(pred))).toBe(`${CHECKED}\n${NODE_SCAN}`);
    for (let again = 0; again < 2; again++) {
      expect(ids(tight, found(pred))).toEqual(want);
      expect(state(tight)).toMatchObject({ built: true, off: null, props: 0 });
    }
  });
});
