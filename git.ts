// git.ts — git smart HTTP, implemented from the protocol up: pkt-line
// framing, pack reading (with OFS/REF delta reconstruction) and writing,
// protocol v2 (ls-refs, fetch) and the v0 fallback, shallow clones and
// fast-forward-only receive-pack with per-ref report-status.
//
// Objects live in the core store (a Map keyed by sha1). Built packs are
// cached per repository keyed by the want/have/depth signature, so the
// repeated shallow-clone workload is served from RAM after the first build.
// The cache is byte-bounded with LRU eviction (see packCacheSet in core.ts):
// the trial pod has 1 GB of RAM, so cached packs may never grow without limit.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

import {
  Forge,
  ForgeError,
  ZERO_OID,
  packCacheClear,
  packCacheGet,
  packCacheSet,
  type GitObject,
  type ObjectType,
  type Repo,
} from './core.ts';
import { readBody, sendRaw } from './http.ts';

const AGENT = 'forge/1.0';
const TYPE_NAMES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_NUMBERS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

// ---------------------------------------------------------------- pkt-lines

/** Encode one pkt-line from a payload (string payloads are utf8). */
export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/** Parse a whole buffer into packets; throws on malformed framing. */
export function parsePackets(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let pos = 0;
  while (pos < buffer.length) {
    if (pos + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const hex = buffer.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
    } else if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      pos += 4;
    } else if (length < 4) {
      throw new Error(`bad pkt-line length ${length}`);
    } else {
      if (pos + length > buffer.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: buffer.subarray(pos + 4, pos + length) });
      pos += length;
    }
  }
  return packets;
}

/** Frame data as sideband band-1 pkt-lines in bounded chunks. */
export function sideband(data: Buffer, band = 1): Buffer[] {
  const frames: Buffer[] = [];
  const CHUNK = 32768;
  for (let pos = 0; pos < data.length; pos += CHUNK) {
    const slice = data.subarray(pos, Math.min(pos + CHUNK, data.length));
    frames.push(pkt(Buffer.concat([Buffer.from([band]), slice])));
  }
  if (frames.length === 0) frames.push(pkt(Buffer.from([band])));
  return frames;
}

// ---------------------------------------------------------------- pack io

/** Inflate one zlib stream starting at `offset`, locating its exact end. */
function inflateAt(buffer: Buffer, offset: number, expectedSize: number): { data: Buffer; next: number } {
  const attempt = (length: number): Buffer | null => {
    try {
      const out = inflateSync(buffer.subarray(offset, offset + length));
      return out.length === expectedSize ? out : null;
    } catch {
      return null;
    }
  };
  const remaining = buffer.length - offset;
  let hi = Math.min(remaining, Math.max(24, expectedSize + 16));
  let data = attempt(hi);
  while (data === null && hi < remaining) {
    hi = Math.min(remaining, hi * 2);
    data = attempt(hi);
  }
  if (data === null) throw new Error('corrupt zlib stream in pack');
  // Binary-search the smallest length that still inflates to the object.
  let lo = 8;
  let high = hi;
  while (lo < high) {
    const mid = (lo + high) >> 1;
    if (attempt(mid) !== null) high = mid;
    else lo = mid + 1;
  }
  const final = attempt(lo);
  if (final === null) throw new Error('corrupt zlib stream in pack');
  return { data: final, next: offset + lo };
}

/** Apply a git delta (copy/insert instructions) to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[pos] as number; pos += 1; }
      if (op & 0x02) { offset |= (delta[pos] as number) << 8; pos += 1; }
      if (op & 0x04) { offset |= (delta[pos] as number) << 16; pos += 1; }
      if (op & 0x08) { offset |= (delta[pos] as number) << 24; pos += 1; }
      if (op & 0x10) { size = delta[pos] as number; pos += 1; }
      if (op & 0x20) { size |= (delta[pos] as number) << 8; pos += 1; }
      if (op & 0x40) { size |= (delta[pos] as number) << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

interface PackEntry {
  start: number;
  typeNumber: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Parse a pack and resolve every entry (deltas included) into whole
 * objects. `external` resolves bases the pack itself does not carry
 * (thin packs against the repository store).
 */
export function readPack(
  buffer: Buffer,
  external: (oid: string) => GitObject | null,
): Array<{ oid: string; type: ObjectType; data: Buffer }> {
  if (buffer.length < 12 + 20) throw new Error('pack too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const version = buffer.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buffer.readUInt32BE(8);
  let pos = 12;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    let byte = buffer[pos] as number;
    pos += 1;
    const typeNumber = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buffer[pos] as number;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeNumber === 6) {
      let c = buffer[pos] as number;
      pos += 1;
      let back = c & 0x7f;
      while (c & 0x80) {
        c = buffer[pos] as number;
        pos += 1;
        back = ((back + 1) << 7) | (c & 0x7f);
      }
      baseOffset = start - back;
    } else if (typeNumber === 7) {
      baseOid = buffer.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else if (TYPE_NAMES[typeNumber] === undefined) {
      throw new Error(`unknown pack object type ${typeNumber}`);
    }
    const inflated = inflateAt(buffer, pos, size);
    pos = inflated.next;
    const entry: PackEntry = { start, typeNumber, data: inflated.data, baseOffset, baseOid };
    entries.push(entry);
    byOffset.set(start, entry);
  }
  const trailer = buffer.subarray(buffer.length - 20);
  const digest = createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');

  const resolved = new Map<number, { type: ObjectType; data: Buffer }>();
  const resolving = new Set<number>();
  const resolveEntry = (entry: PackEntry): { type: ObjectType; data: Buffer } => {
    const cached = resolved.get(entry.start);
    if (cached !== undefined) return cached;
    if (resolving.has(entry.start)) throw new Error('delta cycle in pack');
    resolving.add(entry.start);
    let result: { type: ObjectType; data: Buffer };
    if (entry.typeNumber === 6 || entry.typeNumber === 7) {
      let base: { type: ObjectType; data: Buffer } | null = null;
      if (entry.typeNumber === 6) {
        const baseEntry = byOffset.get(entry.baseOffset as number);
        if (baseEntry === undefined) throw new Error('ofs-delta base missing from pack');
        base = resolveEntry(baseEntry);
      } else {
        const inPack = entries.find((e) => {
          if (e.typeNumber === 6 || e.typeNumber === 7) return false;
          const header = Buffer.from(`${TYPE_NAMES[e.typeNumber]} ${e.data.length}\0`, 'utf8');
          return createHash('sha1').update(header).update(e.data).digest('hex') === entry.baseOid;
        });
        if (inPack !== undefined) base = resolveEntry(inPack);
        else {
          const found = external(entry.baseOid as string);
          if (found !== null) base = { type: found.type, data: found.data };
        }
      }
      if (base === null) throw new Error('delta base not found');
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      result = { type: TYPE_NAMES[entry.typeNumber] as ObjectType, data: entry.data };
    }
    resolving.delete(entry.start);
    resolved.set(entry.start, result);
    return result;
  };

  return entries.map((entry) => {
    const whole = resolveEntry(entry);
    const header = Buffer.from(`${whole.type} ${whole.data.length}\0`, 'utf8');
    const oid = createHash('sha1').update(header).update(whole.data).digest('hex');
    return { oid, type: whole.type, data: whole.data };
  });
}

/** Serialize whole objects into a pack (no delta compression, level 1). */
export function buildPack(objects: Array<{ type: ObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    let size = obj.data.length;
    const first = (TYPE_NUMBERS[obj.type] << 4) | (size & 0x0f);
    size >>= 4;
    if (size === 0) {
      parts.push(Buffer.from([first]));
    } else {
      const bytes = [first | 0x80];
      while (size > 0) {
        let byte = size & 0x7f;
        size >>= 7;
        if (size > 0) byte |= 0x80;
        bytes.push(byte);
      }
      parts.push(Buffer.from(bytes));
    }
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- fetch math

/**
 * Every object oid reachable from the given roots (commits, trees, blobs,
 * tags). Commits in `stopCommits` are included with their trees but their
 * parents are not followed — a shallow boundary the peer already declared.
 */
function objectClosure(forge: Forge, repo: Repo, roots: string[], stopCommits?: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = forge.object(repo, oid);
    if (obj === null) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const info = forge.parseCommit(obj.data);
      stack.push(info.tree);
      if (stopCommits === undefined || !stopCommits.has(oid)) stack.push(...info.parents);
    } else if (obj.type === 'tree') {
      for (const entry of forge.parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const target = forge.commitOf(repo, oid);
      if (target !== null) stack.push(target);
    }
  }
  return seen;
}

interface FetchPlan {
  pack: Buffer;
  empty: boolean;
  shallowOut: string[];
  unshallowOut: string[];
}

/** Boundary results cached beside the pack cache (packs themselves are Buffers). */
const planBoundaries = new WeakMap<Repo, Map<string, { empty: boolean; shallowOut: string[]; unshallowOut: string[] }>>();

/**
 * Work out what a fetch delivers: the commits within the depth limit that
 * the peer lacks, their full tree closures, and the shallow boundary.
 * Results are cached per repository by request signature.
 */
function planFetch(
  forge: Forge,
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowIn: string[],
  depth: number | null,
): FetchPlan {
  const key = [wants.join(','), haves.join(','), shallowIn.join(','), depth ?? ''].join('|');
  const cachedPack = packCacheGet(repo, key);
  const cachedBounds = planBoundaries.get(repo)?.get(key);
  if (cachedPack !== undefined && cachedBounds !== undefined) {
    return { pack: cachedPack, ...cachedBounds };
  }
  // Bounds without their pack are useless (the pack was evicted or the
  // cache was cleared); drop them so this map cannot accumulate orphans.
  if (cachedPack === undefined && cachedBounds !== undefined) {
    planBoundaries.get(repo)?.delete(key);
  }

  // What the peer actually holds: a have that is also a declared shallow
  // boundary stands for itself only — its history is precisely what the
  // peer does not have.
  const shallowSet = new Set(shallowIn);
  const haveObjects = objectClosure(forge, repo, haves, shallowSet);
  const haveCommits = new Set<string>();
  for (const have of haves) {
    const commit = forge.commitOf(repo, have);
    if (commit === null) continue;
    if (shallowSet.has(commit)) haveCommits.add(commit);
    else for (const oid of forge.ancestorsOf(repo, commit).keys()) haveCommits.add(oid);
  }

  // Breadth-first levels from the wants (a want commit is level 1). The
  // walk passes through held commits — deepening travels through them to
  // reach the history below — but delivery below excludes what is held.
  const levels = new Map<string, number>();
  const tagWants: string[] = [];
  const queue: Array<{ oid: string; level: number }> = [];
  for (const want of wants) {
    const obj = forge.object(repo, want);
    if (obj === null) continue;
    if (obj.type === 'tag') {
      if (!haveObjects.has(want)) tagWants.push(want);
      const target = forge.commitOf(repo, want);
      if (target !== null) queue.push({ oid: target, level: 1 });
    } else if (obj.type === 'commit') {
      queue.push({ oid: want, level: 1 });
    }
  }
  while (queue.length > 0) {
    const { oid, level } = queue.shift() as { oid: string; level: number };
    if (levels.has(oid)) continue;
    if (depth !== null && level > depth) continue;
    const obj = forge.object(repo, oid);
    if (obj === null || obj.type !== 'commit') continue;
    levels.set(oid, level);
    for (const parent of forge.parseCommit(obj.data).parents) {
      queue.push({ oid: parent, level: level + 1 });
    }
  }

  const shallowOut: string[] = [];
  if (depth !== null) {
    for (const [oid, level] of levels) {
      if (level !== depth) continue;
      const obj = forge.object(repo, oid);
      if (obj === null || obj.type !== 'commit') continue;
      const parents = forge.parseCommit(obj.data).parents;
      if (parents.some((parent) => !haveCommits.has(parent) && forge.object(repo, parent) !== null)) {
        shallowOut.push(oid);
      }
    }
  }
  const unshallowOut: string[] = [];
  for (const boundary of shallowIn) {
    const level = levels.get(boundary);
    if (level !== undefined && (depth === null || level < depth)) unshallowOut.push(boundary);
  }

  // Assemble: wanted tags, the included commits, and their tree closures,
  // minus everything the peer already holds.
  const send = new Map<string, GitObject>();
  const addObject = (oid: string): void => {
    if (send.has(oid) || haveObjects.has(oid)) return;
    const obj = forge.object(repo, oid);
    if (obj === null) return;
    send.set(oid, obj);
    if (obj.type === 'tree') {
      for (const entry of forge.parseTree(obj.data)) addObject(entry.oid);
    }
  };
  for (const tag of tagWants) addObject(tag);
  for (const oid of levels.keys()) {
    if (!haveObjects.has(oid)) {
      const obj = forge.object(repo, oid);
      if (obj !== null) send.set(oid, obj);
    }
    const obj = forge.object(repo, oid);
    if (obj !== null && obj.type === 'commit') addObject(forge.parseCommit(obj.data).tree);
  }

  const objects = [...send.values()].map((obj) => ({ type: obj.type, data: obj.data }));
  const pack = buildPack(objects);
  const plan: FetchPlan = { pack, empty: objects.length === 0, shallowOut, unshallowOut };
  let bounds = planBoundaries.get(repo);
  if (bounds === undefined) {
    bounds = new Map();
    planBoundaries.set(repo, bounds);
  }
  bounds.set(key, { empty: plan.empty, shallowOut, unshallowOut });
  // Bounded store: if this evicted older packs of this repository, their
  // boundary entries go too, so the two caches never drift apart.
  for (const evictedKey of packCacheSet(repo, key, pack)) {
    if (evictedKey !== key) bounds.delete(evictedKey);
  }
  return plan;
}

// ---------------------------------------------------------------- handlers

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The v0 ref advertisement lines for a service. */
function advertisementV0(forge: Forge, repo: Repo, service: string): Buffer {
  const caps = service === 'git-upload-pack'
    ? `side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const lines: string[] = [];
  const headTip = forge.branchTip(repo, repo.defaultBranch);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}`);
  } else {
    // The capabilities ride on the first line, HEAD's, born or unborn.
    lines.push(headTip !== null ? `${headTip} HEAD\0${caps}` : `${ZERO_OID} HEAD\0${caps}`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}`);
      const obj = forge.object(repo, ref.oid);
      if (obj !== null && obj.type === 'tag') {
        const target = forge.commitOf(repo, ref.oid);
        if (target !== null) lines.push(`${target} ${ref.name}^{}`);
      }
    }
  }
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  for (const line of lines) parts.push(pkt(`${line}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement (upload-pack only). */
function advertisementV2(repo: Repo): Buffer {
  void repo;
  return Buffer.concat([
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow\n'),
    pkt('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

/** Answer an ls-refs command. */
function lsRefs(forge: Forge, repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  if (matches('HEAD')) {
    const tip = forge.branchTip(repo, repo.defaultBranch);
    if (tip !== null) {
      lines.push(`${tip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}`);
    } else if (unborn) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const obj = forge.object(repo, ref.oid);
      if (obj !== null && obj.type === 'tag') {
        const target = forge.commitOf(repo, ref.oid);
        if (target !== null) line += ` peeled:${target}`;
      }
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => pkt(`${line}\n`)), PKT_FLUSH]);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
  }
  return args;
}

/** Answer a v2 fetch command. */
function fetchV2(forge: Forge, repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(forge, repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [pkt('acknowledgments\n'), pkt(plan.empty ? 'ready\n' : 'NAK\n'), PKT_DELIM];
  if (plan.shallowOut.length > 0 || plan.unshallowOut.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallowOut) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallowOut) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  if (!plan.empty) {
    parts.push(pkt('packfile\n'));
    parts.push(...sideband(plan.pack));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Answer a v0 fetch (want/have lines, sideband pack). */
function fetchV0(forge: Forge, repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(forge, repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  for (const oid of plan.shallowOut) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallowOut) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(pkt('NAK\n'));
  if (!plan.empty) parts.push(...sideband(plan.pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Answer a receive-pack: store the pack, move the refs, report per ref. */
function receivePack(forge: Forge, repo: Repo, body: Buffer): Buffer {
  // Commands are pkt-lines up to the flush; the pack is the raw remainder.
  let pos = 0;
  const commandLines: string[] = [];
  let capabilities = '';
  while (pos + 4 <= body.length) {
    const hex = body.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ForgeError(400, 'malformed pkt-line in push');
    const length = parseInt(hex, 16);
    if (length === 0) {
      pos += 4;
      break;
    }
    if (length < 4 || pos + length > body.length) throw new ForgeError(400, 'malformed pkt-line in push');
    let line = body.subarray(pos + 4, pos + length).toString('utf8').replace(/\n$/, '');
    if (commandLines.length === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    commandLines.push(line);
    pos += length;
  }
  const packBytes = body.subarray(pos);

  interface Command { oldOid: string; newOid: string; ref: string }
  const commands: Command[] = [];
  for (const line of commandLines) {
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match === null) throw new ForgeError(400, 'malformed push command');
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }

  let unpackOk = true;
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => forge.object(repo, oid));
      for (const obj of objects) forge.storeObject(repo, obj.type, obj.data);
    } catch {
      unpackOk = false;
    }
  } else if (hasUpdates) {
    unpackOk = false;
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    const done = (): void => {
      results.push({ ref: command.ref, ok: true, reason: '' });
    };
    if (!unpackOk) {
      fail('unpack failed');
      continue;
    }
    if (!command.ref.startsWith('refs/heads/') && !command.ref.startsWith('refs/tags/')) {
      fail('invalid ref');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      if (current === ZERO_OID) fail('reference does not exist');
      else if (command.oldOid !== current) fail('non-fast-forward');
      else {
        repo.refs.delete(command.ref);
        packCacheClear(repo);
        planBoundaries.delete(repo);
        forge.tick();
        done();
      }
      continue;
    }
    if (command.oldOid !== current) {
      fail('non-fast-forward');
      continue;
    }
    const newCommit = forge.commitOf(repo, command.newOid);
    if (command.ref.startsWith('refs/heads/') && newCommit === null) {
      fail('invalid object');
      continue;
    }
    if (forge.object(repo, command.newOid) === null) {
      fail('invalid object');
      continue;
    }
    if (current !== ZERO_OID) {
      const currentCommit = forge.commitOf(repo, current);
      if (currentCommit !== null && newCommit !== null && !forge.isAncestor(repo, currentCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    packCacheClear(repo);
    planBoundaries.delete(repo);
    forge.tick();
    done();
  }

  const inner: Buffer[] = [pkt(`unpack ${unpackOk ? 'ok' : 'error'}\n`)];
  for (const result of results) {
    inner.push(pkt(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  inner.push(PKT_FLUSH);
  const report = Buffer.concat(inner);
  if (capabilities.split(' ').includes('side-band-64k')) {
    return Buffer.concat([...sideband(report), PKT_FLUSH]);
  }
  return report;
}

/** Route one git smart-HTTP request. */
export async function handleGit(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  owner: string,
  name: string,
  route: string,
): Promise<void> {
  const repo = forge.repoFor(owner, name);
  if (repo === null) {
    sendRaw(res, 404, 'not found', 'text/plain');
    return;
  }
  try {
    if (route === 'info/refs') {
      const service = url.searchParams.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendRaw(res, 400, 'bad service', 'text/plain');
        return;
      }
      const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
      const body = wantsV2 ? advertisementV2(repo) : advertisementV0(forge, repo, service);
      sendRaw(res, 200, body, `application/x-${service}-advertisement`);
      return;
    }

    const body = await readBody(req);
    if (route === 'git-receive-pack') {
      const report = receivePack(forge, repo, body);
      sendRaw(res, 200, report, 'application/x-git-receive-pack-result');
      return;
    }

    // git-upload-pack
    const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    if (wantsV2) {
      const packets = parsePackets(body);
      const dataLines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
      const command = (dataLines[0] ?? '').replace(/\n$/, '');
      // Arguments sit after the delim packet.
      const delimIndex = packets.findIndex((p) => p.kind === 'delim');
      const argPackets = delimIndex >= 0 ? packets.slice(delimIndex + 1) : [];
      const argLines = argPackets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
      if (command === 'command=ls-refs') {
        sendRaw(res, 200, lsRefs(forge, repo, argLines.map((l) => l.replace(/\n$/, ''))), 'application/x-git-upload-pack-result');
        return;
      }
      if (command === 'command=fetch') {
        sendRaw(res, 200, fetchV2(forge, repo, parseFetchArgs(argLines)), 'application/x-git-upload-pack-result');
        return;
      }
      sendRaw(res, 400, 'unknown command', 'text/plain');
      return;
    }

    const packets = parsePackets(body);
    const lines = packets
      .filter((p) => p.kind === 'data')
      .map((p) => p.payload.toString('utf8'))
      .map((line) => {
        // The first want line may carry capabilities after the oid.
        if (line.startsWith('want ')) {
          const rest = line.slice(5).replace(/\n$/, '');
          const oid = rest.split(' ')[0] as string;
          return `want ${oid}\n`;
        }
        return line;
      });
    sendRaw(res, 200, fetchV0(forge, repo, parseFetchArgs(lines)), 'application/x-git-upload-pack-result');
  } catch (error) {
    if (error instanceof ForgeError) {
      sendRaw(res, error.status, error.message, 'text/plain');
      return;
    }
    sendRaw(res, 400, 'bad request', 'text/plain');
  }
}
