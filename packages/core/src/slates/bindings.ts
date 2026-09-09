import * as v from 'valibot';
import { isJsonObject, JsonValueSchema, type JsonObject, type JsonValue } from '../utils/json';
import { KinuError } from '../obs/error';
import { isSlateMethodName } from './rpc';
import type { SlateReadModel } from './read-models';
import type { SlateProject } from './project';

export const SlateBindingRequestSchema = v.strictObject({
  member: v.pipe(v.string(), v.minLength(1)),
  args: v.array(JsonValueSchema),
  /**
   * Which app invocation this call is made from, as the host named it.
   *
   * The guest carries this and nothing else about its lineage. An id names an
   * invocation the host is running, so the chain comes out of
   * {@link resolveSlateChain} and never off the wire: a chain riding here
   * directly would let a slate hand back a shorter one and start a shorter
   * lineage.
   *
   * EVERY request a guest can reach carries one. A hop is named by
   * `ResidentSlateHost.call`, a browser hitting the preview by
   * `ResidentSlateHost.previewInvocation` through `routePreview`, and both are
   * released when their request settles — so bindings kept from an earlier
   * request are refused rather than resolving to a root lineage. `null` is left
   * for the actor's own direct call, which is not a guest.
   */
  invocation: v.nullable(v.pipe(v.string(), v.minLength(1))),
});
export type SlateBindingRequest = v.InferOutput<typeof SlateBindingRequestSchema>;

/** One app invocation the host is running: which slate it entered, and the
 *  chain of slates already running above it. */
export interface SlateInvocation {
  readonly id: string;
  readonly chain: readonly string[];
}

/**
 * The chain a binding call runs under, taken from the host's own record of the
 * invocation the guest named.
 *
 * Three answers, and only one of them is a chain the guest influenced at all:
 * an unnamed invocation is the root; a named one the host is running lends its
 * chain; anything else is refused by reason. That covers a guest that retains
 * an older request's bindings and replays them — the id it holds has been
 * retired — and a guest that presents an id issued to a different slate.
 */
export function resolveSlateChain(input: {
  readonly invocations: ReadonlyMap<string, SlateInvocation>;
  readonly id: string;
  readonly invocation: string | null;
}): readonly string[] {
  const { invocations, id, invocation } = input;
  if (invocation === null) return [];
  const issued = invocations.get(invocation);
  if (issued === undefined) {
    throw new KinuError('denied',
      `Slate ${id} named app invocation ${invocation}, which this host is not running; a finished invocation cannot lend its call chain`);
  }
  if (issued.id !== id) {
    throw new KinuError('denied',
      `Slate ${id} named app invocation ${invocation}, which was issued to slate ${issued.id}`);
  }
  return issued.chain;
}

export type SlateBindingRoute =
  | { readonly kind: 'namespace'; readonly namespace: string; readonly member: string; readonly args: readonly JsonValue[] }
  | { readonly kind: 'rpc'; readonly method: SlateReadModel }
  | { readonly kind: 'mcp'; readonly server: string; readonly tool: string; readonly args: JsonObject }
  | {
    readonly kind: 'app';
    readonly id: string;
    readonly method: string;
    readonly args: readonly JsonValue[];
    /** The chain the callee runs under: the caller's chain plus the caller. */
    readonly chain: readonly string[];
  };

export function routeSlateBindingCall(input: {
  readonly id: string;
  readonly project: SlateProject;
  readonly name: string;
  readonly request: SlateBindingRequest;
  /** The caller's lineage, resolved by {@link resolveSlateChain}. Never off the wire. */
  readonly chain: readonly string[];
}): SlateBindingRoute {
  const { id, name, request } = input;
  const bindings = input.project.slate.bindings;
  const binding = Object.hasOwn(bindings, name) ? bindings[name] : undefined;
  if (binding === undefined) throw new KinuError('denied', `Slate ${id} no longer declares binding ${name}`);
  const { member, args } = request;
  switch (binding.kind) {
    case 'namespace':
      if (binding.members !== undefined && !binding.members.includes(member)) {
        throw new KinuError('denied', `${name} does not offer ${binding.namespace}.${member}`);
      }
      return { kind: 'namespace', namespace: binding.namespace, member, args };
    case 'rpc': {
      const method = binding.methods.find((declared) => declared === member);
      if (method === undefined) throw new KinuError('denied', `${name} does not offer ${member}`);
      if (args.length !== 0) throw new KinuError('bad_input', `${name}.${member} is a read model and takes no arguments`);
      return { kind: 'rpc', method };
    }
    case 'mcp': {
      if (binding.tools !== undefined && !binding.tools.includes(member)) {
        throw new KinuError('denied', `${name} does not offer ${member} on ${binding.server}`);
      }
      const argumentsObject = args.length === 0 ? {} : args[0];
      if (args.length > 1 || !isJsonObject(argumentsObject)) throw new KinuError('bad_input', `${name}.${member} takes one JSON object of arguments`);
      return { kind: 'mcp', server: binding.server, tool: member, args: argumentsObject };
    }
    case 'app': {
      if (!isSlateMethodName(member)) {
        throw new KinuError('bad_input', `"${member}" is not a method name the bridge forwards`);
      }
      // An app hop ends because it must name a slate that is not already
      // running above it. A workspace holds finitely many slates, so a chain of
      // distinct ones is finite and no hop count has to bound it. A repeat is a
      // cycle: the callee is waiting on its own caller and cannot answer.
      const chain = [...input.chain, id];
      if (chain.includes(binding.id)) {
        throw new KinuError('denied',
          `${name}.${member} re-enters slate ${binding.id}, which is already running in this call chain: ${[...chain, binding.id].join(' -> ')}`);
      }
      return { kind: 'app', id: binding.id, method: member, args, chain };
    }
  }
}
