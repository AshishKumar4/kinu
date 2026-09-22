/**
 * `agents.*` in the codemode sandbox: a projection of `dispatchAgentsAction` over the same
 * `AgentsToolDeps`, gated by `agentsActionsFor(deps)`. The workspace-clone `forkAgent` RPC
 * is not projected. A search started here rides the enclosing `eval` job, which declines
 * background resume.
 */

import { readExecSignal } from '../execution/signal';
import { branchableToolCall } from '../tools/outcome';
import { MissionBudgetExhausted } from '../mission-budget';
import { projectJsonValue } from '../utils/json';
import * as v from 'valibot';
import type { CodemodeProvider } from '../tools/sandbox-contract';
import { TOOL_REACH, type AgentsToolAction } from '../tools/registry';
// The sandbox declaration and native schema must render presets from the same rows.
import { SWARM_PRESET_DOCTRINE } from '../strategy/swarm';
import { isJsonObject, JsonValueSchema, type JsonObject } from '../utils/json';
import {
  agentsActionInputVariantsFor,
  agentsActionsFor,
  dispatchAgentsAction,
  parseAgentsToolInput,
  AGENTS_FIELD_TS_TYPES,
  type AgentsActionInputVariant,
  type AgentsToolDeps,
} from './agents-tool';

import { renderThrownChain } from '../obs/index';

/** Sandbox declaration per action. Literals, so every backend renders the same contract. */
const AGENTS_CODEMODE_MEMBER_DOCS = {
  swarm: `  /** Run a configured search whose candidates are MEASURED rather than judged.
   *  You name the shape with \`preset\` and what counts with \`objective\`, and
   *  every candidate is scored by your own verifier running in this workspace.
${SWARM_PRESET_DOCTRINE.map((line) => `   *    ${line}`).join('\n')}
   *  \`role\` puts every node under one catalog role (omit for your own active
   *  role — a swarm is role-homogeneous, never mixed); \`tier\` picks the
   *  inference tier when the role's default is not what you want, and
   *  \`models\` routes each node to its own model spec round-robin by slot —
   *  one or the other, never both. A search without \`preset\` takes your
   *  role's default preset.
   *  \`verify\` names a REGISTERED instrument and carries its whole spec: a
   *  script path invented here does not resolve and the call is refused, which
   *  is the one guard that makes a measured number worth anything. A \`floor\`
   *  is a PROOF — a candidate measuring past it comes back as a breach with the
   *  measurement kept and no score, because the bound may be what is wrong.
   *  It refuses rather than approximates: an illegal composition names the axis
   *  to change, and a shape no engine here runs faithfully says so instead of
   *  returning a number from a different mechanism.
   *  NOT resumable from here: a search started inside eval rides this
   *  sandbox call, and eval declines background resume because its
   *  side effects cannot be safely re-run. Script quick fan-out here; call the
   *  top-level \`agents\` tool for one long search that must survive an
   *  eviction, which resumes from its search checkpoint. */`,
  hire: `  /** Put ONE workstream in front of ONE agent. With \`role\` it CREATES the
   *  agent — it starts FRESH, it did not see this conversation, so \`mission\`
   *  is its whole brief — and \`agent\` is then the optional name to create it
   *  under. \`role\` is a catalog role id (the ids are listed on the native
   *  agents tool's role fields); \`tier\` optionally overrides that role's
   *  default inference tier. WITHOUT \`role\`, \`agent\` names one that already
   *  exists and \`message\` is the work: a subordinate's report arrives later as
   *  an event that wakes you — it does NOT resolve here — and a peer workspace
   *  agent's reply is awaited until it arrives, however long the peer's work
   *  takes. Default scope:"subordinate" hires into THIS workspace;
   *  scope:"workspace" creates a specialist workspace of its own, sends it
   *  \`message\`, and awaits the result. */`,
  msg: `  /** Say something to an agent WITHOUT handing it a workstream: \`agent\`
   *  names one by name (no reply awaited), or \`event_id\` answers an incoming
   *  agent message event instead. Exactly one of the two; naming both is
   *  refused. */`,
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
  msg: 'Promise<unknown>',
  list: 'Promise<unknown>',
  dismiss: 'Promise<unknown>',
} satisfies Record<AgentsToolAction, string>;

/** Render one action's sandbox input from {@link AGENTS_ACTION_FIELDS}, the source the
 *  tool schema and parse share. */
function renderInputVariant(
  fields: readonly (keyof typeof AGENTS_FIELD_TS_TYPES)[],
  variant: AgentsActionInputVariant,
): string {
  const required = new Set<keyof typeof AGENTS_FIELD_TS_TYPES>(variant.required);

  return [
    '{',
    ...fields.map((field) => {
      const optional = required.has(field) ? '' : '?';

      const type = field === 'scope' && variant.scope !== undefined
        ? `"${variant.scope}"`
        : AGENTS_FIELD_TS_TYPES[field];

      return `    ${field}${optional}: ${type};`;
    }),
    '  }',
  ].join('\n');
}

/** The `hire` doc's task-lifetime half, rendered only where the task-hire port is wired. */
const AGENTS_CODEMODE_TASK_LIFETIME_DOC = `  /** \`lifetime\` decides how long a created helper lives. "durable" (the
   *  default) stays in your roster across turns. "task" creates a full agent
   *  for this ONE question — its own context window, its own tool loop — and
   *  THIS call resolves with its finished answer, after which the row is
   *  archived and only its transcript remains. There is no follow-up, so put
   *  the whole question in \`mission\` and name bulk material by workspace path
   *  so that agent reads it itself. */`;

function memberDoc(action: AgentsToolAction, deps: AgentsToolDeps): string {
  const base = AGENTS_CODEMODE_MEMBER_DOCS[action];

  return action === 'hire' && deps.team?.temporary
    ? `${base}
${AGENTS_CODEMODE_TASK_LIFETIME_DOC}`
    : base;
}

function renderInputType(action: AgentsToolAction, deps: AgentsToolDeps): string {
  const variants = agentsActionInputVariantsFor(deps, action);

  const input = variants.length === 1
    ? renderInputVariant(variants[0].fields, variants[0])
    : variants.map(variant => renderInputVariant(variant.fields, variant)).join('\n  | ');

  return `${memberDoc(action, deps)}
  ${action}(input: ${variants.length === 1 ? input : `\n  | ${input}`}): ${memberReturn(action, deps)};`;
}

/** One-line member descriptions for the provider record. */
const AGENTS_CODEMODE_DESCRIPTIONS = {
  swarm: 'Run a configured search over ephemeral nodes of yourself whose candidates are measured by your own verifier rather than judged: name the shape with preset and what counts with objective. Refuses an illegal composition by naming the axis, and a shape no engine runs faithfully rather than substituting one. Not resumable from inside the sandbox.',
  hire: 'Put one workstream in front of one agent: `role` creates a helper that starts with a blank context, and without `role` an `agent` that already exists is handed the work (a subordinate reports later as an event; a peer reply is awaited). scope:"workspace" creates a specialist workspace of its own.',
  msg: 'Say something to an agent without handing it a workstream: `agent` by name, or `event_id` to answer an incoming agent message event.',
  list: 'The unified roster: subordinates, peer workspace agents, and the task-lifetime agents running right now.',
  dismiss: 'Retire a subordinate (archived by default — its context is kept).',
} satisfies Record<AgentsToolAction, string>;

/** `hire`'s return and description at the `task` lifetime, gated like its docstring. */
const AGENTS_CODEMODE_TASK_LIFETIME_RETURN =
  'Promise<{ status: "completed" | "failed"; agent: string; lifetime: "task"; role: string;'
  + ' answer: string; transcript: "kept"; elapsed_ms: number; reason?: string } | unknown>';

function memberReturn(action: AgentsToolAction, deps: AgentsToolDeps): string {
  return action === 'hire' && deps.team?.temporary
    ? AGENTS_CODEMODE_TASK_LIFETIME_RETURN
    : AGENTS_CODEMODE_RETURNS[action];
}

function memberDescription(action: AgentsToolAction, deps: AgentsToolDeps): string {
  const base = AGENTS_CODEMODE_DESCRIPTIONS[action];

  return action === 'hire' && deps.team?.temporary
    ? `${base} Pass lifetime:"task" for an agent created for that`
      + ' one question, which resolves with its finished answer and is then archived.'
    : base;
}

/** The `agents` namespace declaration for one actor's actions. Ordering comes
 *  from `agentsActionsFor`, which walks the canonical ladder. */
function renderTypes(actions: readonly AgentsToolAction[], deps: AgentsToolDeps): string {
  return [
    'export declare const agents: {',
    ...actions.map(action => renderInputType(action, deps)),
    '};',
    '',
  ].join('\n');
}

/**
 * Build the `agents.*` codemode provider. `deps` is read per call; the action set is fixed
 * at construction. Callers must supply at least one deps group.
 */
export function createAgentsCodemodeProvider(deps: () => AgentsToolDeps): CodemodeProvider {
  const initialDeps = deps();
  const actions = agentsActionsFor(initialDeps);
  // The trusted mode is fixed per provider: eval may outlive its originating turn.
  const mode = initialDeps.mode;
  const tools: CodemodeProvider['tools'] = {};

  for (const action of actions) {
    tools[action] = {
      planAllowed: true,
      description: memberDescription(action, initialDeps),
      execute: (...args: unknown[]) => branchableToolCall(async () => {
        // The node sandbox appends its exec context as a trailing argument; find it by its
        // signal and remove it from the input so it is not refused as an unknown field.
        let context: unknown;

        for (const arg of args) {
          if (readExecSignal({ context: arg }) !== undefined) context = arg;
        }

        const raw = args[0] === context ? undefined : args[0];
        const parsedRaw = raw === undefined ? undefined : v.safeParse(JsonValueSchema, raw);

        // Reason first, so a script can branch on the class without parsing prose.
        if (parsedRaw && (!parsedRaw.success || !isJsonObject(parsedRaw.output))) {
          return { success: false, reason: 'bad_input', error: `agents.${action}: expects a single options object` };
        }

        // `action` comes from the called member, never from the script's object.
        const candidate: JsonObject = {};

        if (parsedRaw?.success) Object.assign(candidate, parsedRaw.output);
        Object.assign(candidate, { action });
        let input;

        try {
          input = parseAgentsToolInput({ input: candidate });
        } catch (error) {
          return { success: false, reason: 'bad_input', error: `agents.${action}: ${renderThrownChain({ cause: error })}` };
        }

        const signal = readExecSignal({ context });

        try {
          return await dispatchAgentsAction({ ...deps(), mode }, input, signal ? { abortSignal: signal } : undefined);
        } catch (cause) {
          if (cause instanceof MissionBudgetExhausted) return projectJsonValue({ value: cause.refusal });
          throw cause;
        }
      }),
    };
  }

  return {
    // The namespace name comes from TOOL_REACH, so removing sandbox reach fails to compile.
    name: TOOL_REACH.agents.codemode,
    types: renderTypes(actions, initialDeps),
    tools,
    positionalArgs: true,
  };
}
