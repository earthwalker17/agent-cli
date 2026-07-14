/**
 * Typed error classes. Every failure the kernel can produce has an explicit type so
 * callers branch on the class, never on a message string (constitution: make failure
 * states explicit; do not convert failure into success through prose).
 */

/** A tool's input failed schema validation. Returned to the model as an error result. */
export class ToolInputError extends Error {
  override readonly name = 'ToolInputError';
  constructor(
    message: string,
    readonly toolName: string,
  ) {
    super(message);
  }
}

/** A path escaped the workspace boundary or hit a protected/invalid target. */
export class PathError extends Error {
  override readonly name = 'PathError';
  constructor(
    message: string,
    readonly rule: string,
  ) {
    super(message);
  }
}

/** The session's event log is held by a live process. */
export class SessionLockedError extends Error {
  override readonly name = 'SessionLockedError';
  constructor(
    message: string,
    readonly holderPid: number,
  ) {
    super(message);
  }
}

/** A non-final line of the event log is not valid JSON — refuse rather than silently repair. */
export class CorruptLogError extends Error {
  override readonly name = 'CorruptLogError';
  constructor(
    message: string,
    readonly lineNumber: number,
  ) {
    super(message);
  }
}

/** The event log was written by a newer schema version; refuse to read (never truncate). */
export class SchemaVersionError extends Error {
  override readonly name = 'SchemaVersionError';
  constructor(
    message: string,
    readonly foundVersion: number,
    readonly supportedVersion: number,
  ) {
    super(message);
  }
}

/** A pre-mutation snapshot could not be captured; the mutation must not proceed silently. */
export class SnapshotError extends Error {
  override readonly name = 'SnapshotError';
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
  }
}

/** Configuration or environment is unusable (e.g. state dir resolves inside the workspace). */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(message: string) {
    super(message);
  }
}
