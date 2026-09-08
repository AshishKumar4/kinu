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
   * The slate ids already running above this call, outermost first. The caller's
   * own id is not in it: the router appends that from the binding stub's
   * host-set props, so a slate cannot rename itself out of its own chain.
   */
  chain: v.array(v.pipe(v.string(), v.minLength(1))),
});
export type SlateBindingRequest = v.InferOutput<typeof SlateBindingRequestSchema>;
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
      const chain = [...request.chain, id];
      if (chain.includes(binding.id)) {
        throw new KinuError('denied',
          `${name}.${member} re-enters slate ${binding.id}, which is already running in this call chain: ${[...chain, binding.id].join(' -> ')}`);
      }
      return { kind: 'app', id: binding.id, method: member, args, chain };
    }
  }
}
