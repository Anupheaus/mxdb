import { AsyncLocalStorage } from 'async_hooks';
import { is, Logger, type PromiseMaybe } from '@anupheaus/common';

/**
 * Runs a function in the async context as it was when this module loaded: before any connection, request, signed-in
 * user or database scope existed. mxdb is imported statically at server start-up, so this is the empty context.
 */
const runInRootContext = AsyncLocalStorage.snapshot();

export interface RunOutsideAnyConnectionRequest<T> {
  /** Provided to the delegate as the ambient logger (`useLogger()`), since the root context has none. */
  logger: Logger | undefined;
  delegate(): PromiseMaybe<T>;
}

/**
 * The logger ambient now (`Logger.provide`), to hand to {@link runOutsideAnyConnection} later. `undefined` when none was
 * provided, or where `@anupheaus/common` refuses ambient loggers (a browser-like environment, e.g. a jsdom test).
 */
export function captureAmbientLogger(): Logger | undefined {
  if (is.browser()) return undefined;
  return Logger.getCurrent();
}

/**
 * Runs `delegate` on an empty async-context chain, with only `logger` ambient (sc-662): no connection's socket, no
 * signed-in user and no database scope leak into it from whatever context happened to call it. For work the server
 * does on its own behalf, such as the collections' `onAfter*` hooks, which the change stream would otherwise run in the
 * context of the connection that first reached a pooled database. Set any scope the delegate needs (e.g. the database)
 * inside it.
 */
export function runOutsideAnyConnection<T>({ logger, delegate }: RunOutsideAnyConnectionRequest<T>): Promise<T> {
  // `provide` resolves to what the delegate returns, a promise included (it is awaited through), so the result is a T.
  return runInRootContext(async (): Promise<T> => (logger == null ? delegate() : logger.provide(delegate) as Promise<T>));
}
