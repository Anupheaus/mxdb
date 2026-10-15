import type { Logger } from '@anupheaus/common';
import type { CommandFailedEvent, CommandStartedEvent, CommandSucceededEvent } from 'mongodb';
import { classifyMongoFailure, type MongoFailureLike } from './classifyMongoError';

/** What is remembered about a command from its started event, so the failed event can name the collection. */
interface StartedCommand {
  commandName: string;
  collection?: string;
}

/** Handlers for the driver's command monitoring events. */
export interface MongoCommandLogging {
  onCommandStarted(event: CommandStartedEvent): void;
  onCommandSucceeded(event: CommandSucceededEvent): void;
  onCommandFailed(event: CommandFailedEvent): void;
}

/** Reads the collection a command targets: it is the value of the command-named key (`{ find: 'orders' }`). */
function getTargetCollection({ commandName, command }: CommandStartedEvent): string | undefined {
  const target: unknown = command[commandName] ?? command.collection;
  return typeof target === 'string' ? target : undefined;
}

/**
 * The failure of a failed command: the driver hands over either an error or the server's raw reply.
 * Only the code, code name and labels are read, never the message, because a duplicate-key message
 * quotes the offending document's values.
 */
function readFailure(failure: unknown): MongoFailureLike & { codeName?: string } {
  if (failure == null || typeof failure !== 'object') return {};
  const { code, codeName, name, errorLabels } = failure as MongoFailureLike & { codeName?: string };
  return { code, codeName, name, errorLabels };
}

/**
 * Logs the driver's Mongo command events without ever recording a filter or document value.
 *
 * Started and succeeded are debug, which is the flight-recorder context shipped with an error. A failed
 * command is `warn` when {@link classifyMongoFailure} says it is expected or handled, otherwise `error`.
 */
export function createMongoCommandLogging(logger: Logger): MongoCommandLogging {
  const startedCommands = new Map<number, StartedCommand>();

  const onCommandStarted = (event: CommandStartedEvent): void => {
    const { requestId, commandName, databaseName } = event;
    const collection = getTargetCollection(event);
    startedCommands.set(requestId, { commandName, collection });
    logger.debug('Database command started', { commandName, collection, database: databaseName, requestId });
  };

  const onCommandSucceeded = ({ requestId, commandName, duration }: CommandSucceededEvent): void => {
    const { collection } = startedCommands.get(requestId) ?? {};
    startedCommands.delete(requestId);
    logger.debug('Database command succeeded', { commandName, collection, durationMs: duration, requestId });
  };

  const onCommandFailed = ({ requestId, commandName, databaseName, duration, failure }: CommandFailedEvent): void => {
    const { collection } = startedCommands.get(requestId) ?? {};
    startedCommands.delete(requestId);
    const { code, codeName, name, errorLabels } = readFailure(failure);
    const level = classifyMongoFailure({ code, name, errorLabels });
    logger[level]('Database command failed', { commandName, collection, database: databaseName, durationMs: duration, code, codeName, errorName: name, requestId });
  };

  return { onCommandStarted, onCommandSucceeded, onCommandFailed };
}
