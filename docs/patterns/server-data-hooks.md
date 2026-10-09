# Server data hooks

> Server data hooks: createUseRecords with helpers and extensions, one file each, all server data access through them.
>
> Status: accepted · Version 1

`createUseRecords` from `@anupheaus/mxdb/server` is the server mirror of the client hooks, wrapping one collection and exposing named domain helpers so server code never touches a collection directly.

```ts
export const useOrders = createUseRecords('orders', ordersCollection, {
  helpers: context => ({
    convertQuoteToOrder: (quoteId, payment, options) => convertQuoteToOrder(context, quoteId, payment, options),
    lockQuote, isLockedQuote,
  }),
});
```

- `helpers` derive extra values that are merged into the hook's result (`useOrders().convertQuoteToOrder(...)`) and receive the hook context so they can reach the collection API.
- `extensions` are static methods on the hook function (`useUsers.getUserAndContact(...)`) for standalone operations that need not be part of a live result.
- Implement each helper or extension in its own file in the same folder and compose them in; import from the folder barrel.
- Keep pure helpers free of `useCollection` so they unit-test in isolation.
- All server-side data access goes through these hooks, so domain rules live in one place.
