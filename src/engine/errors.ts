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
