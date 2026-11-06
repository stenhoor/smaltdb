/**
 * Builders for every operation (ADR 0016 section 5): window, frames and window calls, source, iterate and working
 * build the objects a plan holds, and plans built with them run.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';

function db(): Database {
  const d = Database.openMemory();
  d.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, g TEXT, v INT); INSERT INTO t VALUES (1, 'a', 1), (2, 'a', 2), (3, 'b', 3), (4, 'b', 4), (5, 'b', 5)");
  return d;
}
const id = p.col(0, 0, 'int');
const g = p.col(0, 1, 'text');
const v = p.col(0, 2, 'int');

describe('builders', () => {
  it('window: running sums, ranks and frames', () => {
    const d = db();
    const w = p.window(p.scan('t', [0, 1, 2]), [p.windowCall('sum', [v], 'int'), p.windowCall('row_number', [], 'int'), p.windowCall('lag', [v], 'int', { ignoreNulls: true })], { partition: [g], order: [p.asc(id)] });
    expect(w.frame).toEqual({ unit: 'RANGE', start: { kind: 'unboundedPreceding' }, end: { kind: 'currentRow' }, exclude: 'NO OTHERS' });
    expect(d.queryPlan(p.sort(p.project(w, [id, p.col(0, 3, 'int'), p.col(0, 4, 'int'), p.col(0, 5, 'int')]), [p.asc(id)])).rows).toEqual([
      [1, 1, 1, null], [2, 3, 2, 1], [3, 3, 1, null], [4, 7, 2, 3], [5, 12, 3, 4],
    ]);
    const moving = p.window(p.scan('t', [0, 2]), [p.windowCall('sum', [p.col(0, 1, 'int')], 'int')], { order: [p.asc(id)], frame: p.frame('ROWS', p.preceding(1), p.following(1)) });
    expect(d.queryPlan(p.project(moving, [p.col(0, 2, 'int')])).rows.map((r) => r[0])).toEqual([3, 6, 9, 12, 9]);
    // As SQL builds the same window.
    expect(d.query('SELECT sum(v) OVER (PARTITION BY g ORDER BY id) FROM t ORDER BY id').rows.map((r) => r[0])).toEqual([1, 3, 3, 7, 12]);
  });

  it('source, iterate and working', () => {
    const d = db();
    expect(p.source('function', 'pragma_table_info', [p.lit('t')], Array(6).fill('any'))).toEqual({ op: 'source', kind: 'function', name: 'pragma_table_info', args: [p.lit('t')], types: Array(6).fill('any') });
    const info = p.source('function', 'pragma_table_info', [p.lit('t')], Array(6).fill('any'));
    expect(d.queryPlan(p.project(info, [p.col(0, 1, 'text')])).rows).toEqual([['id'], ['g'], ['v']]);
    // 1, 2, … 5: each step adds one to the row before it.
    const count = p.iterate(1, 'n', p.values([[p.lit(1)]], ['int']), [p.filter(p.project(p.working(1, ['int']), [p.call('add', [p.col(0, 0, 'int'), p.lit(1)], 'int')]), p.call('cmp_le', [p.col(0, 0, 'int'), p.lit(5)], 'int'))]);
    expect(d.queryPlan(count).rows).toEqual([[1], [2], [3], [4], [5]]);
    expect(d.queryPlan(p.iterate(2, 'n', p.values([[p.lit(1)]], ['int']), [p.project(p.working(2, ['int']), [p.call('add', [p.col(0, 0, 'int'), p.lit(1)], 'int')])], { limit: 3 })).rows).toEqual([[1], [2], [3]]);
  });
});
