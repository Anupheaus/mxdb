import type { NexusServerAction } from '@anupheaus/nexus/server';
import { clientToServerSyncAction } from './clientToServerSyncAction';
import { serverGetAction } from './getAction';
import { serverGetAllAction } from './getAllAction';
import { serverQueryAction } from './queryAction';
import { serverDistinctAction } from './distinctAction';
import { reconcileAction } from './reconcileAction';

export const internalActions: NexusServerAction[] = [
  clientToServerSyncAction,
  serverGetAction,
  serverGetAllAction,
  serverQueryAction,
  serverDistinctAction,
  reconcileAction,
];

