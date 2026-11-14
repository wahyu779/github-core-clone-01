// REST v3 handler for the github-core-clone-01 forge (Hunt 07, lane REST).
//
// One function, handleRest(store, ctx), answering every /api/v3 route the
// conformance suite drives: meta/user/repos, branches, commits, contents,
// labels, issues, comments, pulls, files and squash merges. All state lives
// in the shared Store; this file only translates HTTP into Store calls and
// Store records back into GitHub-shaped JSON.
//
// Notes the implementation leans on:
// - The viewer is fixed by the sealed scenario (id 1000, login adaiversen);
//   the bearer token is opaque, so it is checked for equality only.
// - Timestamps in stored/returned state are the fixed scenario instant;
//   nothing here calls Date.now or Math.random for state.
// - Issue reads are a single Map lookup; issue writes are a single Map
//   insert; nothing on those paths scans a collection.

import type { HandlerCtx, HandlerResponse, Issue, Label, PullRequest, Repo, Store } from './store.js';

const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const FIXED_TS = '2025-01-01T00:00:00Z';
const INSTALLED_VERSION = '1.0.0';
const MERGE_AUTHOR = 'Merge pull request';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function jsonReply(status: number, value: unknown, extraHeaders: Record<string, string> = {}): HandlerResponse {
  return {
    status,
    headers: { 'x-github-request-id': nextRequestId(), ...extraHeaders },
    body: JSON.stringify(value),
    contentType: 'application/json; charset=utf-8',
  };
}

function errorReply(status: number, message: string): HandlerResponse {
  return jsonReply(status, { message });
}

function emptyReply(status: number): HandlerResponse {
  return {
    status,
    headers: { 'x-github-request-id': nextRequestId() },
    body: '',
    contentType: 'application/json; charset=utf-8',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyRecord(ctx: HandlerCtx): Record<string, unknown> | null {
  return isRecord(ctx.json) ? ctx.json : null;
}

/** True when the caller sent a non-empty body that did not parse as JSON. */
function hasMalformedBody(ctx: HandlerCtx): boolean {
  return ctx.body !== undefined && ctx.body.length > 0 && ctx.json === undefined;
}

function checkAuth(ctx: HandlerCtx): HandlerResponse | null {
  const token = ctx.token;
  if (token === null || token === undefined || token === '') {
    return errorReply(401, 'Authentication required');
  }
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected !== undefined && expected !== '') {
    if (token !== expected) return errorReply(401, 'Bad credentials');
  } else if (token !== 'test-token') {
    // No token configured (local runs only): the contract's literal stands in.
    return errorReply(401, 'Bad credentials');
  }
  return null;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function splitPath(path: string): string[] {
  return path
    .split('/')
    .filter((part) => part !== '')
    .map(decodeSegment);
}

function parsePage(query: URLSearchParams): { perPage: number; page: number } {
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  const rawPage = Number.parseInt(query.get('page') ?? '1', 10);
  const perPage = Number.isFinite(rawPerPage) ? Math.min(100, Math.max(1, rawPerPage)) : 30;
  const page = Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1;
  return { perPage, page };
}

/** Slice one page out of a list and build the Link header for the next one. */
function paginate<T>(
  ctx: HandlerCtx,
  items: T[],
): { pageItems: T[]; headers: Record<string, string> } {
  const { perPage, page } = parsePage(ctx.query);
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const host = ctx.headers['host'] ?? '127.0.0.1';
    const params = new URLSearchParams(ctx.query);
    params.set('per_page', String(perPage));
    params.set('page', String(page + 1));
    const nextUrl = `http://${host}${ctx.path}?${params.toString()}`;
    headers['link'] = `<${nextUrl}>; rel="next"`;
  }
  return { pageItems, headers };
}

// ---------------------------------------------------------------- views

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    visibility: repo.private ? 'private' : 'public',
    fork: false,
    has_issues: true,
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
    comments: issue.comments.length,
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
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
  };
}

// ------------------------------------------------------------- git helpers

function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Resolve a ref query (?ref= / ?sha=) to a commit sha, or null when unknown. */
function resolveRef(repo: Repo, ref: string | null | undefined): string | null {
  if (ref === null || ref === undefined || ref === '') {
    return branchTip(repo, repo.default_branch) ?? null;
  }
  const asBranch = branchTip(repo, ref);
  if (asBranch !== undefined) return asBranch;
  if (ref.startsWith('refs/heads/')) {
    return repo.refs.get(ref) ?? null;
  }
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const obj = repo.objects.get(ref);
    if (obj !== undefined && obj.type === 'commit') return ref;
  }
  return null;
}

interface TreeEntry {
  path: string;
  blob: string | null; // null means the path is absent (deleted)
}

/** Walk a commit's tree into a flat path -> blob-sha map. */
function walkTree(store: Store, repo: Repo, commitSha: string): Map<string, string> {
  const out = new Map<string, string>();
  const commitObj = repo.objects.get(commitSha);
  if (commitObj === undefined || commitObj.type !== 'commit') return out;
  const parsed = store.parseCommit(commitObj.data);
  const visit = (treeSha: string, prefix: string, depth: number): void => {
    if (depth > 32) return;
    const treeObj = repo.objects.get(treeSha);
    if (treeObj === undefined || treeObj.type !== 'tree') return;
    for (const entry of store.parseTree(treeObj.data)) {
      if (entry.mode === '40000') {
        visit(entry.oid, prefix + entry.name + '/', depth + 1);
      } else {
        out.set(prefix + entry.name, entry.oid);
      }
    }
  };
  visit(parsed.tree, '', 0);
  return out;
}

/** Paths whose blob differs between two commits (added, removed, changed). */
function diffPaths(
  store: Store,
  repo: Repo,
  fromSha: string,
  toSha: string,
): Map<string, string | null> {
  const from = walkTree(store, repo, fromSha);
  const to = walkTree(store, repo, toSha);
  const changed = new Map<string, string | null>();
  for (const [path, blob] of to) {
    if (from.get(path) !== blob) changed.set(path, blob);
  }
  for (const path of from.keys()) {
    if (!to.has(path)) changed.set(path, null);
  }
  return changed;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line counts of a two-way diff, via longest-common-subsequence length. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let prev = new Array<number>(newLines.length + 1).fill(0);
  let curr = new Array<number>(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i += 1) {
    for (let j = 1; j <= newLines.length; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
    curr.fill(0);
  }
  const common = prev[newLines.length];
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

function blobText(repo: Repo, blobSha: string | null): string {
  if (blobSha === null) return '';
  const obj = repo.objects.get(blobSha);
  if (obj === undefined) return '';
  return obj.data.toString('utf8');
}

// ------------------------------------------------------------------ handler

export async function handleRest(store: Store, ctx: HandlerCtx): Promise<HandlerResponse> {
  const auth = checkAuth(ctx);
  if (auth !== null) return auth;

  const method = ctx.method.toUpperCase();
  const parts = splitPath(ctx.path);
  // parts[0] === 'api', parts[1] === 'v3'; everything after is the route.
  const route = parts.slice(2);

  // GET /api/v3 (the API root; app.ts normally answers this itself).
  if (route.length === 0) {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    return jsonReply(
      200,
      {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (route.length === 1 && route[0] === 'meta') {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    return jsonReply(200, { installed_version: INSTALLED_VERSION });
  }

  // GET /api/v3/user
  if (route.length === 1 && route[0] === 'user') {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    return jsonReply(200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
    });
  }

  // /api/v3/user/repos
  if (route.length === 2 && route[0] === 'user' && route[1] === 'repos') {
    if (method === 'GET') {
      const owned: Repo[] = [];
      for (const repo of store.repos.values()) {
        if (repo.owner === VIEWER_LOGIN) owned.push(repo);
      }
      const { pageItems, headers } = paginate(ctx, owned);
      return jsonReply(200, pageItems.map(repoView), headers);
    }
    if (method === 'POST') {
      if (hasMalformedBody(ctx)) return errorReply(400, 'Malformed JSON body');
      const body = bodyRecord(ctx);
      const name = typeof body?.['name'] === 'string' ? (body['name'] as string).trim() : '';
      if (name === '') return errorReply(422, 'Repository name is required');
      const created = store.createRepo(VIEWER_LOGIN, name, {
        private: body?.['private'] === true,
        description: typeof body?.['description'] === 'string' ? (body['description'] as string) : '',
      });
      if (created === null) return errorReply(422, 'Repository already exists');
      return jsonReply(201, repoView(created));
    }
    return errorReply(404, 'Not Found');
  }

  // Everything below lives under /api/v3/repos/{owner}/{repo}/...
  if (route.length < 3 || route[0] !== 'repos') return errorReply(404, 'Not Found');
  const owner = route[1] as string;
  const repoName = route[2] as string;
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return errorReply(404, 'Not Found');
  const rest = route.slice(3);

  // /api/v3/repos/{owner}/{repo}
  if (rest.length === 0) {
    if (method === 'GET') return jsonReply(200, repoView(repo));
    if (method === 'PATCH') {
      if (hasMalformedBody(ctx)) return errorReply(400, 'Malformed JSON body');
      const body = bodyRecord(ctx);
      if (typeof body?.['description'] === 'string') repo.description = body['description'] as string;
      if (typeof body?.['private'] === 'boolean') repo.private = body['private'] as boolean;
      return jsonReply(200, repoView(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return emptyReply(204);
    }
    return errorReply(404, 'Not Found');
  }

  const head = rest[0] as string;

  // GET /branches and GET /branches/{branch}
  if (head === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') return errorReply(404, 'Not Found');
      const branches: { name: string; commit: { sha: string } }[] = [];
      for (const [ref, sha] of repo.refs) {
        if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
      }
      branches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return jsonReply(200, branches);
    }
    if (method !== 'GET') return errorReply(404, 'Not Found');
    const branch = rest.slice(1).join('/');
    const sha = branchTip(repo, branch);
    if (sha === undefined) return errorReply(404, 'Not Found');
    return jsonReply(200, { name: branch, commit: { sha }, sha, object: { sha } });
  }

  // GET /commits[?sha=<ref>]
  if (head === 'commits' && rest.length === 1) {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    const tip = resolveRef(repo, ctx.query.get('sha'));
    if (tip === null) {
      // Unborn repo (or an unknown ref with no sha given): an empty list.
      if (ctx.query.get('sha') === null) return jsonReply(200, []);
      return errorReply(404, 'Not Found');
    }
    const shas = store.listCommits(repo, tip);
    const out = shas.map((sha) => {
      const obj = repo.objects.get(sha);
      let message = '';
      if (obj !== undefined && obj.type === 'commit') {
        message = store.parseCommit(obj.data).message.replace(/[\r\n]+$/, '');
      }
      return { sha, commit: { message } };
    });
    return jsonReply(200, out);
  }

  // /contents/{path...}
  if (head === 'contents') {
    const filePath = rest.slice(1).join('/');
    if (method === 'GET') {
      const tip = resolveRef(repo, ctx.query.get('ref'));
      if (tip === null) return errorReply(404, 'Not Found');
      const found = store.readPath(repo, tip, filePath);
      if (found === undefined) return errorReply(404, 'Not Found');
      if (found.kind === 'file') {
        const base = filePath.split('/').pop() ?? filePath;
        return jsonReply(200, {
          type: 'file',
          encoding: 'base64',
          content: found.data.toString('base64'),
          sha: found.sha,
          size: found.data.length,
          name: base,
          path: filePath,
        });
      }
      return jsonReply(200, found.entries);
    }
    if (method === 'PUT') {
      if (filePath === '') return errorReply(422, 'content path is required');
      if (hasMalformedBody(ctx)) return errorReply(400, 'Malformed JSON body');
      const body = bodyRecord(ctx);
      const contentB64 = typeof body?.['content'] === 'string' ? (body['content'] as string) : '';
      if (contentB64 === '') return errorReply(422, 'content is required');
      const message = typeof body?.['message'] === 'string' ? (body['message'] as string) : '';
      const branch = typeof body?.['branch'] === 'string' ? (body['branch'] as string) : repo.default_branch;
      const wantedSha = typeof body?.['sha'] === 'string' ? (body['sha'] as string) : null;
      let parentSha = branchTip(repo, branch);
      if (parentSha === undefined) {
        // Writing to a branch that does not exist yet starts from the
        // default branch tip (or from nothing on an unborn repo).
        parentSha = branch === repo.default_branch ? undefined : branchTip(repo, repo.default_branch);
        if (parentSha === undefined && branch !== repo.default_branch) parentSha = undefined;
      }
      const parent = parentSha ?? null;
      const current = parent === null ? undefined : store.readPath(repo, parent, filePath);
      if (wantedSha !== null) {
        if (current === undefined || current.kind !== 'file' || current.sha.toLowerCase() !== wantedSha.toLowerCase()) {
          return errorReply(409, 'The sha does not match the current blob');
        }
      }
      const existed = current !== undefined && current.kind === 'file';
      const bytes = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
      const made = store.commitPath(repo, parent, filePath, bytes, message);
      repo.refs.set(`refs/heads/${branch}`, made.commitSha);
      const base = filePath.split('/').pop() ?? filePath;
      return jsonReply(existed ? 200 : 201, {
        content: {
          name: base,
          path: filePath,
          sha: made.blobSha,
          size: bytes.length,
          type: 'file',
          encoding: 'base64',
        },
        commit: { sha: made.commitSha, message },
      });
    }
    if (method === 'DELETE') {
      if (filePath === '') return errorReply(422, 'content path is required');
      if (hasMalformedBody(ctx)) return errorReply(400, 'Malformed JSON body');
      const body = bodyRecord(ctx);
      const message = typeof body?.['message'] === 'string' ? (body['message'] as string) : '';
      const branch = typeof body?.['branch'] === 'string' ? (body['branch'] as string) : repo.default_branch;
      const wantedSha = typeof body?.['sha'] === 'string' ? (body['sha'] as string) : null;
      const parent = branchTip(repo, branch);
      if (parent === undefined) return errorReply(404, 'Not Found');
      const current = store.readPath(repo, parent, filePath);
      if (current === undefined || current.kind !== 'file') return errorReply(404, 'Not Found');
      if (wantedSha !== null && current.sha.toLowerCase() !== wantedSha.toLowerCase()) {
        return errorReply(409, 'The sha does not match the current blob');
      }
      const made = store.deletePath(repo, parent, filePath, message);
      repo.refs.set(`refs/heads/${branch}`, made.commitSha);
      return jsonReply(200, { commit: { sha: made.commitSha } });
    }
    return errorReply(404, 'Not Found');
  }

  // POST /git/refs and GET /git/refs/heads/{branch}
  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      if (hasMalformedBody(ctx)) return errorReply(400, 'Malformed JSON body');
      const body = bodyRecord(ctx);
      const ref = typeof body?.['ref'] === 'string' ? (body['ref'] as string) : '';
      const sha = typeof body?.['sha'] === 'string' ? (body['sha'] as string) : '';
      if (ref === '' || !ref.startsWith('refs/') || sha === '') {
        return errorReply(422, 'ref and sha are required');
      }
      if (repo.refs.has(ref)) return errorReply(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return jsonReply(201, { ref, object: { sha } });
    }
    if (rest.length >= 4 && rest[2] === 'heads' && method === 'GET') {
      const branch = rest.slice(3).join('/');
      const sha = branchTip(repo, branch);
      if (sha === undefined) return errorReply(404, 'Not Found');
      return jsonReply(200, { ref: `refs/heads/${branch}`, object: { sha }, sha, commit: { sha } });
    }
    return errorReply(404, 'Not Found');
  }

  // POST /labels
  if (head === 'labels' && rest.length === 1) {
    if (method !== 'POST') return errorReply(404, 'Not Found');
    if (hasMalformedBody(ctx)) return errorReply(400, 'Malformed JSON body');
    const body = bodyRecord(ctx);
    const name = typeof body?.['name'] === 'string' ? (body['name'] as string).trim() : '';
    if (name === '') return errorReply(422, 'Label name is required');
    const color = typeof body?.['color'] === 'string' ? (body['color'] as string) : 'ededed';
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return jsonReply(201, { name: label.name, color: label.color });
  }

  // /issues...
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let items: Issue[] = [];
        for (const issue of repo.issues.values()) {
          if (state === 'all' || issue.state === state) items.push(issue);
        }
        const direction = (ctx.query.get('direction') ?? 'desc').toLowerCase();
        if (direction === 'asc') {
          // Insertion order is creation order; keep it.
        } else {
          items = items.reverse();
        }
        const { pageItems, headers } = paginate(ctx, items);
        return jsonReply(200, pageItems.map(issueView), headers);
      }
      if (method === 'POST') {
        if (hasMalformedBody(ctx)) return errorReply(400, 'Malformed JSON body');
        const body = bodyRecord(ctx);
        const title = typeof body?.['title'] === 'string' ? (body['title'] as string) : '';
        if (title === '') return errorReply(422, 'Issue title is required');
        const wantedLabels = Array.isArray(body?.['labels']) ? (body?.['labels'] as unknown[]) : [];
        const labels: Label[] = [];
        for (const wanted of wantedLabels) {
          if (typeof wanted !== 'string') continue;
          const found = repo.labels.get(wanted);
          if (found === undefined) return errorReply(422, `Label "${wanted}" does not exist`);
          labels.push(found);
        }
        const issue: Issue = {
          id: store.nextIssueId,
          number: repo.nextIssue,
          title,
          body: typeof body?.['body'] === 'string' ? (body['body'] as string) : '',
          state: 'open',
          labels,
          user: { id: VIEWER_ID, login: VIEWER_LOGIN, name: VIEWER_NAME, email: VIEWER_EMAIL },
          created_at: FIXED_TS,
          updated_at: FIXED_TS,
          comments: [],
        };
        store.nextIssueId += 1;
        repo.nextIssue += 1;
        repo.issues.set(issue.number, issue);
        return jsonReply(201, issueView(issue));
      }
      return errorReply(404, 'Not Found');
    }

    const number = Number.parseInt(rest[1] as string, 10);
    if (!Number.isFinite(number)) return errorReply(404, 'Not Found');
    const issue = repo.issues.get(number);
    if (rest.length === 2) {
      if (issue === undefined) return errorReply(404, 'Not Found');
      if (method === 'GET') return jsonReply(200, issueView(issue));
      if (method === 'PATCH') {
        if (hasMalformedBody(ctx)) return errorReply(400, 'Malformed JSON body');
        const body = bodyRecord(ctx);
        if (body?.['state'] === 'open' || body?.['state'] === 'closed') issue.state = body['state'] as 'open' | 'closed';
        if (typeof body?.['title'] === 'string') issue.title = body['title'] as string;
        if (typeof body?.['body'] === 'string') issue.body = body['body'] as string;
        return jsonReply(200, issueView(issue));
      }
      return errorReply(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) return errorReply(404, 'Not Found');
      if (method === 'GET') {
        return jsonReply(
          200,
          issue.comments.map((comment) => ({ id: comment.id, body: comment.body })),
        );
      }
      if (method === 'POST') {
        if (hasMalformedBody(ctx)) return errorReply(400, 'Malformed JSON body');
        const body = bodyRecord(ctx);
        const text = typeof body?.['body'] === 'string' ? (body['body'] as string) : '';
        if (text === '') return errorReply(422, 'Comment body is required');
        const comment = { id: store.nextCommentId, body: text };
        store.nextCommentId += 1;
        issue.comments.push(comment);
        return jsonReply(201, { id: comment.id, body: comment.body });
      }
      return errorReply(404, 'Not Found');
    }
    return errorReply(404, 'Not Found');
  }

  // /pulls...
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const items: PullRequest[] = [];
        for (const pull of repo.pulls.values()) {
          if (state === 'all' || pull.state === state) items.push(pull);
        }
        const { pageItems, headers } = paginate(ctx, items);
        return jsonReply(200, pageItems.map(pullView), headers);
      }
      if (method === 'POST') {
        if (hasMalformedBody(ctx)) return errorReply(400, 'Malformed JSON body');
        const body = bodyRecord(ctx);
        const headRef = typeof body?.['head'] === 'string' ? (body['head'] as string) : '';
        const baseRef = typeof body?.['base'] === 'string' ? (body['base'] as string) : '';
        if (headRef === '' || baseRef === '') return errorReply(422, 'head and base are required');
        const headSha = branchTip(repo, headRef);
        if (headSha === undefined) return errorReply(422, `head branch "${headRef}" not found`);
        const baseSha = branchTip(repo, baseRef);
        if (baseSha === undefined) return errorReply(422, `base branch "${baseRef}" not found`);
        const pull: PullRequest = {
          id: store.nextPullId,
          number: repo.nextPull,
          title: typeof body?.['title'] === 'string' ? (body['title'] as string) : '',
          body: typeof body?.['body'] === 'string' ? (body['body'] as string) : '',
          state: 'open',
          head: { ref: headRef, sha: headSha },
          base: { ref: baseRef, sha: baseSha },
          merged: false,
          merged_at: null,
          merge_commit_sha: null,
          mergeable: true,
        };
        store.nextPullId += 1;
        repo.nextPull += 1;
        repo.pulls.set(pull.number, pull);
        return jsonReply(201, pullView(pull));
      }
      return errorReply(404, 'Not Found');
    }

    const number = Number.parseInt(rest[1] as string, 10);
    if (!Number.isFinite(number)) return errorReply(404, 'Not Found');
    const pull = repo.pulls.get(number);

    if (rest.length === 2) {
      if (pull === undefined) return errorReply(404, 'Not Found');
      if (method !== 'GET') return errorReply(404, 'Not Found');
      return jsonReply(200, pullView(pull));
    }

    if (rest.length === 3 && rest[2] === 'files') {
      if (pull === undefined) return errorReply(404, 'Not Found');
      if (method !== 'GET') return errorReply(404, 'Not Found');
      const headTip = branchTip(repo, pull.head.ref) ?? pull.head.sha;
      const changed = diffPaths(store, repo, pull.base.sha, headTip);
      const files = [...changed.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([filename, headBlob]) => {
          const baseMap = walkTree(store, repo, pull.base.sha);
          const baseBlob = baseMap.get(filename) ?? null;
          let status = 'modified';
          let additions = 0;
          let deletions = 0;
          if (baseBlob === null && headBlob !== null) {
            status = 'added';
            additions = splitLines(blobText(repo, headBlob)).length;
          } else if (baseBlob !== null && headBlob === null) {
            status = 'removed';
            deletions = splitLines(blobText(repo, baseBlob)).length;
          } else if (baseBlob !== null && headBlob !== null) {
            const diff = lineDiff(blobText(repo, baseBlob), blobText(repo, headBlob));
            additions = diff.additions;
            deletions = diff.deletions;
          }
          return { filename, status, additions, deletions, changes: additions + deletions };
        });
      return jsonReply(200, files);
    }

    if (rest.length === 3 && rest[2] === 'merge') {
      if (pull === undefined) return errorReply(404, 'Not Found');
      if (method !== 'PUT') return errorReply(404, 'Not Found');
      if (hasMalformedBody(ctx)) return errorReply(400, 'Malformed JSON body');
      if (pull.merged) return errorReply(405, 'Pull request is already merged');
      if (pull.state === 'closed') return errorReply(405, 'Pull request is closed');
      const baseRefName = `refs/heads/${pull.base.ref}`;
      const baseTipNow = repo.refs.get(baseRefName);
      if (baseTipNow === undefined) return errorReply(405, 'Base branch no longer exists');
      const headTip = branchTip(repo, pull.head.ref) ?? pull.head.sha;
      if (baseTipNow !== pull.base.sha) {
        const baseChanges = diffPaths(store, repo, pull.base.sha, baseTipNow);
        const headChanges = diffPaths(store, repo, pull.base.sha, headTip);
        for (const [path, headBlob] of headChanges) {
          if (baseChanges.has(path) && baseChanges.get(path) !== headBlob) {
            return errorReply(405, 'Merge conflict: the base branch changed the same file');
          }
        }
      }
      const mergeMessage = `${MERGE_AUTHOR} #${pull.number} from ${pull.head.ref}`;
      const headChanges = diffPaths(store, repo, pull.base.sha, headTip);
      let cursor = baseTipNow;
      for (const [path, headBlob] of [...headChanges.entries()].sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
      )) {
        if (headBlob === null) {
          cursor = store.deletePath(repo, cursor, path, mergeMessage).commitSha;
        } else {
          const obj = repo.objects.get(headBlob);
          const bytes = obj !== undefined ? obj.data : Buffer.alloc(0);
          cursor = store.commitPath(repo, cursor, path, bytes, mergeMessage).commitSha;
        }
      }
      const mergeSha = cursor;
      repo.refs.set(baseRefName, mergeSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.merged_at = FIXED_TS;
      pull.merge_commit_sha = mergeSha;
      pull.mergeable = true;
      return jsonReply(200, { merged: true, sha: mergeSha, message: mergeMessage });
    }
    return errorReply(404, 'Not Found');
  }

  return errorReply(404, 'Not Found');
}
