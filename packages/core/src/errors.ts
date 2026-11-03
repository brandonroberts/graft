/** Base class for errors caused by tooling/config problems (CLI exit code 2). */
export class GraftError extends Error {
  constructor(
    message: string,
    readonly code: string = 'graft/error',
  ) {
    super(message);
    this.name = 'GraftError';
  }
}

/** Thrown when an anchor does not match. A graft must never silently apply nothing. */
export class AnchorMissError extends GraftError {
  constructor(
    message: string,
    readonly graft: string,
    readonly anchors: string[],
  ) {
    super(message, 'graft/anchor-miss');
    this.name = 'AnchorMissError';
  }
}
