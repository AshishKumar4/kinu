/**
 * What a binding call may reach — the pure half, in one decision.
 *
 * Every binding is the same shape to the process: `env.<NAME>.<member>(...args)`.
 * The host places one loopback stub per manifest entry into the resident
 * process `env`, and every call on a stub comes back to the owning object as
 * ONE request — the member and its JSON arguments, plus how many app-to-app
 * hops the caller is already down. The object asks THIS function what the
 * manifest, as it stands now, lets that request reach, and only then touches
 * anything:
 *
 *   namespace  the provider's member, refused unless the manifest lists it
 *              (or lists none)
 *   rpc        one declared read model, with no arguments
 *   mcp        one tool on the declared connection, with one JSON object
 *   app        one method on the other gadget, one hop deeper
 *
 * Nothing here is a gate. A binding passes the agent's OWN capability into the
 * process, gated exactly as the agent's own call is and no more: a shell
 * command meets the executor's own approval gate inside the provider's
 * `execute` (execution/approval.ts), an MCP tool meets the owner's connection
 * allowlist inside UserDO, a read model is the read the owner can already
 * make. The decision is over the manifest, the request and nothing else, so
 * it can sit behind any transport: the loopback entrypoint today, an HTTP
 * capability endpoint tomorrow.
 */

import * as v from 'valibot';
import { JsonObjectSchema, JsonValueSchema, type JsonObject, type JsonValue } from '../utils/json';
import { KinuError, refusalOf, type Refusal } from '../obs/index';
import type { GadgetDataSource } from './sources';
import { GADGET_LIMITS, gadgetBindings, type GadgetManifest } from './manifest';
import { isGadgetMethodName } from './rpc';

/** One call through a binding, as the workspace object receives it from any
 *  transport. Parsed at the boundary: the process is agent code. */
export const GadgetBindingRequestSchema = v.strictObject({
  member: v.string(),
  args: v.array(JsonValueSchema),
  /** App-to-app hops already taken by the caller. Zero for a server's own call. */
  depth: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export type GadgetBindingRequest = v.InferOutput<typeof GadgetBindingRequestSchema>;

/** What the manifest lets a request reach. The host runs exactly this. */
export type GadgetBindingRoute =
  | {
    readonly kind: 'namespace';
    readonly namespace: string;
    readonly member: string;
    readonly args: readonly JsonValue[];
  }
  | { readonly kind: 'rpc'; readonly method: GadgetDataSource }
  | { readonly kind: 'mcp'; readonly server: string; readonly tool: string; readonly args: JsonObject }
  | {
    readonly kind: 'app';
    readonly id: string;
    readonly method: string;
    readonly args: readonly JsonValue[];
    /** The caller's depth; the hop into `id` is one more. */
    readonly depth: number;
  };

export type GadgetBindingRouteResult =
  | { readonly ok: true; readonly route: GadgetBindingRoute }
  | ({ readonly ok: false } & Refusal);

function refuse(code: 'denied' | 'bad_input', message: string): GadgetBindingRouteResult {
  return { ok: false, ...refusalOf(new KinuError(code, message)) };
}

/**
 * Decide one binding call from the manifest as it stands now.
 *
 * Re-run on every call rather than trusted from the boot: the stub proves the
 * process was built with this binding NAME, and the manifest decides what the
 * name reaches today.
 */
export function routeGadgetBindingCall(input: {
  readonly slug: string;
  readonly manifest: GadgetManifest;
  readonly name: string;
  readonly request: GadgetBindingRequest;
}): GadgetBindingRouteResult {
  const { slug, name, request } = input;
  const binding = gadgetBindings(input.manifest).find(([bound]) => bound === name)?.[1];
  if (!binding) {
    return refuse('denied', `gadget "${slug}" no longer declares a binding named ${name}`);
  }
  const { member, args } = request;
  switch (binding.kind) {
    case 'namespace': {
      if (binding.members !== undefined && !binding.members.includes(member)) {
        return refuse('denied',
          `${name} does not offer ${binding.namespace}.${member}: gadget "${slug}" listed ${binding.members.join(', ')}`);
      }
      return { ok: true, route: { kind: 'namespace', namespace: binding.namespace, member, args } };
    }
    case 'rpc': {
      const method = binding.methods.find((declared) => declared === member);
      if (method === undefined) {
        return refuse('denied', `${name} does not offer ${member}: gadget "${slug}" listed ${binding.methods.join(', ')}`);
      }
      if (args.length > 0) {
        return refuse('bad_input', `${name}.${member} is a read model and takes no arguments`);
      }
      return { ok: true, route: { kind: 'rpc', method } };
    }
    case 'mcp': {
      if (binding.tools !== undefined && !binding.tools.includes(member)) {
        return refuse('denied',
          `${name} does not offer ${member} on ${binding.server}: gadget "${slug}" listed ${binding.tools.join(', ') || 'no tools'}`);
      }
      if (args.length > 1) {
        return refuse('bad_input', `${name}.${member} takes one JSON object of arguments`);
      }
      const parsed = v.safeParse(JsonObjectSchema, args[0] ?? {});
      if (!parsed.success) {
        return refuse('bad_input', `${name}.${member} takes one JSON object of arguments`);
      }
      return { ok: true, route: { kind: 'mcp', server: binding.server, tool: member, args: parsed.output } };
    }
    case 'app': {
      if (!isGadgetMethodName(member)) {
        return refuse('bad_input', `"${member}" is not a method name the bridge forwards`);
      }
      if (request.depth >= GADGET_LIMITS.appDepth) {
        return refuse('denied',
          `${name}.${member} would be app hop ${request.depth + 1}; the bound is ${GADGET_LIMITS.appDepth}, so this is a cycle or a chain too deep`);
      }
      return { ok: true, route: { kind: 'app', id: binding.id, method: member, args, depth: request.depth } };
    }
  }
}
