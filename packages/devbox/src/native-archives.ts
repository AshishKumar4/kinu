import { Effect } from 'effect';
import type { Files } from '@cloudflare/sandbox';
import type { BackupOptions, DirectoryBackup, ExecResult } from './contracts';
import { DevboxError, attempt, layerUnreadable, settle } from './errors';
import { baseObjectKey } from './snapshot-chain';
import { archiveCommand } from './stream-archive';
import { shellPath } from './chunked-delta';
import { DEVBOX_RUNTIME_DIR, type DevboxStore } from './storage';

/** What local extraction reaches: the container, its files, the box's store and its shell. */
export interface ArchiveHost {
  readonly container: Container;
  readonly files: Files;
  readonly store: DevboxStore;
  readonly root: string;
  readonly exec: (command: string, cwd: string) => Promise<ExecResult>;
}

/** Local extraction uses the same squashfs format as its existing records, not tar+zstd. */
export class NativeArchives {
  constructor(readonly host: ArchiveHost) {}

  create(options: BackupOptions): Promise<DirectoryBackup> {
    return settle(Effect.gen({ self: this }, function* () {
      const id = crypto.randomUUID();
      const archive = `${DEVBOX_RUNTIME_DIR}/extract/${id}.sqsh`;
      const command = archiveCommand({ sourceDir: options.dir, archivePath: archive, excludeFile: archive + '.exclude', excludes: options.excludes ?? [] });
      const made = yield* attempt('io', () => this.host.exec(command, DEVBOX_RUNTIME_DIR));
      const [exit, size] = made.stdout.trim().split(' ').map(Number);

      if (made.exitCode !== 0 || exit !== 0 || size === undefined || size <= 0) {
        return yield* Effect.fail(new DevboxError('io', `local checkpoint failed: ${made.stderr}`));
      }

      const process = yield* attempt('process', () => this.host.container.exec(['cat', archive]));
      const output = process.stdout;

      if (output === null) return yield* Effect.fail(new DevboxError('process', 'local archive has no output stream'));
      const pipe = new FixedLengthStream(size);
      yield* attempt('io', () => Promise.all([
        output.pipeTo(pipe.writable),
        this.host.store.bucket.put(baseObjectKey(this.host.root, id), pipe.readable),
      ]));
      const code = yield* attempt('process', () => process.exitCode);

      if (code !== 0) return yield* Effect.fail(new DevboxError('process', 'local archive read failed'));
      yield* attempt('file', () => this.host.files.remove(archive));

      return { id, dir: options.dir };
    }));
  }

  restore(backup: DirectoryBackup): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      const object = yield* attempt('io', () => this.host.store.bucket.get(baseObjectKey(this.host.root, backup.id)));

      if (object === null) return yield* Effect.fail(layerUnreadable('extraction', backup.id, {
        cause: new DevboxError('missing', `local backup ${backup.id} is missing`),
      }));
      const path = `${DEVBOX_RUNTIME_DIR}/extract/${backup.id}.sqsh`;
      yield* attempt('file', () => this.host.files.mkdir(`${DEVBOX_RUNTIME_DIR}/extract`, { recursive: true }));
      yield* attempt('file', () => this.host.files.writeFile(path, object.body));
      const result = yield* attempt('process', () => this.host.exec(`unsquashfs -f -d ${shellPath(backup.dir)} ${shellPath(path)}`, DEVBOX_RUNTIME_DIR));
      yield* attempt('file', () => this.host.files.remove(path));

      if (result.exitCode !== 0) return yield* Effect.fail(layerUnreadable('extraction', backup.id, {
        cause: new DevboxError('io', `local archive extraction failed: ${result.stderr}`),
      }));
    }));
  }
}
