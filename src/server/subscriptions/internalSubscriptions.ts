import type { NexusServerSubscription } from '@anupheaus/nexus/server';
import { serverQuerySubscription } from './querySubscription';
import { serverDistinctSubscription } from './distinctSubscription';
import { serverGetAllSubscription } from './getAllSubscription';

export const internalSubscriptions: NexusServerSubscription[] = [
  serverQuerySubscription,
  serverDistinctSubscription,
  serverGetAllSubscription,
];
