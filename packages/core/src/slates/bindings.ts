import * as v from 'valibot';
import { isJsonObject, JsonValueSchema, type JsonObject, type JsonValue } from '../utils/json';
import { KinuError } from '../obs/error';
import { isSlateMethodName } from './rpc';
import type { SlateReadModel } from './read-models';
import type { SlateProject } from './project';

const APP_DEPTH_LIMIT = 8;

export const SlateBindingRequestSchema = v.strictObject({
  member: v.pipe(v.string(), v.minLength(1)),
  args: v.array(JsonValueSchema),
  depth: v.pipe(v.number(), v.integer(), v.minValue(0)),
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
    /** The caller's depth; the hop into `id` is one more. */
    readonly depth: number;
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
    case 'app':
      if (!isSlateMethodName(member)) {
        throw new KinuError('bad_input', `"${member}" is not a method name the bridge forwards`);
      }
      if (request.depth >= APP_DEPTH_LIMIT) {
        throw new KinuError('denied',
          `${name}.${member} would be app hop ${request.depth + 1}; the bound is ${APP_DEPTH_LIMIT}, so this is a cycle or a chain too deep`);
      }
      return { kind: 'app', id: binding.id, method: member, args, depth: request.depth };
  }
}
