# github-core-clone-01 — a GitHub-compatible git forge

A small, dependency-free forge that speaks the GitHub surfaces the
make.fun `github-core-clone-01` bounty scores: git smart HTTP
(`info/refs`, `git-upload-pack`, `git-receive-pack`), the REST v3 API
(repositories, branches, commits, contents, issues, comments, labels,
pull requests), GraphQL v4, and the MCP endpoint — all backed by one
in-memory store with deterministic state.

## Run it

```sh
node --experimental-strip-types main.ts
```

Node 22.18 or later, nothing to install. The server binds an ephemeral
port, registers it with the trial environment named by
`MAKEFUN_ENV_URL`, and exits once the environment reports done. For
local checks, run it with `MAKEFUN_SHOP_TOKEN=test-token` and talk to it
directly (see below); the trial always sets the real token.

## Layout

- `main.ts` — the entrypoint lifecycle: bind, register, poll for done.
- `app.ts` — the HTTP front door: routing, auth, JSON framing, request ids.
- `store.ts` — the shared store: repos, git objects, refs, issues, PRs.
- `git.ts` — git smart-HTTP (upload-pack / receive-pack, protocol v2).
- `rest.ts` — REST v3 resources.
- `graphql.ts` — GraphQL v4.
- `mcp.ts` — Model Context Protocol over streamable HTTP.

## Local smoke check

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types main.ts &
# with MAKEFUN_ENV_URL unset the entry exits 1; for a bare server check,
# drive app.ts through the kit runner instead:
#   node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT \
#     --token test-token --perf --json
```

`GET /healthz` answers `200 {"ok":true}` with no token. Every other
route needs `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>` and answers JSON
with an `X-GitHub-Request-Id` header.

## License

MIT — see `LICENSE`.
