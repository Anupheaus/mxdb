import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '@anupheaus/common';
import type { CommandFailedEvent, CommandStartedEvent, CommandSucceededEvent } from 'mongodb';
import { createMongoCommandLogging } from './mongoCommandLogging';

const REQUEST_ID = 7;
const SECRET_EMAIL = 'jane@example.com';

function setup() {
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const handlers = createMongoCommandLogging(logger as unknown as Logger);
  return { logger, ...handlers };
}

function started(commandName = 'update', command: object = { update: 'orders', updates: [{ q: { email: SECRET_EMAIL } }] }): CommandStartedEvent {
  return { requestId: REQUEST_ID, commandName, databaseName: 'tenant-a', command } as unknown as CommandStartedEvent;
}

function failed(failure: object): CommandFailedEvent {
  return { requestId: REQUEST_ID, commandName: 'update', databaseName: 'tenant-a', duration: 12, failure } as unknown as CommandFailedEvent;
}

function succeeded(): CommandSucceededEvent {
  return { requestId: REQUEST_ID, commandName: 'update', duration: 5, reply: { n: 1 } } as unknown as CommandSucceededEvent;
}

function everythingLogged(logger: ReturnType<typeof setup>['logger']): string {
  return JSON.stringify([logger.debug.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
}

describe('createMongoCommandLogging', () => {
  it('logs a non-retryable failure once as an error with command, collection, database, duration and code', () => {
    const { logger, onCommandStarted, onCommandFailed } = setup();
    onCommandStarted(started());

    onCommandFailed(failed({ code: 2, codeName: 'BadValue', name: 'MongoServerError' }));

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('Database command failed', expect.objectContaining({
      commandName: 'update', collection: 'orders', database: 'tenant-a', durationMs: 12, code: 2, codeName: 'BadValue',
    }));
  });

  it('logs a transient failure as a warn and nothing at error', () => {
    const { logger, onCommandStarted, onCommandFailed } = setup();
    onCommandStarted(started());

    onCommandFailed(failed({ code: 112, codeName: 'WriteConflict', errorLabels: ['TransientTransactionError'] }));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs nothing above warn when a retried command then succeeds', () => {
    const { logger, onCommandStarted, onCommandFailed, onCommandSucceeded } = setup();
    onCommandStarted(started());
    onCommandFailed(failed({ code: 112 }));
    onCommandStarted(started());
    onCommandSucceeded(succeeded());

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('logs a duplicate key that the upsert logic handles as a warn', () => {
    const { logger, onCommandStarted, onCommandFailed } = setup();
    onCommandStarted(started());

    onCommandFailed(failed({ code: 11_000, codeName: 'DuplicateKey' }));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs started and succeeded at debug with the collection', () => {
    const { logger, onCommandStarted, onCommandSucceeded } = setup();

    onCommandStarted(started());
    onCommandSucceeded(succeeded());

    expect(logger.debug).toHaveBeenCalledWith('Database command started', expect.objectContaining({ commandName: 'update', collection: 'orders' }));
    expect(logger.debug).toHaveBeenCalledWith('Database command succeeded', expect.objectContaining({ collection: 'orders', durationMs: 5 }));
  });

  it('never logs the filter or document values at any level', () => {
    const { logger, onCommandStarted, onCommandSucceeded, onCommandFailed } = setup();
    onCommandStarted(started());
    onCommandFailed(failed({ code: 11_000, message: `dup key: { email: "${SECRET_EMAIL}" }`, errmsg: SECRET_EMAIL }));
    onCommandStarted(started('find', { find: 'users', filter: { email: SECRET_EMAIL } }));
    onCommandSucceeded(succeeded());

    expect(everythingLogged(logger)).not.toContain(SECRET_EMAIL);
  });

  it('still logs a failure whose started event was never seen', () => {
    const { logger, onCommandFailed } = setup();

    onCommandFailed(failed({ code: 2 }));

    expect(logger.error).toHaveBeenCalledWith('Database command failed', expect.objectContaining({ commandName: 'update', collection: undefined }));
  });
});
