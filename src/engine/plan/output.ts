/**
 * The plan types of an operation's output columns, read from the plan (ADR 0016 section 8): the types written on its
 * expressions, a source's or `values`' declared types, and a scanned table's column types. Results carry them, so a
 * statement given without column descriptions still says what each column holds.
 */
import { typeOf } from './expr.js';
import type { PlanOp } from './ops.js';
import type { PlanType } from './types.js';

/** A table's column plan types, by name and schema; undefined when there is no such table. */
export type TableTypes = (table: string, db?: 'main' | 'temp') => readonly PlanType[] | undefined;

/** The plan type of each output column of `op` (a valid plan). */
export function outputTypes(op: PlanOp, tableTypes: TableTypes): PlanType[] {
  switch (op.op) {
    case 'scan': {
      const t = tableTypes(op.table, op.db);
      return op.columns.map((i) => (i < 0 ? 'int' : (t?.[i] ?? 'any')));
    }
    case 'source':
    case 'working':
    case 'values':
      return [...op.types];
    case 'iterate':
      return outputTypes(op.init, tableTypes);
    case 'filter':
    case 'sample':
    case 'sort':
    case 'limit':
    case 'distinct':
      return outputTypes(op.input, tableTypes);
    case 'project':
      return op.exprs.map(typeOf);
    case 'join': {
      const left = outputTypes(op.inputs[0], tableTypes);
      return op.kind === 'semi' || op.kind === 'anti' ? left : [...left, ...outputTypes(op.inputs[1], tableTypes)];
    }
    case 'setop': {
      const left = outputTypes(op.inputs[0], tableTypes);
      const right = outputTypes(op.inputs[1], tableTypes);
      return left.map((t, i) => (t === right[i] ? t : 'any'));
    }
    case 'pivot':
      return [...op.keys.map((k) => typeOf(k.expr)), ...op.values.flatMap(() => op.aggs.map((a) => a.type))];
    case 'unpivot': {
      const t = outputTypes(op.input, tableTypes);
      return [...op.keep.map((i) => t[i]), 'text', op.type];
    }
    case 'aggregate':
      return [...op.keys.map((k) => typeOf(k.expr)), ...op.aggs.map((a) => a.type), ...op.carry.map(typeOf)];
    case 'window':
      return [...outputTypes(op.input, tableTypes), ...op.calls.map((c) => c.type)];
    case 'append':
    case 'update':
    case 'delete':
      return (op.returning ?? []).map(typeOf);
    default:
      return [];
  }
}
