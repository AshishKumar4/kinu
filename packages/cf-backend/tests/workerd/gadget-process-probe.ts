/**
 * The gadget server boundary, executed for real in workerd.
 *
 * `bun test` cannot host this: the process a gadget server runs in is a
 * resident process with no outbound, its `Gadget` a Cap'n Web `RpcTarget`
 * built with the process `env`, and each binding in that `env` a loopback
 * entrypoint that calls back into this object over a stub. The loader, the
 * inherited outbound and the HTTP-batch hop between the process
 * and the host are all platform. What the unit tier checks is the pure half
 * (path resolution, source names, the MCP review); this file checks that the
 * whole thing holds together under workerd.
 *
 * WHAT THE PROBE DRIVES. The real file plane over this object's own SQLite,
 * composed the way the files-eio probe composes it (`NimbusWorkspace.create`
 * with no runtimes, the session credential, `nimbusSessionFiles` over a box
 * whose `files` are the credentialed vfs), and a real `GadgetHost` from
 * `src/gadgets/host.ts` over that plane, with `ctx: this.ctx` and the
 * loader binding. The host mints each binding from this test
 * worker's own `exports`, which publishes the production binding classes
 * exactly as `src/server.ts` does. The `data` port answers one fixed value
 * for `listBackgroundJobs`, the `mcp` port offers one read-only tool and one
 * side-effecting tool with a recording `call`, the approval policy is strict
 * with nobody to ask and no queue, and `broadcast` records.
 *
 * The binding entrypoints reach this object the way production reaches the
 * orchestrator: the test worker binds `OrchestratorAgent` to this class, so
 * `gadgetOwner` resolves the workspace name back to this object, and this
 * class exposes `gadgetBindingCall` beside `gadgetCall` for that hop.
 */
import { DurableObject } from 'cloudflare:workers';
import { GadgetHost } from '../../src/gadgets/host';
import type { GadgetBindingRequest } from '../../src/gadgets/bindings';
import {
  GADGETS_CHANGED_EVENT,
  nimbusSessionFiles,
  type GadgetCallResult,
  type GadgetDataSource,
  type GadgetMcpTool,
  type JsonObject,
  type JsonValue,
  type NimbusSandboxHandle,
} from '@kinu.run/core';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';

/**
 * The probe's RPC surface as the test reaches it. Narrowed the way
 * `gadgetOwner` (src/gadgets/bindings.ts) narrows the orchestrator: a stub
 * typed by the whole class makes TypeScript walk the class's entire surface
 * and, through `DurableObject<Cloudflare.Env>`, the test worker's `Env` back
 * again, which is excessively deep. The narrow view also says what a caller
 * may reach.
 */
export interface GadgetProcessProbeRpc extends Rpc.DurableObjectBranded {
  gadgetCall(slug: string, method: string, args: JsonValue[]): Promise<GadgetCallResult>;
  gadgetBindingCall(slug: string, name: string, request: GadgetBindingRequest): Promise<GadgetCallResult>;
  writeGadget(slug: string, files: Record<string, string>): Promise<{ written: number }>;
  readBroadcasts(): Promise<Array<{ type: typeof GADGETS_CHANGED_EVENT; slugs: string[] }>>;
  readMcpCalls(): Promise<string[]>;
  filesChanged(paths: string[]): Promise<{ broadcasts: number }>;
}
/** What the probe's `data` port answers for `listBackgroundJobs`. Fixed, so
 *  the test asserts an exact value rather than a shape. */
export const PROBE_JOBS: JsonValue = { jobs: [{ id: 'probe-job-1', status: 'running' }] };

/** The two tools the probe's `mcp` port offers: one observation, one side
 *  effect. Exported so the test names the same tools the port offers. */
export const PROBE_MCP_READ_TOOL = 'read_notes';
export const PROBE_MCP_WRITE_TOOL = 'write_notes';

type Composed = { host: GadgetHost; plane: ReturnType<typeof nimbusSessionFiles> };

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

export class GadgetProcessProbeDO extends DurableObject<Cloudflare.Env> {
  private _composed: Promise<Composed> | undefined;
  private broadcasts: Array<{ type: typeof GADGETS_CHANGED_EVENT; slugs: string[] }> = [];
  private mcpCalls: string[] = [];

  private composed(): Promise<Composed> {
    this._composed ??= (async () => {
      const workspace = await NimbusWorkspace.create({
        sql: this.ctx.storage.sql,
        transactions: this.ctx,
      });
      const session: CredentialedVfs = workspace.vfs.as(CRED_SESSION_USER);
      // The same `files` the files-eio probe carries: the native credentialed
      // vfs, so no read shells out.
      const files: NimbusSandboxHandle['files'] = {
        read: async (path) => absentAsNull(() => session.readFileString(path)),
        readBytes: async (path) => absentAsNull(() => session.readFile(path)),
        write: async (path, content) => { session.writeFile(path, content); },
        list: async (path) =>
          session.readdir(path ?? '/').map((entry) => ({ name: entry.name, type: entry.type })),
        stat: async (path) => absentAsNull(() => {
          const s = session.stat(path);
          return { type: s.type, size: s.size, mtime: s.mtime };
        }),
        lstat: async (path) => absentAsNull(() => {
          const s = session.lstat(path);
          return { type: s.type, size: s.size, mtime: s.mtime, mode: s.mode };
        }),
        rename: async (from, to) => { session.rename(from, to); },
        chmod: async (path, mode) => { session.chmod(path, mode); },
        exists: async (path) => session.exists(path),
        mkdir: async (path) => { session.mkdir(path, { recursive: true }); },
        readRange: async (path, offset, length) =>
          absentAsNull(() => session.readRange(path, offset, length)),
        delete: async (path, options) => {
          if (options?.recursive) { session.removeRecursive(path); return; }
          if (session.stat(path).type === 'directory') { session.rmdir(path); return; }
          session.unlink(path);
        },
      };
      const box: NimbusSandboxHandle = {
        files,
        ready: async () => undefined,
        exec: async () => {
          throw new Error('the gadget probe never shells out');
        },
      };
      const plane = nimbusSessionFiles(box);
      const host = new GadgetHost({
        workspace: this.ctx.id.name ?? 'probe',
        vfs: () => plane,
        ctx: this.ctx,
        env: { LOADER: this.env.LOADER },
        broadcast: (event: { type: typeof GADGETS_CHANGED_EVENT; slugs: string[] }) => {
          this.broadcasts.push({ type: event.type, slugs: [...event.slugs] });
        },
        data: async (source: GadgetDataSource): Promise<JsonValue> => {
          if (source !== 'listBackgroundJobs') throw new Error(`the probe answers no fixture for ${source}`);
          return PROBE_JOBS;
        },
        mcp: {
          tools: async (): Promise<GadgetMcpTool[]> => [
            { name: PROBE_MCP_READ_TOOL, readOnly: true },
            { name: PROBE_MCP_WRITE_TOOL, readOnly: false },
          ],
          call: async (_server: string, tool: string, _args: JsonObject): Promise<JsonValue> => {
            this.mcpCalls.push(tool);
            return { called: tool };
          },
        },
        // Strict with no channel and no queue: a side effect is refused with
        // its NOT RUN message, and nobody is asked.
        approval: { mode: () => 'strict' },
      });
      return { host, plane };
    })();
    return this._composed;
  }

  /** One call into a gadget's server, as the tab bridge makes it. */
  async gadgetCall(slug: string, method: string, args: JsonValue[] = []): Promise<GadgetCallResult> {
    const { host } = await this.composed();
    return host.call(slug, method, args);
  }

  /** A gadget server's call through one of its bindings, back from its
   *  isolate through the loopback entrypoints. */
  async gadgetBindingCall(
    slug: string,
    name: string,
    request: GadgetBindingRequest,
  ): Promise<GadgetCallResult> {
    const { host } = await this.composed();
    return host.bindingCall(slug, name, request);
  }

  /** Write files under `gadgets/<slug>/`, creating parent directories. */
  async writeGadget(slug: string, files: Record<string, string>): Promise<{ written: number }> {
    const { plane } = await this.composed();
    let written = 0;
    for (const [name, content] of Object.entries(files)) {
      const path = `gadgets/${slug}/${name}`;
      const parent = path.slice(0, path.lastIndexOf('/'));
      if (parent) await plane.mkdir(parent, { recursive: true });
      await plane.writeFile(path, content);
      written += 1;
    }
    return { written };
  }

  /** The broadcasts `filesChanged` recorded, oldest first. */
  async readBroadcasts(): Promise<Array<{ type: typeof GADGETS_CHANGED_EVENT; slugs: string[] }>> {
    return this.broadcasts.map((event) => ({ type: event.type, slugs: [...event.slugs] }));
  }

  /** The tool names the probe's `mcp` port was asked to call, oldest first. */
  async readMcpCalls(): Promise<string[]> {
    return [...this.mcpCalls];
  }

  /** Feed file-plane event paths through the host, as the event bus does. */
  async filesChanged(paths: string[]): Promise<{ broadcasts: number }> {
    const { host } = await this.composed();
    host.filesChanged(paths);
    return { broadcasts: this.broadcasts.length };
  }
}
