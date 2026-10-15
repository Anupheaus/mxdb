import { isTransientMongoCloseError } from '../../utils/isTransientMongoCloseError';

/** How loudly a failed Mongo command should be logged. */
export type MongoErrorLogLevel = 'warn' | 'error';

/** The parts of a driver error (or a raw failed-command reply) that classification reads. */
export interface MongoFailureLike {
  code?: number;
  name?: string;
  errorLabels?: string[];
}

/** Duplicate key (E11000): the upsert logic catches and handles it. */
const DUPLICATE_KEY_CODE = 11_000;

/** Codes that are expected or handled, so they are not faults worth an error. */
const WARN_CODES = new Set<number>([
  DUPLICATE_KEY_CODE,
  26, // NamespaceNotFound — dropping something already gone
  112, // WriteConflict — retried by the transaction
  251, // NoSuchTransaction — transient, retried
  // Network and replica-set election errors that the driver or our retry loop retries:
  6, // HostUnreachable
  7, // HostNotFound
  89, // NetworkTimeout
  91, // ShutdownInProgress
  189, // PrimarySteppedDown
  9_001, // SocketException
  10_107, // NotWritablePrimary
  11_600, // InterruptedAtShutdown
  11_602, // InterruptedDueToReplStateChange
  13_435, // NotPrimaryNoSecondaryOk
  13_436, // NotPrimaryOrSecondary
]);

/** Error labels the driver attaches to failures it (or we) will retry. */
const WARN_LABELS = new Set<string>(['TransientTransactionError', 'RetryableWriteError']);

/** Driver error class names for network failures, which carry no numeric code. */
const WARN_ERROR_NAMES = new Set<string>(['MongoNetworkError', 'MongoNetworkTimeoutError']);

/**
 * Classifies a Mongo error code: `warn` for expected or handled failures, `error` for anything else
 * (including an unknown or missing code, so a new kind of failure is never hidden).
 *
 * To treat another failure as expected, add its code to {@link WARN_CODES}.
 */
export function classifyMongoError(code: number | undefined): MongoErrorLogLevel {
  return code != null && WARN_CODES.has(code) ? 'warn' : 'error';
}

/**
 * Classifies a whole failure: its code, plus the retry labels and network error names that have no code.
 * Failures from a client being closed during shutdown are expected too.
 */
export function classifyMongoFailure(failure: MongoFailureLike | undefined): MongoErrorLogLevel {
  if (failure == null) return 'error';
  const { code, name, errorLabels } = failure;
  if (classifyMongoError(code) === 'warn') return 'warn';
  if (errorLabels?.some(label => WARN_LABELS.has(label)) === true) return 'warn';
  if (name != null && WARN_ERROR_NAMES.has(name)) return 'warn';
  return isTransientMongoCloseError(failure) ? 'warn' : 'error';
}
