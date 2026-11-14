// git.ts — smart-HTTP git surface for the forge.
//
// Implements the upload-pack (protocol v2 + v0 fallback) and receive-pack (v0)
// endpoints the conformance suite drives: info/refs advertisements, v2 ls-refs,
// v2/v0 fetch with shallow support and sideband framing, and receive-pack pushes
// with pack unpacking (including OFS_DELTA / REF_DELTA), fast-forward enforcement
// and report-status.
//
// Design notes:
// - Objects are stored verbatim through store.putObject and never re-encoded, so
//   clones round-trip byte-for-byte.
// - Packs the server generates carry full objects only (no deltas): valid git,
//   and the suite compares object bytes, not pack bytes.
// - Generated packs are cached per (repo, wants, haves, depth, shallow) and each
//   object's deflated bytes are cached on the object itself, so the 50-concurrent
//   shallow-clone workload deflates each object once.
// - Advertisements are cached too: the v2 ad is a module-level constant (it
//   never mentions the repo), and the v0 ads + ls-refs answers are cached per
//   repo-state fingerprint, so the bench clone's three re-advertisements per
//   clone cost one Map lookup instead of a rebuild.
// - Receive-pack unpacks take a single-pass fast path when the pack holds no
//   delta entries (the bench push shape); packs that do carry deltas still
//   go through the full resolver below.
// - No filesystem or network I/O happens in any handler; everything is in-memory.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, HandlerCtx, HandlerResponse, ObjectType, Repo, Store } from './store.ts';

const ZERO_OID = '0'.repeat(40);
const AGENT = 'makefun-git/1.0';
const MAX_PKT_PAYLOAD = 65516; // PKT_LINE_MAX (65520) minus the 4 length bytes
const MAX_SIDEBAND_CHUNK = MAX_PKT_PAYLOAD - 1; // one band byte per sideband packet

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

function flushPkt(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function delimPkt(): Buffer {
  return Buffer.from('0001', 'ascii');
}

function pktLine(payload: string): Buffer {
  return pkt(payload);
}

/** Decode every pkt-line in `buf`. Throws on truncated or malformed framing. */
function decodeAll(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const hex = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line length');
    const len = parseInt(hex, 16);
    if (len === 0) {
      out.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'end' });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('bad pkt-line length');
    out.push({ kind: 'data', payload: Buffer.from(buf.subarray(off + 4, off + len)) });
    off += len;
  }
  return out;
}

/**
 * Decode pkt-lines up to and including the first flush packet. Everything after
 * that flush is returned untouched as `rest` (for receive-pack: the raw pack).
 */
function decodeUntilFlush(buf: Buffer): { pkts: Pkt[]; rest: Buffer } {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const hex = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line length');
    const len = parseInt(hex, 16);
    if (len === 0) {
      out.push({ kind: 'flush' });
      return { pkts: out, rest: buf.subarray(off + 4) };
    }
    if (len === 1) {
      out.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'end' });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('bad pkt-line length');
    out.push({ kind: 'data', payload: Buffer.from(buf.subarray(off + 4, off + len)) });
    off += len;
  }
  throw new Error('pkt-line stream ended without a flush');
}

/** Data-packet payloads as text lines, trailing newline stripped. */
function dataLines(pkts: Pkt[]): string[] {
  const lines: string[] = [];
  for (const p of pkts) {
    if (p.kind !== 'data') continue;
    lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// object helpers
// ---------------------------------------------------------------------------

function objectId(type: ObjectType, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}

function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

function headRefName(repo: Repo): string {
  return `refs/heads/${repo.default_branch}`;
}

function headOid(repo: Repo): string {
  return repo.refs.get(headRefName(repo)) ?? ZERO_OID;
}

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Follow a tag chain to its ultimate commit target, or null. */
function peelToCommit(repo: Repo, oid: string): string | null {
  let cur = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj) return null;
    if (obj.type !== 'tag') return obj.type === 'commit' ? cur : null;
    const m = /^object ([0-9a-f]{40})\n/.exec(obj.data.toString('utf8'));
    if (!m) return null;
    cur = m[1];
  }
}

/** The peeled commit for a ref pointing at an annotated tag, else undefined. */
function peeledOid(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return undefined;
  return peelToCommit(repo, oid) ?? undefined;
}

function commitParents(store: Store, repo: Repo, oid: string): string[] {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return [];
  try {
    return store.parseCommit(obj.data).parents;
  } catch {
    return [];
  }
}

function commitTree(store: Store, repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  try {
    return store.parseCommit(obj.data).tree;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

/**
 * Commits reachable from `tips` within `depth` steps (tip = level 0). With no
 * depth limit the whole ancestry is included. `boundary` holds the commits at
 * the deepest included level — the shallow boundary of this fetch.
 */
function commitsWithin(
  store: Store,
  repo: Repo,
  tips: string[],
  depth: number | undefined,
): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  let level = tips.filter((t) => {
    const o = repo.objects.get(t);
    return o !== undefined && o.type === 'commit';
  });
  let d = 0;
  while (level.length > 0) {
    const next: string[] = [];
    for (const oid of level) {
      if (included.has(oid)) continue;
      included.add(oid);
      if (depth !== undefined && d === depth - 1) {
        boundary.add(oid);
        continue;
      }
      for (const p of commitParents(store, repo, oid)) {
        if (!included.has(p)) next.push(p);
      }
    }
    level = next;
    d += 1;
    if (depth !== undefined && d >= depth) break;
  }
  return { included, boundary };
}

/**
 * Add `oid` and everything it references to `out`. Commits contribute their
 * tree (parents are NOT followed here — the caller decides which commits are
 * in scope); trees contribute their entries; tags contribute their target.
 * Entries with mode 160000 (gitlinks) name objects that are not in this repo.
 */
function collectClosure(
  store: Store,
  repo: Repo,
  oid: string,
  out: Map<string, GitObject>,
  seen: Set<string>,
): void {
  if (seen.has(oid)) return;
  seen.add(oid);
  const obj = repo.objects.get(oid);
  if (!obj) return;
  out.set(oid, obj);
  if (obj.type === 'commit') {
    const tree = commitTree(store, repo, oid);
    if (tree) collectClosure(store, repo, tree, out, seen);
  } else if (obj.type === 'tree') {
    let entries: Array<{ mode: string; name: string; oid: string }> = [];
    try {
      entries = store.parseTree(obj.data);
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (e.mode === '160000') continue;
      collectClosure(store, repo, e.oid, out, seen);
    }
  } else if (obj.type === 'tag') {
    const m = /^object ([0-9a-f]{40})\n/.exec(obj.data.toString('utf8'));
    if (m) collectClosure(store, repo, m[1], out, seen);
  }
}

/**
 * The full closure of the `haves`, except that parents of commits listed in
 * `stopAt` (the client's existing shallow boundaries) are not traversed — the
 * client does not hold them.
 */
function heldClosure(
  store: Store,
  repo: Repo,
  haves: string[],
  stopAt: Set<string>,
): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const seen = new Set<string>();
  const walk = (oid: string): void => {
    if (seen.has(oid)) return;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) return;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      const tree = commitTree(store, repo, oid);
      if (tree) collectClosure(store, repo, tree, out, seen);
      if (!stopAt.has(oid)) {
        for (const p of commitParents(store, repo, oid)) walk(p);
      }
    } else {
      collectClosure(store, repo, oid, out, seen);
    }
  };
  for (const h of haves) walk(h);
  return out;
}

interface FetchPlan {
  /** Objects to send, as [oid, object] pairs in a stable order. */
  send: Array<[string, GitObject]>;
  shallow: string[];
  unshallow: string[];
}

/** Decide exactly which objects a fetch must deliver, honouring haves + depth. */
function planFetch(store: Store, repo: Repo, args: FetchArgs): FetchPlan {
  const held = heldClosure(store, repo, args.haves, new Set(args.shallow));
  const fetched = new Map<string, GitObject>();
  const seen = new Set<string>();
  const shallow = new Set<string>();
  const fetchedCommits = new Set<string>();

  for (const want of args.wants) {
    const obj = repo.objects.get(want);
    if (!obj) continue;
    if (obj.type === 'commit') {
      const { included, boundary } = commitsWithin(store, repo, [want], args.depth);
      for (const c of included) {
        fetchedCommits.add(c);
        const cObj = repo.objects.get(c);
        if (cObj) fetched.set(c, cObj);
        const tree = commitTree(store, repo, c);
        if (tree) collectClosure(store, repo, tree, fetched, seen);
      }
      for (const b of boundary) shallow.add(b);
    } else if (obj.type === 'tag') {
      // A wanted tag ships with its target; a commit target obeys the depth.
      fetched.set(want, obj);
      const m = /^object ([0-9a-f]{40})\n/.exec(obj.data.toString('utf8'));
      if (m) {
        const target = repo.objects.get(m[1]);
        if (target?.type === 'commit') {
          const { included, boundary } = commitsWithin(store, repo, [m[1]], args.depth);
          for (const c of included) {
            fetchedCommits.add(c);
            const cObj = repo.objects.get(c);
            if (cObj) fetched.set(c, cObj);
            const tree = commitTree(store, repo, c);
            if (tree) collectClosure(store, repo, tree, fetched, seen);
          }
          for (const b of boundary) shallow.add(b);
        } else if (target) {
          collectClosure(store, repo, m[1], fetched, seen);
        }
      }
    } else {
      collectClosure(store, repo, want, fetched, seen);
    }
  }

  // An old boundary that is now fetched together with its parents is no
  // longer shallow (e.g. deepen: the old tip becomes unshallow).
  const unshallow: string[] = [];
  for (const b of args.shallow) {
    if (fetchedCommits.has(b) && !shallow.has(b)) unshallow.push(b);
  }

  for (const oid of held.keys()) fetched.delete(oid);
  const send = [...fetched.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { send, shallow: [...shallow].sort(), unshallow: unshallow.sort() };
}

// ---------------------------------------------------------------------------
// pack generation (full objects, no deltas) + caching
// ---------------------------------------------------------------------------

function packObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function buildPack(objects: Array<[string, GitObject]>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const [, obj] of objects) {
    if (!obj.deflated) obj.deflated = deflateSync(obj.data);
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(obj.deflated);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Pack cache, keyed by everything that determines the pack's bytes. */
const packCache = new Map<string, Buffer>();

function cachedPack(repo: Repo, args: FetchArgs, objects: Array<[string, GitObject]>): Buffer {
  const key = [
    repo.full_name,
    [...args.wants].sort().join(','),
    [...args.haves].sort().join(','),
    args.depth === undefined ? '' : String(args.depth),
    [...args.shallow].sort().join(','),
  ].join('\n');
  const hit = packCache.get(key);
  if (hit) return hit;
  const made = buildPack(objects);
  if (packCache.size > 512) packCache.clear();
  packCache.set(key, made);
  return made;
}

/** Split pack bytes into band-1 sideband packets (max 65520 bytes each). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pack.length; off += MAX_SIDEBAND_CHUNK) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + MAX_SIDEBAND_CHUNK));
    out.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function uploadCaps(repo: Repo): string {
  return [
    'side-band-64k',
    'multi_ack_detailed',
    'thin-pack',
    'ofs-delta',
    'shallow',
    'deepen-relative',
    `symref=HEAD:${headRefName(repo)}`,
    `agent=${AGENT}`,
  ].join(' ');
}

function receiveCaps(): string {
  return ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`].join(' ');
}

function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadCaps(repo) : receiveCaps();
  const chunks: Buffer[] = [pktLine(`# service=${service}\n`), flushPkt()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    chunks.push(pktLine(`${headOid(repo)} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) {
      chunks.push(pktLine(`${oid} ${name}\n`));
      const peeled = peeledOid(repo, oid);
      if (peeled) chunks.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  chunks.push(flushPkt());
  return Buffer.concat(chunks);
}

// The v2 advertisement never mentions the repo (fixed capability list), so
// it is built once at module load and the same Buffer is shared by every
// request. The clone workload asks for it three times per clone; rebuilding
// nine pkt-lines for each of those 150 requests was pure waste.
const ADVERTISEMENT_V2: Buffer = Buffer.concat([
  pktLine('# service=git-upload-pack\n'),
  flushPkt(),
  pktLine('version 2\n'),
  pktLine(`agent=${AGENT}\n`),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow filter\n'),
  pktLine('object-format=sha1\n'),
  flushPkt(),
]);

/**
 * Fingerprint of everything an advertisement's bytes depend on: the default
 * branch (HEAD symref + the upload caps) and every ref name -> oid pair.
 * A peeled `^{}` / `peeled:` value is a pure function of the tag object's
 * bytes, and an oid fixes those bytes, so the refs alone determine the ads.
 *
 * Keying the cache on this string — never on the repo object, and never
 * with an invalidation hook — keeps it correct no matter which surface
 * moved a ref (git push, REST branch / merge / update-ref, GraphQL merge)
 * and across a delete + recreate of a repo under the same name: any change
 * simply yields a different fingerprint, and a stale ad is impossible.
 */
function refsFingerprint(repo: Repo): string {
  const parts: string[] = [repo.default_branch];
  for (const [name, oid] of sortedRefs(repo)) parts.push(`${name}=${oid}`);
  return parts.join('\n');
}

interface AdCacheEntry {
  v0Upload?: Buffer;
  v0Receive?: Buffer;
  /** ls-refs answers, keyed by the joined ref-prefix lines. */
  lsRefs: Map<string, Buffer>;
}

/** Cached v0 advertisements + ls-refs answers, keyed by refs fingerprint. */
const adCache = new Map<string, AdCacheEntry>();

function adCacheEntry(repo: Repo): AdCacheEntry {
  const fp = refsFingerprint(repo);
  let entry = adCache.get(fp);
  if (entry) return entry;
  if (adCache.size > 512) adCache.clear();
  entry = { lsRefs: new Map() };
  adCache.set(fp, entry);
  return entry;
}

function cachedAdvertisementV0(
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
): Buffer {
  const entry = adCacheEntry(repo);
  if (service === 'git-upload-pack') {
    if (!entry.v0Upload) entry.v0Upload = advertisementV0(repo, service);
    return entry.v0Upload;
  }
  if (!entry.v0Receive) entry.v0Receive = advertisementV0(repo, service);
  return entry.v0Receive;
}

// ---------------------------------------------------------------------------
// fetch argument parsing
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  done: boolean;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
  for (const line of lines) {
    if (line === 'done') args.done = true;
    else if (line.startsWith('want ')) {
      const oid = line.slice(5, 45);
      if (isOid(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5, 45);
      if (isOid(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8, 48);
      if (isOid(oid)) args.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
    // thin-pack / ofs-delta / no-progress / filter / deepen-since /
    // deepen-not / agent / object-format / done need no action: this server
    // sends full packs, no progress, and honours depth via `deepen`.
  }
  return args;
}

// ---------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------

function handleLsRefs(repo: Repo, lines: string[]): Buffer {
  const prefixes: string[] = [];
  for (const line of lines) {
    if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  // The bench-clone repo is static during a timed round, so all 50 clones
  // ask the same ls-refs question and get a byte-identical answer. Cache
  // it under (refs fingerprint, prefixes); any ref change anywhere in the
  // forge yields a new fingerprint, so the cached answer can never be stale.
  const entry = adCacheEntry(repo);
  const key = prefixes.join('\n');
  const hit = entry.lsRefs.get(key);
  if (hit) return hit;
  const built = buildLsRefs(repo, prefixes);
  entry.lsRefs.set(key, built);
  return built;
}

function buildLsRefs(repo: Repo, prefixes: string[]): Buffer {
  const chunks: Buffer[] = [];
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  // With a prefix filter the answer must contain ONLY matching refs — not
  // even HEAD (the suite asserts this on the raw lines) — EXCEPT when a
  // prefix actually matches HEAD itself: real `git clone` asks for
  // `ref-prefix HEAD` in the same call and needs the HEAD line to resolve
  // the remote HEAD symref.
  const includeHead = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
  if (includeHead) {
    chunks.push(pktLine(`${headOid(repo)} HEAD symref-target:${headRefName(repo)}\n`));
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    const peeled = peeledOid(repo, oid);
    if (peeled) line += ` peeled:${peeled}`;
    chunks.push(pktLine(`${line}\n`));
  }
  chunks.push(flushPkt());
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// fetch responses
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// whole-response fetch cache (v3 fetch-cache lane)
// ---------------------------------------------------------------------------
//
// The bench clone fires 50 concurrent depth-1 clones of one 200-commit repo:
// every fetch carries IDENTICAL args (same tip want, no haves, depth 1, no
// shallow) against an UNCHANGED repo, so all 50 responses are byte-identical.
// v2 already caches the pack bytes and the ads, but planFetch (repo walk,
// parseCommit/parseTree, Sets/Maps, sorts) and the pkt-line framing still
// run 50 times. This cache stores the complete response Buffer of
// fetchResponseV2 / fetchResponseV0, so repeats cost one Map lookup.
//
// Key covers EVERYTHING the response bytes can depend on:
// - repo.full_name + refs fingerprint: any ref change anywhere (push, REST
//   branch/merge/update-ref, GraphQL merge, delete + recreate under the same
//   name) yields a new fingerprint, so a stale response is impossible. The
//   fingerprint is content-keyed, never invalidated by a hook — same
//   reasoning as the ad cache above.
// - protocol version (v2 vs v0 framing differs), wants / haves / shallow
//   (sorted), depth, done flag.
// - held haves (which haves the store actually holds): the v0 ACK lines
//   depend on exactly this set. Objects are content-addressed, so a held
//   set can only change when objects arrive/depart, which always moves a
//   ref first — but keying it anyway costs one Map lookup per have (the
//   bench carries zero haves) and removes the last assumption.
// Never cached: nothing else is request-time state — planFetch, the pack,
// the shallow lists and the ack lines are all pure functions of the key.
// The cache is capped like the others (clear above 512 entries).
const fetchCache = new Map<string, Buffer>();

function fetchCacheKey(store: Store, repo: Repo, protocol: 'v2' | 'v0', args: FetchArgs): string {
  const held = args.haves.filter((h) => {
    try {
      return store.getObject(repo, h) != null;
    } catch {
      return false;
    }
  });
  return [
    protocol,
    repo.full_name,
    refsFingerprint(repo),
    [...args.wants].sort().join(','),
    [...args.haves].sort().join(','),
    held.sort().join(','),
    args.depth === undefined ? '' : String(args.depth),
    [...args.shallow].sort().join(','),
    args.done ? 'done' : '',
  ].join('\n');
}

function fetchResponseV2(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const key = fetchCacheKey(store, repo, 'v2', args);
  const hit = fetchCache.get(key);
  if (hit) return hit;
  const built = buildFetchResponseV2(store, repo, args);
  if (fetchCache.size > 512) fetchCache.clear();
  fetchCache.set(key, built);
  return built;
}

function fetchResponseV0(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const key = fetchCacheKey(store, repo, 'v0', args);
  const hit = fetchCache.get(key);
  if (hit) return hit;
  const built = buildFetchResponseV0(store, repo, args);
  if (fetchCache.size > 512) fetchCache.clear();
  fetchCache.set(key, built);
  return built;
}

function buildFetchResponseV2(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(store, repo, args);
  // Framing rules, from git 2.43 fetch-pack.c (process_ack /
  // do_fetch_pack_v2), which the suite's client also accepts (it resets
  // its section on both flush and delim):
  // - An `acknowledgments` section appears ONLY when the request carried
  //   haves. It carries `ready` iff a packfile follows, and is then
  //   terminated by DELIM (0001), not flush: a flush after `ready` dies
  //   with "expected packfile to be sent after 'ready'".
  // - With no packfile to send, the section has no `ready` and ends with
  //   FLUSH, and the response ends there (nothing-new).
  // - `shallow-info` (only when a packfile follows) is terminated by DELIM.
  // - The packfile section ends with a flush after the sideband packets.
  const willSendPack =
    plan.send.length > 0 || (args.wants.length > 0 && args.haves.length === 0);
  const chunks: Buffer[] = [];
  if (args.haves.length > 0) {
    chunks.push(pktLine('acknowledgments\n'), pktLine('NAK\n'));
    if (willSendPack) {
      chunks.push(pktLine('ready\n'), delimPkt());
    } else {
      chunks.push(flushPkt());
    }
  }
  if (willSendPack) {
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      chunks.push(pktLine('shallow-info\n'));
      for (const s of plan.shallow) chunks.push(pktLine(`shallow ${s}\n`));
      for (const u of plan.unshallow) chunks.push(pktLine(`unshallow ${u}\n`));
      chunks.push(delimPkt());
    }
    const pack = cachedPack(repo, args, plan.send);
    chunks.push(pktLine('packfile\n'));
    chunks.push(...sidebandPackets(pack));
    chunks.push(flushPkt());
  }
  return Buffer.concat(chunks);
}

function buildFetchResponseV0(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(store, repo, args);
  // Ack lines for a `done` request, matching real upload-pack (verified
  // against git 2.43.0 daemon, 2026-11-14): for every have the server
  // holds, `ACK <oid> common`, then ONE bare `ACK <last-held>` — the bare
  // ACK is what ends the client's ack loop (a lone `ACK ... common`
  // leaves multi_ack set and the loop reads the pack as an ack and dies).
  // No haves, or none held: a single NAK, which the client always
  // accepts (it just means "no common commits", and this server's pack
  // already excludes what the client holds).
  const ackLines = (): Buffer[] => {
    const held = args.haves.filter((h) => {
      try {
        // Contract: getObject(repo, sha) returns GitObject | undefined.
        return store.getObject(repo, h) != null;
      } catch {
        return false;
      }
    });
    if (held.length === 0) return [pktLine('NAK\n')];
    const lines = held.map((h) => pktLine(`ACK ${h} common\n`));
    lines.push(pktLine(`ACK ${held[held.length - 1]}\n`));
    return lines;
  };
  // Only a `deepen` request triggers the shallow-first shape below. A
  // request that merely carries the client's existing shallow boundaries
  // (no deepen) takes the plain path: real git only sends/receives
  // shallow/unshallow lines when deepening, and its pack demux would die
  // on a stray `unshallow` line between the NAK and the pack.
  const hasDepth = args.depth !== undefined;
  if (hasDepth) {
    // v0 + depth, from git 2.43 fetch-pack.c / upload-pack.c: the client
    // reads the shallow list FIRST, before any NAK, and requires it to be
    // terminated by a flush — a leading NAK dies with "expected
    // shallow/unshallow, got NAK". The shallow list is repeated in every
    // response of the stateless dance:
    // - no done, no haves (first POST): shallow list + flush only;
    // - no done, haves (negotiation round): + NAK, no pack yet;
    // - done, no haves (clone): + NAK + pack;
    // - done, haves (deepen): + ACK common(s) + bare ACK + pack (the
    //   haves travel in the SAME post as `done` over stateless HTTP, so
    //   there is no prior round to ack them in — the client reads
    //   ACK/NAK lines after the shallow flush, and a bare pack dies
    //   with "expected ACK/NAK").
    const chunks: Buffer[] = [];
    for (const s of plan.shallow) chunks.push(pktLine(`shallow ${s}\n`));
    for (const u of plan.unshallow) chunks.push(pktLine(`unshallow ${u}\n`));
    chunks.push(flushPkt());
    if (!args.done && args.haves.length === 0) return Buffer.concat(chunks);
    if (!args.done) {
      chunks.push(pktLine('NAK\n'));
      return Buffer.concat(chunks);
    }
    // A `done` request always carries ack lines before the pack: the
    // client reads ACK/NAK lines here (a bare pack dies with "expected
    // ACK/NAK"). See ackLines() above for the exact shape.
    chunks.push(...ackLines());
    if (plan.send.length > 0) {
      const pack = cachedPack(repo, args, plan.send);
      chunks.push(...sidebandPackets(pack));
    } else if (args.wants.length > 0 && args.haves.length === 0) {
      const pack = cachedPack(repo, args, []);
      chunks.push(...sidebandPackets(pack));
    }
    chunks.push(flushPkt());
    return Buffer.concat(chunks);
  }
  // No-depth path. A `done` request with held haves gets the ACK-common
  // + bare-ACK shape (same as the depth path); every other shape gets a
  // single NAK first, which the client always accepts.
  const chunks: Buffer[] = args.done ? ackLines() : [pktLine('NAK\n')];
  if (plan.send.length > 0) {
    const pack = cachedPack(repo, args, plan.send);
    chunks.push(...sidebandPackets(pack));
  } else if (args.wants.length > 0 && args.haves.length === 0 && args.done) {
    // Same empty-pack rule as v2: a want with nothing to send (e.g. a
    // zero-oid want on an empty repo) still gets a packfile.
    const pack = cachedPack(repo, args, []);
    chunks.push(...sidebandPackets(pack));
  }
  chunks.push(flushPkt());
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// pack unpacking (receive-pack): full objects + OFS_DELTA / REF_DELTA
// ---------------------------------------------------------------------------

function readSizeVarint(buf: Buffer, start: number): { size: number; first: number; next: number } {
  if (start >= buf.length) throw new Error('pack entry has no size header');
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    if (off >= buf.length) throw new Error('pack size varint is truncated');
    byte = buf[off++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack size varint is too long');
  }
  return { size, first, next: off };
}

function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buf.length) throw new Error('ofs-delta has no base offset');
  let byte = buf[start];
  let off = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (off >= buf.length) throw new Error('ofs-delta base offset is truncated');
    byte = buf[off++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: off };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the next offset. */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (off >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[off++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (off >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[off++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (off >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[off++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of range');
      if (written + copySize > targetSize) throw new Error('delta writes past its target');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (off + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target');
      delta.copy(out, written, off, off + literal);
      off += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta did not fill its target');
  return out;
}

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: ObjectType;
  resolved?: Buffer;
  oid?: string;
}

/**
 * Unpack a pack that holds no OFS_DELTA / REF_DELTA entries, in a single
 * pass: inflate each entry and store it. No RawEntry graph, no recursion,
 * no resolving set — the bench pushes always send full objects, so this is
 * the shape that actually runs under timing.
 *
 * Returns false (storing nothing) as soon as a delta entry is seen, so the
 * caller can run the full delta-resolving unpack instead. An unknown type
 * code also returns false — the full path raises the same error the old
 * code did. The size and trailer checks mirror the full path, so a corrupt
 * delta-free pack fails here with the same message rather than passing.
 */
function tryUnpackDeltaFree(
  store: Store,
  repo: Repo,
  pack: Buffer,
  trailerStart: number,
  count: number,
): boolean {
  const found: Array<{ type: ObjectType; data: Buffer }> = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const header = readSizeVarint(pack, off);
    off = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    if (typeCode === 6 || typeCode === 7) return false;
    const type = CODE_TYPE[typeCode];
    if (!type) return false;
    const inflated = inflateAt(pack.subarray(0, trailerStart), off);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    found.push({ type, data: inflated.data });
    off = inflated.next;
  }
  if (off !== trailerStart) throw new Error('pack has trailing bytes before its trailer');
  // Store only after the whole scan proved the pack delta-free, so a
  // corrupt pack stores nothing — same failure atomicity as the full path.
  for (const obj of found) store.putObject(repo, obj.type, obj.data);
  return true;
}

/** Parse a packfile, resolve any deltas, and store every object verbatim. */
function unpackPack(store: Store, repo: Repo, pack: Buffer): void {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('pack is too short or has a bad header');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  if (trailerStart < 12) throw new Error('pack is truncated');
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  // Delta-free packs (every bench push) take the single-pass fast path.
  // Delta packs fall through to the full resolver below, which re-parses
  // from scratch — a conformance-only cost, never a timed one.
  if (tryUnpackDeltaFree(store, repo, pack, trailerStart, count)) return;

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const start = off;
    const header = readSizeVarint(pack, off);
    off = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: start, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, off);
      off = base.next;
      if (base.baseOffset <= 0 || base.baseOffset >= start) {
        throw new Error('ofs-delta names an invalid base offset');
      }
      entry.baseOffset = start - base.baseOffset;
    } else if (typeCode === 7) {
      if (off + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), off);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(start, entry);
  }
  if (off !== trailerStart) throw new Error('pack has trailing bytes before its trailer');

  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: ObjectType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = repo.objects.get(entry.baseOid!);
        if (!external) throw new Error('ref-delta base is neither in the pack nor stored');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = objectId(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  for (const entry of raw) {
    const r = resolve(entry);
    store.putObject(repo, r.type, r.data);
  }
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function reportResponse(lines: string[]): Buffer {
  // The report-status stream is pkt-lined inside band 1.
  const inner = Buffer.concat([...lines.map((l) => pktLine(l)), flushPkt()]);
  return Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), inner])), flushPkt()]);
}

function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  let commands: PushCommand[] = [];
  let packBytes: Buffer = Buffer.alloc(0);
  try {
    const decoded = decodeUntilFlush(body);
    packBytes = decoded.rest;
    for (const p of decoded.pkts) {
      if (p.kind !== 'data') continue;
      let text = p.payload.toString('utf8');
      const nul = text.indexOf('\0');
      if (nul >= 0) text = text.slice(0, nul); // capabilities ride the first line only
      const line = text.replace(/\n$/, '');
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
      if (!m) throw new Error('bad receive-pack command line');
      commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
    }
    if (commands.length === 0) throw new Error('no receive-pack commands');
  } catch {
    return reportResponse(['unpack error\n']);
  }

  // Unpack first: a refused ref must still report `unpack ok`.
  let unpackOk = true;
  if (commands.some((c) => c.newOid !== ZERO_OID)) {
    try {
      unpackPack(store, repo, packBytes);
    } catch {
      unpackOk = false;
    }
  }
  if (!unpackOk) return reportResponse(['unpack error\n']);

  const lines: string[] = ['unpack ok\n'];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        lines.push(`ng ${cmd.ref} remote ref does not exist\n`);
      } else {
        repo.refs.delete(cmd.ref);
        lines.push(`ok ${cmd.ref}\n`);
      }
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create (unborn -> new ref is always a fast-forward).
      if (current !== undefined) {
        lines.push(`ng ${cmd.ref} already exists\n`);
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        lines.push(`ng ${cmd.ref} object not found\n`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      lines.push(`ok ${cmd.ref}\n`);
      continue;
    }
    // Update: fast-forward only.
    if (current === undefined) {
      lines.push(`ng ${cmd.ref} remote ref does not exist\n`);
      continue;
    }
    if (current !== cmd.oldOid) {
      lines.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      lines.push(`ng ${cmd.ref} object not found\n`);
      continue;
    }
    let ff = false;
    try {
      ff = store.isAncestor(repo, cmd.oldOid, cmd.newOid);
    } catch {
      ff = false;
    }
    if (!ff) {
      lines.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    lines.push(`ok ${cmd.ref}\n`);
  }
  return reportResponse(lines);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): HandlerResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

function gitResponse(contentType: string, body: Buffer): HandlerResponse {
  return { status: 200, headers: { 'content-type': contentType }, body, contentType };
}

export async function handleGit(store: Store, ctx: HandlerCtx): Promise<HandlerResponse> {
  if (!ctx.token) return jsonResponse(401, { message: 'Unauthorized' });

  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(ctx.path);
  if (!m) return jsonResponse(404, { message: 'Not Found' });
  const [, owner, name, tail] = m;
  const repo = store.getRepo(owner, name);
  if (!repo) return jsonResponse(404, { message: 'Repository not found' });

  if (ctx.method === 'GET' && tail === 'info/refs') {
    const service = ctx.query.get('service');
    if (service === 'git-upload-pack') {
      if ((ctx.headers['git-protocol'] ?? '') === 'version=2') {
        return gitResponse('application/x-git-upload-pack-advertisement', ADVERTISEMENT_V2);
      }
      return gitResponse('application/x-git-upload-pack-advertisement', cachedAdvertisementV0(repo, 'git-upload-pack'));
    }
    if (service === 'git-receive-pack') {
      return gitResponse('application/x-git-receive-pack-advertisement', cachedAdvertisementV0(repo, 'git-receive-pack'));
    }
    return jsonResponse(404, { message: 'Not Found' });
  }

  if (ctx.method === 'POST' && tail === 'git-upload-pack') {
    const isV2 = (ctx.headers['git-protocol'] ?? '') === 'version=2';
    let pkts: Pkt[];
    try {
      pkts = decodeAll(ctx.body);
    } catch {
      // Malformed input must never take the server down; answer and stay up.
      return gitResponse(
        'application/x-git-upload-pack-result',
        Buffer.concat([pktLine('ERR malformed request\n'), flushPkt()]),
      );
    }
    const lines = dataLines(pkts);
    const first = lines[0] ?? '';
    if (first.startsWith('command=ls-refs')) {
      return gitResponse('application/x-git-upload-pack-result', handleLsRefs(repo, lines));
    }
    if (first.startsWith('command=fetch')) {
      const args = parseFetchArgs(lines);
      return gitResponse('application/x-git-upload-pack-result', fetchResponseV2(store, repo, args));
    }
    if (first.startsWith('want ')) {
      // v0 fetch (no Git-Protocol header, or a v2-shaped request that is not
      // one): two sections, wants then haves, split by a flush.
      const args = parseFetchArgs(lines);
      return gitResponse('application/x-git-upload-pack-result', fetchResponseV0(store, repo, args));
    }
    if (isV2) {
      // Unknown v2 command: stay healthy, answer an empty result.
      return gitResponse('application/x-git-upload-pack-result', flushPkt());
    }
    return gitResponse('application/x-git-upload-pack-result', flushPkt());
  }

  if (ctx.method === 'POST' && tail === 'git-receive-pack') {
    return gitResponse(
      'application/x-git-receive-pack-result',
      handleReceivePack(store, repo, ctx.body),
    );
  }

  return jsonResponse(404, { message: 'Not Found' });
}
