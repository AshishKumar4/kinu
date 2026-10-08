/**
 * A slate's one surface, `workspace`: its actor's eval namespaces, each call run as the slate's caller. The host routes
 * every call here, so what a slate never reaches, what a call changes and what a share's grant admits are decided once.
 */
import * as v from 'valibot';
import { isJsonObject, JsonValueSchema, type JsonObject, type JsonValue } from '../utils/json';
import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settleSync } from '../obs/effect';
import { isSlateMethodName } from './rpc';
import { SLATE_READ_MODELS, type SlateReadModel } from './read-models';
import { grantAdmits } from './capability-graph';
import { AI_RUN_MEMBER, slateAddressImpact } from './members';
import type { Impact } from '@agent-core/core/facets';
import type { ShareGrant } from './sharing';

/** The executor a program reaches as `workspace`; a one-name path is its member, as `workspace.readFile` is in a program. */
const WORKSPACE_EXECUTOR = 'workspace';

/**
 * What only the agent does, never a page it shows: delegating, steering itself, reporting, making tools and changing
 * slates. Matched on `namespace.member`, `*` for either half; a member the impact table keeps from slates is refused too.
 */
const SLATE_EXCLUDED = ['agents.*', 'agent.*', 'report.*', '*.createTool', '*.slate', '*.slates'] as const;

export const SlateCallRequestSchema = v.strictObject({
  /** `[member]` of the workspace executor, `[namespace, member]`, or `[namespace, name, member]` under `mcp` and `slates`. */
  path: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1), v.maxLength(3)),
  args: v.array(JsonValueSchema),
  /**
   * Host-issued invocation id; the chain comes from {@link issuedSlateInvocation}, never off the wire.
   * `null` only for the actor's own direct call.
   */
  invocation: v.nullable(v.pipe(v.string(), v.minLength(1))),
});

export type SlateCallRequest = v.InferOutput<typeof SlateCallRequestSchema>;

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

export type SlateRoute =
  | { readonly kind: 'namespace'; readonly namespace: string; readonly member: string; readonly args: readonly JsonValue[] }
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

/** What a call names: a share's grant and a slate's recorded reach are kept by it. */
export interface SlateAddress {
  readonly namespace: string;
  readonly member: string;
}

export interface SlateCall {
  readonly route: SlateRoute;
  readonly address: SlateAddress;
  readonly impact: Impact;
}

const patternMatches = (pattern: string, value: string): boolean => pattern === '*' || pattern === value;

function slateExcludes(address: SlateAddress): boolean {
  return SLATE_EXCLUDED.some((entry) => {
    const [namespace, member] = entry.split('.');

    return patternMatches(namespace, address.namespace) && patternMatches(member, address.member);
  });
}

/** Whether a slate reaches an eval namespace's member: the impact table names it, and it is not the agent's alone. */
export function slateReaches(address: SlateAddress): boolean {
  return slateAddressImpact(address) !== null && !slateExcludes(address);
}

function oneObject(said: string, args: readonly JsonValue[]): Effect.Effect<JsonObject, KinuError> {
  const argument = args.length === 0 ? {} : args[0];

  if (args.length > 1 || !isJsonObject(argument)) return Effect.fail(new KinuError('bad_input', `${said} takes one JSON object of arguments`));

  return Effect.succeed(argument);
}

function routeAgent(id: string, args: readonly JsonValue[]): Effect.Effect<SlateRoute, KinuError> {
  const parsed = v.safeParse(v.strictTuple([v.strictObject({ text: v.pipe(v.string(), v.minLength(1)), data: v.optional(JsonValueSchema) })]), args);

  if (!parsed.success) return Effect.fail(new KinuError('bad_input', 'agent.send takes one { text, data? } object'));
  const [{ text, data }] = parsed.output;

  return Effect.succeed(data === undefined ? { kind: 'agent', slate: id, text } : { kind: 'agent', slate: id, text, data });
}

function routeAi(args: readonly JsonValue[]): Effect.Effect<SlateRoute, KinuError> {
  const parsed = v.safeParse(v.strictTuple([v.strictObject({
    prompt: v.pipe(v.string(), v.minLength(1)),
    system: v.optional(v.string()),
    tier: v.optional(v.string()),
  })]), args);

  if (!parsed.success) return Effect.fail(new KinuError('bad_input', 'ai.run takes one { prompt, system?, tier? } object'));
  const [{ prompt, system, tier }] = parsed.output;

  return Effect.succeed({ kind: 'ai', prompt, ...(system !== undefined && { system }), ...(tier !== undefined && { tier }) });
}

function routeRead(member: string, args: readonly JsonValue[]): Effect.Effect<SlateRoute, KinuError> {
  const method = SLATE_READ_MODELS.find((model) => model === member);

  if (method === undefined) return Effect.fail(new KinuError('missing', `reads has no ${member}; it offers ${SLATE_READ_MODELS.join(', ')}`));

  if (args.length !== 0) return Effect.fail(new KinuError('bad_input', `reads.${member} is a read model and takes no arguments`));

  return Effect.succeed({ kind: 'rpc', method });
}

function routeApp(input: { readonly id: string; readonly callee: string; readonly method: string; readonly args: readonly JsonValue[]; readonly chain: readonly string[] }): Effect.Effect<SlateRoute, KinuError> {
  const { id, callee, method, args } = input;

  if (!isSlateMethodName(method)) return Effect.fail(new KinuError('bad_input', `"${method}" is not a method name the bridge forwards`));
  // A repeated slate is a cycle; distinct slates are finite, so no hop bound is needed.
  const chain = [...input.chain, id];

  if (chain.includes(callee)) {
    return Effect.fail(new KinuError('denied',
      `slates.${callee}.${method} re-enters slate ${callee}, which is already running in this call chain: ${[...chain, callee].join(' -> ')}`));
  }

  return Effect.succeed({ kind: 'app', id: callee, method, args, chain });
}

/** The parts of a path past its namespace, which must be exactly `count` long. */
function rest(namespace: string, names: readonly string[], count: number): Effect.Effect<readonly string[], KinuError> {
  if (names.length === count) return Effect.succeed(names);

  const form = count === 1 ? `${namespace}.<member>` : `${namespace}.<name>.<member>`;

  return Effect.fail(new KinuError('bad_input', `workspace.${[namespace, ...names].join('.')} is not a call; this namespace is called as workspace.${form}`));
}

/** What a path names: its last name is the member, the rest its namespace. */
export function slateCallAddress(path: readonly string[]): SlateAddress {
  const named = path.length === 1 ? [WORKSPACE_EXECUTOR, ...path] : path;

  return { namespace: named.slice(0, -1).join('.'), member: named.at(-1) ?? '' };
}

/** The route a path names, before what it reaches is checked. */
function route(id: string, request: SlateCallRequest, chain: readonly string[]): Effect.Effect<SlateRoute, KinuError> {
  const [namespace, ...names] = request.path.length === 1 ? [WORKSPACE_EXECUTOR, ...request.path] : request.path;
  const { args } = request;

  return Effect.flatMap(rest(namespace, names, namespace === 'mcp' || namespace === 'slates' ? 2 : 1), ([first, second]): Effect.Effect<SlateRoute, KinuError> => {
    switch (namespace) {
      case 'slates': return routeApp({ id, callee: first, method: second, args, chain });
      case 'mcp': return Effect.map(oneObject(`mcp.${first}.${second}`, args), (input) => ({ kind: 'mcp', server: first, tool: second, args: input }));
      case 'tools': return Effect.map(oneObject(`tools.${first}`, args), (input) => ({ kind: 'tool', name: first, input }));
      case 'reads': return routeRead(first, args);
      default: break;
    }

    if (namespace === 'agent' && first === 'send') return routeAgent(id, args);

    if (namespace === 'ai' && first === AI_RUN_MEMBER) return routeAi(args);

    return Effect.succeed({ kind: 'namespace', namespace, member: first, args });
  });
}

function routed(id: string, request: SlateCallRequest, chain: readonly string[]): Effect.Effect<SlateCall, KinuError> {
  const address = slateCallAddress(request.path);
  const impact = slateAddressImpact(address);
  const refused = new KinuError('denied', `${address.namespace}.${address.member} is not on a slate's surface: what only the agent does, or no member at all`);

  if (impact === null) return Effect.fail(refused);

  // The list names eval namespaces; `agent.send` and the rest of the surface's own are routed above it.
  return Effect.flatMap(route(id, request, chain), (found) => (found.kind === 'namespace' && !slateReaches(address)
    ? Effect.fail(refused)
    : Effect.succeed({ route: found, address, impact })));
}

interface SlateCallInput {
  readonly id: string;
  readonly request: SlateCallRequest;
  readonly chain: readonly string[];
}

export function routeSlateCall(input: SlateCallInput): SlateCall {
  return settleSync(routed(input.id, input.request, input.chain));
}

interface ViewerCallInput extends SlateCallInput {
  readonly viewer: SlateViewer;
  readonly grant: ShareGrant;
}

/** Routed as the owner's call is, then held to the grant: a read grant admits only what reads. */
export function routeViewerCall(input: ViewerCallInput): SlateCall {
  return settleSync(Effect.flatMap(routed(input.id, input.request, input.chain), (call) => admitViewer(call, input)));
}

function admitViewer(call: SlateCall, input: ViewerCallInput): Effect.Effect<SlateCall, KinuError> {
  const { id, grant } = input;
  const { route: found, address } = call;
  const refused = new KinuError('denied', `Slate ${id} does not grant ${address.namespace}.${address.member} to viewers`);

  if (found.kind === 'app') return grant.slates.includes(found.id) ? Effect.succeed(call) : Effect.fail(refused);
  const entry = grantAdmits(grant, id, address.namespace, address.member);

  if (entry === null) return Effect.fail(refused);

  // Granted as observing because its server marks it read-only; the actor holds the call to that.
  if (found.kind === 'mcp') return Effect.succeed(entry.impact === 'observe' ? { ...call, route: { ...found, readOnly: true }, impact: 'observe' } : call);

  if (found.kind === 'agent') return Effect.succeed({ ...call, route: { ...found, viewer: input.viewer.subject } });

  return entry.impact === call.impact ? Effect.succeed(call) : Effect.fail(refused);
}
