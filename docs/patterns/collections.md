# Collections as the primary data layer

> define a collection as the primary data layer: seed data, versions, sync sets and server-only wiring.
>
> Status: accepted · Version 1

A collection is the default data layer: a MongoDB-backed schema defined once, shared by client and server, and synced live to connected clients.

```ts
export const entityCollection = defineCollection<Entity>({
  name: 'entities', indexes: [], version: 1,
  onSeed: async useCollection => {
    const { seedWith } = useCollection(entityCollection);
    await seedWith({ fixedRecords: entityData });
  },
});
```

- One folder per entity: `<entity>Collection.ts`, optional `<entity>-seed-data.ts`, and `index.ts`. The type parameter extends `Record` (`{ id, … }`).
- `onSeed` inserts fixed lookups on first run; bump `version` when the on-disk shape changes so migrations run.
- Register collections into sync sets by client capability: a full replica for full-featured clients, a leaner subset for constrained ones. Keep data that is large, expensive to aggregate or not live-reactive out of the sync sets and fetch it on demand.
- Server-only wiring (server indexes, `onAfterUpsert`, server-only collections) lives in the entity's server extension so the shared `defineCollection` stays free of server concerns.
- A `syncMode: 'ServerOnly'` collection needs no read or write guard of its own: mxdb refuses every client request that names one, so only server code can touch it.
