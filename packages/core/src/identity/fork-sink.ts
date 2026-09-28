/** Workspace fork staged file plan: where streamed byte ranges land before a file exists. */

import { createHash } from 'node:crypto';
import { Effect } from 'effect';
import { settle } from '../obs/effect';
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
const noOpenFile = (path: string): Error => new Error(`fork file sink has no open file ${JSON.stringify(path)}`);

const noBytes = (path: string): Error => new Error(`fork protected destination ${JSON.stringify(path)} received no bytes`);

export class NativeSinkPlan implements ForkFileSink {
  private target: string | null = null;
  private temp: string | null = null;
  private held: Uint8Array | null = null;

  constructor(
    private readonly files: ForkNativeFilePort,
    private readonly tempSuffix: string,
    private readonly protect?: ForkProtectedPublisher,
  ) {}

  beginFile(path: string, staged: number): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      if (this.target !== null) return yield* Effect.die(new Error(`fork file sink already stages ${JSON.stringify(this.target)}`));
      this.target = path;

      if (this.protect?.owns(path)) {
        // A protected destination is one frame in one activation; staged bytes mean transfer and sink disagree.
        if (staged > 0) {
          return yield* Effect.die(new Error(
            `fork protected destination ${JSON.stringify(path)} cannot adopt ${staged} staged bytes; `
            + 'a protected write carries a whole file in one argument and stages nothing',
          ));
        }

        return;
      }

      const slash = path.lastIndexOf('/');
      const dir = slash < 0 ? '' : path.slice(0, slash + 1);
      const name = slash < 0 ? path : path.slice(slash + 1);
      const temp = `${dir}.${name}.fork-${this.tempSuffix}.tmp`;
      this.temp = temp;

      if (staged === 0) yield* Effect.promise(() => this.files.writeRange(temp, 0, new Uint8Array(0)));
      // Trim, not truncate: a range written but never counted must not survive as a stale tail.
      yield* Effect.promise(() => this.files.truncate(temp, staged));
    }));
  }

  writeRange(path: string, offset: number, bytes: Uint8Array, last: boolean): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      if (path !== this.target) return yield* Effect.die(noOpenFile(path));
      const temp = this.temp;

      if (temp === null) {
        // Refuse on the first range so nothing is held for a protected file that cannot fit one frame.
        if (!last) {
          return yield* Effect.die(new Error(
            `fork protected destination ${JSON.stringify(path)} spans more than one frame; `
            + 'the protected write carries a whole file in one argument and cannot be streamed',
          ));
        }

        if (this.held !== null) return yield* Effect.die(new Error(`fork protected destination ${JSON.stringify(path)} received a second range`));

        if (offset !== 0) return yield* Effect.die(new Error(`fork protected destination ${JSON.stringify(path)} started at offset ${offset}`));
        this.held = bytes;

        return;
      }

      yield* Effect.promise(() => this.files.writeRange(temp, offset, bytes));
    }));
  }

  /** Digest of the staging, read back one `FORK_FRAME_BYTES` range at a time.
     *  A protected destination hashes its held frame. */
  stagedDigest(path: string, bytes: number): Promise<string> {
    return settle(Effect.gen({ self: this }, function* () {
      if (path !== this.target) return yield* Effect.die(noOpenFile(path));
      const hash = createHash('sha256');
      const temp = this.temp;

      if (temp === null) {
        const held = this.held;

        if (held === null) return yield* Effect.die(noBytes(path));
        hash.update(held);

        return hash.digest('hex');
      }

      for (let offset = 0; offset < bytes; offset += FORK_FRAME_BYTES) {
        const length = Math.min(FORK_FRAME_BYTES, bytes - offset);
        const at = offset;
        const range = yield* Effect.promise(() => this.files.readRange(temp, at, length));

        if (range.byteLength !== length) {
          return yield* Effect.die(new Error(
            `fork transfer staged ${JSON.stringify(path)} read back ${range.byteLength} bytes of ${length} `
            + `at offset ${offset}; the staging is not what the transfer wrote`,
          ));
        }

        hash.update(range);
      }

      return hash.digest('hex');
    }));
  }

  commitFile(path: string, meta: ForkFileMeta): Promise<ForkFileCommit> {
    return settle(Effect.gen({ self: this }, function* () {
      if (path !== this.target) return yield* Effect.die(noOpenFile(path));
      const temp = this.temp;

      if (temp === null) {
        const publisher = this.protect;
        const bytes = this.held;

        if (!publisher || bytes === null) return yield* Effect.die(noBytes(path));
        this.clear();

        return yield* Effect.promise(() => publisher.publish(path, bytes));
      }

      yield* Effect.promise(() => this.files.rename(temp, path));
      yield* Effect.promise(() => this.files.stamp(path, meta));
      this.clear();

      const committed: ForkFileCommit = {};

      return committed;
    }));
  }

  /** Drop what this file staged (for a protected destination, the held frame). */
  async abortFile(path: string): Promise<void> {
    if (path !== this.target) return;
    const temp = this.temp;
    this.clear();

    if (temp !== null) await this.files.unlink(temp);
  }

  place(entries: readonly ForkWireEntry[]): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      for (const entry of entries) {
        if (this.protect?.owns(entry.path)) {
          return yield* Effect.die(new Error(`fork protected destination ${JSON.stringify(entry.path)} arrived as a whole entry, not through its protected write`));
        }

        if (entry.kind === 'symlink') {
          yield* Effect.promise(() => this.files.symlink(entry.target, entry.path));
          continue;
        }

        if (entry.kind === 'directory') yield* Effect.promise(() => this.files.mkdir(entry.path));
        else yield* Effect.promise(() => this.files.writeFile(entry.path, entry.bytes));
        yield* Effect.promise(() => this.files.stamp(entry.path, entry));
      }
    }));
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
