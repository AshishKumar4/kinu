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
 * `agents` tool holds, so fork depth, budgets, roster addressing and the sole
 * sub-agent path are shared, not mirrored. Which members exist is decided by
 * `agentsActionsFor(deps)` — the identical structural gate the tool's action
 * enum and the prompt's Delegation ladder read. An actor with no team deps has
 * no `agents.staff` in its sandbox because the member is never created.
 *
 * Deliberately NOT projected: the workspace-clone `forkAgent` RPC (fork the
 * whole agent DO at a message — the UI's fork-chat). It rejects while a turn is
 * in flight and cloning the actor mid-script is not delegation.
 *
 * One honest limitation, stated in the fork docstring the model reads: a fork
 * started in here rides the enclosing `execute_tools` call, and that job kind
 * declines background resume (side effects can't be re-run). Quick orchestration
 * belongs in the sandbox; one long expensive search that must survive an
 * eviction belongs at the top-level tool, which resumes from its MCTS
 * checkpoint.
 */

import { readExecSignal } from '../execution/signal.js';
import * as v from 'valibot';
import type { CodemodeProvider } from '../rlm.js';
import { TOOL_REACH, type AgentsToolAction } from './registry.js';
import { isJsonObject, JsonValueSchema, type JsonObject } from '../utils/json.js';
import {
  agentsActionsFor,
  dispatchAgentsAction,
  parseAgentsToolInput,
  type AgentsToolDeps,
} from './agents-tool.js';

/**
 * The sandbox-visible declaration of each action, one block per member.
 *
 * Gating is per ACTION, not per field: the only deps shapes any backend wires
 * are `{fork}` (subordinates, CLI local sessions, forks-of-forks) and
 * `{fork, team, peers}` (the workspace orchestrator), so a field that would
 * need finer gating cannot occur. If one ever did, `dispatchAgentsAction`
 * already answers it with a sharp error naming the missing transport.
 *
 * Because these are literals rather than deps-derived text, the same action set
 * renders byte-identically on every backend — the sandbox contract does not
 * change shape depending on where the agent happens to be running.
 */
const AGENTS_CODEMODE_MEMBERS = {
  fork: `  /** Spawn 2-6 ephemeral forks of yourself on this same workspace and settle
   *  them into one answer. The settle decides what the call takes and what a
   *  fork IS, so the two are not interchangeable:
   *    merge (default) runs the briefs in \`forks\` — required — each as a real
   *      agent with its own multi-step tool loop (execute_tools/run/file/web,
   *      narrowed by its own allowedTools) over this workspace, then merges
   *      what they found.
   *    settle:"mcts" reads \`task\` alone and writes its own competing
   *      approaches; a branch is a single proposal with no tool loop of its
   *      own, scored against its rivals by execution. Passing \`forks\` here is
   *      REFUSED rather than ignored — nothing would run them.
   *  NOT resumable from here: a fork started inside execute_tools rides this
   *  sandbox call, and execute_tools declines background resume because its
   *  side effects cannot be safely re-run. Script quick fan-out here; call the
   *  top-level \`agents\` tool for one long search that must survive an
   *  eviction, which resumes from its search checkpoint. */
  fork(input: {
    task: string;
    forks?: Array<{ task: string; rationale: string; model?: string; allowedTools?: string[] }>;
    settle?: "merge" | "mcts";
    merge_strategy?: "synthesize" | "best_of" | "consensus";
    budget?: number;
    wall_clock_ms?: number;
    options?: object;
    /** Cumulative host-enforced spend cap for this fork and everything it
     *  spawns, nested under whatever mission this run already spends against.
     *  Omit for no cap. Name it with budget_label to share one cumulative
     *  ledger across several fork calls in the same script. */
    budget_usd?: number;
    budget_tokens?: number;
    budget_label?: string;
  }): Promise<{ strategy: string; text: string; score: number; trace: unknown; cost: unknown; mission_budget?: unknown } | { error: string; reason?: "bad_input" }>;`,

  staff: `  /** Create a persistent named helper that keeps its own context across turns.
   *  Default scope:"subordinate" staffs THIS workspace (role + mission
   *  required); scope:"workspace" creates a specialist workspace of its own,
   *  sends it \`message\`, and awaits the result. */
  staff(input: {
    role?: string;
    mission: string;
    agent?: string;
    model?: string;
    scope?: "subordinate" | "workspace";
    message?: string;
    timeout_seconds?: number;
  }): Promise<unknown>;`,

  ask: `  /** Hand an agent work and expect the answer back. A subordinate's report
   *  arrives later as an event that wakes you — it does NOT resolve here; a
   *  peer workspace agent's reply is awaited up to timeout_seconds. */
  ask(input: {
    agent: string;
    message: string;
    deliverable?: string;
    deadline_hint?: string;
    topic?: string;
    timeout_seconds?: number;
  }): Promise<unknown>;`,

  send: `  /** Fire-and-forget message to any agent by name (no reply awaited). */
  send(input: { agent: string; message: string; topic?: string }): Promise<unknown>;`,

  reply: `  /** Answer an incoming agent message event by the event_id you were given. */
  reply(input: { event_id: string; message: string }): Promise<unknown>;`,

  list: `  /** The unified roster: subordinates here plus the owner's other workspace
   *  agents. Pass \`agent\` for one subordinate's live status instead. */
  list(input?: { agent?: string }): Promise<unknown>;`,

  dismiss: `  /** Retire a subordinate. Archived by default (its context is kept); pass
   *  keep_history:false ONLY to permanently wipe its storage. */
  dismiss(input: { agent: string; keep_history?: boolean }): Promise<unknown>;`,
} satisfies Record<AgentsToolAction, string>;

/** One-line member descriptions for the provider record. */
const AGENTS_CODEMODE_DESCRIPTIONS = {
  fork: 'Spawn 2-6 ephemeral forks of yourself that settle into one answer (merge, or settle:"mcts"). Not resumable from inside the sandbox.',
  staff: 'Create a persistent named helper: a subordinate here, or scope:"workspace" for a specialist workspace of its own.',
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
    ...actions.map((action) => AGENTS_CODEMODE_MEMBERS[action]),
    '};',
    '',
  ].join('\n');
}

/**
 * Build the codemode provider that exposes `agents.*` to the sandbox.
 *
 * `deps` is a thunk, read per call: the fork substrate binds the actor's
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
        const raw = args[0];
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
          return { error: `agents.${action}: ${error instanceof Error ? error.message : String(error)}` };
        }
        // Cancellation rides the trailing exec-context arg the node sandbox
        // appends; the cf loader passes only the model's own arguments.
        const signal = readExecSignal({ context: args[1] });
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
