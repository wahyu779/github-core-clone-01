// The forge's HTTP front door.
//
// One node:http server owns every route the conformance suite talks to:
// the health probe, git smart-HTTP, the REST v3 API, GraphQL v4 and the
// MCP endpoint. The protocol lanes (git.ts, rest.ts, graphql.ts, mcp.ts)
// each export a single handler; this file only routes, authenticates and
// frames — it never implements protocol behaviour itself.
//
// Rules enforced here, for every route except /healthz:
//   * Authorization: Bearer <MAKEFUN_SHOP_TOKEN> must match exactly. When
//     the variable is unset (local runs only) the literal test-token is
//     accepted. Anything else is a 401 JSON body.
//   * Every JSON reply carries Content-Type application/json and a
//     non-empty X-GitHub-Request-Id header (a plain counter, req-1, req-2…).
//   * A request body that is not valid JSON is a 400 JSON body on the
//     JSON-speaking routes (REST, GraphQL, MCP); git requests carry raw
//     pack bytes, so their body is passed through untouched.
//   * Unknown routes are 404 {"message":"Not Found"} — never HTML.
//   * A handler that throws is caught here and answered 500 JSON, so one
//     bad request can never take the server down.
//
// Perf note (Hunt 07 v2, lane A — framing only, no behaviour change):
// the per-request path used to do work the platform already does or the
// lanes redo anyway. What changed, and why it is safe:
//   * No body read for bodyless requests. A GET with Content-Length: 0
//     (or no length and no transfer-encoding) used to sit through an
//     `end`-event wait; now it gets a shared empty buffer straight away.
//   * No header copy. Node lowercases incoming header names itself, so
//     req.headers is used as-is instead of rebuilding a second object.
//   * No `new URL()` per request. The target is split on the first `?`
//     by hand; the query half still goes through URLSearchParams.
//   * No REST route-params regexes. rest.ts parses ctx.path itself, and
//     no lane reads ctx.params at all, so only the git-owner/repo regex
//     survives — and only on git routes.
//   * Response headers are built with plain assignments, not spreads:
//     sendJson reuses one fixed-shape object; sendResponse builds one
//     fresh literal per reply (reusing a shared object there measured
//     slower on writes — the per-call `delete` deopts it — see the note
//     above sendResponse). Either way the same status codes, headers
//     and bodies come out as before.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { Store, type HandlerCtx, type HandlerResponse } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const OAUTH_SCOPES = 'repo, read:org';

/** One shared empty body for every request that carries nothing. */
const EMPTY_BODY = Buffer.alloc(0);

/** Shared params object for routes that carry no git owner/repo. */
const NO_PARAMS: Record<string, string> = {};

type LaneHandler = (
  store: Store,
  ctx: HandlerCtx,
) => Promise<HandlerResponse>;

interface LaneModule {
  handleGit?: LaneHandler;
  handleRest?: LaneHandler;
  handleGraphQL?: LaneHandler;
  handleMcp?: LaneHandler;
}

// Lane modules are loaded on first use and then cached. That keeps the
// server bootable while a lane is still being written, and costs nothing
// once loaded — the module cache makes every later call a plain function
// call, with no per-request import overhead.
const laneCache = new Map<string, Promise<LaneModule | null>>();

function loadLane(file: string): Promise<LaneModule | null> {
  let pending = laneCache.get(file);
  if (pending === undefined) {
    pending = import(file)
      .then((mod) => mod as LaneModule)
      .catch((err: unknown) => {
        // A lane that fails to load is a lane bug, not a 404: say so loudly
        // on stderr so the coordinator sees it instead of a silent Not Found.
        process.stderr.write(
          `[forge] lane ${file} failed to load: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return null;
      });
    laneCache.set(file, pending);
  }
  return pending;
}

async function laneHandler(file: string, name: keyof LaneModule): Promise<LaneHandler | null> {
  const mod = await loadLane(file);
  const fn = mod?.[name];
  return typeof fn === 'function' ? (fn as LaneHandler) : null;
}

/** The bearer token this process accepts, or the local-only fallback. */
function expectedToken(): string {
  const fromEnv = process.env.MAKEFUN_SHOP_TOKEN;
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : 'test-token';
}

/**
 * Pull "Bearer <token>" out of the Authorization header, or null.
 * Node has already lowercased the header name; a repeated header arrives
 * as an array, in which case the first value is the one that counts.
 */
function bearerToken(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return null;
  const match = /^Bearer\s+(.+)$/.exec(value.trim());
  return match === null ? null : match[1];
}

/**
 * True when the request actually carries a body. A declared length above
 * zero means yes; chunked (or any other) transfer-encoding means yes —
 * the sender may still be streaming. No length and no transfer-encoding
 * means the request is bodyless, which covers every GET in the suite.
 */
function hasBody(req: IncomingMessage): boolean {
  const length = req.headers['content-length'];
  if (length !== undefined) {
    const value = Array.isArray(length) ? length[0] : length;
    return value !== '0' && Number(value) > 0;
  }
  return req.headers['transfer-encoding'] !== undefined;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', reject);
  });
}

/**
 * Split the request target into path and query without a URL parse.
 * The path half is left exactly as sent (the old `new URL()` pathname
 * never decoded it either); the query half keeps URLSearchParams
 * semantics, including `+` as a space and percent-decoding.
 */
function splitTarget(req: IncomingMessage): { path: string; query: URLSearchParams } {
  const target = req.url ?? '/';
  const cut = target.indexOf('?');
  if (cut === -1) return { path: target, query: new URLSearchParams() };
  return { path: target.slice(0, cut), query: new URLSearchParams(target.slice(cut + 1)) };
}

/**
 * Best-effort route params for git routes only; lanes parse ctx.path
 * themselves for detail, and no lane reads ctx.params at all. The REST
 * regexes used to live here too, but rest.ts re-parses its own path, so
 * running them on every request was pure overhead.
 */
function gitParams(path: string): Record<string, string> {
  const git = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(path);
  if (git === null) return NO_PARAMS;
  const params: Record<string, string> = {
    owner: decodeURIComponent(git[1]),
    repo: decodeURIComponent(git[2]),
  };
  if (git[3] !== undefined) params.subpath = git[3];
  return params;
}

export function createApp(): Server {
  const store = new Store();
  let requestSeq = 0;

  function requestId(): string {
    requestSeq += 1;
    return `req-${requestSeq}`;
  }

  // One reused header object for sendJson. Node's writeHead copies the
  // values into its own store synchronously, and sendJson calls writeHead
  // + end with no await in between, so clearing the caller's extras right
  // after writeHead cannot disturb the response in flight. sendResponse
  // deliberately does NOT reuse an object: clearing a shared object with
  // `delete` on every call pushes it into dictionary mode and measured
  // slower and noisier on the write path in the lane A/B test, so it
  // builds one fresh literal per reply with plain assignments instead of
  // spreads (one allocation, no intermediate objects, no deletes).
  const jsonHead: Record<string, string> = { 'content-type': JSON_TYPE };

  function sendJson(
    res: ServerResponse,
    status: number,
    body: unknown,
    extra: Record<string, string> = {},
  ): void {
    const text = `${JSON.stringify(body)}\n`;
    jsonHead['content-length'] = String(Buffer.byteLength(text));
    jsonHead['x-github-request-id'] = requestId();
    for (const name of Object.keys(extra)) jsonHead[name] = extra[name];
    res.writeHead(status, jsonHead);
    for (const name of Object.keys(extra)) delete jsonHead[name];
    res.end(text);
  }

  function sendResponse(res: ServerResponse, reply: HandlerResponse): void {
    const payload: Buffer =
      typeof reply.body === 'string' ? Buffer.from(reply.body, 'utf8') : reply.body;
    // Fresh literal, plain assignments, no spreads: one allocation, and
    // the lane's own headers still overwrite the framing id exactly as
    // the old spread order did (rest.ts sets its own request id).
    const headers: Record<string, string> = {};
    headers['content-length'] = String(payload.length);
    if (reply.contentType === undefined || reply.contentType.startsWith('application/json')) {
      headers['x-github-request-id'] = requestId();
    }
    if (reply.headers !== undefined) {
      for (const name of Object.keys(reply.headers)) headers[name] = reply.headers[name];
    }
    if (reply.contentType !== undefined) headers['content-type'] = reply.contentType;
    else if (headers['content-type'] === undefined) headers['content-type'] = JSON_TYPE;
    res.writeHead(reply.status, headers);
    res.end(payload);
  }

  function sendError(res: ServerResponse, status: number, message: string): void {
    sendJson(res, status, { message });
  }

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const { path, query } = splitTarget(req);
        const method = (req.method ?? 'GET').toUpperCase();

        // Boot probe: no auth, no body, always 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const token = bearerToken(req);
        if (token === null || token !== expectedToken()) {
          sendError(res, 401, 'Bad credentials');
          return;
        }

        // Bodyless requests skip the read entirely — the old code waited
        // for the `end` event even on a GET with no body at all.
        const body = hasBody(req) ? await readBody(req) : EMPTY_BODY;

        // The API root answers here, in this file, like api.github.com's GET /.
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(
            res,
            200,
            { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
            { 'x-oauth-scopes': OAUTH_SCOPES },
          );
          return;
        }

        // JSON-speaking routes: parse leniently and hand the result to the
        // lane. A body that is not valid JSON is NEVER answered here: each
        // lane owns its protocol's malformed-body answer, and they differ
        // on purpose — REST and GraphQL answer 400 {"message": …}, while
        // MCP answers 400 with a JSON-RPC -32700 parse error (recovering
        // the request id from the truncated body). Answering a generic
        // 400 here cost the suite's mcp.malformed-body check in run 1.
        // Git routes are exempt as well — their bodies are raw pack bytes.
        const isGitRoute = /^\/[^/]+\/[^/]+\.git(?:\/.*)?$/.test(path);
        let json: unknown;
        if (!isGitRoute && body.length > 0) {
          try {
            json = JSON.parse(body.toString('utf8')) as unknown;
          } catch {
            json = undefined;
          }
        }

        const ctx: HandlerCtx = {
          method,
          path,
          query,
          // Node lowercases header names already; pass them through
          // untouched instead of rebuilding a second object per request.
          // The cast only bridges the type: values the lanes read
          // (host, git-protocol) arrive as single strings in practice.
          headers: req.headers as unknown as Record<string, string>,
          body,
          json,
          params: isGitRoute ? gitParams(path) : NO_PARAMS,
          token,
        };

        let handler: LaneHandler | null = null;
        if (isGitRoute) {
          handler = await laneHandler('./git.ts', 'handleGit');
        } else if (method === 'POST' && path === '/api/graphql') {
          handler = await laneHandler('./graphql.ts', 'handleGraphQL');
        } else if (method === 'POST' && path === '/mcp') {
          handler = await laneHandler('./mcp.ts', 'handleMcp');
        } else if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          handler = await laneHandler('./rest.ts', 'handleRest');
        }

        if (handler === null) {
          // No lane owns this route (or the lane has not landed yet).
          sendError(res, 404, 'Not Found');
          return;
        }

        const reply = await handler(store, ctx);
        sendResponse(res, reply);
      } catch (err) {
        // Last resort: a handler must never take the server down with it.
        if (!res.headersSent) {
          sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        } else {
          res.end();
        }
      }
    })();
  });
}
