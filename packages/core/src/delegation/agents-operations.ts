/**
 * Delegation: a search over agents, a helper hired for a workstream, an existing agent given its next one, and
 * messages between agents. Each operation is offered only where its wiring is, and its fields reach `dispatchAgentsCall`
 * as its declaration admitted them.
 */
import * as v from 'valibot';
import { Cause, Effect } from 'effect';
import {
  agentsActionsFor, dispatchAgentsCall, nestingRoom, offered, verifierKinds, withheldBeta,
  type AgentsCall, type AgentsToolCallOptions, type AgentsToolDeps,
} from './agents-tool';
import { NAMED_SWARM_PRESETS, SWARM_PRESETS, SWARM_PRESET_DOCTRINE } from '../strategy/swarm';
import { SwarmConfigSchema, SwarmModelsSchema, SwarmNodeAssignmentsSchema, SwarmObjectiveSchema } from '../tools/swarm-input';
import { TierIdSchema } from '../profiles';
import { SUBORDINATE_LIFETIMES } from '../subordinates/temporary';
import { SWARM_CONTEXTS } from '../types/swarm';
import { MissionBudgetExhausted } from '../mission-budget';
import { endWhenSettled } from '../turn-trace';
import { diagnostics, KinuError, settle, type ScopedSpan } from '../obs/index';
import { JsonObjectSchema, JsonValueSchema, projectJsonValue, type JsonObject, type JsonValue } from '../utils/json';
import type { CodemodeProvider } from '../types/codemode';
import { defineOperation, opaque, serve, type OperationCall, type Served } from '../operations/operation';
import { codemodeNamespace, nativeTool } from '../tools/operation-surfaces';
import { BUILTIN_TOOL_DESCRIPTIONS } from '../tools/registry';
import { AGENTS_IMPACTS, type AgentsOp } from '../operations/agents';

const described = <S extends v.GenericSchema>(schema: S, text: string) => v.pipe(schema, v.description(text));

const text = (max: number, about: string) => described(v.pipe(v.string(), v.nonEmpty(), v.maxLength(max)), about);

const optional = <S extends v.GenericSchema>(schema: S) => v.optional(schema);

/** Fields join by wiring, so an operation's entries are assembled per wiring; its fields keep their types to its arm. */
const agentsOp = <const E extends v.ObjectEntries>(name: AgentsOp, help: string, plan: boolean, entries: E) =>
  defineOperation({ ns: 'agents', name, help, impact: AGENTS_IMPACTS[name], plan, slate: false, input: v.strictObject(entries), output: JsonValueSchema });

const ROLE = described(v.pipe(v.string(), v.maxLength(64)), 'A catalog role id; your step context lists the roles.');

/** A tier, which a `task` hire refuses where the wiring has one: a description never promises a lifetime the wiring
 *  has no port for. */
const tierField = (temporary: boolean) =>
  described(TierIdSchema, `An inference tier id your step context lists; default: the role's.${temporary ? ' A lifetime "task" hire refuses it.' : ''}`);

/** A search's fields. */
function swarmEntries(temporary: boolean) {
  return {
    task: text(20000, 'What the search is for, stated once for every node. The measured quantity goes in `objective`.'),
    preset: optional(described(v.picklist(SWARM_PRESETS), "The search's shape.")),
    objective: optional(described(opaque(SwarmObjectiveSchema, { type: 'object' }), 'What a verifier measures, which turns the judged sweep into a measured search. '
      + '{kind:"scalar", metric, unit, direction:"minimise"|"maximise", scale:"linear"|"log", target, verify:{kind, spec}}, optionally floor:{value, kind:"certificate", proof, best_known_honest}. '
      + `verify.kind is a registered instrument: ${verifierKinds()}. kind "instanced" (one metric over \`instances\`) and "vector" (several \`components\`) need advance:"pareto"; kind "witness" needs a scalar \`proxy\`.`)),
    key: optional(described(v.string(), 'With advance:"archive", where it is required: the quantity elites are binned by, one the objective\'s verifier reports.')),
    config: optional(described(opaque(SwarmConfigSchema, { type: 'object' }), 'With preset "custom" only: the axes unit, context, expand, score, advance and carry, overriding `from`\'s or all six without it.')),
    from: optional(described(v.picklist(NAMED_SWARM_PRESETS), 'With preset "custom": the named preset whose axes `config` overrides.')),
    label: optional(described(v.pipe(v.string(), v.maxLength(120)), 'With preset "custom", required: a name for the composed shape.')),
    name: optional(described(v.pipe(v.string(), v.maxLength(60)), 'A two-to-four-word name for the search; default: derived from `task`.')),
    branches: optional(described(v.pipe(v.number(), v.integer(), v.minValue(1)), 'Candidates per expansion; default the preset\'s. Not with `nodes`.')),
    depth: optional(described(v.pipe(v.number(), v.integer(), v.minValue(1)), 'Maximum tree depth; default the preset\'s.')),
    nodes: optional(described(SwarmNodeAssignmentsSchema, 'The first level, one entry per node; its length is the branch count. Not with `branches`.')),
    models: optional(described(SwarmModelsSchema, 'Model specs, node i runs models[i % length]. Route for capability or cost, not for variety. Not with `tier`.')),
    role: optional(described(ROLE, 'The role every node runs under; default yours.')),
    tier: optional(tierField(temporary)),
    budgetUsd: optional(described(v.pipe(v.number(), v.minValue(0)), 'USD cap on everything the search spawns; default none.')),
    budgetTokens: optional(described(v.pipe(v.number(), v.integer(), v.minValue(1)), 'Token cap, same scope as budgetUsd.')),
    budgetLabel: optional(described(v.pipe(v.string(), v.maxLength(120)), 'A ledger name, so several calls share one budget.')),
    };
}

/** The fields a stored search is re-driven with. */
const SWARM_FIELDS = new Set(Object.keys(swarmEntries(false)));

/**
 * The background-job resume filter and detach gate (orchestrator/background-tools.ts): a call that cannot be re-driven
 * must never be detached. Only a search resumes, re-driven through the native tool with its own fields; any other field
 * it carried is dropped and logged.
 */
export function resumableAgentsInput(kind: string, input: JsonValue): JsonObject | null {
  const row = v.safeParse(v.looseObject({ op: v.literal('swarm') }), input);

  if (kind !== 'agents' || !row.success) return null;
  const dropped = Object.keys(row.output).filter((field) => field !== 'op' && !SWARM_FIELDS.has(field));

  if (dropped.length > 0) diagnostics.event('agents.resume.fields_dropped', { kind, fields: dropped.join(','), count: dropped.length });

  return v.parse(JsonObjectSchema, Object.fromEntries(Object.entries(row.output).filter(([field]) => !dropped.includes(field))));
}

/** Each operation this wiring offers, its fields described for it and served straight to its arm of the dispatch.
 *  `deps` is read per call; the operation set is fixed when served. */
function serveAgents(deps: () => AgentsToolDeps): readonly Served[] {
  const wired = offered(deps());
  const { team, peers } = wired;
  const offers = new Set(agentsActionsFor(wired));
  const temporary = team?.temporary !== undefined;

  const targets = [
    ...(team ? ['a subordinate'] : []), ...(peers ? ['a peer workspace agent'] : []),
  ].join(' here or ') + (team && peers ? ' (a subordinate wins a name collision)' : '');

  const agent = described(v.pipe(v.string(), v.nonEmpty()), `The agent: ${targets}.`);
  const topic = optional(described(v.pipe(v.string(), v.maxLength(80)), 'A short label for a message to a peer workspace agent; default "message".'));
  const deliverable = optional(described(v.pipe(v.string(), v.maxLength(2000)), 'What the finished result is.'));
  const served: Served[] = [];

  const dispatched = async (call: AgentsCall, { trace, native, signal }: OperationCall): Promise<JsonValue> => {
    const options: AgentsToolCallOptions = { ...native, ...(signal !== undefined && { abortSignal: signal }), ...(trace !== undefined && { trace }) };
    const run = dispatchAgentsCall(deps(), call, options);

    if (trace === undefined || !DELEGATING.has(call.op)) return projectJsonValue({ value: await run });

    const timer = trace.begin('turn.delegation');
    const stamp = (span: ScopedSpan): void => { span.setAttribute('kinu.delegation.action', call.op); };

    return projectJsonValue({ value: await endWhenSettled(run, timer, {
      stamp,
      failed: (span) => { stamp(span); span.fail(new KinuError('io', 'the delegation failed')); },
    }) });
  };

  if (offers.has('swarm')) {
    served.push(serve(agentsOp('swarm', `Run a search over short-lived nodes of yourself in parallel over this workspace and return what they found, judged, or measured by your verifier when you give an objective. It takes minutes; on a live session it runs in the background and its result wakes you. ${SWARM_PRESET_DOCTRINE.join(' ')}`, true, swarmEntries(temporary)),
      (fields, call) => dispatched({ op: 'swarm', fields }, call)));
  }

  if (team && offers.has('hire')) {
    const hire = {
      role: ROLE,
      mission: text(20000, `The brief, run as the new agent's first turn${temporary ? '; for lifetime "task", the whole question' : ''}.`),
      name: optional(described(v.string(), 'A name for the new agent.')),
      tier: optional(tierField(temporary)),
      context: optional(described(v.picklist(SWARM_CONTEXTS), 'fresh (default) starts from the mission and a digest of your recent messages; inherit also carries your recent turns.')),
    };

    const help = `Create a helper under a role for one workstream; its mission is its first turn. It returns at once; the helper's report, or its failure, arrives later as a message that opens your next turn. It stays in your roster, with its context, after it reports. ${nestingRoom(team.delegation)}`;
    const lifetime = optional(described(v.picklist(SUBORDINATE_LIFETIMES), 'durable (default) stays in your roster; task answers one question, as a later message, and is archived.'));

    served.push(temporary
      ? serve(agentsOp('hire', help, true, { ...hire, lifetime }), (fields, call) => dispatched({ op: 'hire', fields }, call))
      : serve(agentsOp('hire', help, true, hire), (fields, call) => dispatched({ op: 'hire', fields }, call)));
  }

  if (offers.has('assign')) {
    const help = 'Hand an existing agent its next workstream; a subordinate reports later as a message, a peer\'s reply is awaited.';
    const assign = { agent, message: text(20000, 'The work.') };
    const run = (fields: AgentsCallFields<'assign'>, call: OperationCall) => dispatched({ op: 'assign', fields }, call);

    // A deliverable is a subordinate's to meet; a topic labels a peer's message.
    if (team && peers) served.push(serve(agentsOp('assign', help, true, { ...assign, deliverable, topic }), run));
    else if (team) served.push(serve(agentsOp('assign', help, true, { ...assign, deliverable }), run));
    else served.push(serve(agentsOp('assign', help, true, { ...assign, topic }), run));
  }

  if (offers.has('hireWorkspace')) {
    served.push(serve(agentsOp('hireWorkspace', 'Create or reuse a specialist workspace, send it its first task and wait for the result.', true, {
      mission: text(20000, 'What the workspace is for.'),
      message: text(20000, 'Its first task.'),
      agent: optional(described(v.string(), 'The workspace agent\'s name.')),
    }), (fields, call) => dispatched({ op: 'hireWorkspace', fields }, call)));
  }

  if (offers.has('message')) {
    const help = 'Message an agent without handing it a workstream.';
    const message = { agent, message: text(20000, 'What you say.') };
    const run = (fields: AgentsCallFields<'message'>, call: OperationCall) => dispatched({ op: 'message', fields }, call);

    served.push(peers ? serve(agentsOp('message', help, true, { ...message, topic }), run) : serve(agentsOp('message', help, true, message), run));
  }

  if (offers.has('reply')) {
    served.push(serve(agentsOp('reply', 'Answer an incoming agent message.', true, {
      eventId: described(v.pipe(v.string(), v.nonEmpty()), 'The incoming agent message you are answering.'),
      message: text(20000, 'Your answer.'),
    }), (fields, call) => dispatched({ op: 'reply', fields }, call)));
  }

  if (offers.has('list')) {
    const listed = [...(team ? ['your subordinates'] : []), ...(peers ? ['peer workspace agents'] : []), ...(temporary ? ['the task-lifetime agents running now'] : [])];

    served.push(serve(agentsOp('list', `The roster: ${listed.join(', ')}.`, true, {
      agent: optional(described(v.string(), 'Only this agent.')),
    }), (fields, call) => dispatched({ op: 'list', fields }, call)));
  }

  if (offers.has('dismiss')) {
    served.push(serve(agentsOp('dismiss', 'Retire a subordinate; archived with its context by default.', false, {
      agent: described(v.pipe(v.string(), v.nonEmpty()), 'The subordinate.'),
      keepHistory: optional(described(v.boolean(), 'false deletes its storage for good; default true.')),
    }), (fields, call) => dispatched({ op: 'dismiss', fields }, call)));
  }

  return served;
}

/** The fields of one operation's call, as the dispatch takes them. */
type AgentsCallFields<Op extends AgentsOp> = Extract<AgentsCall, { readonly op: Op }>['fields'];

const DELEGATING: ReadonlySet<AgentsOp> = new Set(['swarm', 'hire', 'assign', 'hireWorkspace', 'message', 'reply']);

/**
 * The native `agents` tool: each operation it offers is described with it, so it promises only what is wired. A swarm
 * the account's beta withholds is not offered, and a call to it is refused naming the setting.
 */
export function createAgentsTool(deps: AgentsToolDeps) {
  const beta = withheldBeta(deps, 'swarm');

  return nativeTool(BUILTIN_TOOL_DESCRIPTIONS.agents, serveAgents(() => deps), beta === null ? new Map() : new Map([['swarm', beta]]));
}

/**
 * `agents.*` for programs. The trusted work mode is the one the provider was built under: eval may outlive its turn.
 * A spent mission budget is the call's value, for the program to branch on.
 */
export function createAgentsCodemodeProvider(deps: () => AgentsToolDeps): CodemodeProvider {
  const { mode } = deps();

  return codemodeNamespace('agents', serveAgents(() => ({ ...deps(), mode })).map((served) => ({
    ...served,
    run: async (input, call) => await settle(Effect.catchCause(Effect.promise(() => served.run(input, call)), (failed) => {
      const cause = Cause.squash(failed);

      return cause instanceof MissionBudgetExhausted ? Effect.succeed({ value: projectJsonValue({ value: cause.refusal }) }) : Effect.failCause(failed);
    })),
  })));
}
