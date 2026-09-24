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

/** What a program must know beyond the native schema, per member. Literals, so every backend renders the same contract. */
const AGENTS_CODEMODE_MEMBER_DOCS = {
  swarm: '  /** A search started here is not resumed after an eviction; one started by the native tool is. */',
  hire: '  /** A subordinate\'s report arrives later as an event; a peer workspace agent\'s reply is awaited here. */',
  msg: '',
  list: '',
  dismiss: '',
} satisfies Record<AgentsToolAction, string>;

/** Per-member return annotations. `unknown` where the caller only reads it
 *  incidentally; the swarm union is spelled out because scripts branch on it. */
const AGENTS_CODEMODE_RETURNS = {
  swarm: 'Promise<{ preset: string; config: unknown; caps: unknown; report: unknown; publication: unknown; best: unknown; candidates: unknown[] } | Refusal>',
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

function renderInputType(action: AgentsToolAction, deps: AgentsToolDeps): string {
  const variants = agentsActionInputVariantsFor(deps, action);

  const input = variants.length === 1
    ? renderInputVariant(variants[0].fields, variants[0])
    : variants.map(variant => renderInputVariant(variant.fields, variant)).join('\n  | ');

  const doc = AGENTS_CODEMODE_MEMBER_DOCS[action];

  return `${doc === '' ? '' : `${doc}\n`}  ${action}(input: ${variants.length === 1 ? input : `\n  | ${input}`}): ${memberReturn(action, deps)};`;
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
    '/** The native `agents` actions; each takes that action\'s input without `action`. */',
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
