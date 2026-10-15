// Shared by `serverOnlyCollections.crud.e2e.tests.ts` and the server extensions it loads into the forked server.

import type { Record } from '@anupheaus/common';
import { defineAction } from '@anupheaus/nexus/common';
import { defineCollection } from '../../../src/common/index.js';

/** A record only the server may see or change, shaped like a stored OAuth token. */
export interface ServerOnlySecret extends Record {
  token: string;
}

/** The server-only collection a hostile client goes after. The client app never registers it. */
export const serverOnlySecretsCollection = defineCollection<ServerOnlySecret>({
  name: 'e2eServerOnlySecrets',
  indexes: [],
  syncMode: 'ServerOnly',
});

/** What the server's own probe is asked to do: store `upsert` (when given), then answer what is stored. */
export interface ServerOnlyProbeRequest {
  upsert?: ServerOnlySecret[];
}

/**
 * The server's own use of the collection, as a scheduled job or webhook would: a server action that writes through
 * `useCollection` and reads back every stored record. The test uses it to seed the collection and to read what is
 * stored, since no client request may.
 */
export const serverOnlyProbeAction = defineAction<ServerOnlyProbeRequest, ServerOnlySecret[]>()('e2eServerOnlyProbeAction');

/** A synchronised-collection value the suite's read gate hides from every client. */
export const GATED_VALUE = 'server-only-suite-gated';
