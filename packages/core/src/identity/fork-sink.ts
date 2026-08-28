/**
 * Workspace fork — the staged file plan.
 *
 * The wire (`identity/fork-transfer.ts`) carries a file as bounded byte ranges;
 * this module is where those ranges LAND before the file exists. It owns the
 * narrow native filesystem port a fork needs, the protected-destination
 * exception, and the sibling-temp plan that turns "a sequence of ranges" into
 * "one file, published atomically or not at all".
 *
 * Its own module because a fork's frames arrive on several activations of one
 * Durable Object, which makes the staging a thing with a LIFETIME rather than a
 * step inside one call: a plan adopts what an interrupted predecessor staged,
 * and the whole-file digest is read back out of that staging instead of folded
 * in memory. None of that is the wire's business.
 */

import { createHash } from 'node:crypto';
import { FORK_FRAME_BYTES } from './fork-transfer';

/** The five native operations a streamed fork needs. This deliberately is not
 * VFS: an ordinary caller must not receive raw range-write authority. */
export interface ForkNativeFilePort {
  truncate(path: string, size: number): Promise<void>;
  writeRange(path: string, offset: number, bytes: Uint8Array): Promise<void>;
  /** One bounded range of a staged file. Required because the whole-file digest
   *  is computed by reading the staging back: the isolate that wrote a range
   *  may not be the one that finishes the file, so the check cannot be a hash
   *  carried in memory. Ranged, so the read-back costs one range at a time. */
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

/** Metadata produced when a sink commits one file. The protected SOUL sink
 * carries its mission here rather than letting the receiver decode a file. */
export interface ForkFileCommit {
  mission?: string;
}

/**
 * A destination that cannot be published by renaming a staged temp over it.
 *
 * A protected destination never gets a temp at all. Its bytes are handed over
 * exactly as they arrived, from the ONE frame it is allowed to occupy, so the
 * protected write costs no second copy and no read-back — and a protected file
 * too large for one frame is refused rather than quietly held whole.
 */
export interface ForkProtectedPublisher {
  owns(targetPath: string): boolean;
  publish(targetPath: string, bytes: Uint8Array): Promise<ForkFileCommit>;
}

/** Fork-specific staged file port. This deliberately is not VFS: range writes
 * and atomic temp-to-destination commit are native capabilities. */
export interface ForkFileSink {
  /**
   * Open `path` for staging.
   *
   * `staged` is how many of its bytes the target already holds, which is zero
   * for a file starting now and non-zero for one an interrupted activation left
   * part-way through. A sink ADOPTS that staging rather than restarting it, so a
   * fork evicted mid-file continues from the next byte instead of resending the
   * file or failing.
   */
  beginFile(path: string, staged: number): Promise<void>;
  /** One range, and whether it completes the file — a sink that can only
   *  publish whole content refuses a file that will span frames HERE, before
   *  it holds anything. */
  writeRange(path: string, offset: number, bytes: Uint8Array, last: boolean): Promise<void>;
  /**
   * The SHA-256 of the `bytes` this sink has staged for `path`.
   *
   * The receiver checks it against the digest the source declared before it
   * commits. Computed by the sink because only the sink knows where the staging
   * lives, and computed from the STAGING rather than from a running hash so the
   * answer does not depend on one activation having seen every range.
   */
  stagedDigest(path: string, bytes: number): Promise<string>;
  commitFile(path: string): Promise<ForkFileCommit | void>;
  abortFile(path: string): Promise<void>;
}

/**
 * One sibling-temp file plan, backed by a narrow native filesystem port.
 *
 * The destination does not change until `commitFile`; a failed range or digest
 * deletes only this private sibling.
 *
 * The temp's NAME is derived from the destination and the transfer, so it is the
 * same name in every activation of one transfer. That is what lets a plan adopt
 * a staging an interrupted predecessor left: `beginFile` with bytes already
 * staged trims the temp to exactly those bytes and writes on from there, rather
 * than truncating work the target has already durably counted.
 *
 * `protect` is the exception a protected destination needs. Such a destination
 * stages nothing on disk: its single frame is held for the length of that one
 * frame and published through the protected write, so there is no temp to
 * rename and none to clean up.
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
      // A protected destination is one frame in one activation, so there is no
      // staging of it to inherit. Bytes counted against one means the transfer
      // and this sink disagree about which destination is protected.
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
    // Trim rather than truncate to zero: `staged` is what the target durably
    // counted, and a range the interrupted activation wrote but never got to
    // count must not survive as a tail nobody will overwrite.
    await this.files.truncate(this.temp, staged);
  }

  async writeRange(path: string, offset: number, bytes: Uint8Array, last: boolean): Promise<void> {
    if (path !== this.target) throw new Error(`fork file sink has no open file ${JSON.stringify(path)}`);
    if (this.temp === null) {
      // A protected destination is published from one frame. A file that will
      // not fit one is refused on its FIRST range, so nothing is ever held for
      // a transfer that cannot finish.
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

  /**
   * The digest of the staging, read back one bounded range at a time.
   *
   * `FORK_FRAME_BYTES` is the read bound, so verifying a file costs the same
   * peak as receiving one frame of it however large the file is. A protected
   * destination has nothing on disk to read: its one frame is still held, and
   * that is what is hashed.
   */
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

  async commitFile(path: string): Promise<ForkFileCommit> {
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
    this.clear();
    return {};
  }

  /** Drop what this file staged. A protected destination staged nothing on
   *  disk, so there is only the held frame to release. */
  async abortFile(path: string): Promise<void> {
    if (path !== this.target) return;
    const temp = this.temp;
    this.clear();
    if (temp !== null) await this.files.unlink(temp);
  }

  private clear(): void {
    this.target = null;
    this.temp = null;
    this.held = null;
  }
}
