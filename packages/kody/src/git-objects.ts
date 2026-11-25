// Pure-JS Git object store, SHA-1 hashing, tree/commit codecs, and reachability walk for workerd.

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Uint8Array;
}

export interface GitTreeEntry {
  /** Normalized Git mode: `40000` (tree), `100644`, `100755`, `120000`, or `160000`. */
  mode: string;
  name: string;
  oid: string;
}

export interface GitFileEntry {
  mode: string;
  oid: string;
}

export interface GitAuthor {
  name: string;
  email: string;
  /** Unix epoch seconds (default: current time). */
  timestamp?: number;
  /** Timezone offset string like `+0000` (default: `+0000`). */
  tz?: string;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function encodeUtf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`Invalid hex string length: ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.byteLength; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function sha1Bytes(data: Uint8Array): Promise<Uint8Array> {
  // Copy into a plain ArrayBuffer view so strict DOM BufferSource typings accept it.
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await crypto.subtle.digest('SHA-1', copy);
  return new Uint8Array(digest);
}

export async function sha1Hex(data: Uint8Array): Promise<string> {
  return bytesToHex(await sha1Bytes(data));
}

export async function hashGitObject(type: GitObjectType, data: Uint8Array): Promise<string> {
  const header = encodeUtf8(`${type} ${data.byteLength}\0`);
  return sha1Hex(concatBytes([header, data]));
}

export function isBinaryContent(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, 8000);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  try {
    strictDecoder.decode(bytes);
    return false;
  } catch {
    return true;
  }
}

export function normalizeTreeMode(mode: string): string {
  return mode === '040000' ? '40000' : mode;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < len; i++) {
    const diff = a[i]! - b[i]!;
    if (diff !== 0) return diff;
  }
  return a.byteLength - b.byteLength;
}

function gitTreeSortKey(entry: GitTreeEntry): Uint8Array {
  const isTree = normalizeTreeMode(entry.mode) === '40000';
  return encodeUtf8(isTree ? `${entry.name}/` : entry.name);
}

export function serializeTree(entries: GitTreeEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => compareBytes(gitTreeSortKey(a), gitTreeSortKey(b)));
  const chunks: Uint8Array[] = [];
  for (const entry of sorted) {
    const mode = normalizeTreeMode(entry.mode);
    chunks.push(encodeUtf8(`${mode} ${entry.name}\0`));
    chunks.push(hexToBytes(entry.oid));
  }
  return concatBytes(chunks);
}

export function parseTree(data: Uint8Array): GitTreeEntry[] {
  const entries: GitTreeEntry[] = [];
  let i = 0;
  while (i < data.byteLength) {
    let space = i;
    while (space < data.byteLength && data[space] !== 0x20) space++;
    if (space >= data.byteLength) throw new Error('Malformed git tree: missing mode separator');
    const mode = normalizeTreeMode(decodeUtf8(data.subarray(i, space)));
    let nul = space + 1;
    while (nul < data.byteLength && data[nul] !== 0x00) nul++;
    if (nul + 21 > data.byteLength) throw new Error('Malformed git tree: truncated entry');
    const name = decodeUtf8(data.subarray(space + 1, nul));
    const oid = bytesToHex(data.subarray(nul + 1, nul + 21));
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export function parseCommit(data: Uint8Array): ParsedCommit {
  const text = decodeUtf8(data);
  const splitIdx = text.indexOf('\n\n');
  const headerPart = splitIdx >= 0 ? text.slice(0, splitIdx) : text;
  const message = splitIdx >= 0 ? text.slice(splitIdx + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerPart.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (!tree) throw new Error('Malformed git commit: missing tree header');
  return { tree, parents, author, committer, message };
}

function formatIdentity(id: GitAuthor): string {
  const safeName = (id.name || 'graft').replace(/[<>\n\r]/g, '').trim() || 'graft';
  const safeEmail = (id.email || 'graft@localhost').replace(/[<>\n\r]/g, '').trim() || 'graft@localhost';
  const ts = id.timestamp ?? Math.floor(Date.now() / 1000);
  const tz = id.tz ?? '+0000';
  return `${safeName} <${safeEmail}> ${ts} ${tz}`;
}

export function serializeCommit(input: {
  tree: string;
  parents: string[];
  author: GitAuthor;
  committer?: GitAuthor;
  message: string;
}): Uint8Array {
  const lines: string[] = [`tree ${input.tree}`];
  for (const p of input.parents) lines.push(`parent ${p}`);
  lines.push(`author ${formatIdentity(input.author)}`);
  lines.push(`committer ${formatIdentity(input.committer ?? input.author)}`);
  lines.push('');
  const msg = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return encodeUtf8(`${lines.join('\n')}\n${msg}`);
}

/** In-memory Git object database used during a single cloud sync run. */
export class GitObjectStore {
  private readonly objects = new Map<string, GitObject>();

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  set(oid: string, obj: GitObject): void {
    this.objects.set(oid, obj);
  }

  oids(): IterableIterator<string> {
    return this.objects.keys();
  }

  get size(): number {
    return this.objects.size;
  }

  async write(type: GitObjectType, data: Uint8Array): Promise<string> {
    const oid = await hashGitObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data });
    }
    return oid;
  }

  async writeBlob(content: Uint8Array | string): Promise<string> {
    return this.write('blob', typeof content === 'string' ? encodeUtf8(content) : content);
  }

  async writeTree(entries: GitTreeEntry[]): Promise<string> {
    return this.write('tree', serializeTree(entries));
  }

  async writeCommit(input: {
    tree: string;
    parents: string[];
    author: GitAuthor;
    committer?: GitAuthor;
    message: string;
  }): Promise<string> {
    return this.write('commit', serializeCommit(input));
  }

  /** Resolve a commit or annotated tag OID to its commit OID, or undefined if missing. */
  peelToCommit(oid: string): string | undefined {
    let cur = oid;
    for (let depth = 0; depth < 8; depth++) {
      const obj = this.objects.get(cur);
      if (!obj) return undefined;
      if (obj.type === 'commit') return cur;
      if (obj.type === 'tag') {
        const text = decodeUtf8(obj.data);
        const match = /^object ([0-9a-f]{40})$/m.exec(text);
        if (!match) return undefined;
        cur = match[1]!;
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  /** Resolve a full or abbreviated (7-40 hex chars) commit SHA in the object store. */
  resolveCommitPrefix(ref: string): string | undefined {
    const lower = ref.toLowerCase();
    if (lower.length === 40) return this.peelToCommit(lower);
    if (!/^[0-9a-f]{7,39}$/.test(lower)) return undefined;
    let found: string | undefined;
    for (const oid of this.objects.keys()) {
      if (!oid.startsWith(lower)) continue;
      const commit = this.peelToCommit(oid);
      if (!commit) continue;
      if (found && found !== commit) {
        throw new Error(`Ambiguous commit prefix "${ref}" in object store`);
      }
      found = commit;
    }
    return found;
  }
}

/** Flatten all file entries under `commitOid` into a POSIX-path map (`"src/index.ts" -> { mode, oid }`). */
export function walkCommitTree(store: GitObjectStore, commitOid: string): Map<string, GitFileEntry> {
  const commitObj = store.get(commitOid);
  if (!commitObj || commitObj.type !== 'commit') {
    throw new Error(`Commit ${commitOid} not found in object store`);
  }
  const { tree } = parseCommit(commitObj.data);
  const files = new Map<string, GitFileEntry>();
  const visit = (treeOid: string, prefix: string) => {
    const treeObj = store.get(treeOid);
    if (!treeObj || treeObj.type !== 'tree') {
      throw new Error(`Tree ${treeOid} not found in object store`);
    }
    for (const entry of parseTree(treeObj.data)) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') {
        visit(entry.oid, fullPath);
      } else {
        files.set(fullPath, { mode: entry.mode, oid: entry.oid });
      }
    }
  };
  visit(tree, '');
  return files;
}

interface TreeNode {
  dirs: Map<string, TreeNode>;
  files: Map<string, GitFileEntry>;
}

/** Build nested Git tree objects from a flat path map and return the root tree OID. */
export async function buildTreeFromFlatMap(store: GitObjectStore, files: Map<string, GitFileEntry>): Promise<string> {
  const root: TreeNode = { dirs: new Map(), files: new Map() };
  for (const [rawPath, entry] of files) {
    const parts = rawPath.split('/').filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      let child = node.dirs.get(seg);
      if (!child) {
        child = { dirs: new Map(), files: new Map() };
        node.dirs.set(seg, child);
      }
      node = child;
    }
    node.files.set(parts.at(-1)!, entry);
  }

  const writeNode = async (node: TreeNode): Promise<string> => {
    const entries: GitTreeEntry[] = [];
    for (const [name, child] of node.dirs) {
      entries.push({ mode: '40000', name, oid: await writeNode(child) });
    }
    for (const [name, file] of node.files) {
      entries.push({ mode: file.mode, name, oid: file.oid });
    }
    return store.writeTree(entries);
  };
  return writeNode(root);
}

/**
 * Collect every object OID reachable from `startOids` that is present in `store` and not in
 * `excludeOids`. Used to build the minimal packfile for `git-receive-pack` pushes.
 */
export function collectReachableOids(store: GitObjectStore, startOids: Iterable<string>, excludeOids: ReadonlySet<string>): string[] {
  const visited = new Set<string>();
  const out: string[] = [];
  const stack: string[] = [...startOids];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (visited.has(oid) || excludeOids.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj) continue;
    visited.add(oid);
    out.push(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      for (const p of commit.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(decodeUtf8(obj.data));
      if (match) stack.push(match[1]!);
    }
  }
  return out;
}
