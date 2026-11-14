// The shared in-memory store for the github-core-clone-01 forge.
//
// Everything the four protocol lanes (git smart-HTTP, REST v3, GraphQL v4, MCP)
// read and write lives here: repositories, their git object databases, refs,
// labels, issues, comments and pull requests. All state is deterministic —
// fixed timestamps, fixed identities, counters only — so two runs of the
// same request sequence produce byte-identical stored state.
//
// Git objects are kept verbatim: the raw bytes a client pushed are the bytes
// a later fetch returns, never re-encoded. Object identity is the SHA-1 of
// "<type> <len>\0<data>", exactly as git computes it.

import { createHash } from 'node:crypto';
import { deflateSync as zlibDeflate } from 'node:zlib';

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

// The token owner and the two other fixed actors. The bearer token is
// opaque, so the entry hard-codes these identities and treats the exact
// token value as the viewer credential (see the conformance spec §1).
export const VIEWER: User = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};
export const TEAMMATE: User = {
  id: 1001,
  login: 'quinnkeller',
  name: 'quinn keller',
  email: 'quinnkeller@example.invalid',
};
export const STRANGER: User = {
  id: 1002,
  login: 'olgabauer',
  name: 'olga bauer',
  email: 'olgabauer@example.invalid',
};

// Deterministic timestamps: every stored record pretends it was created at
// the scenario epoch, and every server-made git commit at the fixed git time.
export const FIXED_TS = '2025-01-01T00:00:00Z';
export const FIXED_GIT_TS = 1700000000;

const GIT_IDENTITY = 'Conformance <conformance@make.fun>';
const GIT_TZ = '+0000';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer; // raw bytes, stored verbatim, never re-encoded
  deflated?: Buffer; // zlib bytes, filled lazily on first use and then reused
}

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: User;
  created_at: string;
  updated_at: string;
  comments: IssueComment[];
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  mergeable: boolean;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  refs: Map<string, string>; // full refname ('refs/heads/main') -> sha
  objects: Map<string, GitObject>; // sha1 hex -> object
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  nextIssue: number;
  pulls: Map<number, PullRequest>;
  nextPull: number;
}

export interface HandlerResponse {
  status: number;
  headers?: Record<string, string>;
  body: Buffer | string; // Buffer for binary (git), string otherwise
  contentType?: string; // default 'application/json; charset=utf-8'
}

export interface HandlerCtx {
  method: string;
  path: string; // pathname, no query
  query: URLSearchParams;
  headers: Record<string, string>; // lower-cased names
  body: Buffer; // raw request body (empty Buffer if none)
  json: unknown; // parsed JSON body, or undefined if empty/invalid (caller checks)
  params: Record<string, string>; // route params filled by app.ts
  token: string | null; // bearer token or null
}

/** SHA-1 of the git object header + payload, hex-encoded. */
export function objectSha(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Deflate an object's bytes once and cache the result on the object. */
export function deflatedBytes(obj: GitObject): Buffer {
  if (obj.deflated === undefined) {
    obj.deflated = zlibDeflate(obj.data);
  }
  return obj.deflated;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export type PathLookup =
  | { kind: 'file'; sha: string; data: Buffer }
  | {
      kind: 'dir';
      entries: { name: string; path: string; sha: string; type: 'file' | 'dir' }[];
    }
  | undefined;

function splitLines(text: string): string[] {
  return text.split('\n');
}

/** Unix timestamp carried by an author/committer line, or 0 if unparseable. */
function identityTimestamp(line: string): number {
  const parts = line.trim().split(/\s+/);
  const ts = Number(parts[parts.length - 2]);
  return Number.isFinite(ts) ? ts : 0;
}

/** Git tree ordering: names compared byte-wise, directories as name + '/'. */
function treeSortKey(mode: string, name: string): string {
  return mode === '40000' ? `${name}/` : name;
}

export class Store {
  repos: Map<string, Repo> = new Map();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;
  viewer: User = VIEWER;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(
    owner: string,
    name: string,
    opts: { private?: boolean; description?: string },
  ): Repo | null {
    const k = this.key(owner, name);
    if (this.repos.has(k)) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      full_name: k,
      description: opts.description ?? '',
      private: opts.private ?? false,
      default_branch: 'main',
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      nextIssue: 1,
      pulls: new Map(),
      nextPull: 1,
    };
    this.repos.set(k, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  // --- git object helpers ---

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const sha = objectSha(type, data);
    if (!repo.objects.has(sha)) {
      repo.objects.set(sha, { type, data });
    }
    return sha;
  }

  getObject(repo: Repo, sha: string): GitObject | undefined {
    return repo.objects.get(sha.toLowerCase());
  }

  parseCommit(data: Buffer): ParsedCommit {
    const text = data.toString('utf8');
    const splitAt = text.indexOf('\n\n');
    const head = splitAt === -1 ? text : text.slice(0, splitAt);
    const message = splitAt === -1 ? '' : text.slice(splitAt + 2);
    let tree = '';
    const parents: string[] = [];
    let author = '';
    let committer = '';
    for (const line of splitLines(head)) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
      else if (line.startsWith('author ')) author = line.slice(7);
      else if (line.startsWith('committer ')) committer = line.slice(10);
    }
    return { tree, parents, author, committer, message };
  }

  parseTree(data: Buffer): TreeEntry[] {
    const out: TreeEntry[] = [];
    let i = 0;
    while (i < data.length) {
      const space = data.indexOf(0x20, i);
      if (space === -1) break;
      const nul = data.indexOf(0x00, space + 1);
      if (nul === -1 || nul + 21 > data.length) break;
      const mode = data.subarray(i, space).toString('utf8');
      const name = data.subarray(space + 1, nul).toString('utf8');
      const oid = data.subarray(nul + 1, nul + 21).toString('hex');
      out.push({ mode, name, oid });
      i = nul + 21;
    }
    return out;
  }

  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack: string[] = [descendant];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = this.getObject(repo, sha);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of this.parseCommit(obj.data).parents) {
        if (!seen.has(parent)) stack.push(parent);
      }
    }
    return false;
  }

  listCommits(repo: Repo, tipSha: string): string[] {
    // Walk the commit graph from the tip, remembering first-seen order,
    // then order newest-first by commit timestamp (ties keep discovery order).
    const order: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tipSha];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = this.getObject(repo, sha);
      if (obj === undefined || obj.type !== 'commit') continue;
      order.push(sha);
      const parents = this.parseCommit(obj.data).parents;
      for (let i = parents.length - 1; i >= 0; i--) {
        if (!seen.has(parents[i])) stack.push(parents[i]);
      }
    }
    const stamp = new Map<string, number>();
    for (const sha of order) {
      const obj = this.getObject(repo, sha);
      stamp.set(sha, obj ? identityTimestamp(this.parseCommit(obj.data).committer) : 0);
    }
    return order
      .map((sha, idx) => ({ sha, idx, ts: stamp.get(sha) ?? 0 }))
      .sort((a, b) => b.ts - a.ts || a.idx - b.idx)
      .map((entry) => entry.sha);
  }

  readPath(repo: Repo, commitSha: string, path: string): PathLookup {
    const commit = this.getObject(repo, commitSha);
    if (commit === undefined || commit.type !== 'commit') return undefined;
    const rootTree = this.parseCommit(commit.data).tree;
    const segments = path.split('/').filter((part) => part.length > 0);
    let treeSha = rootTree;
    for (let depth = 0; depth < segments.length; depth++) {
      const treeObj = this.getObject(repo, treeSha);
      if (treeObj === undefined || treeObj.type !== 'tree') return undefined;
      const entries = this.parseTree(treeObj.data);
      const hit = entries.find((entry) => entry.name === segments[depth]);
      if (hit === undefined) return undefined;
      const last = depth === segments.length - 1;
      if (last) {
        if (hit.mode === '40000') {
          const sub = this.getObject(repo, hit.oid);
          if (sub === undefined || sub.type !== 'tree') return undefined;
          return {
            kind: 'dir',
            entries: this.parseTree(sub.data)
              .map((entry) => ({
                name: entry.name,
                path: [...segments, entry.name].join('/'),
                sha: entry.oid,
                type: (entry.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
              }))
              .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
          };
        }
        const blob = this.getObject(repo, hit.oid);
        if (blob === undefined || blob.type !== 'blob') return undefined;
        return { kind: 'file', sha: hit.oid, data: blob.data };
      }
      if (hit.mode !== '40000') return undefined;
      treeSha = hit.oid;
    }
    // Empty path (or '/'): the root directory itself.
    const root = this.getObject(repo, rootTree);
    if (root === undefined || root.type !== 'tree') return undefined;
    return {
      kind: 'dir',
      entries: this.parseTree(root.data)
        .map((entry) => ({
          name: entry.name,
          path: entry.name,
          sha: entry.oid,
          type: (entry.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    };
  }

  /** Rebuild the tree chain for one path write, bottom-up. */
  private rebuildTrees(
    repo: Repo,
    baseTreeSha: string | null,
    segments: string[],
    leaf: TreeEntry,
  ): string {
    if (segments.length === 0) {
      // Should not happen (a write always has a leaf name); guard anyway.
      return baseTreeSha ?? this.putObject(repo, 'tree', Buffer.alloc(0));
    }
    if (segments.length === 1) {
      const entries = this.treeEntriesOf(repo, baseTreeSha);
      const next = entries.filter((entry) => entry.name !== segments[0]);
      next.push(leaf);
      return this.writeTree(repo, next);
    }
    const entries = this.treeEntriesOf(repo, baseTreeSha);
    const child = entries.find(
      (entry) => entry.name === segments[0] && entry.mode === '40000',
    );
    const childSha = this.rebuildTrees(
      repo,
      child ? child.oid : null,
      segments.slice(1),
      leaf,
    );
    const next = entries.filter((entry) => entry.name !== segments[0]);
    next.push({ mode: '40000', name: segments[0], oid: childSha });
    return this.writeTree(repo, next);
  }

  /** Rebuild the tree chain with one path removed; prunes dirs left empty. */
  private removeFromTrees(
    repo: Repo,
    baseTreeSha: string | null,
    segments: string[],
  ): string | null {
    if (baseTreeSha === null || segments.length === 0) return baseTreeSha;
    const entries = this.treeEntriesOf(repo, baseTreeSha);
    if (segments.length === 1) {
      const next = entries.filter((entry) => entry.name !== segments[0]);
      if (next.length === 0) return null;
      return this.writeTree(repo, next);
    }
    const child = entries.find(
      (entry) => entry.name === segments[0] && entry.mode === '40000',
    );
    if (child === undefined) return baseTreeSha;
    const childSha = this.removeFromTrees(repo, child.oid, segments.slice(1));
    const next = entries.filter((entry) => entry.name !== segments[0]);
    if (childSha !== null) {
      next.push({ mode: '40000', name: segments[0], oid: childSha });
    }
    if (next.length === 0) return null;
    return this.writeTree(repo, next);
  }

  private treeEntriesOf(repo: Repo, treeSha: string | null): TreeEntry[] {
    if (treeSha === null) return [];
    const obj = this.getObject(repo, treeSha);
    if (obj === undefined || obj.type !== 'tree') return [];
    return this.parseTree(obj.data);
  }

  private writeTree(repo: Repo, entries: TreeEntry[]): string {
    const sorted = [...entries].sort((a, b) => {
      const ka = treeSortKey(a.mode, a.name);
      const kb = treeSortKey(b.mode, b.name);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const chunks: Buffer[] = [];
    for (const entry of sorted) {
      chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
      chunks.push(Buffer.from(entry.oid, 'hex'));
    }
    return this.putObject(repo, 'tree', Buffer.concat(chunks));
  }

  private buildCommitObject(
    repo: Repo,
    treeSha: string,
    parentSha: string | null,
    message: string,
  ): string {
    const body = message.endsWith('\n') ? message : `${message}\n`;
    const lines: string[] = [`tree ${treeSha}`];
    if (parentSha !== null) lines.push(`parent ${parentSha}`);
    lines.push(`author ${GIT_IDENTITY} ${FIXED_GIT_TS} ${GIT_TZ}`);
    lines.push(`committer ${GIT_IDENTITY} ${FIXED_GIT_TS} ${GIT_TZ}`);
    const text = `${lines.join('\n')}\n\n${body}`;
    return this.putObject(repo, 'commit', Buffer.from(text, 'utf8'));
  }

  commitPath(
    repo: Repo,
    parentSha: string | null,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string } {
    const segments = path.split('/').filter((part) => part.length > 0);
    if (segments.length === 0) throw new Error('commitPath needs a non-empty path');
    const blobSha = this.putObject(repo, 'blob', content);
    const baseTree =
      parentSha === null
        ? null
        : this.parseCommit(this.getObject(repo, parentSha)?.data ?? Buffer.alloc(0)).tree;
    const rootTree = this.rebuildTrees(repo, baseTree, segments, {
      mode: '100644',
      name: segments[segments.length - 1],
      oid: blobSha,
    });
    const commitSha = this.buildCommitObject(repo, rootTree, parentSha, message);
    return { commitSha, blobSha };
  }

  deletePath(
    repo: Repo,
    parentSha: string,
    path: string,
    message: string,
  ): { commitSha: string } {
    const segments = path.split('/').filter((part) => part.length > 0);
    if (segments.length === 0) throw new Error('deletePath needs a non-empty path');
    const parentObj = this.getObject(repo, parentSha);
    if (parentObj === undefined || parentObj.type !== 'commit') {
      throw new Error('deletePath needs an existing parent commit');
    }
    const baseTree = this.parseCommit(parentObj.data).tree;
    const rootTree = this.removeFromTrees(repo, baseTree, segments);
    const finalTree =
      rootTree ?? this.putObject(repo, 'tree', Buffer.alloc(0));
    const commitSha = this.buildCommitObject(repo, finalTree, parentSha, message);
    return { commitSha };
  }
}
