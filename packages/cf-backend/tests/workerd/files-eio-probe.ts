/**
 * workerd's V8 CSP forbids codegen from strings, so a ranged read shelling `node -e` dies with EIO
 * (bun test allows `new Function`). `NimbusWorkspace.create` avoids a CJS loader this pool cannot
 * shim.
 */
import { DurableObject } from 'cloudflare:workers';
import { nimbusSessionFiles } from '@kinu.run/core';
import type { NimbusSandboxHandle } from '@kinu.run/core';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { workspaceBoxFiles } from '@kinu.run/core/workspace';

export interface RangeReadReport {
  readonly execs: readonly string[];
  readonly error: string | null;
  readonly content: string | null;
}

export class FilesEioProbeDO extends DurableObject<Cloudflare.Env> {
  private _workspace: Promise<SqliteVFS> | undefined;

  private workspace(): Promise<SqliteVFS> {
    this._workspace ??= NimbusWorkspace.create({
      sql: this.ctx.storage.sql,
      transactions: { storage: this.ctx.storage },
    }).then((workspace) => workspace.vfs);

    return this._workspace;
  }

  /** The orchestrator's file-plane handle over production's box files, except `exec` refuses and
   *  records: a read reaching it failed. */
  private box(): NimbusSandboxHandle {
    return {
      files: workspaceBoxFiles(() => this.workspace()),
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
    const plane = nimbusSessionFiles(this.box());

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
