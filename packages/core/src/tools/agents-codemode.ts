/**
 * `agents.*` — the delegation tool, projected into the codemode sandbox.
 *
 * This is the bridge that makes a WORKFLOW an ordinary crafted tool: LLM-authored
 * JS inside `execute_tools` already reaches `llm.*`, `workspace.*`, `web.*` and
 * `codemode.*`, so once it can also delegate, a deterministic script over
 * nondeterministic agent calls is just code — savable via `workspace.createTool`,
 * callable as `codemode.<name>()`, schedulable via `agent.schedule`, EMA-scored
 * and shareable like every other craft. No workflow DSL, graph engine, step store
 * or scheduler is needed, because each of those already exists here under a
 * different name.
 *
 * It is a PROJECTION, not a second implementation: every member funnels into
 * `dispatchAgentsAction` over the very same `AgentsToolDeps` the top-level
 * `agents` tool holds, so delegation depth, budgets, roster addressing and the
 * sole sub-agent path are shared, not mirrored. Which members exist is decided by
 * `agentsActionsFor(deps)` — the identical structural gate the tool's action
 * enum and the prompt's Delegation ladder read. An actor with no team deps has
 * no `agents.hire` in its sandbox because the member is never created.
 *
 * Deliberately NOT projected: the workspace-clone `forkAgent` RPC (clone the
 * whole agent DO at a message — the UI's fork-chat, a workspace operation and
 * not a delegation). It rejects while a turn is in flight and cloning the actor
 * mid-script is not delegation either.
 *
 * One honest limitation, stated in the swarm docstring the model reads: a search
 * started in here rides the enclosing `execute_tools` call, and that job kind
 * declines background resume (side effects can't be re-run). Quick orchestration
 * belongs in the sandbox; one long expensive search that must survive an
 * eviction belongs at the top-level tool, which resumes from its search
 * checkpoint.
 */

import { readExecSignal } from '../execution/signal';
import * as v from 'valibot';
import type { CodemodeProvider } from '../rlm';
import { TOOL_REACH, type AgentsToolAction } from './registry';
// Beside the preset table it is rendered from, not beside the other doctrine: the
// sandbox declaration and the native schema must show the same presets, and they can
// only be the same if both read the rows.
import { SWARM_PRESET_DOCTRINE } from '../strategy/swarm';
import { isJsonObject, JsonValueSchema, type JsonObject } from '../utils/json';
import {
  agentsActionsFor,
  dispatchAgentsAction,
  parseAgentsToolInput,
  AGENTS_ACTION_FIELDS, AGENTS_ACTION_REQUIRED_FIELDS, AGENTS_FIELD_TS_TYPES,
  type AgentsToolDeps,
} from './agents-tool';

import { renderThrownChain } from '../obs/index';
/**
 * The sandbox-visible declaration of each action, one block per member.
 *
 * Gating is per ACTION, not per field: the only deps shapes any backend wires
 * are `{fork}` (subordinates, CLI local sessions, nodes) and `{fork, team,
 * peers}` (the workspace orchestrator), so a field that would need finer gating
 * cannot occur. If one ever did, `dispatchAgentsAction` already answers it with
 * a sharp error naming the missing transport.
 *
 * Because these are literals rather than deps-derived text, the same action set
 * renders byte-identically on every backend — the sandbox contract does not
 * change shape depending on where the agent happens to be running.
 */
const AGENTS_CODEMODE_MEMBER_DOCS = {
  swarm: `  /** Run a configured search whose candidates are MEASURED rather than judged.
   *  You name the shape with \`preset\` and what counts with \`objective\`, and
   *  every candidate is scored by your own verifier running in this workspace.
${SWARM_PRESET_DOCTRINE.map((line) => `   *    ${line}`).join('\n')}
   *  \`role\` puts every node under one catalog role (omit for your own active
   *  role — a swarm is role-homogeneous, never mixed); \`tier\` picks the
   *  inference tier when the role's default is not what you want. A search
   *  without \`preset\` takes your role's default preset.
   *  \`verify\` names a REGISTERED instrument and carries its whole spec: a
   *  script path invented here does not resolve and the call is refused, which
   *  is the one guard that makes a measured number worth anything. A \`floor\`
   *  is a PROOF — a candidate measuring past it comes back as a breach with the
   *  measurement kept and no score, because the bound may be what is wrong.
   *  It refuses rather than approximates: an illegal composition names the axis
   *  to change, and a shape no engine here runs faithfully says so instead of
   *  returning a number from a different mechanism.
   *  NOT resumable from here: a search started inside execute_tools rides this
   *  sandbox call, and execute_tools declines background resume because its
   *  side effects cannot be safely re-run. Script quick fan-out here; call the
   *  top-level \`agents\` tool for one long search that must survive an
   *  eviction, which resumes from its search checkpoint. */`,
  hire: `  /** Create a persistent named helper that keeps its own context across turns.
   *  It starts FRESH — it did not see this conversation — so the mission is its
   *  whole brief. \`role\` is a catalog role id (the ids are listed on the
   *  native agents tool's role fields); \`tier\` optionally overrides that
   *  role's default inference tier. Default scope:"subordinate" hires into
   *  THIS workspace; scope:"workspace" creates a specialist workspace of its
   *  own, sends it \`message\`, and awaits the result. */`,
  ask: `  /** Hand an agent work and expect the answer back. A subordinate's report
   *  arrives later as an event that wakes you — it does NOT resolve here; a
   *  peer workspace agent's reply is awaited until it arrives, however long
   *  the peer's work takes. */`,
  send: `  /** Fire-and-forget message to any agent by name (no reply awaited). */`,
  reply: `  /** Answer an incoming agent message event by the event_id you were given. */`,
  list: `  /** The unified roster: subordinates here plus the owner's other workspace
   *  agents. Pass \`agent\` for one subordinate's live status instead. */`,
  dismiss: `  /** Retire a subordinate. Archived by default (its context is kept); pass
   *  keep_history:false ONLY to permanently wipe its storage. */`,
} satisfies Record<AgentsToolAction, string>;

/** Per-member return annotations. `unknown` where the caller only reads it
 *  incidentally; the swarm union is spelled out because scripts branch on it. */
const AGENTS_CODEMODE_RETURNS = {
  swarm: 'Promise<{ preset: string; config: unknown; caps: unknown; report: unknown; publication: unknown; best: unknown; candidates: unknown[] } | { reason: string; error: string }>',
  hire: 'Promise<unknown>',
  ask: 'Promise<unknown>',
  send: 'Promise<unknown>',
  reply: 'Promise<unknown>',
  list: 'Promise<unknown>',
  dismiss: 'Promise<unknown>',
} satisfies Record<AgentsToolAction, string>;

/** Render ONE action's sandbox input object from {@link AGENTS_ACTION_FIELDS}
 *  — the same lists the tool schema and the parse read. Field order, names,
 *  optionality and types all come from that single source plus the two tables
 *  beside it, so the sandbox contract cannot drift from the surface it mirrors
 *  (this rendering is exactly where a hand-written copy once lost the swarm's
 *  `name` field). */
function renderInputType(action: AgentsToolAction): string {
  const required: Record<string, true> = {};
  for (const field of AGENTS_ACTION_REQUIRED_FIELDS[action]) required[field] = true;
  const fields = AGENTS_ACTION_FIELDS[action]
    .map((field) => `    ${field}${required[field] ? '' : '?'}: ${AGENTS_FIELD_TS_TYPES[field]};`)
    .join('\n');
  return `${AGENTS_CODEMODE_MEMBER_DOCS[action]}
  ${action}(input: {
${fields}
  }): ${AGENTS_CODEMODE_RETURNS[action]};`;
}

/** One-line member descriptions for the provider record. */
const AGENTS_CODEMODE_DESCRIPTIONS = {
  swarm: 'Run a configured search over ephemeral nodes of yourself whose candidates are measured by your own verifier rather than judged: name the shape with preset and what counts with objective. Refuses an illegal composition by naming the axis, and a shape no engine runs faithfully rather than substituting one. Not resumable from inside the sandbox.',
  hire: 'Create a persistent named helper that starts with a blank context: a subordinate here, or scope:"workspace" for a specialist workspace of its own.',
  ask: 'Hand an agent work and expect the answer back (a subordinate reports later as an event; a peer reply is awaited).',
  send: 'Fire-and-forget message to any agent by name.',
  reply: 'Answer an incoming agent message event by its event_id.',
  list: 'The unified roster of subordinates and peer workspace agents.',
  dismiss: 'Retire a subordinate (archived by default — its context is kept).',
} satisfies Record<AgentsToolAction, string>;

/** The `agents` namespace declaration for one actor's actions. Ordering comes
 *  from `agentsActionsFor`, which walks the canonical ladder. */
function renderTypes(actions: readonly AgentsToolAction[]): string {
  return [
    'export declare const agents: {',
    ...actions.map(renderInputType),
    '};',
    '',
  ].join('\n');
}

/**
 * Build the codemode provider that exposes `agents.*` to the sandbox.
 *
 * `deps` is a thunk, read per call: the exploration substrate binds the actor's
 * CURRENT model and MCTS session, and the provider outlives them (it is built
 * once with the sandbox tool). Its ACTION set is read once, at construction,
 * because which transports an actor wires is structural and fixed for its
 * lifetime — the same thing that decides its tool schema.
 *
 * At least one deps group must be present; callers gate on that, exactly as
 * they do for `createAgentsTool`.
 */
export function createAgentsCodemodeProvider(deps: () => AgentsToolDeps): CodemodeProvider {
  const initialDeps = deps();
  const actions = agentsActionsFor(initialDeps);
  // A provider belongs to one Plan/Build tool surface. Other dependencies may
  // refresh between calls, but the trusted mode must not: execute_tools may
  // keep running after its originating turn has detached.
  const mode = initialDeps.mode;
  const tools: CodemodeProvider['tools'] = {};

  for (const action of actions) {
    tools[action] = {
      description: AGENTS_CODEMODE_DESCRIPTIONS[action],
      execute: async (...args: unknown[]) => {
        // The node sandbox appends its exec context as a trailing argument, so a
        // member called with no options of its own arrives as `list({ signal })`.
        // That object is the HOST's, never a field the script wrote: it is found
        // by the signal it carries and taken out of the input, because an
        // injected field refused as unknown would refuse the call the script
        // actually made. Reading it positionally (`args[1]`) also lost
        // cancellation for every zero-argument call.
        let context: unknown;
        for (const arg of args) {
          if (readExecSignal({ context: arg }) !== undefined) context = arg;
        }
        const raw = args[0] === context ? undefined : args[0];
        const parsedRaw = raw === undefined ? undefined : v.safeParse(JsonValueSchema, raw);
        if (parsedRaw && (!parsedRaw.success || !isJsonObject(parsedRaw.output))) {
          return { error: `agents.${action}: expects a single options object` };
        }
        // `action` is written last: the member the script called decides it,
        // never a field in the object the script passed.
        const candidate: JsonObject = {};
        if (parsedRaw?.success) Object.assign(candidate, parsedRaw.output);
        Object.assign(candidate, { action });
        let input;
        try {
          input = parseAgentsToolInput(candidate);
        } catch (error) {
          return { error: `agents.${action}: ${renderThrownChain({ cause: error })}` };
        }
        const signal = readExecSignal({ context });
        return dispatchAgentsAction({ ...deps(), mode }, input, signal ? { abortSignal: signal } : undefined);
      },
    };
  }

  return {
    // The namespace name is the registry's declared reach for this capability,
    // not a literal here: TOOL_REACH is what says `agents` is reachable in the
    // sandbox at all, so a declaration that took that away would fail to
    // compile rather than leave this provider advertising a dead namespace.
    name: TOOL_REACH.agents.codemode,
    types: renderTypes(actions),
    tools,
    positionalArgs: true,
  };
}
