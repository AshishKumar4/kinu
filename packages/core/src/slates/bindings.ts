import * as v from 'valibot';
import { isJsonObject, JsonValueSchema, type JsonObject, type JsonValue } from '../utils/json';
import { KinuError } from '../obs/error';
import { isSlateMethodName } from './rpc';
import type { SlateReadModel } from './read-models';
import type { SlateBinding, SlateProject } from './project';

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
  | { readonly kind: 'codemode'; readonly namespace: 'memory' | 'tasks' | 'web'; readonly member: string; readonly args: readonly JsonValue[] }
  | { readonly kind: 'tool'; readonly name: string; readonly input: JsonObject }
  | { readonly kind: 'rpc'; readonly method: SlateReadModel }
  | { readonly kind: 'mcp'; readonly server: string; readonly tool: string; readonly args: JsonObject }
  | { readonly kind: 'agent'; readonly slate: string; readonly text: string; readonly data?: JsonValue }
  | { readonly kind: 'ai'; readonly prompt: string; readonly system?: string; readonly tier?: string }
  | {
    readonly kind: 'app';
    readonly id: string;
    readonly method: string;
    readonly args: readonly JsonValue[];
    /** The chain the callee runs under: the caller's chain plus the caller. */
    readonly chain: readonly string[];
  };

/** The resolved caller context every kind router reads: the calling slate's
 *  id, the binding's own name for refusals, and the caller's lineage. */
interface BindingCallContext {
  readonly id: string;
  readonly name: string;
  readonly chain: readonly string[];
}

function routeToolCall(binding: Extract<SlateBinding, { kind: 'tool' }>, request: SlateBindingRequest, ctx: BindingCallContext): SlateBindingRoute {
  const { name } = ctx;
  const { member, args } = request;

  if (member !== 'call') throw new KinuError('denied', `${name} offers call(input) for tools.${binding.name}`);
  const argumentsObject = args.length === 0 ? {} : args[0];

  if (args.length > 1 || !isJsonObject(argumentsObject)) throw new KinuError('bad_input', `${name}.call takes one JSON object of arguments`);

  return { kind: 'tool', name: binding.name, input: argumentsObject };
}

function routeCodemodeCall(binding: Extract<SlateBinding, { kind: 'memory' | 'tasks' | 'web' }>, request: SlateBindingRequest, ctx: BindingCallContext): SlateBindingRoute {
  const { name } = ctx;
  const { member, args } = request;

  if (binding.members !== undefined && !binding.members.includes(member)) {
    throw new KinuError('denied', `${name} does not offer ${binding.kind}.${member}`);
  }

  return { kind: 'codemode', namespace: binding.kind, member, args };
}

function routeNamespaceCall(binding: Extract<SlateBinding, { kind: 'namespace' }>, request: SlateBindingRequest, ctx: BindingCallContext): SlateBindingRoute {
  const { name } = ctx;
  const { member, args } = request;

  if (binding.namespace === 'agents' || binding.namespace === 'agent') {
    throw new KinuError('denied', 'A slate cannot delegate or control its calling agent');
  }

  if (binding.members !== undefined && !binding.members.includes(member)) {
    throw new KinuError('denied', `${name} does not offer ${binding.namespace}.${member}`);
  }

  // A `paths`-scoped workspace binding narrows to the file members, and
  // every call's first argument must resolve inside one declared prefix.
  if (binding.paths !== undefined) {
    const prefixes = binding.paths;
    const FILE_MEMBERS = ['readFile', 'writeFile', 'editFile', 'readdir', 'exists'];

    if (!FILE_MEMBERS.includes(member)) {
      throw new KinuError('denied', 'a path-scoped workspace binding offers only file members');
    }

    const target = v.safeParse(v.string(), args[0]);

    if (!target.success || !target.output.startsWith('/') || target.output.split('/').includes('..')
      || !prefixes.some((prefix) => target.output === prefix || target.output.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'))) {
      throw new KinuError('denied',
        `${name}.${member} names a path outside its prefixes: ${prefixes.join(', ')}`);
    }
  }

  return { kind: 'namespace', namespace: binding.namespace, member, args };
}

function routeAgentCall(request: SlateBindingRequest, ctx: BindingCallContext): SlateBindingRoute {
  const { id, name } = ctx;
  const { member, args } = request;
  const payload = args[0];

  if (member !== 'send') throw new KinuError('denied', `${name} offers send({ text, data? }) for the calling agent's inbox`);

  if (args.length !== 1 || !isJsonObject(payload)) throw new KinuError('bad_input', `${name}.send takes one { text, data? } object`);

  const parsed = v.safeParse(v.strictObject({ text: v.pipe(v.string(), v.minLength(1)), data: v.optional(JsonValueSchema) }), payload);

  if (!parsed.success) throw new KinuError('bad_input', `${name}.send takes one { text, data? } object`);

  const data = parsed.output.data;

  return data === undefined
    ? { kind: 'agent', slate: id, text: parsed.output.text }
    : { kind: 'agent', slate: id, text: parsed.output.text, data };
}

function routeAiCall(binding: Extract<SlateBinding, { kind: 'ai' }>, request: SlateBindingRequest, ctx: BindingCallContext): SlateBindingRoute {
  const { name } = ctx;
  const { member, args } = request;
  const payload = args[0];

  if (member !== 'run') throw new KinuError('denied', `${name} offers run({ prompt, system?, tier? }) for one model call`);

  if (args.length !== 1 || !isJsonObject(payload)) throw new KinuError('bad_input', `${name}.run takes one { prompt, system?, tier? } object`);

  const parsed = v.safeParse(v.strictObject({
    prompt: v.pipe(v.string(), v.minLength(1)),
    system: v.optional(v.string()),
    tier: v.optional(v.string()),
  }), payload);

  if (!parsed.success) throw new KinuError('bad_input', `${name}.run takes one { prompt, system?, tier? } object`);

  // The binding's declared tier is the default a call can override only
  // when the binding declares none; a declared tier the call tries to
  // change is refused rather than silently kept.
  if (binding.tier !== undefined && parsed.output.tier !== undefined && parsed.output.tier !== binding.tier) {
    throw new KinuError('bad_input', `${name} pins tier ${binding.tier}; the call's tier cannot change it`);
  }

  const tier = binding.tier ?? parsed.output.tier;
  const prompt = parsed.output.prompt;
  const system = parsed.output.system;

  if (system !== undefined && tier !== undefined) return { kind: 'ai', prompt, system, tier };

  if (system !== undefined) return { kind: 'ai', prompt, system };

  if (tier !== undefined) return { kind: 'ai', prompt, tier };

  return { kind: 'ai', prompt };
}

function routeRpcCall(binding: Extract<SlateBinding, { kind: 'rpc' }>, request: SlateBindingRequest, ctx: BindingCallContext): SlateBindingRoute {
  const { name } = ctx;
  const { member, args } = request;

  const method = binding.methods.find((declared) => declared === member);

  if (method === undefined) throw new KinuError('denied', `${name} does not offer ${member}`);

  if (args.length !== 0) throw new KinuError('bad_input', `${name}.${member} is a read model and takes no arguments`);

  return { kind: 'rpc', method };
}

function routeMcpCall(binding: Extract<SlateBinding, { kind: 'mcp' }>, request: SlateBindingRequest, ctx: BindingCallContext): SlateBindingRoute {
  const { name } = ctx;
  const { member, args } = request;

  if (binding.tools !== undefined && !binding.tools.includes(member)) {
    throw new KinuError('denied', `${name} does not offer ${member} on ${binding.server}`);
  }

  const argumentsObject = args.length === 0 ? {} : args[0];

  if (args.length > 1 || !isJsonObject(argumentsObject)) throw new KinuError('bad_input', `${name}.${member} takes one JSON object of arguments`);

  return { kind: 'mcp', server: binding.server, tool: member, args: argumentsObject };
}

function routeAppCall(binding: Extract<SlateBinding, { kind: 'app' }>, request: SlateBindingRequest, ctx: BindingCallContext): SlateBindingRoute {
  const { id, name } = ctx;
  const { member, args } = request;

  if (!isSlateMethodName(member)) {
    throw new KinuError('bad_input', `"${member}" is not a method name the bridge forwards`);
  }

  // An app hop ends because it must name a slate that is not already
  // running above it. A workspace holds finitely many slates, so a chain of
  // distinct ones is finite and no hop count has to bound it. A repeat is a
  // cycle: the callee is waiting on its own caller and cannot answer.
  const chain = [...ctx.chain, id];

  if (chain.includes(binding.id)) {
    throw new KinuError('denied',
      `${name}.${member} re-enters slate ${binding.id}, which is already running in this call chain: ${[...chain, binding.id].join(' -> ')}`);
  }

  return { kind: 'app', id: binding.id, method: member, args, chain };
}

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
  const ctx = { id, name, chain: input.chain };

  switch (binding.kind) {
    case 'tool': return routeToolCall(binding, request, ctx);
    case 'memory':
    case 'tasks':
    case 'web': return routeCodemodeCall(binding, request, ctx);
    case 'namespace': return routeNamespaceCall(binding, request, ctx);
    case 'agent': return routeAgentCall(request, ctx);
    case 'ai': return routeAiCall(binding, request, ctx);
    case 'rpc': return routeRpcCall(binding, request, ctx);
    case 'mcp': return routeMcpCall(binding, request, ctx);
    case 'app': return routeAppCall(binding, request, ctx);
  }
}
