import { ApiError } from './api';

/** A structured rejection means these endpoints did not admit an operation.
 * Keep the original ID on network failures: its outcome may still be running. */
export const workRequestRejected = (error: unknown) => error instanceof ApiError &&
  [400,401,403,404,409,413,422].includes(error.status ?? 0) &&
  !['host_unavailable','request_failed'].includes(error.code);
