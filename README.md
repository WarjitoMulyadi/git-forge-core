# Forge — a GitHub-compatible git forge in memory

A standalone forge that speaks the four surfaces of the GitHub platform
contract from one in-memory core store:

- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  labels, issues, comments, pull requests and squash merges.
- **GraphQL v4** at `/api/graphql` — the query and mutation documents gh
  and github-mcp-server send, cursor-paginated connections, Relay node
  ids, and the introspection surface their feature probes read.
- **MCP** at `/mcp` — JSON-RPC over streamable HTTP in both the
  2026-07-28 discover revision and the legacy initialize handshake, with
  repository, issue and pull-request tools.
- **Git smart HTTP** at `/<owner>/<repo>.git/…` — protocol v2 (ls-refs,
  fetch) and v0, shallow clones and deepening, fast-forward-only
  receive-pack with per-ref report-status, and full pack delta
  reconstruction (OFS_DELTA and REF_DELTA).

## Design

- **One core store, thin adapters.** `core.ts` owns all state and every
  operation; `rest.ts`, `graphql.ts`, `mcp.ts` and `git.ts` only
  translate wire shapes, so an object created through one surface reads
  back identically through the others.
- **In-memory everything.** Git objects live in a `Map` keyed by SHA-1;
  nothing touches the filesystem in a request path, and a fresh process
  is a fresh, empty forge.
- **Deterministic.** Ids come from counters and timestamps from a fixed
  epoch that advances one second per mutation — no wall clock, no
  randomness — so a replayed trial observes byte-identical state.
- **Pack cache.** Built packfiles are cached per repository by their
  want/have/depth signature and served from RAM on repeats.

## Running

Node 22, standard library only, no install step:

```
MAKEFUN_ENV_URL=<env url> MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

`main.ts` binds an ephemeral port, registers it with the env, serves
until the env reports the trial done, and exits 0.
