/** Text form of plan expressions, for tests, debugging and (later) EXPLAIN. */
import type { SqlValue } from '../values.js';
import type { BoundExpr } from './expr.js';
import type { PlanOp } from './ops.js';

function literal(v: SqlValue): string {
  if (v === null) return 'NULL';
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  if (v instanceof Uint8Array) return `X'${Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()}'`;
  return String(v);
}

/**
 * `#input.index` for a column (with `^depth` when it reads an enclosing operation), `$n` for a parameter, and
 * `fn(args)` for calls, with `[collation]` when one is set.
 */
export function printExpr(e: BoundExpr): string {
  switch (e.k) {
    case 'col':
      return `#${e.input}.${e.index}${e.depth ? `^${e.depth}` : ''}`;
    case 'lit':
      return literal(e.value);
    case 'param':
      return `$${e.index}`;
    case 'call':
      return `${e.fn}(${e.args.map(printExpr).join(', ')})${e.collation && e.collation !== 'binary' ? `[${e.collation}]` : ''}`;
    case 'cast':
      return `${e.fn}(${printExpr(e.arg)})`;
    case 'and':
    case 'or':
      return `(${e.args.map(printExpr).join(` ${e.k} `)})`;
    case 'not':
      return `not ${printExpr(e.arg)}`;
    case 'isNull':
      return `${printExpr(e.arg)} is${e.not ? ' not' : ''} null`;
    case 'case':
      return `case ${e.whens.map((w) => `when ${printExpr(w.when)} then ${printExpr(w.then)}`).join(' ')} else ${printExpr(e.else)} end`;
    case 'subquery':
      return `${e.mode}(<${e.plan.op}>)`;
    case 'inSubquery':
      return `${printExpr(e.probe)} in (<${e.plan.op}>)`;
    case 'each': {
      const aggs = (e.aggs ?? []).map((a) => `${a.fn}(${a.distinct ? 'distinct ' : ''}${a.star ? '*' : a.args.map(printExpr).join(', ')})${a.filter ? ` filter ${printExpr(a.filter)}` : ''}`);
      return `each ${e.mode}(${printExpr(e.list)}${aggs.length ? ` aggs [${aggs.join(', ')}]` : ''}: ${printExpr(e.body)})`;
    }
    case 'element':
      return `@${e.part === 'value' ? 'value' : 'position'}${e.depth ? `^${e.depth}` : ''}`;
    case 'eachAgg':
      return `@agg${e.index}${e.depth ? `^${e.depth}` : ''}`;
    case 'slot':
      return `r${e.reg}`;
    case 'native':
      return '<compiled>';
  }
}

/** Indented text form of a plan, one operation per line, for tests and debugging. */
export function printPlan(op: PlanOp, depth = 0): string {
  const pad = '  '.repeat(depth);
  const list = (xs: readonly BoundExpr[]): string => xs.map(printExpr).join(', ');
  const sub = (o: PlanOp): string => printPlan(o, depth + 1);
  switch (op.op) {
    case 'scan':
      return `${pad}scan ${op.db ? `${op.db}.` : ''}${op.table} [${op.columns.join(', ')}]`;
    case 'source':
      return `${pad}${op.kind} ${op.schema ? `${op.schema}.` : ''}${op.name}(${[list(op.args), ...Object.entries(op.named ?? {}).map(([k, e]) => `${k} => ${printExpr(e)}`)].filter((x) => x).join(', ')})`;
    case 'iterate':
      return [`${pad}iterate #${op.id}${op.distinct ? ' distinct' : ''}${op.limit ? ` limit ${printExpr(op.limit)}` : ''}`, sub(op.init), ...op.steps.map(sub)].join('\n');
    case 'working':
      return `${pad}working #${op.id}`;
    case 'values':
      if (op.columns) return `${pad}values columns [${op.types.join(', ')}]`;
      return `${pad}values ${op.rows.map((r) => `(${list(r)})`).join(', ')}`;
    case 'filter':
      return `${pad}filter ${printExpr(op.pred)}\n${sub(op.input)}`;
    case 'project':
      return `${pad}project ${list(op.exprs)}\n${sub(op.input)}`;
    case 'limit':
      return `${pad}limit ${printExpr(op.count)}${op.offset ? ` offset ${printExpr(op.offset)}` : ''}\n${sub(op.input)}`;
    case 'join':
      return `${pad}join ${op.kind}${op.on ? ` on ${printExpr(op.on)}` : ''}\n${sub(op.inputs[0])}\n${sub(op.inputs[1])}`;
    case 'setop':
      return `${pad}${op.kind}\n${sub(op.inputs[0])}\n${sub(op.inputs[1])}`;
    case 'sort':
      return `${pad}sort ${op.keys.map((k) => `${printExpr(k.expr)}${k.desc ? ' desc' : ''}${k.collation !== 'binary' ? ` [${k.collation}]` : ''}`).join(', ')}\n${sub(op.input)}`;
    case 'aggregate': {
      const aggs = op.aggs.map((a) => `${a.fn}(${a.distinct ? 'distinct ' : ''}${a.star ? '*' : list(a.args)})${a.filter ? ` filter ${printExpr(a.filter)}` : ''}`);
      return `${pad}aggregate keys [${op.keys.map((k) => printExpr(k.expr)).join(', ')}] aggs [${aggs.join(', ')}]${op.carry.length ? ` carry [${list(op.carry)}]` : ''}\n${sub(op.input)}`;
    }
    case 'sample':
      return `${pad}sample ${op.count ? printExpr(op.count) : `fraction ${printExpr(op.fraction!)}`}${op.replace ? ' with replacement' : ''} seed ${op.seed}\n${sub(op.input)}`;
    case 'pivot':
      return `${pad}pivot ${printExpr(op.on)} in (${op.values.map((v) => JSON.stringify(typeof v === 'bigint' ? String(v) : v)).join(', ')}) by [${op.keys.map((k) => printExpr(k.expr)).join(', ')}]\n${sub(op.input)}`;
    case 'explode':
      return `${pad}explode ${op.column} ${op.type}${(op.also ?? []).map((a) => `, ${a.column} ${a.type}`).join('')}${op.position ? ' with position' : ''}\n${sub(op.input)}`;
    case 'unpivot':
      return `${pad}unpivot keep [${op.keep.join(', ')}] columns [${op.columns.map((c, i) => `${c} as ${JSON.stringify(op.names[i])}`).join(', ')}]\n${sub(op.input)}`;
    case 'distinct':
      return `${pad}distinct\n${sub(op.input)}`;
    case 'append':
      return `${pad}append ${op.db}.${op.table} [${op.columns.join(', ')}]${op.upserts.length ? ` upserts ${op.upserts.length}` : ''}${op.returning ? ` returning ${list(op.returning)}` : ''}${op.input ? `\n${sub(op.input)}` : ''}`;
    case 'update':
      return `${pad}update ${op.db}.${op.table} rowid #0.${op.rowid} set ${op.sets.map((x) => `${x.column} = ${printExpr(x.value)}`).join(', ')}${op.returning ? ` returning ${list(op.returning)}` : ''}\n${sub(op.input)}`;
    case 'delete':
      return `${pad}delete ${op.db}.${op.table} rowid #0.${op.rowid}${op.returning ? ` returning ${list(op.returning)}` : ''}\n${sub(op.input)}`;
    case 'window': {
      const calls = op.calls.map((c) => `${c.fn}(${c.star ? '*' : list(c.args)})`).join(', ');
      const part = op.partition.length ? ` partition [${list(op.partition.map((p) => p.expr))}]` : '';
      const order = op.order.length ? ` order [${op.order.map((k) => `${printExpr(k.expr)}${k.desc ? ' desc' : ''}`).join(', ')}]` : '';
      return `${pad}window [${calls}]${part}${order} ${op.frame.unit} ${op.frame.start.kind}..${op.frame.end.kind}\n${sub(op.input)}`;
    }
  }
}
