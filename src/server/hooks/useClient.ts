import { Logger } from '@anupheaus/common';
import { useClient as useSocketApiClient } from '@anupheaus/nexus/server';
import {
  subscriptionDataGet,
  subscriptionDataIsAvailable,
  subscriptionDataSet,
} from '../subscriptionDataStore';

export function useClient() {
  const socket = useSocketApiClient();

  function getLogger(subLoggerName?: string) {
    const parentLogger = Logger.getCurrent() ?? new Logger('mxdb');
    const clientLogger = parentLogger.createSubLogger(socket?.id ?? 'admin');
    if (subLoggerName != null) return clientLogger.createSubLogger(subLoggerName);
    return clientLogger;
  }

  return {
    getLogger,
    isDataAvailable: subscriptionDataIsAvailable,
    getData: subscriptionDataGet,
    setData: subscriptionDataSet,
  };
}
