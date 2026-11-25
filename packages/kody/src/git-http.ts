// Pure-JS Git Smart HTTP v1 client + Packfile v2 unpacker/builder for Cloudflare Workers (workerd).
import { deflate, Inflate } from 'pako';
import {
  bytesToHex,
  collectReachableOids,
  concatBytes,
  decodeUtf8,
  encodeUtf8,
  GitObjectStore,
  sha1Bytes,
  ZERO_OID,
  type GitObjectType,
} from './git-objects.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RemoteRefDiscovery {
  refs: Map<string, string>;
  symrefs: Map<string, string>;
  capabilities: Set<string>;
  defaultBranch: string;
}

const FLUSH_PKT = encodeUtf8('0000');

const TYPE_NUM_TO_NAME: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

const TYPE_NAME_TO_NUM: Record<GitObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

export function encodePktLine(payload: string | Uint8Array): Uint8Array {
  const bytes = typeof payload === 'string' ? encodeUtf8(payload) : payload;
  const len = bytes.byteLength + 4;
  if (len > 0xffff) throw new Error(`Git pkt-line too large (${len} bytes)`);
  return concatBytes([encodeUtf8(len.toString(16).padStart(4, '0')), bytes]);
}

function isHex4(bytes: Uint8Array, offset: number): boolean {
  if (offset + 4 > bytes.byteLength) return false;
  for (let i = 0; i < 4; i++) {
    const c = bytes[offset + i]!;
    const ok = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
    if (!ok) return false;
  }
  return true;
}

/**
 * Decode leading pkt-lines from `buf`. Stops cleanly if raw packfile bytes (`PACK...`) begin after
 * a pkt-line (non-sideband upload-pack responses).
 */
export function decodePktLines(buf: Uint8Array): { packets: Array<Uint8Array | null>; rest: Uint8Array } {
  const packets: Array<Uint8Array | null> = [];
  let offset = 0;
  while (offset + 4 <= buf.byteLength) {
    // Raw packfile header (`PACK`) is not a pkt-line.
    if (buf[offset] === 0x50 && buf[offset + 1] === 0x41 && buf[offset + 2] === 0x43 && buf[offset + 3] === 0x4b) {
      break;
    }
    if (!isHex4(buf, offset)) break;
    const lenHex = decodeUtf8(buf.subarray(offset, offset + 4));
    const len = Number.parseInt(lenHex, 16);
    if (len === 0) {
      packets.push(null);
      offset += 4;
      continue;
    }
    if (len === 1 || len === 2) {
      // Protocol v2 delimiter / response-end.
      packets.push(null);
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.byteLength) {
      throw new Error(`Malformed git pkt-line header "${lenHex}" at offset ${offset}`);
    }
    packets.push(buf.subarray(offset + 4, offset + len));
    offset += len;
  }
  return { packets, rest: buf.subarray(offset) };
}

/** Parse a single `"Header-Name: value"` string (e.g. `git_extra_header`) into a headers record. */
export function parseExtraHeader(headerLine?: string): Record<string, string> {
  if (!headerLine) return {};
  const idx = headerLine.indexOf(':');
  if (idx <= 0) return {};
  const name = headerLine.slice(0, idx).trim();
  const value = headerLine.slice(idx + 1).trim();
  return name && value ? { [name]: value } : {};
}

function normalizeRepoUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Parse a Smart HTTP v1 `/info/refs?service=...` response body. */
export function parseInfoRefs(body: Uint8Array, expectedService: string): RemoteRefDiscovery {
  const { packets } = decodePktLines(body);
  const refs = new Map<string, string>();
  const symrefs = new Map<string, string>();
  const capabilities = new Set<string>();
  let pastServiceHeader = false;

  for (const pkt of packets) {
    if (pkt === null) {
      if (!pastServiceHeader) pastServiceHeader = true;
      continue;
    }
    const line = decodeUtf8(pkt);
    if (!pastServiceHeader) {
      if (line.startsWith('# service=')) {
        const svc = line.slice('# service='.length).trim();
        if (svc !== expectedService) {
          throw new Error(`Unexpected git service "${svc}" (expected "${expectedService}")`);
        }
        continue;
      }
      if (line.startsWith('ERR ')) throw new Error(`Git remote error: ${line.slice(4).trim()}`);
      // Some servers omit the `# service=` preamble; fall through to ref parsing.
      pastServiceHeader = true;
    }
    if (line.startsWith('ERR ')) throw new Error(`Git remote error: ${line.slice(4).trim()}`);

    const nulIdx = line.indexOf('\0');
    const refPart = (nulIdx >= 0 ? line.slice(0, nulIdx) : line).replace(/\r?\n$/, '');
    const capPart = nulIdx >= 0 ? line.slice(nulIdx + 1).replace(/\r?\n$/, '') : '';
    if (capPart) {
      for (const cap of capPart.trim().split(/\s+/)) {
        if (!cap) continue;
        capabilities.add(cap);
        if (cap.startsWith('symref=')) {
          const [from, to] = cap.slice('symref='.length).split(':');
          if (from && to) symrefs.set(from, to);
        }
      }
    }
    const spaceIdx = refPart.indexOf(' ');
    if (spaceIdx === 40) {
      const oid = refPart.slice(0, 40).toLowerCase();
      const name = refPart.slice(41).trim();
      if (name && name !== 'capabilities^{}') {
        refs.set(name, oid);
      }
    }
  }

  let defaultBranch = 'main';
  const headSym = symrefs.get('HEAD');
  if (headSym?.startsWith('refs/heads/')) {
    defaultBranch = headSym.slice('refs/heads/'.length);
  } else {
    const headOid = refs.get('HEAD');
    if (headOid) {
      for (const [ref, oid] of refs) {
        if (ref.startsWith('refs/heads/') && oid === headOid) {
          defaultBranch = ref.slice('refs/heads/'.length);
          break;
        }
      }
    }
  }

  return { refs, symrefs, capabilities, defaultBranch };
}

/** Extract the raw `PACK...` payload from a `git-upload-pack` HTTP response (sideband or raw). */
export function extractPackFromUploadResponse(body: Uint8Array): Uint8Array {
  const { packets, rest } = decodePktLines(body);
  const sidebandChunks: Uint8Array[] = [];
  for (const pkt of packets) {
    if (pkt === null || pkt.byteLength === 0) continue;
    const channel = pkt[0]!;
    if (channel === 1) {
      sidebandChunks.push(pkt.subarray(1));
    } else if (channel === 2) {
      // Sideband progress message; ignored.
    } else if (channel === 3) {
      throw new Error(`git-upload-pack remote error: ${decodeUtf8(pkt.subarray(1)).trim()}`);
    } else {
      const text = decodeUtf8(pkt);
      if (text.startsWith('ERR ')) {
        throw new Error(`git-upload-pack error: ${text.slice(4).trim()}`);
      }
    }
  }
  if (sidebandChunks.length > 0) return concatBytes(sidebandChunks);
  if (rest.byteLength >= 12) return rest;
  throw new Error('git-upload-pack response contained no packfile data');
}

function readLittleVarint(buf: Uint8Array, start: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = start;
  while (pos < buf.byteLength) {
    const b = buf[pos++]!;
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return { value, next: pos };
    shift += 7;
  }
  throw new Error('Truncated varint in git delta stream');
}

/** Apply a Git binary delta stream onto `base` bytes. */
export function applyGitDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  const srcHdr = readLittleVarint(delta, 0);
  if (srcHdr.value !== base.byteLength) {
    throw new Error(`Git delta base length mismatch: expected ${srcHdr.value}, got ${base.byteLength}`);
  }
  const dstHdr = readLittleVarint(delta, srcHdr.next);
  const out = new Uint8Array(dstHdr.value);
  let pos = dstHdr.next;
  let outPos = 0;

  while (pos < delta.byteLength) {
    const cmd = delta[pos++]!;
    if (cmd & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (cmd & 0x01) cpOff |= delta[pos++]!;
      if (cmd & 0x02) cpOff |= delta[pos++]! << 8;
      if (cmd & 0x04) cpOff |= delta[pos++]! << 16;
      if (cmd & 0x08) cpOff |= delta[pos++]! << 24;
      if (cmd & 0x10) cpSize |= delta[pos++]!;
      if (cmd & 0x20) cpSize |= delta[pos++]! << 8;
      if (cmd & 0x40) cpSize |= delta[pos++]! << 16;
      if (cpSize === 0) cpSize = 0x10000;
      if (cpOff < 0 || cpOff + cpSize > base.byteLength || outPos + cpSize > out.byteLength) {
        throw new Error('Git delta copy out of bounds');
      }
      out.set(base.subarray(cpOff, cpOff + cpSize), outPos);
      outPos += cpSize;
    } else if (cmd > 0) {
      if (pos + cmd > delta.byteLength || outPos + cmd > out.byteLength) {
        throw new Error('Git delta insert out of bounds');
      }
      out.set(delta.subarray(pos, pos + cmd), outPos);
      pos += cmd;
      outPos += cmd;
    } else {
      throw new Error('Invalid git delta opcode 0x00');
    }
  }
  if (outPos !== dstHdr.value) {
    throw new Error(`Git delta output size mismatch: expected ${dstHdr.value}, got ${outPos}`);
  }
  return out;
}

function inflatePackEntry(pack: Uint8Array, offset: number, expectedSize: number): { data: Uint8Array; bytesRead: number } {
  const inflator = new Inflate();
  // Feed a slice starting at `offset`; pako stops at Z_STREAM_END and sets `strm.total_in`.
  inflator.push(pack.subarray(offset), false);
  if (inflator.err) {
    throw new Error(`Packfile zlib inflate failed at offset ${offset}: ${inflator.msg || String(inflator.err)}`);
  }
  const strm = (inflator as unknown as { strm?: { total_in?: number } }).strm;
  const bytesRead = strm?.total_in ?? 0;
  if (!inflator.ended || bytesRead <= 0) {
    throw new Error(`Packfile zlib stream at offset ${offset} did not complete cleanly`);
  }
  const result = inflator.result;
  if (!(result instanceof Uint8Array)) {
    throw new Error(`Packfile zlib inflate returned unexpected result type at offset ${offset}`);
  }
  if (result.byteLength !== expectedSize) {
    throw new Error(`Packfile entry size mismatch at offset ${offset}: expected ${expectedSize}, got ${result.byteLength}`);
  }
  return { data: result, bytesRead };
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return (buf[offset]! * 0x1000000 + ((buf[offset + 1]! << 16) | (buf[offset + 2]! << 8) | buf[offset + 3]!)) >>> 0;
}

function writeUint32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

/**
 * Unpack a Git Packfile v2 into `store`, resolving both `OFS_DELTA` and `REF_DELTA` entries.
 * Returns the set of all object OIDs decoded from this packfile.
 */
export async function unpackPackfile(pack: Uint8Array, store: GitObjectStore): Promise<Set<string>> {
  if (pack.byteLength < 32) throw new Error(`Packfile too short (${pack.byteLength} bytes)`);
  if (decodeUtf8(pack.subarray(0, 4)) !== 'PACK') throw new Error('Invalid packfile magic header');
  const version = readUint32BE(pack, 4);
  if (version !== 2) throw new Error(`Unsupported git packfile version ${version} (expected 2)`);

  const expectedChecksum = bytesToHex(pack.subarray(pack.byteLength - 20));
  const actualChecksum = bytesToHex(await sha1Bytes(pack.subarray(0, pack.byteLength - 20)));
  if (expectedChecksum !== actualChecksum) {
    throw new Error(`Packfile SHA-1 checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`);
  }

  const count = readUint32BE(pack, 8);
  const decodedOids = new Set<string>();
  const byOffset = new Map<number, { type: GitObjectType; data: Uint8Array; oid: string }>();
  const pendingRefDeltas: Array<{ entryOffset: number; baseOid: string; delta: Uint8Array }> = [];
  const pendingOfsDeltas: Array<{ entryOffset: number; baseOffset: number; delta: Uint8Array }> = [];

  let offset = 12;
  const bodyEnd = pack.byteLength - 20;

  for (let i = 0; i < count; i++) {
    if (offset >= bodyEnd) throw new Error(`Unexpected end of packfile at entry ${i}/${count}`);
    const entryOffset = offset;
    let b = pack[offset++]!;
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = pack[offset++]!;
      size += (b & 0x7f) * 2 ** shift;
      shift += 7;
    }

    if (typeCode >= 1 && typeCode <= 4) {
      const type = TYPE_NUM_TO_NAME[typeCode]!;
      const { data, bytesRead } = inflatePackEntry(pack, offset, size);
      offset += bytesRead;
      const oid = await store.write(type, data);
      decodedOids.add(oid);
      byOffset.set(entryOffset, { type, data, oid });
    } else if (typeCode === 6) {
      // OFS_DELTA
      let ob = pack[offset++]!;
      let negOffset = ob & 0x7f;
      while (ob & 0x80) {
        ob = pack[offset++]!;
        negOffset = (negOffset + 1) * 128 + (ob & 0x7f);
      }
      const { data: delta, bytesRead } = inflatePackEntry(pack, offset, size);
      offset += bytesRead;
      const baseOffset = entryOffset - negOffset;
      const base = byOffset.get(baseOffset);
      if (base) {
        const resolved = applyGitDelta(base.data, delta);
        const oid = await store.write(base.type, resolved);
        decodedOids.add(oid);
        byOffset.set(entryOffset, { type: base.type, data: resolved, oid });
      } else {
        pendingOfsDeltas.push({ entryOffset, baseOffset, delta });
      }
    } else if (typeCode === 7) {
      // REF_DELTA
      if (offset + 20 > bodyEnd) throw new Error(`Truncated REF_DELTA base OID at offset ${offset}`);
      const baseOid = bytesToHex(pack.subarray(offset, offset + 20));
      offset += 20;
      const { data: delta, bytesRead } = inflatePackEntry(pack, offset, size);
      offset += bytesRead;
      const base = store.get(baseOid);
      if (base) {
        const resolved = applyGitDelta(base.data, delta);
        const oid = await store.write(base.type, resolved);
        decodedOids.add(oid);
        byOffset.set(entryOffset, { type: base.type, data: resolved, oid });
      } else {
        pendingRefDeltas.push({ entryOffset, baseOid, delta });
      }
    } else {
      throw new Error(`Unknown git packfile object type ${typeCode} at offset ${entryOffset}`);
    }
  }

  // Resolve any out-of-order chained deltas iteratively.
  while (pendingRefDeltas.length > 0 || pendingOfsDeltas.length > 0) {
    let progressed = false;
    for (let i = pendingRefDeltas.length - 1; i >= 0; i--) {
      const item = pendingRefDeltas[i]!;
      const base = store.get(item.baseOid);
      if (!base) continue;
      const resolved = applyGitDelta(base.data, item.delta);
      const oid = await store.write(base.type, resolved);
      decodedOids.add(oid);
      byOffset.set(item.entryOffset, { type: base.type, data: resolved, oid });
      pendingRefDeltas.splice(i, 1);
      progressed = true;
    }
    for (let i = pendingOfsDeltas.length - 1; i >= 0; i--) {
      const item = pendingOfsDeltas[i]!;
      const base = byOffset.get(item.baseOffset);
      if (!base) continue;
      const resolved = applyGitDelta(base.data, item.delta);
      const oid = await store.write(base.type, resolved);
      decodedOids.add(oid);
      byOffset.set(item.entryOffset, { type: base.type, data: resolved, oid });
      pendingOfsDeltas.splice(i, 1);
      progressed = true;
    }
    if (!progressed) {
      throw new Error(`Could not resolve ${pendingRefDeltas.length + pendingOfsDeltas.length} packfile delta(s); missing base object(s)`);
    }
  }

  return decodedOids;
}

/** Build a valid Packfile v2 containing the specified objects from `store`. */
export async function buildPackfile(store: GitObjectStore, oids: string[]): Promise<Uint8Array> {
  const unique = [...new Set(oids)];
  const header = new Uint8Array(12);
  header.set(encodeUtf8('PACK'), 0);
  writeUint32BE(header, 4, 2);
  writeUint32BE(header, 8, unique.length);

  const chunks: Uint8Array[] = [header];
  for (const oid of unique) {
    const obj = store.get(oid);
    if (!obj) throw new Error(`Cannot pack missing git object ${oid}`);
    const typeNum = TYPE_NAME_TO_NUM[obj.type];
    let sz = obj.data.byteLength;
    const hdrBytes: number[] = [];
    let first = (typeNum << 4) | (sz & 0x0f);
    sz = Math.floor(sz / 16);
    while (sz > 0) {
      hdrBytes.push(first | 0x80);
      first = sz & 0x7f;
      sz = Math.floor(sz / 128);
    }
    hdrBytes.push(first);
    chunks.push(new Uint8Array(hdrBytes));
    chunks.push(deflate(obj.data));
  }

  const body = concatBytes(chunks);
  const checksum = await sha1Bytes(body);
  return concatBytes([body, checksum]);
}

function parseReceivePackStatus(body: Uint8Array, expectedRef: string): void {
  const { packets } = decodePktLines(body);
  let unpackStatus: string | undefined;
  let refStatus: string | undefined;

  const inspectLine = (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('unpack ')) {
      unpackStatus = line.slice('unpack '.length).trim();
    } else if (line.startsWith('ok ')) {
      if (line.slice(3).trim() === expectedRef) refStatus = 'ok';
    } else if (line.startsWith('ng ')) {
      refStatus = line;
    } else if (line.startsWith('ERR ')) {
      throw new Error(`git-receive-pack error: ${line.slice(4).trim()}`);
    }
  };

  for (const pkt of packets) {
    if (pkt === null || pkt.byteLength === 0) continue;
    const ch = pkt[0]!;
    if (ch === 1) {
      // Sideband channel 1 may itself contain nested pkt-lines.
      const inner = decodePktLines(pkt.subarray(1));
      if (inner.packets.length > 0) {
        for (const ip of inner.packets) {
          if (ip) inspectLine(decodeUtf8(ip));
        }
      } else {
        inspectLine(decodeUtf8(pkt.subarray(1)));
      }
    } else if (ch === 2) {
      // Progress message.
    } else if (ch === 3) {
      throw new Error(`git-receive-pack remote error: ${decodeUtf8(pkt.subarray(1)).trim()}`);
    } else {
      inspectLine(decodeUtf8(pkt));
    }
  }

  if (unpackStatus && unpackStatus !== 'ok') {
    throw new Error(`git-receive-pack unpack failed: ${unpackStatus}`);
  }
  if (refStatus && refStatus !== 'ok') {
    throw new Error(`git-receive-pack rejected push to ${expectedRef}: ${refStatus}`);
  }
}

export interface GitHttpClient {
  lsRefs(url: string, service: 'git-upload-pack' | 'git-receive-pack', headers?: Record<string, string>): Promise<RemoteRefDiscovery>;
  fetchIntoStore(
    url: string,
    store: GitObjectStore,
    options?: { headers?: Record<string, string>; extraWants?: string[]; allHeads?: boolean },
  ): Promise<{ discovery: RemoteRefDiscovery; fetchedOids: Set<string> }>;
  pushRef(
    url: string,
    store: GitObjectStore,
    options: {
      ref: string;
      oldOid?: string;
      newOid: string;
      remoteHaveOids: ReadonlySet<string>;
      headers?: Record<string, string>;
    },
  ): Promise<void>;
}

/** Create a pure-JS Git Smart HTTP v1 client backed by Web `fetch`. */
export function createGitHttpClient(fetchImpl: FetchLike = (url, init) => fetch(url, init)): GitHttpClient {
  const lsRefs = async (
    url: string,
    service: 'git-upload-pack' | 'git-receive-pack',
    headers: Record<string, string> = {},
  ): Promise<RemoteRefDiscovery> => {
    const base = normalizeRepoUrl(url);
    const res = await fetchImpl(`${base}/info/refs?service=${service}`, {
      method: 'GET',
      headers: {
        Accept: `application/x-${service}-advertisement`,
        'User-Agent': 'git/graft-kody-cloud',
        ...headers,
      },
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).trim().slice(0, 300);
      throw new Error(`GET ${base}/info/refs?service=${service} failed (HTTP ${res.status})${text ? `: ${text}` : ''}`);
    }
    const body = new Uint8Array(await res.arrayBuffer());
    return parseInfoRefs(body, service);
  };

  const fetchIntoStore = async (
    url: string,
    store: GitObjectStore,
    options: { headers?: Record<string, string>; extraWants?: string[]; allHeads?: boolean } = {},
  ): Promise<{ discovery: RemoteRefDiscovery; fetchedOids: Set<string> }> => {
    const base = normalizeRepoUrl(url);
    const headers = options.headers ?? {};
    const discovery = await lsRefs(base, 'git-upload-pack', headers);

    const runUploadPack = async (wantOids: string[]): Promise<Set<string>> => {
      if (wantOids.length === 0) return new Set();
      const reqCaps: string[] = [];
      if (discovery.capabilities.has('side-band-64k')) reqCaps.push('side-band-64k');
      else if (discovery.capabilities.has('side-band')) reqCaps.push('side-band');
      if (discovery.capabilities.has('ofs-delta')) reqCaps.push('ofs-delta');
      if (discovery.capabilities.has('no-progress')) reqCaps.push('no-progress');

      const reqChunks: Uint8Array[] = [];
      for (let i = 0; i < wantOids.length; i++) {
        const oid = wantOids[i]!;
        const line = i === 0 && reqCaps.length > 0 ? `want ${oid} ${reqCaps.join(' ')}\n` : `want ${oid}\n`;
        reqChunks.push(encodePktLine(line));
      }
      reqChunks.push(FLUSH_PKT);
      reqChunks.push(encodePktLine('done\n'));

      const res = await fetchImpl(`${base}/git-upload-pack`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-git-upload-pack-request',
          Accept: 'application/x-git-upload-pack-result',
          'User-Agent': 'git/graft-kody-cloud',
          ...headers,
        },
        body: concatBytes(reqChunks) as unknown as BodyInit,
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).trim().slice(0, 300);
        throw new Error(`POST ${base}/git-upload-pack failed (HTTP ${res.status})${text ? `: ${text}` : ''}`);
      }
      const respBytes = new Uint8Array(await res.arrayBuffer());
      const packBytes = extractPackFromUploadResponse(respBytes);
      return unpackPackfile(packBytes, store);
    };

    const wants = new Set<string>();
    const headOid = discovery.refs.get('HEAD') ?? discovery.refs.get(`refs/heads/${discovery.defaultBranch}`);
    if (headOid && headOid !== ZERO_OID) wants.add(headOid);
    if (options.allHeads) {
      for (const [ref, oid] of discovery.refs) {
        if ((ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')) && !ref.endsWith('^{}') && oid !== ZERO_OID) {
          wants.add(oid);
        }
      }
    }
    const advertisedOids = new Set(discovery.refs.values());
    for (const extra of options.extraWants ?? []) {
      const lower = extra.toLowerCase();
      if (/^[0-9a-f]{40}$/.test(lower) && lower !== ZERO_OID && advertisedOids.has(lower)) {
        wants.add(lower);
      }
    }

    const fetchedOids = await runUploadPack([...wants]);

    // Only request unadvertised extraWants if they weren't already included in HEAD's ancestry
    // (Kody's public `.git` proxy only allows wanting the advertised snapshot commit).
    if (discovery.capabilities.has('allow-reachable-sha1-in-want')) {
      const missingExtras = (options.extraWants ?? [])
        .map((s) => s.toLowerCase())
        .filter((s) => /^[0-9a-f]{40}$/.test(s) && s !== ZERO_OID && !store.has(s));
      if (missingExtras.length > 0) {
        try {
          const extraFetched = await runUploadPack([...new Set(missingExtras)]);
          for (const oid of extraFetched) fetchedOids.add(oid);
        } catch {
          // Ignore fallback failure here; downstream commit resolution will fail loudly with fork/no-commit.
        }
      }
    }
    return { discovery, fetchedOids };
  };

  const pushRef = async (
    url: string,
    store: GitObjectStore,
    options: {
      ref: string;
      oldOid?: string;
      newOid: string;
      remoteHaveOids: ReadonlySet<string>;
      headers?: Record<string, string>;
    },
  ): Promise<void> => {
    const base = normalizeRepoUrl(url);
    const headers = options.headers ?? {};
    const discovery = await lsRefs(base, 'git-receive-pack', headers);
    const oldOid = options.oldOid ?? discovery.refs.get(options.ref) ?? ZERO_OID;

    // Include all objects reachable from newOid not already on the remote.
    const oidsToSend = collectReachableOids(store, [options.newOid], options.remoteHaveOids);
    const pack = await buildPackfile(store, oidsToSend);

    const caps: string[] = [];
    if (discovery.capabilities.has('report-status')) caps.push('report-status');
    if (discovery.capabilities.has('side-band-64k')) caps.push('side-band-64k');

    const cmdLine = `${oldOid} ${options.newOid} ${options.ref}${caps.length ? `\0${caps.join(' ')}` : ''}\n`;
    const body = concatBytes([encodePktLine(cmdLine), FLUSH_PKT, pack]);

    const res = await fetchImpl(`${base}/git-receive-pack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-git-receive-pack-request',
        Accept: 'application/x-git-receive-pack-result',
        'User-Agent': 'git/graft-kody-cloud',
        ...headers,
      },
      body: body as unknown as BodyInit,
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).trim().slice(0, 300);
      throw new Error(`POST ${base}/git-receive-pack failed (HTTP ${res.status})${text ? `: ${text}` : ''}`);
    }
    const respBytes = new Uint8Array(await res.arrayBuffer());
    if (respBytes.byteLength > 0) {
      parseReceivePackStatus(respBytes, options.ref);
    }
  };

  return { lsRefs, fetchIntoStore, pushRef };
}
