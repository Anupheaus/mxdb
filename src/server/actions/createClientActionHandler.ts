import type { PromiseMaybe } from '@anupheaus/common';
import type { NexusAction } from '@anupheaus/nexus/common';
import { createServerActionHandler, type NexusServerAction } from '@anupheaus/nexus/server';
import { refuseServerOnlyCollections } from '../collections/refuseServerOnlyCollections';

/** An mxdb action's handler: it is given the client's request and answers it. */
export type ClientActionHandler<Request, Response> = (request: Request) => PromiseMaybe<Response>;

/**
 * Registers an mxdb action a client calls. A request naming a server-only collection is refused before `handler` runs
 * (`refuseServerOnlyCollections`), over the socket and over REST alike. Every mxdb client action is registered here
 * (`clientRequestHandlers.tests.ts` keeps it so), so a new action cannot forget the check.
 */
export function createClientActionHandler<Name extends string, Request, Response>(
  action: NexusAction<Name, Request, Response>,
  handler: ClientActionHandler<Request, Response>,
): NexusServerAction {
  return createServerActionHandler(action, request => {
    refuseServerOnlyCollections({ requestName: action.name, request });
    return handler(request);
  });
}
