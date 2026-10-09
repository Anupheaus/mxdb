# Editing reconciliation against a live collection

> Keep unsaved local edits when a live collection update arrives, using useUpdatableState and an isDirtyRef.
>
> Status: accepted · Version 1

Because a collection syncs live, a form editing one of its records must guard against an incoming server update clobbering unsaved local edits. Reconcile with `useUpdatableState` plus an `isDirtyRef`, and flush through an auto-save.

```ts
const [survey, setSurvey] = useUpdatableState<Survey | undefined>(prev => {
  const server = surveys.first();
  if (server && isDirtyRef.current && prev?.id === server.id) return prev; // keep local edits
  return server ?? Survey.create({ addressId: appointment!.addressId });
}, [surveys, appointment]);
```

- On a live update: if the local copy is dirty and refers to the same record, keep the local edit; otherwise take the server value.
- Clear `isDirtyRef` only after the `upsert` resolves, so a mid-save sync cannot drop the pending write.
