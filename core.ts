// core.ts — the forge's single core store.
//
// Every surface (REST, GraphQL, MCP, git smart HTTP) is a thin adapter over
// the state and operations in this file, so an object created through one
// surface reads back identically through the others. All state lives in
// memory: a fresh process is a fresh, empty forge.
//
// Determinism: nothing observable may come from the wall clock or a random
// source. Ids come from counters, timestamps from a fixed epoch that
// advances one second per mutation, and iteration order is insertion order
// everywhere the adapters expose it.

import { createHash } from 'node:crypto';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorUnix: number;
  committerName: string;
  committerEmail: string;
  committerUnix: number;
  message: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
}

export interface Pull {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedSeq: number | null;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  packCache: Map<string, Buffer>;
}

/**
 * The built-pack cache, bounded. Packs are cached per repository by fetch
 * signature (see planFetch in git.ts), but the cache as a whole may hold at
 * most PACK_CACHE_MAX_BYTES across every repository: the trial pod has
 * 1 GB of RAM and the forge is otherwise entirely in memory, so an
 * unbounded cache of pack Buffers is the one growth path that could OOM
 * the process. Eviction is LRU over whole entries; a miss simply rebuilds
 * the pack, so eviction never changes behaviour, only speed. All state
 * here is internal bookkeeping — entry ids and byte counts never appear
 * in a response, and eviction order depends only on the request sequence,
 * so replays stay byte-identical.
 */
export const PACK_CACHE_MAX_BYTES = 100 * 1024 * 1024;

let packCacheBytes = 0;
/** Every cached pack, in least-recently-used-first order. */
const packCacheIndex = new Map<string, { repo: Repo; key: string; bytes: number }>();
const packCacheRepoIds = new WeakMap<Repo, number>();
let nextPackCacheRepoId = 1;

function packCacheIndexKey(repo: Repo, key: string): string {
  let id = packCacheRepoIds.get(repo);
  if (id === undefined) {
    id = nextPackCacheRepoId;
    nextPackCacheRepoId += 1;
    packCacheRepoIds.set(repo, id);
  }
  return `${id}|${key}`;
}

/** Fetch a cached pack, refreshing its recency. */
export function packCacheGet(repo: Repo, key: string): Buffer | undefined {
  const pack = repo.packCache.get(key);
  if (pack === undefined) return undefined;
  const indexKey = packCacheIndexKey(repo, key);
  const entry = packCacheIndex.get(indexKey);
  if (entry !== undefined) {
    packCacheIndex.delete(indexKey);
    packCacheIndex.set(indexKey, entry);
  }
  return pack;
}

/**
 * Store a pack under a fetch signature, then evict least-recently-used
 * packs (whole entries, across all repositories) until the cached total
 * is within the cap. Returns the evicted keys that belonged to this
 * repository, so the caller can drop companion per-signature data.
 */
export function packCacheSet(repo: Repo, key: string, pack: Buffer): string[] {
  const indexKey = packCacheIndexKey(repo, key);
  const previous = packCacheIndex.get(indexKey);
  if (previous !== undefined) {
    packCacheIndex.delete(indexKey);
    packCacheBytes -= previous.bytes;
  }
  repo.packCache.set(key, pack);
  packCacheIndex.set(indexKey, { repo, key, bytes: pack.length });
  packCacheBytes += pack.length;
  const evictedHere: string[] = [];
  while (packCacheBytes > PACK_CACHE_MAX_BYTES && packCacheIndex.size > 0) {
    const oldestKey = packCacheIndex.keys().next().value as string;
    const oldest = packCacheIndex.get(oldestKey) as { repo: Repo; key: string; bytes: number };
    packCacheIndex.delete(oldestKey);
    packCacheBytes -= oldest.bytes;
    oldest.repo.packCache.delete(oldest.key);
    if (oldest.repo === repo) evictedHere.push(oldest.key);
  }
  return evictedHere;
}

/** Drop every cached pack for a repository (a ref update invalidates all signatures). */
export function packCacheClear(repo: Repo): void {
  for (const [indexKey, entry] of packCacheIndex) {
    if (entry.repo === repo) {
      packCacheIndex.delete(indexKey);
      packCacheBytes -= entry.bytes;
    }
  }
  repo.packCache.clear();
}

/** An error an adapter can translate directly into an HTTP answer. */
export class ForgeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const ZERO_OID = '0'.repeat(40);

/** The fixed epoch every forge timestamp derives from (2025-01-01T00:00:00Z). */
const EPOCH_UNIX = 1735689600;

export class Forge {
  /** The login the bearer token names; adopted from the first owner path seen. */
  viewerLogin: string | null = null;
  readonly viewerId = 1000;

  private seq = 0;
  private nextRepoId = 1;
  private nextObjectId = 1;
  private nextCommentId = 1;
  private readonly reposByName = new Map<string, Repo>();
  private readonly repoOrder: Repo[] = [];

  /** Advance the deterministic clock and return the new sequence number. */
  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  /** ISO-8601 rendering of a sequence number's timestamp. */
  isoOf(seq: number): string {
    return new Date((EPOCH_UNIX + seq) * 1000).toISOString();
  }

  /** Unix seconds for a sequence number (git commit timestamps). */
  unixOf(seq: number): number {
    return EPOCH_UNIX + seq;
  }

  get currentSeq(): number {
    return this.seq;
  }

  /** Record the token owner's login the first time an owner path names it. */
  adoptLogin(login: string): void {
    if (this.viewerLogin === null && login !== '') this.viewerLogin = login;
  }

  /** Whether an owner path names the token's owner (or none is known yet). */
  ownerMatches(owner: string): boolean {
    return this.viewerLogin === null || owner === this.viewerLogin;
  }

  /** The identity forge-authored commits carry. */
  authorIdentity(): { name: string; email: string } {
    const login = this.viewerLogin ?? 'forge';
    return { name: login, email: `${login}@example.invalid` };
  }

  // ------------------------------------------------------------ repositories

  createRepo(input: { name: string; isPrivate: boolean; description: string }): Repo {
    const name = input.name;
    if (typeof name !== 'string' || name === '' || name.includes('/') || name === '.' || name === '..') {
      throw new ForgeError(422, 'Repository creation failed: name is invalid');
    }
    if (this.reposByName.has(name)) {
      throw new ForgeError(422, 'Repository creation failed: name already exists on this account');
    }
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      isPrivate: input.isPrivate,
      description: input.description,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      packCache: new Map(),
    };
    this.nextRepoId += 1;
    this.tick();
    this.reposByName.set(name, repo);
    this.repoOrder.push(repo);
    return repo;
  }

  /** Resolve a repository by owner + name; null when it is not the viewer's. */
  repoFor(owner: string, name: string): Repo | null {
    this.adoptLogin(owner);
    if (!this.ownerMatches(owner)) return null;
    return this.reposByName.get(name) ?? null;
  }

  /** Resolve a repository by name alone (git routes carry the owner too). */
  repoByName(name: string): Repo | null {
    return this.reposByName.get(name) ?? null;
  }

  deleteRepo(repo: Repo): void {
    this.reposByName.delete(repo.name);
    const index = this.repoOrder.indexOf(repo);
    if (index >= 0) this.repoOrder.splice(index, 1);
    this.tick();
  }

  /** The viewer's repositories in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repoOrder];
  }

  // ------------------------------------------------------------ git objects

  /** Hash and store an object; returns its oid. Storing is idempotent. */
  storeObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
    const oid = createHash('sha1').update(header).update(data).digest('hex');
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  object(repo: Repo, oid: string): GitObject | null {
    return repo.objects.get(oid) ?? null;
  }

  /** Parse a tree object's raw bytes into entries (stored order). */
  parseTree(data: Buffer): TreeEntry[] {
    const entries: TreeEntry[] = [];
    let pos = 0;
    while (pos < data.length) {
      const space = data.indexOf(0x20, pos);
      const mode = data.subarray(pos, space).toString('utf8');
      const nul = data.indexOf(0x00, space + 1);
      const name = data.subarray(space + 1, nul).toString('utf8');
      const oid = data.subarray(nul + 1, nul + 21).toString('hex');
      entries.push({ mode, name, oid });
      pos = nul + 21;
    }
    return entries;
  }

  /** Serialize tree entries, sorted the way git sorts them. */
  buildTree(entries: TreeEntry[]): Buffer {
    const sorted = [...entries].sort((a, b) => {
      const ka = a.mode === '40000' ? `${a.name}/` : a.name;
      const kb = b.mode === '40000' ? `${b.name}/` : b.name;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const parts: Buffer[] = [];
    for (const entry of sorted) {
      parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
      parts.push(Buffer.from(entry.oid, 'hex'));
    }
    return Buffer.concat(parts);
  }

  storeTree(repo: Repo, entries: TreeEntry[]): string {
    return this.storeObject(repo, 'tree', this.buildTree(entries));
  }

  /** Parse a commit object's raw bytes. */
  parseCommit(data: Buffer): CommitInfo {
    const text = data.toString('utf8');
    const split = text.indexOf('\n\n');
    const head = split >= 0 ? text.slice(0, split) : text;
    const message = split >= 0 ? text.slice(split + 2) : '';
    let tree = '';
    const parents: string[] = [];
    let author = '';
    let committer = '';
    for (const line of head.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
      else if (line.startsWith('author ')) author = line.slice(7);
      else if (line.startsWith('committer ')) committer = line.slice(10);
    }
    const person = (line: string): { name: string; email: string; unix: number } => {
      const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
      if (match === null) return { name: line, email: '', unix: EPOCH_UNIX };
      return { name: match[1] as string, email: match[2] as string, unix: Number(match[3]) };
    };
    const a = person(author);
    const c = person(committer);
    return {
      tree,
      parents,
      authorName: a.name,
      authorEmail: a.email,
      authorUnix: a.unix,
      committerName: c.name,
      committerEmail: c.email,
      committerUnix: c.unix,
      message,
    };
  }

  /** Build and store a commit; returns its oid. */
  createCommit(
    repo: Repo,
    input: { tree: string; parents: string[]; message: string; seq: number },
  ): string {
    const identity = this.authorIdentity();
    const unix = this.unixOf(input.seq);
    const lines = [`tree ${input.tree}`];
    for (const parent of input.parents) lines.push(`parent ${parent}`);
    lines.push(`author ${identity.name} <${identity.email}> ${unix} +0000`);
    lines.push(`committer ${identity.name} <${identity.email}> ${unix} +0000`);
    const data = Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
    return this.storeObject(repo, 'commit', data);
  }

  /** The commit a ref or oid names, following tags; null when unresolvable. */
  commitOf(repo: Repo, oid: string): string | null {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const obj = this.object(repo, current);
      if (obj === null) return null;
      if (obj.type === 'commit') return current;
      if (obj.type === 'tag') {
        const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (match === null) return null;
        current = match[1] as string;
        continue;
      }
      return null;
    }
    return null;
  }

  /** The oid a ref value (branch name, full ref, or raw oid) resolves to. */
  resolveRef(repo: Repo, ref: string | null | undefined): string | null {
    if (ref === null || ref === undefined || ref === '') {
      return this.branchTip(repo, repo.defaultBranch);
    }
    if (ref.startsWith('refs/')) {
      const direct = repo.refs.get(ref);
      if (direct !== undefined) return direct;
    }
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) return tag;
    if (/^[0-9a-f]{40}$/.test(ref) && this.object(repo, ref) !== null) return ref;
    return null;
  }

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Branch names in sorted order. */
  branchNames(repo: Repo): string[] {
    const names: string[] = [];
    for (const ref of repo.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  setBranch(repo: Repo, branch: string, oid: string): void {
    repo.refs.set(`refs/heads/${branch}`, oid);
    packCacheClear(repo);
  }

  /** Every commit reachable from a tip, with its BFS depth (tip = 0). */
  ancestorsOf(repo: Repo, tip: string): Map<string, number> {
    const depths = new Map<string, number>();
    const queue: Array<{ oid: string; depth: number }> = [{ oid: tip, depth: 0 }];
    while (queue.length > 0) {
      const { oid, depth } = queue.shift() as { oid: string; depth: number };
      if (depths.has(oid)) continue;
      const obj = this.object(repo, oid);
      if (obj === null || obj.type !== 'commit') continue;
      depths.set(oid, depth);
      for (const parent of this.parseCommit(obj.data).parents) {
        if (!depths.has(parent)) queue.push({ oid: parent, depth: depth + 1 });
      }
    }
    return depths;
  }

  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return this.ancestorsOf(repo, descendant).has(ancestor);
  }

  /** A best common ancestor of two commits, or null when unrelated. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const fromA = this.ancestorsOf(repo, a);
    const fromB = this.ancestorsOf(repo, b);
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [oid, depthA] of fromA) {
      const depthB = fromB.get(oid);
      if (depthB === undefined) continue;
      const score = depthA + depthB;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    return best;
  }

  /** Flatten a tree into a map of file path -> blob oid (recursive). */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
    const obj = this.object(repo, treeOid);
    if (obj === null || obj.type !== 'tree') return out;
    for (const entry of this.parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(repo, entry.oid, path, out);
      else out.set(path, entry.oid);
    }
    return out;
  }

  /** Rebuild nested trees from a flat path -> blob map; returns the root oid. */
  treeFromFlat(repo: Repo, flat: Map<string, string>): string {
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, oid] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i] as string;
        let next = node.dirs.get(part);
        if (next === undefined) {
          next = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, next);
        }
        node = next;
      }
      node.files.set(parts[parts.length - 1] as string, oid);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.storeTree(repo, entries);
    };
    return build(root);
  }

  /** The tree oid at a path inside a root tree, or null. */
  treeAt(repo: Repo, rootTree: string, parts: string[]): { type: 'tree' | 'blob'; oid: string } | null {
    let current = rootTree;
    for (let i = 0; i < parts.length; i += 1) {
      const obj = this.object(repo, current);
      if (obj === null || obj.type !== 'tree') return null;
      const entry = this.parseTree(obj.data).find((e) => e.name === parts[i]);
      if (entry === undefined) return null;
      if (i === parts.length - 1) {
        return entry.mode === '40000' ? { type: 'tree', oid: entry.oid } : { type: 'blob', oid: entry.oid };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return { type: 'tree', oid: rootTree };
  }

  // ------------------------------------------------------------ contents API

  /** Read a file or directory at a path on a ref. */
  readContent(
    repo: Repo,
    path: string,
    ref: string | null | undefined,
  ): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: TreeEntry[]; prefix: string } | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return null;
    const commitOid = this.commitOf(repo, tip);
    if (commitOid === null) return null;
    const commit = this.object(repo, commitOid);
    if (commit === null) return null;
    const rootTree = this.parseCommit(commit.data).tree;
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (clean === '') {
      const root = this.object(repo, rootTree);
      if (root === null) return null;
      return { kind: 'dir', entries: this.parseTree(root.data), prefix: '' };
    }
    const found = this.treeAt(repo, rootTree, clean.split('/'));
    if (found === null) return null;
    if (found.type === 'blob') {
      const blob = this.object(repo, found.oid);
      if (blob === null) return null;
      return { kind: 'file', oid: found.oid, data: blob.data };
    }
    const tree = this.object(repo, found.oid);
    if (tree === null) return null;
    return { kind: 'dir', entries: this.parseTree(tree.data), prefix: clean };
  }

  /**
   * Write a file on a branch, creating the branch (and the repository's first
   * commit) when needed. Returns the blob and commit oids and whether the
   * file was created.
   */
  putContent(
    repo: Repo,
    input: { path: string; data: Buffer; message: string; branch?: string; sha?: string },
  ): { blobOid: string; commitOid: string; created: boolean } {
    const branch = input.branch ?? repo.defaultBranch;
    const clean = input.path.replace(/^\/+/, '');
    if (clean === '') throw new ForgeError(422, 'Invalid path');
    const tip = this.branchTip(repo, branch);
    let flat = new Map<string, string>();
    let parents: string[] = [];
    if (tip !== null) {
      const commitOid = this.commitOf(repo, tip);
      if (commitOid !== null) {
        const commit = this.object(repo, commitOid);
        if (commit !== null) {
          flat = this.flattenTree(repo, this.parseCommit(commit.data).tree);
          parents = [commitOid];
        }
      }
    } else if (branch !== repo.defaultBranch) {
      // A new branch starts from the default branch's tip when there is one.
      const baseTip = this.branchTip(repo, repo.defaultBranch);
      if (baseTip !== null) {
        const commitOid = this.commitOf(repo, baseTip);
        if (commitOid !== null) {
          const commit = this.object(repo, commitOid);
          if (commit !== null) {
            flat = this.flattenTree(repo, this.parseCommit(commit.data).tree);
            parents = [commitOid];
          }
        }
      }
    }
    const existing = flat.get(clean);
    const created = existing === undefined;
    if (!created && input.sha !== undefined && input.sha !== existing) {
      throw new ForgeError(409, `${clean} does not match ${input.sha}`);
    }
    const blobOid = this.storeObject(repo, 'blob', input.data);
    flat.set(clean, blobOid);
    const tree = this.treeFromFlat(repo, flat);
    const seq = this.tick();
    const commitOid = this.createCommit(repo, { tree, parents, message: input.message, seq });
    this.setBranch(repo, branch, commitOid);
    return { blobOid, commitOid, created };
  }

  /** Delete a file on a branch; returns the new commit oid. */
  deleteContent(repo: Repo, input: { path: string; message: string; sha?: string; branch?: string }): { commitOid: string } {
    const branch = input.branch ?? repo.defaultBranch;
    const clean = input.path.replace(/^\/+/, '');
    const tip = this.branchTip(repo, branch);
    if (tip === null) throw new ForgeError(404, 'Not Found');
    const commitOid = this.commitOf(repo, tip);
    if (commitOid === null) throw new ForgeError(404, 'Not Found');
    const commit = this.object(repo, commitOid);
    if (commit === null) throw new ForgeError(404, 'Not Found');
    const flat = this.flattenTree(repo, this.parseCommit(commit.data).tree);
    const existing = flat.get(clean);
    if (existing === undefined) throw new ForgeError(404, 'Not Found');
    if (input.sha !== undefined && input.sha !== existing) {
      throw new ForgeError(409, `${clean} does not match ${input.sha}`);
    }
    flat.delete(clean);
    const tree = this.treeFromFlat(repo, flat);
    const seq = this.tick();
    const next = this.createCommit(repo, { tree, parents: [commitOid], message: input.message, seq });
    this.setBranch(repo, branch, next);
    return { commitOid: next };
  }

  // ------------------------------------------------------------ labels

  createLabel(repo: Repo, input: { name: string; color: string }): Label {
    if (repo.labels.has(input.name)) {
      throw new ForgeError(422, `Label "${input.name}" already exists`);
    }
    const label: Label = { name: input.name, color: input.color.replace(/^#/, '') };
    repo.labels.set(label.name, label);
    this.tick();
    return label;
  }

  // ------------------------------------------------------------ issues

  createIssue(repo: Repo, input: { title: string; body: string; labels?: string[] }): Issue {
    const labels = input.labels ?? [];
    for (const name of labels) {
      if (!repo.labels.has(name)) {
        throw new ForgeError(422, `Label "${name}" does not exist on this repository`);
      }
    }
    const seq = this.tick();
    const issue: Issue = {
      kind: 'issue',
      id: this.nextObjectId,
      number: repo.nextNumber,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq,
    };
    this.nextObjectId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  listIssues(repo: Repo, filter: { state: string; direction: string }): Issue[] {
    const all = [...repo.issues.values()];
    const filtered = filter.state === 'all' ? all : all.filter((i) => i.state === filter.state);
    filtered.sort((a, b) => a.number - b.number);
    if (filter.direction === 'desc') filtered.reverse();
    return filtered;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const seq = this.tick();
    const comment: IssueComment = { id: this.nextCommentId, body, seq };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // ------------------------------------------------------------ pull requests

  createPull(repo: Repo, input: { title: string; body: string; head: string; base: string }): Pull {
    const headTip = this.branchTip(repo, input.head);
    if (headTip === null) throw new ForgeError(422, `Head ref ${input.head} does not exist`);
    const baseTip = this.branchTip(repo, input.base);
    if (baseTip === null) throw new ForgeError(422, `Base ref ${input.base} does not exist`);
    if (input.head === input.base) throw new ForgeError(422, 'Head and base must be different');
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === input.head && pull.baseRef === input.base) {
        throw new ForgeError(422, `A pull request already exists for ${input.head} into ${input.base}`);
      }
    }
    if (headTip === baseTip) throw new ForgeError(422, `No commits between ${input.base} and ${input.head}`);
    const seq = this.tick();
    const pull: Pull = {
      kind: 'pull',
      id: this.nextObjectId,
      number: repo.nextNumber,
      title: input.title,
      body: input.body,
      state: 'open',
      headRef: input.head,
      baseRef: input.base,
      merged: false,
      mergeCommitSha: null,
      mergedSeq: null,
      seq,
    };
    this.nextObjectId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  listPulls(repo: Repo, state: string): Pull[] {
    const all = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
    if (state === 'all') return all;
    if (state === 'closed') return all.filter((p) => p.state === 'closed');
    return all.filter((p) => p.state === 'open');
  }

  /** The tree a commit oid points at. */
  treeOfCommit(repo: Repo, commitOid: string): string | null {
    const obj = this.object(repo, commitOid);
    if (obj === null || obj.type !== 'commit') return null;
    return this.parseCommit(obj.data).tree;
  }

  /**
   * Three-way merge of two tips' trees against their merge base.
   * Returns the merged tree oid, or null on a content conflict.
   */
  mergedTree(repo: Repo, baseTip: string, headTip: string): string | null {
    const base = this.mergeBase(repo, baseTip, headTip);
    const baseTree = this.treeOfCommit(repo, baseTip);
    const headTree = this.treeOfCommit(repo, headTip);
    if (baseTree === null || headTree === null) return null;
    const ancestorTree = base !== null ? this.treeOfCommit(repo, base) : null;
    const baseFlat = this.flattenTree(repo, baseTree);
    const headFlat = this.flattenTree(repo, headTree);
    const ancestorFlat = ancestorTree !== null ? this.flattenTree(repo, ancestorTree) : new Map<string, string>();
    const merged = new Map<string, string>();
    const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys(), ...ancestorFlat.keys()]);
    for (const path of paths) {
      const inBase = baseFlat.get(path);
      const inHead = headFlat.get(path);
      const inAncestor = ancestorFlat.get(path);
      let chosen: string | undefined;
      if (inHead === inBase) chosen = inBase;
      else if (inBase === inAncestor) chosen = inHead;
      else if (inHead === inAncestor) chosen = inBase;
      else return null;
      if (chosen !== undefined) merged.set(path, chosen);
    }
    return this.treeFromFlat(repo, merged);
  }

  /** Whether a pull request would merge cleanly right now. */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    if (pull.state !== 'open' || pull.merged) return false;
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return false;
    if (headTip === baseTip) return false;
    if (this.isAncestor(repo, headTip, baseTip)) return false;
    return this.mergedTree(repo, baseTip, headTip) !== null;
  }

  /** The changed files of a pull request, against its merge base. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return [];
    const base = this.mergeBase(repo, baseTip, headTip);
    const headTree = this.treeOfCommit(repo, headTip);
    if (headTree === null) return [];
    const ancestorTree = base !== null ? this.treeOfCommit(repo, base) : null;
    const headFlat = this.flattenTree(repo, headTree);
    const ancestorFlat = ancestorTree !== null ? this.flattenTree(repo, ancestorTree) : new Map<string, string>();
    const lines = (oid: string | undefined): number => {
      if (oid === undefined) return 0;
      const obj = this.object(repo, oid);
      if (obj === null) return 0;
      const text = obj.data.toString('utf8');
      if (text === '') return 0;
      const parts = text.split('\n');
      return text.endsWith('\n') ? parts.length - 1 : parts.length;
    };
    const files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set<string>([...ancestorFlat.keys(), ...headFlat.keys()]);
    for (const path of [...paths].sort()) {
      const before = ancestorFlat.get(path);
      const after = headFlat.get(path);
      if (before === after) continue;
      if (before === undefined) {
        const additions = lines(after);
        files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (after === undefined) {
        const deletions = lines(before);
        files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else {
        const additions = lines(after);
        const deletions = lines(before);
        files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  /**
   * Squash-merge a pull request onto its base branch.
   * Throws ForgeError 404/405 in the shapes the wire contract requires.
   */
  mergePull(repo: Repo, pull: Pull): { sha: string } {
    if (pull.merged || pull.state !== 'open') {
      throw new ForgeError(405, 'Pull Request is not mergeable');
    }
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) throw new ForgeError(405, 'Pull Request is not mergeable');
    if (headTip === baseTip || this.isAncestor(repo, headTip, baseTip)) {
      throw new ForgeError(405, 'Pull Request is not mergeable');
    }
    const tree = this.mergedTree(repo, baseTip, headTip);
    if (tree === null) throw new ForgeError(405, 'Pull Request is not mergeable');
    const seq = this.tick();
    const message = pull.body === '' ? pull.title : `${pull.title}\n\n${pull.body}`;
    const sha = this.createCommit(repo, { tree, parents: [baseTip], message, seq });
    this.setBranch(repo, pull.baseRef, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = sha;
    pull.mergedSeq = seq;
    return { sha };
  }

  /** Commits reachable from a ref, newest first (DFS pre-order). */
  listCommits(repo: Repo, ref: string | null | undefined): Array<{ sha: string; info: CommitInfo }> {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return [];
    const start = this.commitOf(repo, tip);
    if (start === null) return [];
    const seen = new Set<string>();
    const out: Array<{ sha: string; info: CommitInfo }> = [];
    const stack: string[] = [start];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.object(repo, oid);
      if (obj === null || obj.type !== 'commit') continue;
      const info = this.parseCommit(obj.data);
      out.push({ sha: oid, info });
      for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i] as string);
    }
    return out;
  }
}
