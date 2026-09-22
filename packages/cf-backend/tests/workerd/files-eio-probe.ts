/**
 * workerd's V8 CSP forbids codegen from strings, so a ranged read shelling `node -e` dies with EIO
 * (bun test allows `new Function`). `NimbusWorkspace.create` avoids a CJS loader this pool cannot
 * shim.
 */
import { DurableObject } from 'cloudflare:workers';
import { nimbusSessionFiles } from '@kinu.run/core';
import type { NimbusSandboxHandle } from '@kinu.run/core';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';

export interface RangeReadReport {
  readonly execs: readonly string[];
  readonly error: string | null;
  readonly content: string | null;
}

/** The SDK file contract answers `null` for ENOENT, and nothing else. */
function absentAsNull<T>(read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    if (error instanceof Error && error.message.includes('ENOENT')) return null;
    throw error;
  }
}

export class FilesEioProbeDO extends DurableObject<Cloudflare.Env> {
  private _session: Promise<CredentialedVfs> | undefined;

  private session(): Promise<CredentialedVfs> {
    this._session ??= (async () => {
      const workspace = await NimbusWorkspace.create({
        sql: this.ctx.storage.sql,
        transactions: { storage: this.ctx.storage },
      });

      return workspace.vfs.as(CRED_SESSION_USER);
    })();

    return this._session;
  }

  /** The orchestrator's file-plane handle, except `exec` refuses and records: a read reaching it
   *  failed. */
  private async box(): Promise<NimbusSandboxHandle> {
    const vfs = await this.session();

    const files: NimbusSandboxHandle['files'] = {
      read: async (path) => absentAsNull(() => vfs.readFileString(path)),
      readBytes: async (path) => absentAsNull(() => vfs.readFile(path)),
      write: async (path, content) => { vfs.writeFile(path, content); },
      list: async (path) =>
        vfs.readdir(path ?? '/').map((entry) => ({ name: entry.name, type: entry.type })),
      stat: async (path) => absentAsNull(() => {
        const s = vfs.stat(path);

        return { type: s.type, size: s.size, mtime: s.mtime };
      }),
      lstat: async (path) => absentAsNull(() => {
        const s = vfs.lstat(path);

        return { type: s.type, size: s.size, mtime: s.mtime, mode: s.mode };
      }),
      rename: async (from, to) => { vfs.rename(from, to); },
      chmod: async (path, mode) => { vfs.chmod(path, mode); },
      exists: async (path) => vfs.exists(path),
      mkdir: async (path) => { vfs.mkdir(path, { recursive: true }); },
      // Mirrors workspace-host.ts's workspaceBoxFiles; the typecheck holds the shape, this probe
      // the behavior.
      readRange: async (path, offset, length) => absentAsNull(() => vfs.readRange(path, offset, length)),
      delete: async (path, options) => {
        if (options?.recursive) {
          vfs.removeRecursive(path);

          return;
        }

        if (vfs.stat(path).type === 'directory') {
          vfs.rmdir(path);

          return;
        }

        vfs.unlink(path);
      },
    };

    return {
      files,
      ready: async () => undefined,
      exec: async (command) => {
        this.execs.push(command);
        throw new Error('the file plane does not shell out to read its own bytes');
      },
    };
  }

  private execs: string[] = [];

  /** The box plane's `readRange` is `readNimbusOriginRange`, the `node -e` reader. */
  async readRange(path: string, offset: number, length: number): Promise<RangeReadReport> {
    this.execs = [];
    const plane = nimbusSessionFiles(await this.box());

    try {
      const bytes = await plane.readRange(path, offset, length);

      return { execs: [...this.execs], error: null, content: new TextDecoder().decode(bytes) };
    } catch (cause) {
      return {
        execs: [...this.execs],
        error: cause instanceof Error ? cause.message : String(cause),
        content: null,
      };
    }
  }
}
