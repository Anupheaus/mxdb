# Records: interface plus namespace

> The interface plus namespace record shape, how models are imported, and the mxdb folder grammar table.
>
> Status: accepted · Version 1

Every record stored in a collection is an interface extending `Record`, paired with a same-named namespace holding its factory and logic.

```ts
export interface SurveyRoom extends Record { typeIds: string[]; windows: SurveyWindow[]; }
export namespace SurveyRoom {
  export const create = (): SurveyRoom => ({ id: Math.uniqueId(), typeIds: [], windows: [] });
  export function generateLabel(types: SurveyRoomType[], typeIds: string[]): string | undefined { /* … */ }
}
```

- `Record` (`{ id, … }`) comes from `@anupheaus/common`; `create()` mints the id with `Math.uniqueId()`.
- Sub-type enumerations are namespace members (e.g. `Appointment.Type.types`).
- Import the type with `import type { Entity } from '…/models'` and the namespace with `import { Entity } from '…/models'`.
- Organise by domain folder, each barrelled by `index.ts`.

## Folder grammar

| Concern | Location | Factory / primitive |
|---|---|---|
| Collection schema | `<entity>/*Collection.ts` | `defineCollection<T>()` |
| Server collection wiring | server `extensions/<entity>/` | extension + `onAfterUpsert` hooks |
| Client list hook | client `hooks/<entity>/use*.ts` | `createUseRecords(name, collection, { extensions })` |
| Client record hook | client `hooks/<entity>/use*.ts` | `createUseRecord(name, collection, { hydrateRecord, extensions })` |
| Server data hook | server `hooks/<entity>/use*.ts` | `createUseRecords(name, collection, { helpers, extensions })` |
| Record model | `models/<domain>/*-models.ts` | `interface extends Record` + `namespace` |

**Living docs:** each folder carries an `agents.md` describing its current structure; keeping it accurate is part of completing a change.
