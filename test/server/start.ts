
import { config } from 'dotenv';
config();
import { Error, Logger } from '@anupheaus/common';
import { startServer } from '../../src/server';
import http from 'http';
import { configureViews } from './configureViews';
import { configureStaticFiles } from './configureStaticFiles';
import { configureAuth } from './configureAuth';
import { collections } from '../common';
import './configureExtensions';
import { actions } from './configureActions';
import { waitForBindablePort } from './waitForBindablePort';

const mongoDbName = process.env.MONGO_DB_NAME as string;
const mongoDbUrl = process.env.MONGO_DB_URI as string;
const newRelicApiKey = process.env.NEW_RELIC_LOGGING_API_KEY as string;
const port = 3010;

const loggerService = Logger.services.useNewRelic(newRelicApiKey);

Logger.registerListener({
  sendInterval: {
    seconds: 2,
  },
  maxEntries: 100,
  onTrigger: loggerService,
});

const logger = new Logger('MXDB');
const server = http.createServer();

async function start() {
  try {
    await waitForBindablePort(port, logger);
    const { app, createInvite } = await startServer({
      name: 'mxdb-test',
      logger,
      collections,
      actions,
      server,
      mongoDbName,
      mongoDbUrl,
      clientLoggingService: () => loggerService,
      auth: {
        mode: 'webauthn',
        onGetUserDetails: async (userId) => ({ id: userId }),
      },
    });
    configureStaticFiles(app as any);
    configureAuth(app as any, createInvite);
    configureViews(app as any);
    server.on('error', error => { logger.error(error); server.close(); });
    server.listen(port, () => { logger.info(`Server listening on port ${port}...`); });
  } catch (error) {
    logger.error(new Error({ error }));
    server.close();
  }
}

start();

process.on('unhandledRejection', error => {
  logger.error(new Error({ error }));
  server.close();
});

const shutdown = () => {
  server.closeAllConnections?.();
  server.close();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);