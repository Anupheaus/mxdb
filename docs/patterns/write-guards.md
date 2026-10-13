# Write guards: before-write hooks and the read gate

> Before-write hooks, amend versus reject, write locks, and onQuery as both the read and the write gate.
>
> Status: accepted · Version 1

`onBeforeUpsert` / `onBeforeDelete`, registered with `extendCollection` in the entity's server extension, run on the server before anything is persisted — for server writes and synced client writes alike — and only for real changes.

- Prefer amending records in place over throwing for client-writable data: the amendment is audited and synced back, so the user's change is kept. Throw a `ValidationError` with a message you would show the user to reject; the app hears it through `onSyncAmended`/`onSyncRejected` with `kind: 'validation'`. Another error arrives as `kind: 'error'` (log it, show a generic message), a read-gate refusal as `kind: 'access'`.
- When a hook amends instead of refusing, return `[{ id, note }]` so the app can show a plain-English warning through `onSyncAmended`; the save succeeded.
- A rule that reads other records needs a `writeLock`, held across the check and the save on every write path, and given to the actions that change what it reads.
- `onQuery` is the read gate and the write gate. The payload's `purpose` is `'read'` (or absent) or `'write'`: authority rules ignore it, but a delivery scope (a device's date window) applies to reads only, so an offline edit to a record that has left the scope is still saved and the record is then evicted from the device.
- A write the server keeps failing for any other reason stays on the device and retries with backoff; after a few attempts `MXDBSync`'s `onError` reports `SYNC_STALLED`.
