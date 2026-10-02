import * as v from 'valibot';
import { isJsonObject, JsonValueSchema, type JsonObject, type JsonValue } from '../utils/json';
import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { attempt, settle, settleSync } from '../obs/effect';
import { tolerateAsync } from '../obs/expected-failure';
import { vfsBasename, vfsDirname } from '../utils/vfs-helpers';
import type { CompositeVFS } from '@nimbus-sh/core/vfs/composite.js';
import { workspacePath } from '../vfs/workspace-path';
import { isSlateMethodName } from './rpc';
import type { SlateReadModel } from './read-models';
import type { SlateBinding, SlateProject } from './project';
import { grantAdmits } from './capability-graph';
import { memberEffect, toolActionEffect, toolActionMember } from './members';
import type { ShareGrant } from './sharing';

export const SlateBindingRequestSchema = v.strictObject({
  member: v.pipe(v.string(), v.minLength(1)),
  args: v.array(JsonValueSchema),
  /**
   * Host-issued invocation id; the chain comes from {@link resolveSlateChain}, never off the wire.
   * `null` only for the actor's own direct call.
   */
  invocation: v.nullable(v.pipe(v.string(), v.minLength(1))),
});

export type SlateBindingRequest = v.InferOutput<typeof SlateBindingRequestSchema>;

export interface SlateInvocation {
  readonly id: string;
  readonly chain: readonly string[];
  readonly viewer?: SlateViewer;
}

export interface SlateViewer {
  readonly share: string;
  readonly subject: string;
  readonly request: number;
}

/** Resolved from the host's own record, never off the wire: retired or foreign ids are refused. */
export function issuedSlateInvocation(input: {
  readonly invocations: ReadonlyMap<string, SlateInvocation>;
  readonly id: string;
  readonly invocation: string | null;
}): SlateInvocation | null {
  return settleSync(issued(input));
}

function issued(input: Parameters<typeof issuedSlateInvocation>[0]): Effect.Effect<SlateInvocation | null, KinuError> {
  const { invocations, id, invocation } = input;

  if (invocation === null) return Effect.succeed(null);
  const found = invocations.get(invocation);

  if (found === undefined) {
    return Effect.fail(new KinuError('denied',
      `Slate ${id} named app invocation ${invocation}, which this host is not running; a finished invocation cannot lend its call chain`));
  }

  if (found.id !== id) {
    return Effect.fail(new KinuError('denied',
      `Slate ${id} named app invocation ${invocation}, which was issued to slate ${found.id}`));
  }

  return Effect.succeed(found);
}

export type SlateBindingRoute =
  | {
    readonly kind: 'namespace'; readonly namespace: string; readonly member: string; readonly args: readonly JsonValue[];
    /** Prefixes the path must land in. */
    readonly within?: readonly string[];
  }
  | { readonly kind: 'codemode'; readonly namespace: 'memory' | 'tasks' | 'web'; readonly member: string; readonly args: readonly JsonValue[] }
  | { readonly kind: 'tool'; readonly name: string; readonly input: JsonObject }
  | { readonly kind: 'rpc'; readonly method: SlateReadModel }
  | { readonly kind: 'mcp'; readonly server: string; readonly tool: string; readonly args: JsonObject; readonly readOnly?: true }
  | { readonly kind: 'agent'; readonly slate: string; readonly text: string; readonly data?: JsonValue; readonly viewer?: string }
  | { readonly kind: 'ai'; readonly prompt: string; readonly system?: string; readonly tier?: string }
  | {
    readonly kind: 'app';
    readonly id: string;
    readonly method: string;
    readonly args: readonly JsonValue[];
    readonly chain: readonly string[];
  };

interface BindingCallContext {
  readonly id: string;
  readonly name: string;
  readonly chain: readonly string[];
}

function routeToolCall(binding: Extract<SlateBinding, { kind: 'tool' }>, request: SlateBindingRequest, ctx: BindingCallContext): Effect.Effect<SlateBindingRoute, KinuError> {
  const { name } = ctx;
  const { member, args } = request;

  if (member !== 'call') return Effect.fail(new KinuError('denied', `${name} offers call(input) for tools.${binding.name}`));
  const argumentsObject = args.length === 0 ? {} : args[0];

  if (args.length > 1 || !isJsonObject(argumentsObject)) return Effect.fail(new KinuError('bad_input', `${name}.call takes one JSON object of arguments`));

  return Effect.succeed({ kind: 'tool', name: binding.name, input: argumentsObject });
}

function routeCodemodeCall(binding: Extract<SlateBinding, { kind: 'memory' | 'tasks' | 'web' }>, request: SlateBindingRequest, ctx: BindingCallContext): Effect.Effect<SlateBindingRoute, KinuError> {
  const { name } = ctx;
  const { member, args } = request;

  if (binding.members !== undefined && !binding.members.includes(member)) {
    return Effect.fail(new KinuError('denied', `${name} does not offer ${binding.kind}.${member}`));
  }

  return Effect.succeed({ kind: 'codemode', namespace: binding.kind, member, args });
}

function insidePrefixes(prefixes: readonly string[], path: string): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'));
}

export type GrantNamespace = Pick<CompositeVFS, 'realpathAsync' | 'stat'>;

/** `path` with every link followed; null for a dangling link. */
async function landing(namespace: GrantNamespace, path: string): Promise<string | null> {
  const real = await tolerateAsync(() => namespace.realpathAsync(path), 'enoent');

  if (real !== undefined) return real;

  if ((await namespace.stat(path, { follow: false }))?.type === 'symlink') return null;
  const parent = vfsDirname(path) || '/';

  if (parent === path) return path;
  const above = await landing(namespace, parent);

  return above === null ? null : `${above === '/' ? '' : above}/${vfsBasename(path)}`;
}

/** Refuses a path a link carries outside its prefixes. */
export function assertLandsWithin(namespace: GrantNamespace, route: Extract<SlateBindingRoute, { kind: 'namespace' }>): Promise<void> {
  return settle(Effect.gen(function* () {
    if (route.within === undefined) return;
    const declared = route.within;
    const path = v.parse(v.string(), route.args[0]);

    const [landed, ...prefixes] = yield* attempt({ doing: `resolving ${path}`, otherwise: 'io' },
      () => Promise.all([path, ...declared].map((named) => landing(namespace, named))));

    if (landed === null || !insidePrefixes(prefixes.filter((prefix) => prefix !== null), landed)) {
      return yield* Effect.fail(new KinuError('denied', `${path} leads outside its prefixes, to ${landed ?? 'a link that names nothing'}: ${declared.join(', ')}`));
    }
  }));
}

function routeNamespaceCall(binding: Extract<SlateBinding, { kind: 'namespace' }>, request: SlateBindingRequest, ctx: BindingCallContext): Effect.Effect<SlateBindingRoute, KinuError> {
  const { name } = ctx;
  const { member, args } = request;

  if (binding.namespace === 'agents' || binding.namespace === 'agent') {
    return Effect.fail(new KinuError('denied', 'A slate cannot delegate or control its calling agent'));
  }

  if (binding.members !== undefined && !binding.members.includes(member)) {
    return Effect.fail(new KinuError('denied', `${name} does not offer ${binding.namespace}.${member}`));
  }

  if (binding.paths !== undefined) {
    const FILE_MEMBERS = ['readFile', 'writeFile', 'editFile', 'readdir', 'exists'];

    if (!FILE_MEMBERS.includes(member)) {
      return Effect.fail(new KinuError('denied', 'a path-scoped workspace binding offers only file members'));
    }

    const named = v.safeParse(v.string(), args[0]);

    if (!named.success || !named.output.startsWith('/')) {
      return Effect.fail(new KinuError('denied', `${name}.${member} takes an absolute path inside ${binding.paths.join(', ')}`));
    }

    const forwarded = args.slice();
    forwarded[0] = workspacePath(named.output);

    return Effect.succeed({ kind: 'namespace', namespace: binding.namespace, member, args: forwarded, within: binding.paths });
  }

  return Effect.succeed({ kind: 'namespace', namespace: binding.namespace, member, args });
}

function routeAgentCall(request: SlateBindingRequest, ctx: BindingCallContext): Effect.Effect<SlateBindingRoute, KinuError> {
  const { id, name } = ctx;
  const { member, args } = request;
  const payload = args[0];

  if (member !== 'send') return Effect.fail(new KinuError('denied', `${name} offers send({ text, data? }) for the calling agent's inbox`));

  if (args.length !== 1 || !isJsonObject(payload)) return Effect.fail(new KinuError('bad_input', `${name}.send takes one { text, data? } object`));

  const parsed = v.safeParse(v.strictObject({ text: v.pipe(v.string(), v.minLength(1)), data: v.optional(JsonValueSchema) }), payload);

  if (!parsed.success) return Effect.fail(new KinuError('bad_input', `${name}.send takes one { text, data? } object`));

  const data = parsed.output.data;

  return Effect.succeed(data === undefined
    ? { kind: 'agent', slate: id, text: parsed.output.text }
    : { kind: 'agent', slate: id, text: parsed.output.text, data });
}

function routeAiCall(binding: Extract<SlateBinding, { kind: 'ai' }>, request: SlateBindingRequest, ctx: BindingCallContext): Effect.Effect<SlateBindingRoute, KinuError> {
  const { name } = ctx;
  const { member, args } = request;
  const payload = args[0];

  if (member !== 'shell') return Effect.fail(new KinuError('denied', `${name} offers run({ prompt, system?, tier? }) for one model call`));

  if (args.length !== 1 || !isJsonObject(payload)) return Effect.fail(new KinuError('bad_input', `${name}.run takes one { prompt, system?, tier? } object`));

  const parsed = v.safeParse(v.strictObject({
    prompt: v.pipe(v.string(), v.minLength(1)),
    system: v.optional(v.string()),
    tier: v.optional(v.string()),
  }), payload);

  if (!parsed.success) return Effect.fail(new KinuError('bad_input', `${name}.run takes one { prompt, system?, tier? } object`));

  if (binding.tier !== undefined && parsed.output.tier !== undefined && parsed.output.tier !== binding.tier) {
    return Effect.fail(new KinuError('bad_input', `${name} pins tier ${binding.tier}; the call's tier cannot change it`));
  }

  const tier = binding.tier ?? parsed.output.tier;
  const prompt = parsed.output.prompt;
  const system = parsed.output.system;

  if (system !== undefined && tier !== undefined) return Effect.succeed({ kind: 'ai', prompt, system, tier });

  if (system !== undefined) return Effect.succeed({ kind: 'ai', prompt, system });

  if (tier !== undefined) return Effect.succeed({ kind: 'ai', prompt, tier });

  return Effect.succeed({ kind: 'ai', prompt });
}

function routeRpcCall(binding: Extract<SlateBinding, { kind: 'rpc' }>, request: SlateBindingRequest, ctx: BindingCallContext): Effect.Effect<SlateBindingRoute, KinuError> {
  const { name } = ctx;
  const { member, args } = request;

  const method = binding.methods.find((declared) => declared === member);

  if (method === undefined) return Effect.fail(new KinuError('denied', `${name} does not offer ${member}`));

  if (args.length !== 0) return Effect.fail(new KinuError('bad_input', `${name}.${member} is a read model and takes no arguments`));

  return Effect.succeed({ kind: 'rpc', method });
}

function routeMcpCall(binding: Extract<SlateBinding, { kind: 'mcp' }>, request: SlateBindingRequest, ctx: BindingCallContext): Effect.Effect<SlateBindingRoute, KinuError> {
  const { name } = ctx;
  const { member, args } = request;

  if (binding.tools !== undefined && !binding.tools.includes(member)) {
    return Effect.fail(new KinuError('denied', `${name} does not offer ${member} on ${binding.server}`));
  }

  const argumentsObject = args.length === 0 ? {} : args[0];

  if (args.length > 1 || !isJsonObject(argumentsObject)) return Effect.fail(new KinuError('bad_input', `${name}.${member} takes one JSON object of arguments`));

  return Effect.succeed({ kind: 'mcp', server: binding.server, tool: member, args: argumentsObject });
}

function routeAppCall(binding: Extract<SlateBinding, { kind: 'app' }>, request: SlateBindingRequest, ctx: BindingCallContext): Effect.Effect<SlateBindingRoute, KinuError> {
  const { id, name } = ctx;
  const { member, args } = request;

  if (!isSlateMethodName(member)) {
    return Effect.fail(new KinuError('bad_input', `"${member}" is not a method name the bridge forwards`));
  }

  // A repeated slate is a cycle; distinct slates are finite, so no hop bound is needed.
  const chain = [...ctx.chain, id];

  if (chain.includes(binding.id)) {
    return Effect.fail(new KinuError('denied',
      `${name}.${member} re-enters slate ${binding.id}, which is already running in this call chain: ${[...chain, binding.id].join(' -> ')}`));
  }

  return Effect.succeed({ kind: 'app', id: binding.id, method: member, args, chain });
}

interface SlateBindingCallInput {
  readonly id: string;
  readonly project: SlateProject;
  readonly name: string;
  readonly request: SlateBindingRequest;
  readonly chain: readonly string[];
}

export function routeSlateBindingCall(input: SlateBindingCallInput): SlateBindingRoute {
  return settleSync(slateBindingRoute(input));
}

function slateBindingRoute(input: SlateBindingCallInput): Effect.Effect<SlateBindingRoute, KinuError> {
  const { id, name, request } = input;
  const bindings = input.project.slate.bindings;
  const binding = Object.hasOwn(bindings, name) ? bindings[name] : undefined;

  if (binding === undefined) return Effect.fail(new KinuError('denied', `Slate ${id} no longer declares binding ${name}`));
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

export interface ViewerBindingCall {
  readonly route: SlateBindingRoute;
  readonly member: string;
  readonly effect: 'read' | 'mutate';
}

interface ViewerBindingCallInput extends SlateBindingCallInput {
  readonly viewer: SlateViewer;
  readonly grant: ShareGrant;
}

/** Ordinary route first (undeclared bindings refuse as for owners), then the grant check. */
export function routeViewerBindingCall(input: ViewerBindingCallInput): ViewerBindingCall {
  return settleSync(Effect.flatMap(slateBindingRoute(input), (route) => admitViewer(route, input)));
}

function admitViewer(route: SlateBindingRoute, input: ViewerBindingCallInput): Effect.Effect<ViewerBindingCall, KinuError> {
  const { id, name, grant } = input;

  const admitted = (member: string, effect: 'read' | 'mutate'): Effect.Effect<ViewerBindingCall, KinuError> => (
    grantAdmits(grant, id, name, member) === null
      ? Effect.fail(new KinuError('denied', `Slate ${id} does not grant ${name}.${member} to viewers`))
      : Effect.succeed({ route, member, effect })
  );

  switch (route.kind) {
    case 'namespace': return admitted(route.member, memberEffect('namespace', route.member));
    case 'codemode': return admitted(route.member, memberEffect(route.namespace, route.member));
    case 'tool': {
      const member = toolActionMember(route.name, route.input);

      return admitted(member, toolActionEffect(route.name, member));
    }

    case 'rpc': return admitted(route.method, 'read');
    case 'mcp': {
      const entry = grantAdmits(grant, id, name, route.tool);

      if (entry === null) return Effect.fail(new KinuError('denied', `Slate ${id} does not grant ${name}.${route.tool} to viewers`));

      return Effect.succeed({
        route: entry.effect === 'read' ? { ...route, readOnly: true } : route,
        member: route.tool,
        effect: entry.effect,
      });
    }

    case 'agent': return Effect.map(admitted('send', 'mutate'), (call) => ({ ...call, route: { ...route, viewer: input.viewer.subject } }));
    case 'ai': return admitted('shell', 'mutate');
    case 'app': {
      if (!grant.slates.includes(route.id)) {
        return Effect.fail(new KinuError('denied', `Slate ${id} does not grant ${name}.${route.method} to viewers`));
      }

      return Effect.succeed({
        route,
        member: route.method,
        effect: grant.members.some((member) => member.slate === route.id && member.effect === 'mutate') ? 'mutate' : 'read',
      });
    }
  }
}
