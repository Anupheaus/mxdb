# mxdb — repo overview

> What @anupheaus/mxdb is, what it depends on, and who reads its docs.
>
> Status: accepted · Version 1

## What it is

The sync engine (`@anupheaus/mxdb`) that mirrors MongoDB to client-side storage with offline support, plus its React hooks. It also hosts the remote MCP server that lets agents inspect and query connected clients — the tool semantics live in `src/server/AGENTS.md`.

## Depends on

`common` and `react-ui`.

## Who depends on it

`vision`. Changing a collection contract, a query hook or the remote MCP tool surface opens vision's docs in the same change.

## Notes

The credentials, endpoint and environment variables used to reach a running remote MCP server belong to the application that runs it, not here.
