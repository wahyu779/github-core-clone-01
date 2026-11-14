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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { Store, type HandlerCtx, type HandlerResponse } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const OAUTH_SCOPES = 'repo, read:org';

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

/** Pull "Bearer <token>" out of the Authorization header, or null. */
function bearerToken(headers: Record<string, string>): string | null {
  const raw = headers.authorization;
  if (raw === undefined) return null;
  const match = /^Bearer\s+(.+)$/.exec(raw.trim());
  return match === null ? null : match[1];
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

function lowerHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') out[name.toLowerCase()] = value;
    else if (Array.isArray(value)) out[name.toLowerCase()] = value.join(', ');
  }
  return out;
}

function splitPath(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://forge');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

/** Best-effort route params; lanes parse ctx.path themselves for detail. */
function routeParams(path: string): Record<string, string> {
  const params: Record<string, string> = {};
  const git = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(path);
  if (git !== null) {
    params.owner = decodeURIComponent(git[1]);
    params.repo = decodeURIComponent(git[2]);
    if (git[3] !== undefined) params.subpath = git[3];
    return params;
  }
  const repo = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (repo !== null) {
    params.owner = decodeURIComponent(repo[1]);
    params.repo = decodeURIComponent(repo[2]);
    if (repo[3] !== undefined) params.rest = repo[3];
  }
  return params;
}

export function createApp(): Server {
  const store = new Store();
  let requestSeq = 0;

  function requestId(): string {
    requestSeq += 1;
    return `req-${requestSeq}`;
  }

  function sendJson(
    res: ServerResponse,
    status: number,
    body: unknown,
    extra: Record<string, string> = {},
  ): void {
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, {
      'content-type': JSON_TYPE,
      'content-length': Buffer.byteLength(text),
      'x-github-request-id': requestId(),
      ...extra,
    });
    res.end(text);
  }

  function sendResponse(res: ServerResponse, reply: HandlerResponse): void {
    const payload: Buffer =
      typeof reply.body === 'string' ? Buffer.from(reply.body, 'utf8') : reply.body;
    const headers: Record<string, string> = {
      'content-length': String(payload.length),
      ...(reply.contentType === undefined || reply.contentType.startsWith('application/json')
        ? { 'x-github-request-id': requestId() }
        : {}),
      ...(reply.headers ?? {}),
    };
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
        const { path, query } = splitPath(req);
        const method = (req.method ?? 'GET').toUpperCase();
        const headers = lowerHeaders(req);

        // Boot probe: no auth, no body, always 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const token = bearerToken(headers);
        if (token === null || token !== expectedToken()) {
          sendError(res, 401, 'Bad credentials');
          return;
        }

        const body = await readBody(req);

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
          headers,
          body,
          json,
          params: routeParams(path),
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
