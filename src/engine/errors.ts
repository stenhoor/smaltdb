/** Base class for all smaltdb engine errors. `code` mirrors SQLite result-code names where one fits. */
export class SmaltError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SmaltError';
  }
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
