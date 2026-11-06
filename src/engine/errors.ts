/**
 * What an error is about, as fields a language words for its users (ADR 0016 section 10): the `origin` of the plan
 * node it arose in, and for a constraint, which one, on which table and columns.
 */
export interface ErrorDetails {
  /** The `origin` of the plan node the error arose in (the innermost one that has an origin), as the language gave it. */
  origin?: unknown;
  /** The constraint that failed. */
  constraint?: 'notNull' | 'unique' | 'primaryKey' | 'check' | 'foreignKey' | 'datatype';
  /** The table it is on. */
  table?: string;
  /** The columns it covers (an index on expressions: none). */
  columns?: readonly string[];
  /** The constraint's or index's name, where it has one. */
  name?: string;
}

/** Base class for all smaltdb engine errors. `code` mirrors SQLite result-code names where one fits. */
export class SmaltError extends Error {
  /** {@link ErrorDetails} `origin`. */
  origin?: unknown;
  /** {@link ErrorDetails} `constraint`. */
  constraint?: ErrorDetails['constraint'];
  /** {@link ErrorDetails} `table`. */
  table?: string;
  /** {@link ErrorDetails} `columns`. */
  columns?: readonly string[];
  /** {@link ErrorDetails} `name` (`name` itself is the error class's name). */
  constraintName?: string;
  constructor(
    readonly code: string,
    message: string,
    details?: ErrorDetails,
  ) {
    super(message);
    this.name = 'SmaltError';
    if (details) withDetails(this, details);
  }
}

/**
 * `err` with `details` set where it has none of its own (an error keeps the innermost origin it was given). Returns
 * `err`.
 */
export function withDetails<E>(err: E, details: ErrorDetails): E {
  if (!(err instanceof SmaltError)) return err;
  if (details.origin !== undefined && err.origin === undefined) err.origin = details.origin;
  if (details.constraint !== undefined && err.constraint === undefined) err.constraint = details.constraint;
  if (details.table !== undefined && err.table === undefined) err.table = details.table;
  if (details.columns !== undefined && err.columns === undefined) err.columns = details.columns;
  if (details.name !== undefined && err.constraintName === undefined) err.constraintName = details.name;
  return err;
}

/** `err`'s details as plain data (for the worker protocol), or undefined when it has none. */
export function errorDetails(err: unknown): ErrorDetails | undefined {
  if (!(err instanceof SmaltError)) return undefined;
  const d: ErrorDetails = {
    ...(err.origin !== undefined ? { origin: err.origin } : {}),
    ...(err.constraint !== undefined ? { constraint: err.constraint } : {}),
    ...(err.table !== undefined ? { table: err.table } : {}),
    ...(err.columns !== undefined ? { columns: [...err.columns] } : {}),
    ...(err.constraintName !== undefined ? { name: err.constraintName } : {}),
  };
  return Object.keys(d).length > 0 ? d : undefined;
}

export class CorruptionError extends SmaltError {
  constructor(message: string) {
    super('SMALT_CORRUPT', message);
    this.name = 'CorruptionError';
  }
}

export class MisuseError extends SmaltError {
  constructor(message: string) {
    super('SMALT_MISUSE', message);
    this.name = 'MisuseError';
  }
}

/**
 * The error code to report for `err`: a SmaltError's code, or a `SMALT_…` code that a plugin's error
 * carries (plugins cannot create SmaltErrors: they import nothing from the engine at run time).
 */
export function errorCode(err: unknown): string {
  if (err instanceof SmaltError) return err.code;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('SMALT_') ? code : 'SMALT_INTERNAL';
}
