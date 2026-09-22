import { AgentCoreError, ContentRef, Digest } from '@agent-core/core';
import { ByteRange, ContentStat, ContentStore, type ContentPutResult } from '@agent-core/core/content';

/** Under the kernel-owned /etc, never under an authored or user-owned parent. */
const SLATE_CONTENT_ROOT = '/etc/kinu-slate-content';

export interface SlateContentFiles {
  exists(path: string): boolean;
  lstat(path: string): { type: string; size: number; mode: number; uid: number; gid: number };
  mkdir(path: string, options: { mode: number }): void;
  writeFile(path: string, bytes: Uint8Array, options: { mode: number }): void;
  readRangeUncached(path: string, offset: number, length: number): Uint8Array;
}

/** Immutable content in the workspace filesystem; SQL records retain only refs. `retain` joins the caller's
 * synchronous VFS transaction without nesting. Existing digest paths are never overwritten; a mismatched inode is corruption. */
export class WorkspaceSlateContentStore extends ContentStore {
  constructor(private readonly files: SlateContentFiles) {
    super();
    this.requireProtected('/etc', 'directory', 0o755);

    if (!files.exists(SLATE_CONTENT_ROOT)) files.mkdir(SLATE_CONTENT_ROOT, { mode: 0o700 });
    this.requireProtected(SLATE_CONTENT_ROOT, 'directory', 0o700);
  }

  async put(bytes: Uint8Array): Promise<ContentPutResult> {
    return this.retain(bytes);
  }

  retain(bytes: Uint8Array): ContentPutResult {
    const digest = Digest.sha256(bytes);
    const ref = ContentRef.fromDigest(digest);
    const path = this.path(ref);

    if (this.files.exists(path)) {
      const stat = this.requireProtected(path, 'file', 0o400);

      if (stat.size !== bytes.length) throw new AgentCoreError('codec.invalid', 'Slate content size differs from its digest object');
    } else {
      this.files.writeFile(path, bytes, { mode: 0o400 });
    }

    return { digest, ref };
  }

  async get(ref: ContentRef, range = ByteRange.all()): Promise<Uint8Array> {
    return this.read(ref, range);
  }

  read(ref: ContentRef, range = ByteRange.all()): Uint8Array {
    const stat = this.describe(ref);

    if (stat === undefined) throw new AgentCoreError('content.not-found', `Slate content not found: ${ref.value}`);
    const window = range.resolve(stat.size);

    return this.files.readRangeUncached(this.path(ref), window.offset, window.length);
  }

  async stat(ref: ContentRef): Promise<ContentStat | undefined> {
    return this.describe(ref);
  }

  private describe(ref: ContentRef): ContentStat | undefined {
    const path = this.path(ref);

    if (!this.files.exists(path)) return undefined;
    const stat = this.requireProtected(path, 'file', 0o400);

    return new ContentStat(ref, ref.digest, stat.size);
  }

  private path(ref: ContentRef): string {
    const digest = ref.digest.value;

    if (!/^[a-f0-9]{64}$/.test(digest)) throw new AgentCoreError('codec.invalid', 'Slate content requires a SHA-256 digest');

    return `${SLATE_CONTENT_ROOT}/${digest}`;
  }

  private requireProtected(path: string, type: string, mode: number) {
    const stat = this.files.lstat(path);

    if (stat.type !== type || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== mode) {
      throw new AgentCoreError('codec.invalid', `Slate content path is not kernel-owned and protected: ${path}`);
    }

    return stat;
  }
}
