/** Base class for every error this package raises. */
export class KodakError extends Error {
  public override readonly name: string = 'KodakError';

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** A frame could not be decoded, or arrived truncated or malformed. */
export class ProtocolError extends KodakError {
  public override readonly name = 'ProtocolError';
}

/** The transport failed to open, closed unexpectedly, or timed out. */
export class TransportError extends KodakError {
  public override readonly name = 'TransportError';
}

/** An optional native dependency needed by a transport is not installed. */
export class MissingDependencyError extends KodakError {
  public override readonly name = 'MissingDependencyError';

  public constructor(
    public readonly packageName: string,
    public readonly purpose: string,
    options?: { cause?: unknown },
  ) {
    super(
      `The optional dependency "${packageName}" is required for ${purpose}. ` +
        `Install it, for example: pnpm add ${packageName}`,
      options,
    );
  }
}

/** The printer reported an error condition during a job. */
export class PrinterError extends KodakError {
  public override readonly name = 'PrinterError';

  public constructor(
    message: string,
    public readonly code: number,
    public readonly detail: number,
  ) {
    super(message);
  }
}

/** An operation exceeded its allotted time. */
export class TimeoutError extends KodakError {
  public override readonly name = 'TimeoutError';
}
