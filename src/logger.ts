import { Logger } from '@anupheaus/common';
import { createUILogger } from '@anupheaus/react-ui';

export const logger = new Logger('MXDB');

export const { useLogger, LoggerProvider } = createUILogger(logger);
