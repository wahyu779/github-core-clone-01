// mcp.ts — Model Context Protocol endpoint for the github-core-clone-01 entry.
//
// POST /mcp speaks JSON-RPC 2.0 over Streamable HTTP and answers plain JSON
// (the suite also accepts SSE, but one JSON answer per request is enough).
// Two eras are supported side by side:
//   - modern, revision 2026-07-28, negotiated through server/discover;
//   - legacy, revisions 2025-11-25 and earlier, negotiated through
//     initialize + notifications/initialized, with an optional session id.
// server/discover is deliberately lenient: it answers success whenever it
// possibly can. A refusal there (anything but -32601 / 404 / 405) makes the
// suite's connect() throw and fails the whole MCP group, so discover never
// validates its params, never demands a header, and never errors.
// The six tools act directly on the shared Store the REST handlers use, so a
// repository or issue created here reads back over /api/v3 as the same object
// with the same id. No per-request mutable state is shared: every answer is
// built fresh from the request's own id and arguments.

import type { HandlerCtx, HandlerResponse, Issue, PullRequest, Repo, Store } from './store.ts';
import { FIXED_TS } from './store.ts';
import { squashMergePullRequest } from './rest.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const SUPPORTED_REVISIONS: readonly string[] = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First non-empty string found under any of the given keys (numbers coerce). */
function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/** First integer found under any of the given keys (numeric strings coerce). */
function pickNumber(args: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && value !== '') {
      const parsed = Number(value);
      if (Number.isInteger(parsed)) return parsed;
    }
  }
  return undefined;
}

/** First boolean found under any of the given keys. */
function pickBool(args: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

/** Split an "owner/repo" string, or null when it has no slash. */
function splitFullName(full: string): { owner: string; repo: string } | null {
  const slash = full.indexOf('/');
  if (slash <= 0 || slash === full.length - 1) return null;
  return { owner: full.slice(0, slash), repo: full.slice(slash + 1) };
}

/** "refs/heads/main" -> "main"; anything else passes through unchanged. */
function shortBranch(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/** Best-effort id recovery from a truncated (unparsable) JSON body. */
function extractId(raw: string): unknown {
  const match = /"id"\s*:\s*("[^"]*"|-?\d+)/.exec(raw);
  if (match === null) return null;
  const token = match[1]!;
  if (token.startsWith('"')) return token.slice(1, -1);
  return Number(token);
}

// ---------------------------------------------------------------------------
// JSON-RPC envelope helpers
// ---------------------------------------------------------------------------

function jsonReply(status: number, body: unknown): HandlerResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    contentType: 'application/json; charset=utf-8',
  };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

function toolOk(value: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolFail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------------------
// Store views (the shapes tools return; same ids as REST reads)
// ---------------------------------------------------------------------------

function repoView(store: Store, repo: Repo): Record<string, unknown> {
  const owner: Record<string, unknown> = { login: repo.owner };
  if (repo.owner === store.viewer.login) owner.id = store.viewer.id;
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner,
    description: repo.description,
    private: repo.private,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
  };
}

function issueView(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: issue.user.login, id: issue.user.id },
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

function pullView(pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: pull.mergeable,
  };
}

// ---------------------------------------------------------------------------
// Argument resolution (owner/repo/full_name + synonyms)
// ---------------------------------------------------------------------------

const OWNER_KEYS = [
  'owner', 'owner_login', 'org', 'organization', 'organisation', 'user',
  'user_login', 'login', 'account', 'namespace', 'owner_name',
] as const;
const REPO_KEYS = [
  'repo', 'repository', 'repository_name', 'repo_name', 'repo_slug',
  'project', 'project_name',
] as const;
const FULL_NAME_KEYS = ['full_name', 'repo_full_name', 'repository_full_name', 'fullName'] as const;

type RepoRef = { owner: string; repo: string } | { error: string };

function resolveRepoRef(store: Store, args: Record<string, unknown>): RepoRef {
  let owner = pickString(args, OWNER_KEYS);
  let repo = pickString(args, REPO_KEYS);
  const full = pickString(args, FULL_NAME_KEYS);
  if ((owner === undefined || repo === undefined) && full !== undefined) {
    const split = splitFullName(full);
    if (split !== null) {
      if (owner === undefined) owner = split.owner;
      if (repo === undefined) repo = split.repo;
    }
  }
  if (owner === undefined) owner = store.viewer.login;
  if (repo === undefined) return { error: 'missing required argument: repo' };
  return { owner, repo };
}

function loadRepo(store: Store, ref: RepoRef): Repo | { error: string } {
  if ('error' in ref) return ref;
  const repo = store.getRepo(ref.owner, ref.repo);
  if (repo === undefined) return { error: `Repository not found: ${ref.owner}/${ref.repo}` };
  return repo;
}

// ---------------------------------------------------------------------------
// The six tools
// ---------------------------------------------------------------------------

function strProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

const OWNER_PROP = strProp('Login of the repository owner (defaults to the token owner).');
const REPO_PROP = strProp('Repository name, without the owner.');
const FULL_NAME_PROP = strProp('Repository as "owner/repo"; used when owner/repo are absent.');

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (store: Store, args: Record<string, unknown>) => ToolResult;
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the given owner (default: the token owner).',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        owner: OWNER_PROP,
        name: strProp('Name of the repository to create.'),
        repo: REPO_PROP,
        repository: REPO_PROP,
        repository_name: REPO_PROP,
        repo_name: REPO_PROP,
        full_name: FULL_NAME_PROP,
        description: strProp('Short description of the repository.'),
        about: strProp('Short description of the repository.'),
        summary: strProp('Short description of the repository.'),
        body: strProp('Short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        is_private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run(store, args) {
      const owner = pickString(args, OWNER_KEYS) ?? store.viewer.login;
      let name = pickString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
      if (name === undefined) {
        const full = pickString(args, FULL_NAME_KEYS);
        if (full !== undefined) {
          const split = splitFullName(full);
          if (split !== null) name = split.repo;
        }
      }
      if (name === undefined) return toolFail('missing required argument: name');
      const description = pickString(args, ['description', 'about', 'summary', 'body']) ?? '';
      const isPrivate = pickBool(args, ['private', 'is_private']) ?? false;
      const repo = store.createRepo(owner, name, { private: isPrivate, description });
      if (repo === null) return toolFail(`Repository already exists: ${owner}/${name}`);
      return toolOk(repoView(store, repo));
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        owner: OWNER_PROP,
        owner_login: OWNER_PROP,
        org: OWNER_PROP,
        repo: REPO_PROP,
        repository: REPO_PROP,
        repository_name: REPO_PROP,
        repo_name: REPO_PROP,
        full_name: FULL_NAME_PROP,
        repo_full_name: FULL_NAME_PROP,
        repository_full_name: FULL_NAME_PROP,
        fullName: FULL_NAME_PROP,
      },
      required: ['owner', 'repo'],
    },
    run(store, args) {
      const repo = loadRepo(store, resolveRepoRef(store, args));
      if ('error' in repo) return toolFail(repo.error);
      return toolOk(repoView(store, repo));
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        repository: REPO_PROP,
        repository_name: REPO_PROP,
        repo_name: REPO_PROP,
        full_name: FULL_NAME_PROP,
        title: strProp('Title of the issue.'),
        issue_title: strProp('Title of the issue.'),
        subject: strProp('Title of the issue.'),
        body: strProp('Body text of the issue.'),
        issue_body: strProp('Body text of the issue.'),
        description: strProp('Body text of the issue.'),
        content: strProp('Body text of the issue.'),
        text: strProp('Body text of the issue.'),
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to attach; each must already exist on the repository.' },
        state: strProp('Initial state of the issue (open).'),
      },
      required: ['owner', 'repo', 'title'],
    },
    run(store, args) {
      const repo = loadRepo(store, resolveRepoRef(store, args));
      if ('error' in repo) return toolFail(repo.error);
      const title = pickString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
      if (title === undefined) return toolFail('missing required argument: title');
      const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
      const labels: { name: string; color: string }[] = [];
      if (Array.isArray(args.labels)) {
        for (const entry of args.labels) {
          if (typeof entry !== 'string') continue;
          const label = repo.labels.get(entry);
          if (label === undefined) return toolFail(`Unknown label: ${entry}`);
          labels.push({ name: label.name, color: label.color });
        }
      }
      const issue: Issue = {
        id: store.nextIssueId,
        number: repo.nextIssue,
        title,
        body,
        state: 'open',
        labels,
        user: store.viewer,
        created_at: FIXED_TS,
        updated_at: FIXED_TS,
        comments: [],
      };
      store.nextIssueId += 1;
      repo.nextIssue += 1;
      repo.issues.set(issue.number, issue);
      return toolOk(issueView(issue));
    },
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        repository: REPO_PROP,
        repository_name: REPO_PROP,
        repo_name: REPO_PROP,
        full_name: FULL_NAME_PROP,
        state: strProp('Issue state to list: open, closed, or all (default open).'),
        status: strProp('Issue state to list: open, closed, or all (default open).'),
      },
      required: ['owner', 'repo'],
    },
    run(store, args) {
      const repo = loadRepo(store, resolveRepoRef(store, args));
      if ('error' in repo) return toolFail(repo.error);
      const state = pickString(args, ['state', 'status']) ?? 'open';
      const list = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueView(issue));
      return {
        content: [{ type: 'text', text: JSON.stringify(list) }],
        structuredContent: { issues: list },
      };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        repository: REPO_PROP,
        repository_name: REPO_PROP,
        repo_name: REPO_PROP,
        full_name: FULL_NAME_PROP,
        title: strProp('Title of the pull request.'),
        pr_title: strProp('Title of the pull request.'),
        pull_request_title: strProp('Title of the pull request.'),
        subject: strProp('Title of the pull request.'),
        body: strProp('Body text of the pull request.'),
        description: strProp('Body text of the pull request.'),
        head: strProp('Head branch the pull request proposes to merge.'),
        head_ref: strProp('Head branch the pull request proposes to merge.'),
        head_branch: strProp('Head branch the pull request proposes to merge.'),
        source_branch: strProp('Head branch the pull request proposes to merge.'),
        base: strProp('Base branch the pull request merges into.'),
        base_ref: strProp('Base branch the pull request merges into.'),
        base_branch: strProp('Base branch the pull request merges into.'),
        target_branch: strProp('Base branch the pull request merges into.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run(store, args) {
      const repo = loadRepo(store, resolveRepoRef(store, args));
      if ('error' in repo) return toolFail(repo.error);
      const title = pickString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
      if (title === undefined) return toolFail('missing required argument: title');
      const head = pickString(args, [
        'head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source',
        'source_ref', 'source_branch', 'from', 'from_branch', 'branch',
      ]);
      const base = pickString(args, [
        'base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target',
        'target_ref', 'target_branch', 'into', 'into_branch',
      ]);
      if (head === undefined) return toolFail('missing required argument: head');
      if (base === undefined) return toolFail('missing required argument: base');
      const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
      const headSha = repo.refs.get(`refs/heads/${shortBranch(head)}`);
      const baseSha = repo.refs.get(`refs/heads/${shortBranch(base)}`);
      if (headSha === undefined) return toolFail(`Unknown branch: ${head}`);
      if (baseSha === undefined) return toolFail(`Unknown branch: ${base}`);
      const pull: PullRequest = {
        id: store.nextPullId,
        number: repo.nextPull,
        title,
        body,
        state: 'open',
        head: { ref: shortBranch(head), sha: headSha },
        base: { ref: shortBranch(base), sha: baseSha },
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        mergeable: true,
      };
      store.nextPullId += 1;
      repo.nextPull += 1;
      repo.pulls.set(pull.number, pull);
      return toolOk(pullView(pull));
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        repository: REPO_PROP,
        repository_name: REPO_PROP,
        repo_name: REPO_PROP,
        full_name: FULL_NAME_PROP,
        pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
        pull_request_number: { type: 'integer', description: 'Number of the pull request to merge.' },
        pr_number: { type: 'integer', description: 'Number of the pull request to merge.' },
        number: { type: 'integer', description: 'Number of the pull request to merge.' },
        issue_number: { type: 'integer', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run(store, args) {
      const repo = loadRepo(store, resolveRepoRef(store, args));
      if ('error' in repo) return toolFail(repo.error);
      const number = pickNumber(args, [
        'pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index',
      ]);
      if (number === undefined) return toolFail('missing required argument: pull_number');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolFail(`Pull request not found: #${number}`);
      if (!pull.merged) {
        // Same squash merge REST performs: replay the head's changes onto the
        // base tip, move the base ref to the resulting merge commit, and
        // record that commit on the pull. (Previously this just stamped the
        // head tip sha onto the pull and left the base ref unmoved, so the
        // merged files never actually landed on the base branch.)
        const merged = squashMergePullRequest(store, repo, pull);
        if (!merged.ok) return toolFail(merged.message);
      }
      return toolOk(pullView(pull));
    },
  },
];

/** Plain canonical tool definitions, in fixed order, for tools/list. */
const TOOL_LIST: readonly Record<string, unknown>[] = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
}));

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(name: string): ToolDef | undefined {
  const wanted = normalizeToolName(name);
  for (const tool of TOOLS) {
    const canonical = normalizeToolName(tool.name);
    if (wanted === canonical || wanted.endsWith(canonical)) return tool;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

type Outcome = { ok: true; result: unknown } | { ok: false; code: number; message: string };

function ok(result: unknown): Outcome {
  return { ok: true, result };
}

function fail(code: number, message: string): Outcome {
  return { ok: false, code, message };
}

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function runMethod(store: Store, method: string, params: Record<string, unknown>): Outcome {
  // Modern era. Lenient on purpose: params (including _meta) are never
  // validated here, so a discover can only fail by crashing — and it cannot.
  if (method === 'server/discover') {
    return ok({
      supportedVersions: [...SUPPORTED_REVISIONS],
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
      instructions: 'GitHub-compatible git forge over MCP: create and read repositories, issues and pull requests.',
    });
  }

  // Legacy era handshake. Echo the revision the client declared when it is a
  // known one; otherwise answer the modern revision.
  if (method === 'initialize') {
    const declared = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const revision = SUPPORTED_REVISIONS.includes(declared) ? declared : MODERN_REVISION;
    return ok({
      protocolVersion: revision,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
    });
  }

  if (method === 'ping') return ok({});

  if (method === 'tools/list') {
    return ok({ tools: TOOL_LIST });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const tool = findTool(name);
    if (tool === undefined) return fail(-32602, `Unknown tool: ${name}`);
    try {
      return ok(tool.run(store, args));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool failed';
      return ok(toolFail(message));
    }
  }

  // Notifications with an id are answered empty; without one they never get
  // a response at all (handled by the caller).
  if (method.startsWith('notifications/')) return ok({});

  if (method === 'resources/list') return ok({ resources: [] });
  if (method === 'prompts/list') return ok({ prompts: [] });

  return fail(-32601, `Method not found: ${method}`);
}

/**
 * Dispatch one JSON-RPC request object. Returns the response object, or null
 * for a notification (no id), which must get no JSON-RPC response at all.
 */
function dispatchOne(store: Store, request: unknown): Record<string, unknown> | null {
  if (!isRecord(request)) return rpcError(null, -32600, 'Invalid Request');
  const hasId = 'id' in request;
  const id = hasId ? request.id : undefined;
  const method = request.method;
  if (typeof method !== 'string' || method === '') {
    if (!hasId) return null;
    return rpcError(id ?? null, -32600, 'Invalid Request');
  }
  const params = isRecord(request.params) ? request.params : {};
  let outcome: Outcome;
  try {
    outcome = runMethod(store, method, params);
  } catch (error) {
    // Never HTTP 500 for any MCP input: a handler fault becomes -32603.
    const message = error instanceof Error ? error.message : 'Internal error';
    outcome = fail(-32603, message);
  }
  if (!hasId) return null;
  if (outcome.ok) return rpcResult(id, outcome.result);
  return rpcError(id, outcome.code, outcome.message);
}

// ---------------------------------------------------------------------------
// Entry point (POST /mcp)
// ---------------------------------------------------------------------------

export async function handleMcp(store: Store, ctx: HandlerCtx): Promise<HandlerResponse> {
  // The suite's close() may DELETE a session id; there is nothing to tear
  // down, so acknowledge it and move on.
  if (ctx.method === 'DELETE') return { status: 200, body: '' };
  if (ctx.method !== 'POST') return jsonReply(405, { message: 'Method Not Allowed' });

  // Auth first: no (or a wrong) bearer token is 401, before any parsing.
  const configured = process.env.MAKEFUN_SHOP_TOKEN;
  const expected = configured !== undefined && configured !== '' ? configured : 'test-token';
  if (ctx.token !== expected) return jsonReply(401, { message: 'Unauthorized' });

  const raw = ctx.body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = raw.trim() === '' ? undefined : JSON.parse(raw);
  } catch {
    // Malformed JSON: HTTP 400 with JSON-RPC -32700, keeping the id when the
    // truncated body still carries one.
    return jsonReply(400, rpcError(extractId(raw), -32700, 'Parse error'));
  }
  if (parsed === undefined) return jsonReply(400, rpcError(null, -32700, 'Parse error'));

  if (Array.isArray(parsed)) {
    const responses: Record<string, unknown>[] = [];
    for (const item of parsed) {
      const response = dispatchOne(store, item);
      if (response !== null) responses.push(response);
    }
    return jsonReply(200, responses);
  }

  const response = dispatchOne(store, parsed);
  if (response === null) return { status: 202, body: '' };
  return jsonReply(200, response);
}
