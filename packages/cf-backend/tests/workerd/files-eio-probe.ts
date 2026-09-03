/**
 * The Files-tab EIO, executed for real in workerd.
 *
 * The owner opened `/etc/hostname` in the Files tab of a live workspace and the
 * tab answered `EIO: EvalError: Code generation from strings disallowed for
 * this context`, with `new Function` inside the `node` command shim as the
 * top frame. Every frame of that stack is the seam this probe drives:
 * `readNimbusOriginRange` (core/src/execution/nimbus.ts) reads a byte window
 * by shelling `node -e <one-line CJS reader>` through the box's exec —
 * `rpcExec` → `execOnShell` → `Shell.execute` → `Interpreter` → the `node`
 * command → `new Function('return ' + wrapped)()`. workerd's V8 CSP forbids
 * codegen from strings, so the first read that needs a range dies exactly as
 * the owner saw it — while `bun test` executes `new Function` happily, which
 * is why nothing caught this before the pool.
 *
 * The probe composes the REAL workspace over this object's own SQLite and
 * wraps its session vfs in the same box-shaped file plane the orchestrator's
 * Files tab reads through (`nimbusSessionFiles` over `files`), with ONE
 * recording difference: `box.exec` writes down every command it is asked to
 * run and refuses it — a read that reaches it has already failed the contract
 * this probe exists to hold, so the assertion can be "no exec carried this
 * read AND the bytes are the file's own" rather than "the read succeeded".
 *
 * `NimbusWorkspace.create` directly, not `createWorkspace`: the Kinu bundle's
 * boot runs `provisionWorkspaceRuntimes`, whose toolkit eagerly imports
 * `cpython-runner` → `python-pip` → `pip-requirements-js`, a CJS
 * `require('ohm-js')` this pool cannot shim — an unrelated loader boundary
 * the read under test never reaches. `create` with no runtimes and no facets
 * is the same filesystem, the same shell, and the same `/etc/hostname` rows
 * the read path serves; the registry it registers `node` into is exactly the
 * one the shell-out reaches in production.
 */
import { DurableObject } from 'cloudflare:workers';
import { nimbusSessionFiles } from '@kinu.run/core';
import type { NimbusSandboxHandle } from '@kinu.run/core';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';

export interface RangeReadReport {
  /** What `box.exec` was asked to run while the file plane served the read. */
  readonly execs: readonly string[];
  readonly error: string | null;
  readonly content: string | null;
}

/** ENOENT is how the durable filesystem reports a missing path; the SDK file
 *  contract answers `null` for exactly that case, and nothing else. */
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
        transactions: this.ctx,
      });
      return workspace.vfs.as(CRED_SESSION_USER);
    })();
    return this._session;
  }

  /**
   * The same `NimbusSandboxHandle` the orchestrator hands the file plane, with
   * one recording difference: `exec` refuses and records. A read that reaches
   * it has already failed the contract this probe exists to hold.
   */
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
      // Line-for-line the member workspace-host.ts's workspaceBoxFiles
      // carries: the native SqliteVFS ranged read over the same credentialed
      // vfs. The typecheck holds the shape to the production plane; this
      // probe holds the behavior.
      readRange: async (path, offset, length) => absentAsNull(() => vfs.readRange(path, offset, length)),
      delete: async (path, options) => {
        if (options?.recursive) { vfs.removeRecursive(path); return; }
        if (vfs.stat(path).type === 'directory') { vfs.rmdir(path); return; }
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

  /**
   * The viewer's bounded read, in the exact shape the Files tab pays for:
   * `readBoundedWithVfsOps` prefers the plane's `readRange`, and the box
   * plane's `readRange` is `readNimbusOriginRange` — the `node -e` reader.
   */
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
