/**
 * The binding a gadget server holds — one loopback entrypoint for every kind.
 *
 * A gadget's `server.js` runs in a resident process whose `env` is exactly
 * what the owning workspace object put there: for each entry in the manifest,
 * one stub minted with `ctx.exports.GadgetBinding({ props })`. The props name
 * the workspace, the gadget and the binding, and only this Worker can write
 * them — the process never sees them (Dynamic Workers docs, usage/bindings).
 * A stub has no global identifier and cannot be forged: the only way to hold
 * one is to have been handed it, which is what makes `env` the whole of a
 * gadget's reach.
 *
 * ONE CLASS, ONE METHOD. Every plane is the same shape to the process,
 * `env.<NAME>.<member>(...args)`, and a Workers RPC stub answers only the
 * methods its class declares, so the process-side runner (gadgets/host.ts)
 * wraps each stub in a Proxy that turns any member access into `call(member,
 * args, depth)` here. The entrypoint decides nothing: it carries the request
 * back to the workspace object that owns the manifest, the executors, the
 * read models and the owner's connections, where `GadgetHost.bindingCall`
 * re-reads the manifest and routes with the pure decision in `@kinu.run/core`
 * (`gadgets/bindings.ts`). Nothing is decided in the entrypoint, because an
 * entrypoint is stateless and the manifest may have changed since the
 * process was built. A second transport — an HTTP capability endpoint — would
 * reach the same `bindingCall` with the same request.
 *
 * A refusal THROWS. The gadget author reads `await env.WS.readFile(path)` as a
 * string, so a refused read is a rejection with the class in front of the
 * message (`denied: SANDBOX does not offer sandbox.readFile`), the shape a
 * `catch` in agent-written code expects and the model already reads on every
 * other tool.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { workspaceOwner, type WorkspaceOwnerRpc } from '../workspace-box-rpc';
import type { JsonValue } from '@kinu.run/core';

/** What a minted stub carries. Written by the host, read by `this.ctx.props`. */
export interface GadgetBindingProps {
  readonly workspace: string;
  readonly slug: string;
  readonly name: string;
}

/** The two gadget methods on the workspace object, as the slice of the owner
 *  contract a binding entrypoint or a facet actor holds. */
export type GadgetOwnerRpc = Pick<WorkspaceOwnerRpc, 'gadgetBindingCall'>;

export function gadgetOwner(env: { OrchestratorAgent: DurableObjectNamespace }, workspaceName: string): GadgetOwnerRpc {
  return workspaceOwner(env, workspaceName);
}

interface GadgetBindingEnv {
  OrchestratorAgent: DurableObjectNamespace;
}

/** `env.<NAME>` for every binding kind: the one hop back to the owner. */
export class GadgetBinding extends WorkerEntrypoint<GadgetBindingEnv, GadgetBindingProps> {
  /**
   * One member call. `args` and `depth` arrive as the process's runner sent
   * them and are parsed on the owner, never trusted here: the process is
   * agent code.
   */
  async call(member: string, args: JsonValue[], depth: number): Promise<JsonValue> {
    const { workspace, slug, name } = this.ctx.props;
    const result = await gadgetOwner(this.env, workspace).gadgetBindingCall(slug, name, { member, args, depth });
    if (!result.ok) throw new Error(`${result.reason}: ${result.error}`);
    return result.value;
  }
}
