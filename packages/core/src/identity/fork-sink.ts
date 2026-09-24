/** Workspace fork staged file plan: where streamed byte ranges land before a file exists. */

import { createHash } from 'node:crypto';
import { FORK_FRAME_BYTES, type ForkWireEntry } from './fork-transfer';

export interface ForkFileMeta {
  mode: number;
  mtimeMs: number;
}

/** Native operations a streamed fork needs; deliberately not VFS (no raw range-write authority for ordinary callers). */
export interface ForkNativeFilePort {
  truncate(path: string, size: number): Promise<void>;
  writeRange(path: string, offset: number, bytes: Uint8Array): Promise<void>;
  /** One bounded range of a staged file. The digest is read back from staging because
     *  the isolate that wrote a range may not be the one that finishes the file. */
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Replaces a symlink already there (a re-delivered frame). */
  symlink(target: string, path: string): Promise<void>;
  stamp(path: string, meta: ForkFileMeta): Promise<void>;
  /** Recursive; a missing path is not an error. */
  remove(path: string): Promise<void>;
}

/** Metadata from committing one file; the protected SOUL sink carries its mission here. */
export interface ForkFileCommit {
  mission?: string;
}

/** A destination that cannot be published by renaming a temp over it: its bytes come from one
 *  frame, with no temp; a file too large for one frame is refused. */
export interface ForkProtectedPublisher {
  owns(targetPath: string): boolean;
  publish(targetPath: string, bytes: Uint8Array): Promise<ForkFileCommit>;
}

export interface ForkFileSink {
  /** Open `path` for staging. `staged` is bytes the target already holds; a sink adopts
     *  that staging so a fork evicted mid-file continues from the next byte. */
  beginFile(path: string, staged: number): Promise<void>;
  /** One range; a whole-content-only sink refuses a multi-frame file here, before holding anything. */
  writeRange(path: string, offset: number, bytes: Uint8Array, last: boolean): Promise<void>;
  /** SHA-256 of the staged `bytes` for `path`, computed from staging rather than a running hash
     *  so it does not depend on one activation seeing every range. */
  stagedDigest(path: string, bytes: number): Promise<string>;
  commitFile(path: string, meta: ForkFileMeta): Promise<ForkFileCommit | void>;
  abortFile(path: string): Promise<void>;
  place(entries: readonly ForkWireEntry[]): Promise<void>;
  remove(paths: readonly string[]): Promise<void>;
}

/**
 * One sibling-temp file plan. The destination is untouched until `commitFile`. The temp name derives
 * from destination and transfer so every activation of one transfer adopts the same staging.
 */
export class NativeSinkPlan implements ForkFileSink {
  private target: string | null = null;
  private temp: string | null = null;
  private held: Uint8Array | null = null;

  constructor(
    private readonly files: ForkNativeFilePort,
    private readonly tempSuffix: string,
    private readonly protect?: ForkProtectedPublisher,
  ) {}

  async beginFile(path: string, staged: number): Promise<void> {
    if (this.target !== null) throw new Error(`fork file sink already stages ${JSON.stringify(this.target)}`);
    this.target = path;

    if (this.protect?.owns(path)) {
      // A protected destination is one frame in one activation; staged bytes mean transfer and sink disagree.
      if (staged > 0) {
        throw new Error(
          `fork protected destination ${JSON.stringify(path)} cannot adopt ${staged} staged bytes; `
          + 'a protected write carries a whole file in one argument and stages nothing',
        );
      }

      return;
    }

    const slash = path.lastIndexOf('/');
    const dir = slash < 0 ? '' : path.slice(0, slash + 1);
    const name = slash < 0 ? path : path.slice(slash + 1);
    this.temp = `${dir}.${name}.fork-${this.tempSuffix}.tmp`;

    if (staged === 0) await this.files.writeRange(this.temp, 0, new Uint8Array(0));
    // Trim, not truncate: a range written but never counted must not survive as a stale tail.
    await this.files.truncate(this.temp, staged);
  }

  async writeRange(path: string, offset: number, bytes: Uint8Array, last: boolean): Promise<void> {
    if (path !== this.target) throw new Error(`fork file sink has no open file ${JSON.stringify(path)}`);

    if (this.temp === null) {
      // Refuse on the first range so nothing is held for a protected file that cannot fit one frame.
      if (!last) {
        throw new Error(
          `fork protected destination ${JSON.stringify(path)} spans more than one frame; `
          + 'the protected write carries a whole file in one argument and cannot be streamed',
        );
      }

      if (this.held !== null) throw new Error(`fork protected destination ${JSON.stringify(path)} received a second range`);

      if (offset !== 0) throw new Error(`fork protected destination ${JSON.stringify(path)} started at offset ${offset}`);
      this.held = bytes;

      return;
    }

    await this.files.writeRange(this.temp, offset, bytes);
  }

  /** Digest of the staging, read back one `FORK_FRAME_BYTES` range at a time.
     *  A protected destination hashes its held frame. */
  async stagedDigest(path: string, bytes: number): Promise<string> {
    if (path !== this.target) throw new Error(`fork file sink has no open file ${JSON.stringify(path)}`);
    const hash = createHash('sha256');

    if (this.temp === null) {
      const held = this.held;

      if (held === null) throw new Error(`fork protected destination ${JSON.stringify(path)} received no bytes`);
      hash.update(held);

      return hash.digest('hex');
    }

    for (let offset = 0; offset < bytes; offset += FORK_FRAME_BYTES) {
      const length = Math.min(FORK_FRAME_BYTES, bytes - offset);
      const range = await this.files.readRange(this.temp, offset, length);

      if (range.byteLength !== length) {
        throw new Error(
          `fork transfer staged ${JSON.stringify(path)} read back ${range.byteLength} bytes of ${length} `
          + `at offset ${offset}; the staging is not what the transfer wrote`,
        );
      }

      hash.update(range);
    }

    return hash.digest('hex');
  }

  async commitFile(path: string, meta: ForkFileMeta): Promise<ForkFileCommit> {
    if (path !== this.target) throw new Error(`fork file sink has no open file ${JSON.stringify(path)}`);

    if (this.temp === null) {
      const publisher = this.protect;
      const bytes = this.held;

      if (!publisher || bytes === null) throw new Error(`fork protected destination ${JSON.stringify(path)} received no bytes`);
      this.clear();

      return publisher.publish(path, bytes);
    }

    const temp = this.temp;
    await this.files.rename(temp, path);
    await this.files.stamp(path, meta);
    this.clear();

    return {};
  }

  /** Drop what this file staged (for a protected destination, the held frame). */
  async abortFile(path: string): Promise<void> {
    if (path !== this.target) return;
    const temp = this.temp;
    this.clear();

    if (temp !== null) await this.files.unlink(temp);
  }

  async place(entries: readonly ForkWireEntry[]): Promise<void> {
    for (const entry of entries) {
      if (this.protect?.owns(entry.path)) {
        throw new Error(`fork protected destination ${JSON.stringify(entry.path)} arrived as a whole entry, not through its protected write`);
      }

      if (entry.kind === 'symlink') {
        await this.files.symlink(entry.target, entry.path);
        continue;
      }

      if (entry.kind === 'directory') await this.files.mkdir(entry.path);
      else await this.files.writeFile(entry.path, entry.bytes);
      await this.files.stamp(entry.path, entry);
    }
  }

  async remove(paths: readonly string[]): Promise<void> {
    for (const path of paths) await this.files.remove(path);
  }

  private clear(): void {
    this.target = null;
    this.temp = null;
    this.held = null;
  }
}
