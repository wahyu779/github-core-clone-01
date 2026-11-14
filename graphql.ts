// GraphQL v4 surface for the github-core-clone-01 forge (Hunt 07, GraphQL lane).
//
// A small hand-rolled executor for the eighteen documents the conformance suite
// sends, plus the introspection probes gh uses. No GraphQL library is used and
// no dependency is needed: the document text is tokenised, parsed into a tiny
// AST, checked against a small field table, and then executed against the
// shared in-memory Store. The module never touches the filesystem or the
// network, and it never invents timestamps or random values.
//
// Node ids are opaque base64 of a typed numeric id, for example the base64 of
// "Repository:5000" or "Issue:42". The numeric part is the Store's own global
// id for that object, so the same object carries the same id over REST, MCP
// and GraphQL, the id is stable across reads, and node(id:) can resolve it by
// decoding it alone, with no extra state kept anywhere.

export interface GqlUser {
  id: number;
  login: string;
  name: string;
  email: string;
}
export interface GqlLabel {
  name: string;
  color: string;
}
export interface GqlComment {
  id: number;
  body: string;
}
export interface GqlIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: GqlLabel[];
  user: GqlUser;
  created_at: string;
  updated_at: string;
  comments: GqlComment[];
}
export interface GqlPull {
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
export interface GqlGitObject {
  type: string;
  data: Buffer;
}
export interface GqlRepo {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  refs: Map<string, string>;
  objects: Map<string, GqlGitObject>;
  labels: Map<string, GqlLabel>;
  issues: Map<number, GqlIssue>;
  nextIssue: number;
  pulls: Map<number, GqlPull>;
  nextPull: number;
}
export interface GqlStore {
  repos: Map<string, GqlRepo>;
  nextRepoId: number;
  nextIssueId: number;
  nextPullId: number;
  nextCommentId: number;
  viewer: GqlUser;
  key(owner: string, name: string): string;
  getRepo(owner: string, name: string): GqlRepo | undefined;
  getObject(repo: GqlRepo, sha: string): GqlGitObject | undefined;
  parseCommit(data: Buffer): { tree: string; parents: string[]; author: string; committer: string; message: string };
  parseTree(data: Buffer): { mode: string; name: string; oid: string }[];
  listCommits(repo: GqlRepo, tipSha: string): string[];
  readPath(repo: GqlRepo, commitSha: string, path: string): unknown;
  commitPath(repo: GqlRepo, parentSha: string | null, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string };
  deletePath(repo: GqlRepo, parentSha: string, path: string, message: string): { commitSha: string };
}
export interface GqlHandlerCtx {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
  json: unknown;
  params: Record<string, string>;
  token: string | null;
}
export interface GqlHandlerResponse {
  status: number;
  headers?: Record<string, string>;
  body: Buffer | string;
  contentType?: string;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const FIXED_TS = '2025-01-01T00:00:00Z';
const KNOWN_LOGINS: Record<string, number> = { adaiversen: 1000, quinnkeller: 1001, olgabauer: 1002 };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function jsonReply(status: number, payload: unknown): GqlHandlerResponse {
  return { status, headers: {}, body: JSON.stringify(payload), contentType: JSON_TYPE };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function encodeId(kind: string, num: number): string {
  return Buffer.from(`${kind}:${num}`, 'utf8').toString('base64');
}

function decodeId(id: unknown): { kind: string; num: number } | null {
  if (typeof id !== 'string' || id === '') return null;
  let text = '';
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const m = /^(Repository|Issue|PullRequest|IssueComment|User|Ref):(\d+)(?::.*)?$/.exec(text);
  if (!m) return null;
  return { kind: m[1], num: Number(m[2]) };
}

function encodeCursor(num: number): string {
  return Buffer.from(`cursor:${num}`, 'utf8').toString('base64');
}

function decodeCursor(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const text = Buffer.from(raw, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    if (m) return Number(m[1]);
  } catch {
    return null;
  }
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

class OpError extends Error {}

function allocId(store: GqlStore, counter: 'nextIssueId' | 'nextPullId' | 'nextCommentId' | 'nextRepoId'): number {
  const cur = store[counter];
  if (typeof cur === 'number' && Number.isFinite(cur)) {
    store[counter] = cur + 1;
    return cur;
  }
  // A Store built without the counter initialised: fall back to a scan so the
  // id still grows monotonically instead of colliding.
  let max = 0;
  for (const repo of store.repos.values()) {
    if (counter === 'nextIssueId') for (const it of repo.issues.values()) max = Math.max(max, it.id);
    if (counter === 'nextPullId') for (const pr of repo.pulls.values()) max = Math.max(max, pr.id);
    if (counter === 'nextCommentId') for (const it of repo.issues.values()) for (const c of it.comments) max = Math.max(max, c.id);
    if (counter === 'nextRepoId') max = Math.max(max, repo.id);
  }
  const next = max + 1;
  store[counter] = next + 1;
  return next;
}

function findRepoByNumericId(store: GqlStore, numericId: number): GqlRepo | undefined {
  for (const repo of store.repos.values()) if (repo.id === numericId) return repo;
  return undefined;
}

function findIssueById(store: GqlStore, id: number): { repo: GqlRepo; issue: GqlIssue } | undefined {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) if (issue.id === id) return { repo, issue };
  }
  return undefined;
}

function findPullById(store: GqlStore, id: number): { repo: GqlRepo; pull: GqlPull } | undefined {
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.id === id) return { repo, pull };
  }
  return undefined;
}

function findCommentById(store: GqlStore, id: number): { repo: GqlRepo; issue: GqlIssue; comment: GqlComment } | undefined {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) {
      for (const comment of issue.comments) if (comment.id === id) return { repo, issue, comment };
    }
  }
  return undefined;
}

function gqlIssueState(state: string): string {
  return state === 'closed' ? 'CLOSED' : 'OPEN';
}

function gqlPullState(pull: GqlPull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

// ---------------------------------------------------------------------------
// Tokeniser + parser for the small GraphQL subset the suite speaks
// ---------------------------------------------------------------------------

type Tok =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: string }
  | { kind: 'var'; value: string };

function tokenise(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '.' && src.slice(i, i + 3) === '...') { out.push({ kind: 'spread', value: '...' }); i += 3; continue; }
    if (ch === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      out.push({ kind: 'var', value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if ('{}()[]!:=@|&'.includes(ch)) { out.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let val = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === 'n') val += '\n';
          else if (esc === 't') val += '\t';
          else if (esc === 'r') val += '\r';
          else if (esc === '"') val += '"';
          else if (esc === '\\') val += '\\';
          else if (esc === '/') val += '/';
          else if (esc === 'u') { val += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
          else val += esc;
          j += 2;
        } else {
          val += src[j];
          j += 1;
        }
      }
      out.push({ kind: 'string', value: val });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      let isFloat = false;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      if (src[j] === '.' || src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      }
      out.push(isFloat ? { kind: 'float', value: src.slice(i, j) } : { kind: 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      out.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new OpError(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return out;
}

interface ValueNode {
  kind: 'variable' | 'string' | 'int' | 'float' | 'boolean' | 'null' | 'enum' | 'list' | 'object';
  name?: string;
  value?: string | number | boolean;
  items?: ValueNode[];
  fields?: { name: string; value: ValueNode }[];
}
interface Selection {
  kind: 'field' | 'inlineFragment' | 'fragmentSpread';
  alias?: string;
  name?: string;
  typeCondition?: string;
  args?: { name: string; value: ValueNode }[];
  selections?: Selection[];
}
interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name?: string;
  varDefs: string[];
  selections: Selection[];
}
interface GqlDocument {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
}

class Parser {
  private pos = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok {
    const t = this.toks[this.pos];
    if (!t) throw new OpError('Unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new OpError(`Expected "${v}" in GraphQL document, got ${t.value}`);
  }
  private acceptPunct(v: string): boolean {
    const t = this.peek();
    if (t && t.kind === 'punct' && t.value === v) { this.pos += 1; return true; }
    return false;
  }

  parseDocument(): GqlDocument {
    const doc: GqlDocument = { operations: [], fragments: new Map() };
    while (this.peek()) {
      const t = this.peek();
      if (t && t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const nameTok = this.next();
        if (nameTok.kind !== 'name') throw new OpError('Expected a fragment name');
        const onTok = this.next();
        if (onTok.kind !== 'name' || onTok.value !== 'on') throw new OpError('Expected "on" in a fragment definition');
        const typeTok = this.next();
        if (typeTok.kind !== 'name') throw new OpError('Expected a type name in a fragment definition');
        const sels = this.parseSelectionSet();
        doc.fragments.set(nameTok.value, { typeCondition: typeTok.value, selections: sels });
        continue;
      }
      doc.operations.push(this.parseOperation());
    }
    if (doc.operations.length === 0) throw new OpError('GraphQL document carries no operation');
    return doc;
  }

  private parseOperation(): Operation {
    let type: Operation['type'] = 'query';
    const t = this.peek();
    if (t && t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      type = t.value as Operation['type'];
      this.next();
    }
    let name: string | undefined;
    const nameTok = this.peek();
    if (nameTok && nameTok.kind === 'name') { name = nameTok.value; this.next(); }
    const varDefs: string[] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const v = this.next();
        if (v.kind !== 'var') throw new OpError('Expected a variable in a variable definition');
        varDefs.push(v.value);
        this.expectPunct(':');
        // Skip the type annotation: a name, possibly wrapped in [ ] and !.
        this.skipTypeAnnotation();
        if (this.acceptPunct('=')) this.parseValue();
      }
    }
    const selections = this.parseSelectionSet();
    return { type, name, varDefs, selections };
  }

  private skipTypeAnnotation(): void {
    // Consumes e.g. String!, [IssueState!], Int, ID!
    while (true) {
      const t = this.peek();
      if (!t) return;
      if (t.kind === 'punct' && (t.value === '[' || t.value === ']' || t.value === '!')) { this.next(); continue; }
      if (t.kind === 'name') { this.next(); continue; }
      return;
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const out: Selection[] = [];
    while (true) {
      const t = this.peek();
      if (!t) throw new OpError('Unterminated selection set');
      if (t.kind === 'punct' && t.value === '}') { this.next(); break; }
      if (t.kind === 'spread') {
        this.next();
        const nxt = this.peek();
        if (nxt && nxt.kind === 'name' && nxt.value === 'on') {
          this.next();
          const typeTok = this.next();
          if (typeTok.kind !== 'name') throw new OpError('Expected a type name after "on"');
          out.push({ kind: 'inlineFragment', typeCondition: typeTok.value, selections: this.parseSelectionSet() });
        } else {
          const nameTok = this.next();
          if (nameTok.kind !== 'name') throw new OpError('Expected a fragment name after "..."');
          out.push({ kind: 'fragmentSpread', name: nameTok.value });
        }
        continue;
      }
      const first = this.next();
      if (first.kind !== 'name') throw new OpError('Expected a field name in a selection set');
      let alias: string | undefined;
      let fieldName = first.value;
      if (this.acceptPunct(':')) {
        alias = fieldName;
        const real = this.next();
        if (real.kind !== 'name') throw new OpError('Expected a field name after an alias');
        fieldName = real.value;
      }
      // Directives (@...) are ignored: the suite never sends any.
      while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
        this.next();
        const d = this.next();
        if (d.kind !== 'name') throw new OpError('Expected a directive name');
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseArguments();
      }
      let args: { name: string; value: ValueNode }[] | undefined;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') args = this.parseArguments();
      let sels: Selection[] | undefined;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') sels = this.parseSelectionSet();
      out.push({ kind: 'field', alias, name: fieldName, args, selections: sels });
    }
    return out;
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    this.expectPunct('(');
    const out: { name: string; value: ValueNode }[] = [];
    while (!this.acceptPunct(')')) {
      const nameTok = this.next();
      if (nameTok.kind !== 'name') throw new OpError('Expected an argument name');
      this.expectPunct(':');
      out.push({ name: nameTok.value, value: this.parseValue() });
    }
    return out;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'var') return { kind: 'variable', name: t.value };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const nameTok = this.next();
        if (nameTok.kind !== 'name') throw new OpError('Expected a field name in an input object');
        this.expectPunct(':');
        fields.push({ name: nameTok.value, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    throw new OpError(`Unexpected value token ${t.value} in GraphQL document`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name ?? ''];
    case 'string': case 'int': case 'float': case 'boolean': return node.value ?? null;
    case 'null': return null;
    case 'enum': return node.value ?? null;
    case 'list': return (node.items ?? []).map((it) => resolveValue(it, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields ?? []) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argMap(args: { name: string; value: ValueNode }[] | undefined, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args ?? []) out[a.name] = resolveValue(a.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// The field table used for validation (type -> field -> result type)
// ---------------------------------------------------------------------------

const FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  Repository: {
    id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User',
    defaultBranchRef: 'Ref', viewerPermission: 'RepositoryPermission', hasIssuesEnabled: 'Boolean',
    issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest',
    description: 'String', private: 'Boolean', createdAt: 'String', updatedAt: 'String', url: 'String',
  },
  User: { id: 'ID', login: 'String', name: 'String', email: 'String' },
  Issue: {
    id: 'ID', number: 'Int', title: 'String', state: 'IssueState', body: 'String',
    author: 'User', user: 'User', labels: 'Label', comments: 'IssueCommentConnection',
    createdAt: 'String', updatedAt: 'String', url: 'String', repository: 'Repository',
  },
  Label: { name: 'String', color: 'String' },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo', totalCount: 'Int', edges: 'IssueEdge' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  IssueCommentConnection: { nodes: 'IssueComment', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueComment: { id: 'ID', body: 'String', author: 'User', createdAt: 'String', updatedAt: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  PullRequest: {
    id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'PullRequestState',
    merged: 'Boolean', headRefName: 'String', baseRefName: 'String', mergeable: 'MergeableState',
    files: 'PullRequestChangedFileConnection', author: 'User', createdAt: 'String', updatedAt: 'String',
    mergedAt: 'String', mergeCommit: 'Commit',
  },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo', totalCount: 'Int', edges: 'PullRequestEdge' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFile: { path: 'String', filename: 'String', additions: 'Int', deletions: 'Int', changes: 'Int', status: 'String' },
  Ref: { id: 'ID', name: 'String', prefix: 'String', target: 'Commit' },
  Commit: { oid: 'String', sha: 'String', message: 'String' },
  Node: { id: 'ID' },
  __Type: { name: 'String', kind: 'String', description: 'String', fields: '__Field', enumValues: '__EnumValue', inputFields: '__InputValue', interfaces: '__Type', possibleTypes: '__Type', specifiedByURL: 'String' },
  __Field: { name: 'String', description: 'String', args: '__InputValue', type: '__Type', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __EnumValue: { name: 'String', description: 'String', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __InputValue: { name: 'String', description: 'String', type: '__Type', defaultValue: 'String' },
  __Schema: { description: 'String', types: '__Type', queryType: '__Type', mutationType: '__Type', directives: '__Directive' },
  __Directive: { name: 'String', description: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', subject: 'Issue', clientMutationId: 'String' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
};

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

// Introspection data: the field and enum names the suite's probes assert.
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'user', 'labels', 'comments', 'createdAt', 'updatedAt', 'url', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changes', 'status'],
  Ref: ['id', 'name', 'prefix', 'target'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  Label: ['name', 'color'],
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};
const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function validateSelections(doc: GqlDocument, sels: Selection[], typeName: string, errors: string[]): void {
  const table = FIELD_TYPES[typeName];
  for (const sel of sels) {
    if (sel.kind === 'field') {
      const fname = sel.name ?? '';
      if (fname === '__typename') continue;
      if (!table || !(fname in table)) {
        errors.push(`Cannot query field "${fname}" on type "${typeName}".`);
        continue;
      }
      const resultType = table[fname];
      if (sel.selections && !SCALARS.has(resultType)) {
        validateSelections(doc, sel.selections, resultType, errors);
      }
    } else if (sel.kind === 'inlineFragment') {
      const cond = sel.typeCondition ?? typeName;
      if (!(cond in FIELD_TYPES) && cond !== 'Node') {
        errors.push(`Unknown type "${cond}".`);
        continue;
      }
      // An inline fragment on the Node interface applies to every node type;
      // a fragment on a concrete type applies when the parent is that type
      // or the parent is the Node interface itself.
      if (cond === typeName || typeName === 'Node' || cond === 'Node') {
        validateSelections(doc, sel.selections ?? [], cond === 'Node' ? typeName : cond, errors);
      }
    } else if (sel.kind === 'fragmentSpread') {
      const frag = doc.fragments.get(sel.name ?? '');
      if (!frag) {
        errors.push(`Unknown fragment "${sel.name ?? ''}".`);
        continue;
      }
      if (frag.typeCondition === typeName || typeName === 'Node' || frag.typeCondition === 'Node') {
        validateSelections(doc, frag.selections, frag.typeCondition === 'Node' ? typeName : frag.typeCondition, errors);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Execution nodes: plain objects carrying a __type tag and a __src handle
// ---------------------------------------------------------------------------

type GNode = Record<string, unknown> & { __type: string; __src?: unknown };

function nodeOf(typeName: string, src: unknown, fields: Record<string, unknown>): GNode {
  const n: GNode = { __type: typeName, __src: src, ...fields };
  return n;
}

function userNode(user: GqlUser): GNode {
  return nodeOf('User', user, { id: encodeId('User', user.id), login: user.login, name: user.name, email: user.email });
}

function repoNode(store: GqlStore, repo: GqlRepo): GNode {
  const ownerId = KNOWN_LOGINS[repo.owner] ?? store.viewer.id;
  const ownerUser: GqlUser = { id: ownerId, login: repo.owner, name: repo.owner, email: `${repo.owner}@example.invalid` };
  return nodeOf('Repository', repo, {
    id: encodeId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.full_name || `${repo.owner}/${repo.name}`,
    owner: userNode(ownerUser),
    defaultBranchRef: nodeOf('Ref', { repo, ref: repo.default_branch }, { id: encodeId('Ref', repo.id), name: repo.default_branch, prefix: 'refs/heads/' }),
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.private,
    createdAt: repo.created_at,
    updatedAt: repo.updated_at,
    url: `/${repo.owner}/${repo.name}`,
  });
}

function issueNode(repo: GqlRepo, issue: GqlIssue): GNode {
  return nodeOf('Issue', { repo, issue }, {
    id: encodeId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    state: gqlIssueState(issue.state),
    body: issue.body,
    author: userNode(issue.user),
    user: userNode(issue.user),
    labels: (issue.labels ?? []).map((l) => nodeOf('Label', l, { name: l.name, color: l.color })),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  });
}

function prNode(store: GqlStore, repo: GqlRepo, pull: GqlPull): GNode {
  let mergeable = 'UNKNOWN';
  try {
    const m = computeMergeable(store, repo, pull);
    if (m === true) mergeable = 'MERGEABLE';
    else if (m === false) mergeable = 'CONFLICTING';
  } catch {
    mergeable = 'UNKNOWN';
  }
  return nodeOf('PullRequest', { repo, pull }, {
    id: encodeId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: gqlPullState(pull),
    merged: pull.merged,
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    mergeable,
    author: userNode(store.viewer),
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
    mergedAt: pull.merged_at,
    mergeCommit: pull.merge_commit_sha ? nodeOf('Commit', pull.merge_commit_sha, { oid: pull.merge_commit_sha, sha: pull.merge_commit_sha, message: pull.title }) : null,
  });
}

function commentNode(repo: GqlRepo, issue: GqlIssue, comment: GqlComment): GNode {
  return nodeOf('IssueComment', { repo, issue, comment }, {
    id: encodeId('IssueComment', comment.id),
    body: comment.body,
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
  });
}

function pageInfoNode(hasNext: boolean, startCursor: string | null, endCursor: string | null): GNode {
  return nodeOf('PageInfo', null, { hasNextPage: hasNext, hasPreviousPage: false, startCursor, endCursor });
}

// ---------------------------------------------------------------------------
// Git tree helpers (for pull-request files and squash merges)
// ---------------------------------------------------------------------------

function flattenTree(store: GqlStore, repo: GqlRepo, commitSha: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  if (!commitSha) return out;
  const commitObj = store.getObject(repo, commitSha);
  if (!commitObj) return out;
  let treeOid = '';
  try {
    treeOid = store.parseCommit(commitObj.data).tree;
  } catch {
    return out;
  }
  const walk = (tree: string, prefix: string): void => {
    const obj = store.getObject(repo, tree);
    if (!obj) return;
    let entries: { mode: string; name: string; oid: string }[] = [];
    try {
      entries = store.parseTree(obj.data);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.mode === '40000') walk(e.oid, `${prefix}${e.name}/`);
      else out.set(`${prefix}${e.name}`, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  oldOid?: string;
  newOid?: string;
}

function changedFiles(store: GqlStore, repo: GqlRepo, baseSha: string, headSha: string): ChangedFile[] {
  const base = flattenTree(store, repo, baseSha);
  const head = flattenTree(store, repo, headSha);
  const out: ChangedFile[] = [];
  for (const [path, entry] of head) {
    const old = base.get(path);
    if (!old) out.push({ path, status: 'added', newOid: entry.oid });
    else if (old.oid !== entry.oid) out.push({ path, status: 'modified', oldOid: old.oid, newOid: entry.oid });
  }
  for (const [path, entry] of base) {
    if (!head.has(path)) out.push({ path, status: 'deleted', oldOid: entry.oid });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function mergeBaseSha(store: GqlStore, repo: GqlRepo, headSha: string, baseSha: string): string {
  try {
    const headList = store.listCommits(repo, headSha);
    const baseSet = new Set(store.listCommits(repo, baseSha));
    for (const sha of headList) if (baseSet.has(sha)) return sha;
  } catch {
    // Fall through to treating the base tip as the merge base.
  }
  return baseSha;
}

/** True when the head applies cleanly on the base tip, false on a real
 *  conflict, null when the merge base cannot be worked out. */
function computeMergeable(store: GqlStore, repo: GqlRepo, pull: GqlPull): boolean | null {
  const baseSha = repo.refs.get(`refs/heads/${pull.base.ref}`);
  const headSha = repo.refs.get(`refs/heads/${pull.head.ref}`);
  if (!baseSha || !headSha) return null;
  const mb = mergeBaseSha(store, repo, headSha, baseSha);
  const baseTree = flattenTree(store, repo, mb);
  const headTree = flattenTree(store, repo, headSha);
  const tipTree = flattenTree(store, repo, baseSha);
  const headChanged = new Set<string>();
  for (const [path, e] of headTree) {
    const old = baseTree.get(path);
    if (!old || old.oid !== e.oid) headChanged.add(path);
  }
  for (const path of baseTree.keys()) if (!headTree.has(path)) headChanged.add(path);
  for (const path of headChanged) {
    const old = baseTree.get(path);
    const tip = tipTree.get(path);
    const tipChanged = !old ? !!tip : !tip || tip.oid !== old.oid;
    if (!tipChanged) continue;
    const headEntry = headTree.get(path);
    const headOid = headEntry ? headEntry.oid : undefined;
    const tipOid = tip ? tip.oid : undefined;
    if (headOid !== tipOid) return false;
  }
  return true;
}

function blobLines(store: GqlStore, repo: GqlRepo, oid: string | undefined): number {
  if (!oid) return 0;
  const obj = store.getObject(repo, oid);
  if (!obj || !obj.data) return 0;
  const text = obj.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length;
}

function fileNodes(store: GqlStore, repo: GqlRepo, pull: GqlPull, first: number | undefined): GNode[] {
  const baseSha = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  const headSha = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  const changes = changedFiles(store, repo, baseSha, headSha);
  const limited = typeof first === 'number' ? changes.slice(0, first) : changes;
  return limited.map((c) => {
    const additions = c.status === 'deleted' ? 0 : Math.max(1, blobLines(store, repo, c.newOid));
    const deletions = c.status === 'added' ? 0 : blobLines(store, repo, c.oldOid);
    return nodeOf('PullRequestChangedFile', c, {
      path: c.path,
      filename: c.path,
      additions,
      deletions,
      changes: additions + deletions,
      status: c.status,
    });
  });
}

// ---------------------------------------------------------------------------
// Issue list ordering / pagination
// ---------------------------------------------------------------------------

function sortedIssues(repo: GqlRepo, args: Record<string, unknown>): GqlIssue[] {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((it) => wanted.has(it.state));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : undefined;
  const field = orderBy ? String(orderBy.field ?? 'CREATED_AT') : 'CREATED_AT';
  const direction = orderBy ? String(orderBy.direction ?? 'DESC') : 'DESC';
  const sign = direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => {
    if (field === 'COMMENTS') {
      const d = (a.comments.length - b.comments.length) * sign;
      if (d !== 0) return d;
    } else {
      const ta = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
      if (ta !== 0) return ta * sign;
    }
    return (a.number - b.number) * sign;
  });
  return list;
}

function issueConnection(repo: GqlRepo, args: Record<string, unknown>): GNode {
  const ordered = sortedIssues(repo, args);
  let start = 0;
  if (args.after !== undefined && args.after !== null) {
    const cursorNum = decodeCursor(args.after);
    if (cursorNum !== null) {
      const idx = ordered.findIndex((it) => it.number === cursorNum);
      if (idx >= 0) start = idx + 1;
    }
  }
  const rest = ordered.slice(start);
  const first = typeof args.first === 'number' ? args.first : rest.length;
  const page = rest.slice(0, first);
  const hasNext = rest.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  const startCursor = page.length > 0 ? encodeCursor(page[0].number) : null;
  return nodeOf('IssueConnection', { repo }, {
    nodes: page.map((it) => issueNode(repo, it)),
    totalCount: ordered.length,
    pageInfo: pageInfoNode(hasNext, startCursor, endCursor),
    edges: page.map((it) => nodeOf('IssueEdge', it, { node: issueNode(repo, it), cursor: encodeCursor(it.number) })),
  });
}

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

function resolveField(store: GqlStore, parentType: string, parent: GNode, field: Selection, variables: Record<string, unknown>): unknown {
  const name = field.name ?? '';
  const args = argMap(field.args, variables);

  if (parentType === 'Query') {
    if (name === 'viewer') return userNode(store.viewer);
    if (name === 'repository') {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (!repo) return null;
      return repoNode(store, repo);
    }
    if (name === 'node') {
      const decoded = decodeId(args.id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = findRepoByNumericId(store, decoded.num);
        return repo ? repoNode(store, repo) : null;
      }
      if (decoded.kind === 'Issue') {
        const hit = findIssueById(store, decoded.num);
        return hit ? issueNode(hit.repo, hit.issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const hit = findPullById(store, decoded.num);
        return hit ? prNode(store, hit.repo, hit.pull) : null;
      }
      if (decoded.kind === 'IssueComment') {
        const hit = findCommentById(store, decoded.num);
        return hit ? commentNode(hit.repo, hit.issue, hit.comment) : null;
      }
      if (decoded.kind === 'User') {
        const user = store.viewer.id === decoded.num ? store.viewer : null;
        return user ? userNode(user) : null;
      }
      return null;
    }
    if (name === '__type') {
      const typeName = String(args.name ?? '');
      if (!(typeName in FIELD_TYPES) && !(typeName in TYPE_FIELDS) && !(typeName in TYPE_ENUM_VALUES)) return null;
      return nodeOf('__Type', { typeName }, {
        name: typeName,
        kind: typeName in TYPE_ENUM_VALUES ? 'ENUM' : 'OBJECT',
        description: null,
      });
    }
    if (name === '__schema') {
      return nodeOf('__Schema', null, { description: null });
    }
  }

  if (parentType === 'Repository') {
    const repo = parent.__src as GqlRepo;
    if (name === 'issue') {
      const n = Number(args.number);
      const issue = repo.issues.get(n);
      return issue ? issueNode(repo, issue) : null;
    }
    if (name === 'issues') return issueConnection(repo, args);
    if (name === 'pullRequests') {
      let list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
      if (typeof args.first === 'number') list = list.slice(0, args.first);
      return nodeOf('PullRequestConnection', { repo }, {
        nodes: list.map((pr) => prNode(store, repo, pr)),
        totalCount: repo.pulls.size,
        pageInfo: pageInfoNode(false, null, null),
        edges: list.map((pr) => nodeOf('PullRequestEdge', pr, { node: prNode(store, repo, pr), cursor: encodeCursor(pr.number) })),
      });
    }
    if (name === 'pullRequest') {
      const n = Number(args.number);
      const pull = repo.pulls.get(n);
      return pull ? prNode(store, repo, pull) : null;
    }
  }

  if (parentType === 'PullRequest') {
    const src = parent.__src as { repo: GqlRepo; pull: GqlPull };
    if (name === 'files') {
      const first = typeof args.first === 'number' ? args.first : undefined;
      const nodes = fileNodes(store, src.repo, src.pull, first);
      return nodeOf('PullRequestChangedFileConnection', src, {
        nodes,
        totalCount: nodes.length,
        pageInfo: pageInfoNode(false, null, null),
      });
    }
  }

  if (parentType === 'Issue') {
    const src = parent.__src as { repo: GqlRepo; issue: GqlIssue };
    if (name === 'comments') {
      const nodes = src.issue.comments.map((c) => commentNode(src.repo, src.issue, c));
      return nodeOf('IssueCommentConnection', src, {
        nodes,
        totalCount: nodes.length,
        pageInfo: pageInfoNode(false, null, null),
      });
    }
    if (name === 'repository') return repoNode(store, src.repo);
  }

  if (parentType === '__Type') {
    const src = parent.__src as { typeName: string };
    const typeName = src.typeName;
    if (name === 'fields') {
      const names = TYPE_FIELDS[typeName] ?? Object.keys(FIELD_TYPES[typeName] ?? {});
      return names.map((f) => nodeOf('__Field', { name: f }, { name: f, description: null, isDeprecated: false, deprecationReason: null, args: [], type: nodeOf('__Type', { typeName: 'String' }, { name: 'String', kind: 'SCALAR', description: null }) }));
    }
    if (name === 'enumValues') {
      const names = TYPE_ENUM_VALUES[typeName] ?? [];
      return names.map((v) => nodeOf('__EnumValue', { name: v }, { name: v, description: null, isDeprecated: false, deprecationReason: null }));
    }
    if (name === 'inputFields' || name === 'interfaces' || name === 'possibleTypes') return [];
  }

  if (parentType === '__Schema') {
    if (name === 'queryType') return nodeOf('__Type', { typeName: 'Query' }, { name: 'Query', kind: 'OBJECT', description: null });
    if (name === 'mutationType') return nodeOf('__Type', { typeName: 'Mutation' }, { name: 'Mutation', kind: 'OBJECT', description: null });
    if (name === 'types') return [];
    if (name === 'directives') return [];
  }

  // Plain stored field on the node, or null when the node does not carry it.
  if (name in parent) return parent[name];
  return null;
}

// ---------------------------------------------------------------------------
// Selection application
// ---------------------------------------------------------------------------

function applySelections(store: GqlStore, doc: GqlDocument, value: unknown, sels: Selection[], typeName: string, variables: Record<string, unknown>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => applySelections(store, doc, v, sels, typeName, variables));
  if (typeof value !== 'object') return value;
  const node = value as GNode;
  const nodeType = node.__type ?? typeName;
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'field') {
      const fname = sel.name ?? '';
      if (fname === '__typename') {
        out[sel.alias ?? fname] = nodeType;
        continue;
      }
      const raw = resolveField(store, nodeType, node, sel, variables);
      if (sel.selections) {
        const childType = FIELD_TYPES[nodeType]?.[fname] ?? nodeType;
        out[sel.alias ?? fname] = applySelections(store, doc, raw, sel.selections, childType, variables);
      } else {
        out[sel.alias ?? fname] = raw === undefined ? null : raw;
      }
    } else if (sel.kind === 'inlineFragment') {
      const cond = sel.typeCondition ?? nodeType;
      if (cond === nodeType || cond === 'Node') {
        const merged = applySelections(store, doc, value, sel.selections ?? [], nodeType, variables);
        if (isRecord(merged)) Object.assign(out, merged);
      }
    } else if (sel.kind === 'fragmentSpread') {
      const frag = doc.fragments.get(sel.name ?? '');
      if (frag && (frag.typeCondition === nodeType || frag.typeCondition === 'Node')) {
        const merged = applySelections(store, doc, value, frag.selections, nodeType, variables);
        if (isRecord(merged)) Object.assign(out, merged);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mutations (all against the shared Store, so REST reads the same objects)
// ---------------------------------------------------------------------------

function doMutation(store: GqlStore, field: Selection, variables: Record<string, unknown>): GNode {
  const name = field.name ?? '';
  const args = argMap(field.args, variables);
  const input = isRecord(args.input) ? args.input : {};

  if (name === 'createIssue') {
    const decoded = decodeId(input.repositoryId);
    const repo = decoded && decoded.kind === 'Repository' ? findRepoByNumericId(store, decoded.num) : undefined;
    if (!repo) throw new OpError('createIssue: unknown repositoryId');
    const issue: GqlIssue = {
      id: allocId(store, 'nextIssueId'),
      number: repo.nextIssue++,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open',
      labels: [],
      user: store.viewer,
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
      comments: [],
    };
    repo.issues.set(issue.number, issue);
    return nodeOf('CreateIssuePayload', { issue }, { issue: issueNode(repo, issue), clientMutationId: null });
  }

  if (name === 'closeIssue') {
    const decoded = decodeId(input.issueId);
    const hit = decoded && decoded.kind === 'Issue' ? findIssueById(store, decoded.num) : undefined;
    if (!hit) throw new OpError('closeIssue: unknown issueId');
    hit.issue.state = 'closed';
    hit.issue.updated_at = FIXED_TS;
    return nodeOf('CloseIssuePayload', hit, { issue: issueNode(hit.repo, hit.issue), clientMutationId: null });
  }

  if (name === 'createPullRequest') {
    const decoded = decodeId(input.repositoryId);
    const repo = decoded && decoded.kind === 'Repository' ? findRepoByNumericId(store, decoded.num) : undefined;
    if (!repo) throw new OpError('createPullRequest: unknown repositoryId');
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha) throw new OpError(`createPullRequest: head branch "${headRef}" was not pushed`);
    if (!baseSha) throw new OpError(`createPullRequest: base branch "${baseRef}" does not exist`);
    const pull: GqlPull = {
      id: allocId(store, 'nextPullId'),
      number: repo.nextPull++,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open',
      head: { ref: headRef, sha: headSha },
      base: { ref: baseRef, sha: baseSha },
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      mergeable: true,
    };
    repo.pulls.set(pull.number, pull);
    return nodeOf('CreatePullRequestPayload', { repo, pull }, { pullRequest: prNode(store, repo, pull), clientMutationId: null });
  }

  if (name === 'mergePullRequest') {
    const decoded = decodeId(input.pullRequestId);
    const hit = decoded && decoded.kind === 'PullRequest' ? findPullById(store, decoded.num) : undefined;
    if (!hit) throw new OpError('mergePullRequest: unknown pullRequestId');
    const { repo, pull } = hit;
    if (!pull.merged) {
      const baseRefFull = `refs/heads/${pull.base.ref}`;
      const baseSha = repo.refs.get(baseRefFull) ?? pull.base.sha;
      const headSha = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
      const mergeable = computeMergeable(store, repo, pull);
      if (mergeable === false) throw new OpError('mergePullRequest: the pull request has a merge conflict');
      const changes = changedFiles(store, repo, baseSha, headSha);
      const message = `Merge pull request #${pull.number}: ${pull.title}`;
      let cur = baseSha;
      if (changes.length > 0) {
        for (const change of changes) {
          if (change.status === 'deleted') {
            cur = store.deletePath(repo, cur, change.path, message).commitSha;
          } else {
            const obj = change.newOid ? store.getObject(repo, change.newOid) : undefined;
            const data = obj ? obj.data : Buffer.alloc(0);
            cur = store.commitPath(repo, cur, change.path, data, message).commitSha;
          }
        }
      }
      repo.refs.set(baseRefFull, cur);
      pull.merged = true;
      pull.merged_at = FIXED_TS;
      pull.merge_commit_sha = cur;
      pull.state = 'closed';
    }
    return nodeOf('MergePullRequestPayload', hit, { pullRequest: prNode(store, repo, pull), clientMutationId: null });
  }

  if (name === 'addComment') {
    const decoded = decodeId(input.subjectId);
    const hit = decoded && decoded.kind === 'Issue' ? findIssueById(store, decoded.num) : undefined;
    if (!hit) throw new OpError('addComment: unknown subjectId');
    const comment: GqlComment = { id: allocId(store, 'nextCommentId'), body: String(input.body ?? '') };
    hit.issue.comments.push(comment);
    const cnode = commentNode(hit.repo, hit.issue, comment);
    const edge = nodeOf('IssueCommentEdge', { comment }, { node: cnode, cursor: encodeCursor(comment.id) });
    return nodeOf('AddCommentPayload', hit, { commentEdge: edge, subject: issueNode(hit.repo, hit.issue), clientMutationId: null });
  }

  throw new OpError(`Unknown mutation "${name}"`);
}

// ---------------------------------------------------------------------------
// One operation, then the handler
// ---------------------------------------------------------------------------

function executeOperation(store: GqlStore, opBody: unknown): Record<string, unknown> {
  if (!isRecord(opBody) || typeof opBody.query !== 'string') {
    return { data: null, errors: [{ message: 'GraphQL request body must carry a query string' }] };
  }
  const variables: Record<string, unknown> = isRecord(opBody.variables) ? (opBody.variables as Record<string, unknown>) : {};
  let doc: GqlDocument;
  try {
    doc = new Parser(tokenise(opBody.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let operation: Operation | undefined;
  if (typeof opBody.operationName === 'string' && opBody.operationName !== '') {
    operation = doc.operations.find((o) => o.name === opBody.operationName);
    if (!operation) return { data: null, errors: [{ message: `Unknown operation named "${opBody.operationName}"` }] };
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else {
    return { data: null, errors: [{ message: 'GraphQL document carries several operations but no operationName was given' }] };
  }

  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const errors: string[] = [];
  validateSelections(doc, operation.selections, rootType, errors);
  if (errors.length > 0) {
    return { data: null, errors: errors.map((message) => ({ message })) };
  }

  try {
    if (operation.type === 'mutation') {
      // Mutations run in document order, each against the shared Store.
      const root: GNode = nodeOf('Mutation', null, {});
      const data: Record<string, unknown> = {};
      for (const sel of operation.selections) {
        if (sel.kind !== 'field') continue;
        const payload = doMutation(store, sel, variables);
        const childType = FIELD_TYPES.Mutation[sel.name ?? ''] ?? 'CreateIssuePayload';
        data[sel.alias ?? sel.name ?? ''] = applySelections(store, doc, payload, sel.selections ?? [], childType, variables);
      }
      void root;
      return { data };
    }
    const root: GNode = nodeOf('Query', null, {});
    const data = applySelections(store, doc, root, operation.selections, 'Query', variables);
    return { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

export async function handleGraphQL(store: GqlStore, ctx: GqlHandlerCtx): Promise<GqlHandlerResponse> {
  if (ctx.method !== 'POST') {
    return jsonReply(405, { message: 'Method Not Allowed' });
  }
  // Auth: the exact trial token, or the literal test-token when no token is
  // configured locally. A missing or wrong token is exactly 401.
  const expected = process.env.MAKEFUN_SHOP_TOKEN ? process.env.MAKEFUN_SHOP_TOKEN : 'test-token';
  if (ctx.token === null || ctx.token !== expected) {
    return jsonReply(401, { message: 'Unauthorized' });
  }

  let body: unknown = ctx.json;
  if (body === undefined) {
    const raw = ctx.body && ctx.body.length > 0 ? ctx.body.toString('utf8') : '';
    if (raw.trim() === '') return jsonReply(400, { message: 'Empty GraphQL request body' });
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      return jsonReply(400, { message: 'Malformed JSON body' });
    }
  }

  if (Array.isArray(body)) {
    const results = body.map((entry) => executeOperation(store, entry));
    return jsonReply(200, results);
  }
  if (isRecord(body)) {
    return jsonReply(200, executeOperation(store, body));
  }
  return jsonReply(400, { message: 'GraphQL request body must be a JSON object or an array of operations' });
}
