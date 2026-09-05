/**
 * The bindings a gadget server holds — one loopback entrypoint per kind.
 *
 * A gadget's `server.js` runs in a dynamic Worker whose `env` is exactly what
 * the owning workspace object put there: for each entry in the manifest, one
 * stub minted with `ctx.exports.<Class>({ props })`. The props name the
 * workspace, the gadget and the binding, and only this Worker can write them —
 * the dynamic Worker never sees them (Dynamic Workers docs, usage/bindings).
 * A stub has no global identifier and cannot be forged: the only way to hold
 * one is to have been handed it, which is what makes `env` the whole of a
 * gadget's reach.
 *
 * Every method here does one thing: carry the call back to the workspace
 * object that owns the files, the read models and the owner's connections,
 * where `GadgetHost.bindingCall` re-reads the manifest and decides. Nothing is
 * decided in the entrypoint, because an entrypoint is stateless and the
 * manifest may have changed since the isolate was built.
 *
 * A refusal THROWS. The gadget author reads `await env.FILES.read(path)` as a
 * string, so a refused read is a rejection with the class in front of the
 * message (`denied: "../SOUL.md" leaves reports/`), the shape a `catch` in
 * agent-written code expects and the model already reads on every other
 * tool.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { workspaceOwner } from '../workspace-box-rpc';
import type { JsonValue, GadgetBindingKind, GadgetCallResult } from '@kinu.run/core';

/** What a minted stub carries. Written by the host, read by `this.ctx.props`. */
export interface GadgetBindingProps {
  readonly workspace: string;
  readonly slug: string;
  readonly name: string;
  readonly kind: GadgetBindingKind;
}

/** One call through a binding, as the workspace object receives it. */
export type GadgetBindingRequest =
  | { readonly kind: 'files'; readonly op: 'read'; readonly path: string }
  | { readonly kind: 'files'; readonly op: 'write'; readonly path: string; readonly text: string }
  | { readonly kind: 'files'; readonly op: 'list'; readonly path: string }
  | { readonly kind: 'files'; readonly op: 'remove'; readonly path: string }
  | { readonly kind: 'workspace'; readonly op: 'read'; readonly source: string }
  | { readonly kind: 'mcp'; readonly op: 'tools' }
  | { readonly kind: 'mcp'; readonly op: 'call'; readonly tool: string; readonly args: JsonValue };

/**
 * The two gadget methods on the workspace object, as the narrow view a
 * binding entrypoint or a facet actor holds. Narrowed the way
 * `workspaceBoxOwner` narrows the same namespace, and for the same reason:
 * `DurableObjectStub<OrchestratorAgent>` makes TypeScript walk that class's
 * whole RPC surface, and the narrow view also says what a caller may reach.
 */
export interface GadgetOwnerRpc {
  gadgetCall(slug: string, method: string, args: JsonValue[]): Promise<GadgetCallResult>;
  gadgetBindingCall(slug: string, name: string, request: GadgetBindingRequest): Promise<GadgetCallResult>;
}

export function gadgetOwner(env: { OrchestratorAgent: DurableObjectNamespace }, workspaceName: string): GadgetOwnerRpc {
  return workspaceOwner(env, workspaceName);
}

interface GadgetBindingEnv {
  OrchestratorAgent: DurableObjectNamespace;
}

/** What every binding kind shares: the props, the owner, and the one hop. */
abstract class GadgetBindingBase extends WorkerEntrypoint<GadgetBindingEnv, GadgetBindingProps> {
  protected async carry(request: GadgetBindingRequest): Promise<JsonValue> {
    const { workspace, slug, name, kind } = this.ctx.props;
    if (request.kind !== kind) {
      throw new Error(`denied: binding ${name} is a ${kind} binding`);
    }
    const result = await gadgetOwner(this.env, workspace).gadgetBindingCall(slug, name, request);
    if (!result.ok) throw new Error(`${result.reason}: ${result.error}`);
    return result.value;
  }
}

/** `env.<NAME>` for `{ kind: 'files' }`: a directory of the workspace file
 *  plane. Paths are relative to the binding's root. */
export class GadgetFilesBinding extends GadgetBindingBase {
  async read(path: string): Promise<JsonValue> {
    return this.carry({ kind: 'files', op: 'read', path: String(path) });
  }

  async write(path: string, text: string): Promise<JsonValue> {
    return this.carry({ kind: 'files', op: 'write', path: String(path), text: String(text) });
  }

  async list(path: string = ''): Promise<JsonValue> {
    return this.carry({ kind: 'files', op: 'list', path: String(path) });
  }

  async remove(path: string): Promise<JsonValue> {
    return this.carry({ kind: 'files', op: 'remove', path: String(path) });
  }
}

/** `env.<NAME>` for `{ kind: 'workspace' }`: the closed list of read models. */
export class GadgetWorkspaceBinding extends GadgetBindingBase {
  async read(source: string): Promise<JsonValue> {
    return this.carry({ kind: 'workspace', op: 'read', source: String(source) });
  }
}

/** `env.<NAME>` for `{ kind: 'mcp' }`: one of the owner's MCP connections,
 *  every side-effecting call parked on the owner's approval. */
export class GadgetMcpBinding extends GadgetBindingBase {
  async tools(): Promise<JsonValue> {
    return this.carry({ kind: 'mcp', op: 'tools' });
  }

  async call(tool: string, args: JsonValue = {}): Promise<JsonValue> {
    return this.carry({ kind: 'mcp', op: 'call', tool: String(tool), args });
  }
}

export type GadgetBindingEntrypoint = 'GadgetFilesBinding' | 'GadgetWorkspaceBinding' | 'GadgetMcpBinding';

/** One loopback stub factory per binding entrypoint, by export name: what
 *  `ctx.exports.<Class>({ props })` answers. The narrow view both mints read
 *  through, so neither walks the whole generic surface of `exports`, which is
 *  what made the record-wide view excessively deep (TS2589). */
export interface GadgetLoopbackFactories {
  readonly GadgetFilesBinding: (opts: { props: GadgetBindingProps }) => Fetcher;
  readonly GadgetWorkspaceBinding: (opts: { props: GadgetBindingProps }) => Fetcher;
  readonly GadgetMcpBinding: (opts: { props: GadgetBindingProps }) => Fetcher;
}

/** The entrypoint class a binding kind is minted from, by name in the main
 *  module's exports. One table, so the host and `server.ts` cannot disagree. */
export const GADGET_BINDING_ENTRYPOINT = {
  files: 'GadgetFilesBinding',
  workspace: 'GadgetWorkspaceBinding',
  mcp: 'GadgetMcpBinding',
} satisfies Record<GadgetBindingKind, GadgetBindingEntrypoint>;
