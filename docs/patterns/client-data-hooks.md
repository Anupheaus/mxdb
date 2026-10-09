# Client data hooks

> createUseRecord and createUseRecords: the factory client hooks, extensions, live-value comparison and read-only records.
>
> Status: accepted · Version 1

Reactive reads come from factories over a collection. `useCollection` / `useRecord` from `@anupheaus/mxdb/client` are the raw escape hatch for bespoke logic.

```ts
export const useSurveys = createUseRecords('surveys', surveysCollection);
export const useSurvey = createUseRecord('survey', surveysCollection, {
  hydrateRecord: (survey, addressId) => ({ id: Math.uniqueId(), addressId, ...survey }),
});
```

`createUseRecords` returns `surveys`, `isLoadingSurveys`, `upsertSurveys`, `removeSurveys`, `totalSurveys`, `querySurveys`, `getSurveys`, named from the record label. `createUseRecord` returns `survey`, `isLoadingSurvey`, `isNewSurvey`, `setSurvey`, `upsertSurvey`, `removeSurvey`; `hydrateRecord` supplies a default new record. One hook per file, named `use[Entity]` / `use[Entity]s`, folder barrelled.

- `extensions` add named query variants as static methods on the hook function (`useSurveys.for(...)`), each a hook in its own right; keep a non-trivial one in its own file.
- Live results are compared by value with `is.deepEqual`, never by hashing the result: `Object.hash` walked every DateTime and was most of a page's CPU. A DateTime re-zoned at the same instant is not a change.
- Delivered records are read-only: to change one, copy it (`{ ...record, name }`) and upsert the copy. In development they are frozen, and hook props are compared by value, so a props object changed in place is never noticed.
- Use `String.undefined()`, not `''`, for a not-yet-known id.
