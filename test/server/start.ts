import { config } from 'dotenv';
config();
import { Logger } from '@anupheaus/common';
import http from 'http';
import { configureViews } from './configureViews';
import { configureStaticFiles } from './configureStaticFiles';
import Koa from 'koa';

const port = 3010;

const logger = new Logger('mxdb');

async function start() {
  const app = new Koa();
  const server = http.createServer(app.callback());
  configureStaticFiles(app);
  configureViews(app);
  logger.info(`Server listening on port ${port}...`);
  server.listen(port);
}

start();
