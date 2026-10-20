/**
 * What the live suites share: the product's own session as their agent, the request-surface probe on its model, a
 * credential-free scripted model, and the refusals that stop a runtime which cannot execute, or can execute on the
 * developer's own machine, before any model is driven.
 */
import type { LanguageModel } from 'ai';
import * as v from 'valibot';

import type {
  AgentRuntime, LLMProviderConfig, ProfileCatalog, ProfileCatalogEnvelope,
  ProviderCatalogSnapshot, JsonObject, JsonValue, ToolOutcome, CompletedTurn, SessionEvent, TurnEndEvent,
} from '../../packages/core/src/index';
import {
  JsonObjectSchema, JsonValueSchema, ToolOutcomeSchema,
  BUILTIN_PROFILE_CATALOG, profileCatalogDigest, resolveTurnProfile,
} from '../../packages/core/src/index';
import type { CLIRuntime } from '../../packages/cli-backend/src/runtime';
import { LocalAgentSession, type LocalSessionDb } from '../../packages/cli-backend/src/local-session';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { isAbsolute, relative, resolve } from 'node:path';
import { REPO_ROOT } from '../../scripts/repo-root';

/** The repository this suite runs from: an episode's folder is never it, nor a folder above it. */

/** A turn's call as the session said it, with its result, for a suite's own assertions. */
export interface LiveToolCall {
  readonly toolCallId: string;
  readonly name: string;
  readonly args: JsonObject;
  result: JsonValue;
  outcome?: ToolOutcome;
}

/**
 * WHAT THE PROVIDER WAS ACTUALLY ASKED WITH.
 *
 * PRD §9.5's instrument: record whether the model saw the agents surface, and
 * never treat autonomous non-use as a wiring defect without raw prompt/response
 * evidence.
 *
 * The tool list is read off `LanguageModelV2CallOptions.tools` — the wire-level
 * argument the provider receives, after `generateText` has resolved the ToolSet,
 * applied every filter and serialised the schemas. That is a different fact from
 * `Object.keys(tools)` at the call site: the call site is what the harness
 * INTENDED to offer, this is what the model WAS offered. A run reporting zero
 * delegation calls carries the evidence that separates "declined" from "was
 * never asked", so the two are not one observation.
 */
export interface RequestSurfaceEvidence {
  /** Turn requests observed (a lane that offers no tools is none). Zero means the episode never reached the model,
   *  which is an unmeasured episode rather than a model that declined. */
  readonly calls: number;
  /** Union of every tool name offered across those calls, sorted. */
  readonly toolsOffered: readonly string[];
  /** Whether `agents` was among them — the delegation surface, in the request. */
  readonly agentsOffered: boolean;
  /** Whether the system prompt the provider received names `agents` in its
   *  tool index. Both halves are needed: a tool the prompt never names is a
   *  capability the model was not taught, and an index entry with no tool is
   *  one it cannot reach. The index line is the only prompt text about
   *  delegation; the Delegation section that once ranked the rungs is gone. */
  readonly agentsIndexed: boolean;
  /** System-prompt size, so a truncated or empty projection is visible without
   *  publishing the prompt itself. */
  readonly systemChars: number;
  /** Whether every observed request carried the dynamic block's runtime section (backend, model, date), which the
   *  system prompt no longer states. */
  readonly runtimeFacts: boolean;
}

/** The swarm rung's marker in the RENDERED section (section-templates.ts:296):
 *  `action=swarm` appears only when the ladder was rendered WITH the swarm
 *  rung, which is the fact §9.5 wants — not merely that a heading exists. */
const AGENTS_INDEX_MARKER = '- **agents**:';

/** The dynamic block's runtime section opening, as it reads inside the JSON of a provider prompt. */
const RUNTIME_SECTION_MARKER = JSON.stringify('## Runtime context\n- Backend: ').slice(1, -1);

/**
 * The two fields of a provider call this reads, in the shape BOTH model
 * specifications share. Structural rather than either version's own call-options
 * type: `LanguageModel` is `string | LanguageModelV3 | LanguageModelV2`
 * (ai/dist/index.d.ts:96), the two versions' options are separate nominal types,
 * and this observer needs exactly the two members they agree on. A system
 * message's content is a string in both, so a non-string is skipped rather than
 * coerced.
 */
interface ObservedRequest {
  readonly prompt: readonly { readonly role: string; readonly content: unknown }[];
  readonly tools?: readonly { readonly name: string }[];
}

/** The two model specifications `LanguageModel` unions over. Named so each
 *  branch of the wrapper below can be annotated: a literal typed as the union
 *  gets no contextual parameter types, and the callbacks fall to `any`. */
type ModelV2 = Extract<LanguageModel, { specificationVersion: 'v2' }>;

type ModelV3 = Extract<LanguageModel, { specificationVersion: 'v3' }>;

type ModelV4 = Extract<LanguageModel, { specificationVersion: 'v4' }>;

/**
 * Wrap a model so every request it receives is observed. The wrapper forwards
 * verbatim — it is not a fake and it changes nothing about the call — so the
 * evidence is of the real request and a suite keeps driving the real model.
 *
 * Branched on `specificationVersion` rather than spread once, because a single
 * spread over the union widens `doGenerate` to a signature that satisfies
 * neither version: the two carry incompatible content and stream-part types, and
 * the compiler is right to refuse. The branches are byte-identical because the
 * observer only reads what both specifications share.
 */
export interface RecordedRequestSurface {
  readonly model: LanguageModel;
  /** Over the turn requests from the `since`-th on (every one by default), so one turn's evidence is its own. */
  evidence(since?: number): RequestSurfaceEvidence;
  /** Each turn request's prompt as the provider received it, serialised, oldest first. */
  prompts(): readonly string[];
}

/** The I/O-boundary check for this wrapper's input. `LanguageModel` unions a
 *  bare model-id STRING with the two resolved specifications, and only the
 *  resolved ones carry a spec tag — so a successful parse IS the proof of
 *  resolution, and it doubles as the type guard the branches below need. */
const RESOLVED_LANGUAGE_MODEL = v.object({
  specificationVersion: v.picklist(['v2', 'v3', 'v4']),
});

function isResolvedLanguageModel(model: LanguageModel): model is ModelV2 | ModelV3 | ModelV4 {
  return v.safeParse(RESOLVED_LANGUAGE_MODEL, model).success;
}

/** The system message both model specifications agree on: role tag plus plain
 *  text. Parsing each prompt message against it is how the ladder probe reads
 *  the system block without reaching into representation. */
const SYSTEM_MESSAGE = v.object({ role: v.literal('system'), content: v.string() });

/** `model`, forwarding every call unchanged after `observe` reads it; one branch per specification, which the SDK's
 *  types keep apart though the code is the same. */
function observedModel(model: ModelV2 | ModelV3 | ModelV4, observe: (options: ObservedRequest) => void): LanguageModel {
  if (model.specificationVersion === 'v2') {
    return {
      ...model,
      doGenerate: (options) => {
        observe(options);

        return model.doGenerate(options);
      },
      doStream: (options) => {
        observe(options);

        return model.doStream(options);
      },
    } satisfies ModelV2;
  }

  if (model.specificationVersion === 'v3') {
    return {
      ...model,
      doGenerate: (options) => {
        observe(options);

        return model.doGenerate(options);
      },
      doStream: (options) => {
        observe(options);

        return model.doStream(options);
      },
    } satisfies ModelV3;
  }

  return {
    ...model,
    doGenerate: (options) => {
      observe(options);

      return model.doGenerate(options);
    },
    doStream: (options) => {
      observe(options);

      return model.doStream(options);
    },
  } satisfies ModelV4;
}

/**
 * Wrap a model so every request it receives is observed. The wrapper forwards
 * verbatim — it is not a fake and it changes nothing about the call — so the
 * evidence is of the real request and a suite keeps driving the real model.
 *
 * Branched on `specificationVersion` rather than spread once, because a single
 * spread over the union widens `doGenerate` to a signature that satisfies
 * neither version: the two carry incompatible content and stream-part types,
 * and the compiler is right to refuse. The branches delegate identically
 * because the observer only reads what both specifications share.
 */
function recordRequestSurface(model: LanguageModel): RecordedRequestSurface {
  if (!isResolvedLanguageModel(model)) {
    throw new Error(
      'recordRequestSurface needs a resolved LanguageModel, not a model id string: '
      + 'a string is resolved inside the SDK, where the request cannot be observed');
  }

  // A turn's own requests: one offered no tools is a lane beside the turn (a title, a review), with no surface to read.
  const turnRequests: { readonly tools: readonly string[]; readonly system: string; readonly prompt: string }[] = [];

  const observe = (options: ObservedRequest): void => {
    const tools = (options.tools ?? []).map((entry) => entry.name);

    if (tools.length === 0) return;

    const system = options.prompt
      .flatMap((message) => {
        const parsed = v.safeParse(SYSTEM_MESSAGE, message);

        return parsed.success ? [parsed.output.content] : [];
      })
      .join('\n');

    turnRequests.push({ tools, system, prompt: JSON.stringify(options.prompt) });
  };

  const recording = observedModel(model, observe);

  return {
    model: recording,
    evidence: (since = 0) => {
      const read = turnRequests.slice(since);
      const offered = new Set(read.flatMap((request) => request.tools));

      return {
        calls: read.length,
        toolsOffered: [...offered].sort(),
        agentsOffered: offered.has('agents'),
        agentsIndexed: read.some((request) => request.system.includes(AGENTS_INDEX_MARKER)),
        systemChars: Math.max(0, ...read.map((request) => request.system.length)),
        runtimeFacts: read.length > 0 && read.every((request) => request.prompt.includes(RUNTIME_SECTION_MARKER)),
      };
    },
    prompts: () => turnRequests.map((request) => request.prompt),
  };
}

/** One step of a scripted turn: a tool call, or the text that ends it. */
export type ScriptedEvalStep = { readonly call: string; readonly input: JsonObject } | { readonly text: string };

const SCRIPTED_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/**
 * A credential-free model for a session's turn: the step a request is on is how many tool results it already carries,
 * and a request offered no tools (a title, a background lane) is answered plain. Past the script, the last step repeats.
 */
export function scriptedEvalModel(script: readonly [ScriptedEvalStep, ...ScriptedEvalStep[]]): LanguageModel {
  return scriptedTurnModel({
    doGenerate: (options) => {
      const answered = options.prompt.filter((message) => message.role === 'tool').length;
      const step = (options.tools ?? []).length === 0 ? { text: 'ok' } : script[Math.min(answered, script.length - 1)] ?? { text: 'ok' };

      const content = 'call' in step
        ? [{ type: 'tool-call' as const, toolCallId: `scripted-${String(answered)}`, toolName: step.call, input: JSON.stringify(step.input) }]
        : [{ type: 'text' as const, text: step.text }];

      return { content, finishReason: { unified: 'call' in step ? 'tool-calls' : 'stop', raw: undefined }, usage: SCRIPTED_USAGE, warnings: [] };
    },
  });
}

/** One turn as the product's session ran it: the turn it recorded, each call with its result, and the error it said. */
export interface EvalTurn {
  readonly turnId: string;
  readonly turn: CompletedTurn;
  readonly calls: readonly LiveToolCall[];
  readonly error: string | null;
}

/** What one turn has said so far, as its events arrive. */
interface TurnObservation {
  readonly calls: LiveToolCall[];
  error: string | null;
  ended: TurnEndEvent | null;
}

/** A live suite's agent: the product's own session over the suite's runtime, every request it sends observed. */
export interface EvalSession {
  readonly session: LocalAgentSession;
  readonly requests: RecordedRequestSurface;
  /** Every event the session has said, oldest first: its evolution and background notices among them. */
  readonly events: readonly SessionEvent[];
  turn(text: string): Promise<EvalTurn>;
  end(): Promise<void>;
}

/**
 * THE EVAL AGENT IS THE PRODUCT'S. A suite drives `LocalAgentSession` with `model` as `kinu` does: its prompt, its tool
 * surface, its turn gates and what it records are the product's, so a score cannot be of a surface the suite assembled.
 */
export function evalSession(input: { readonly rt: CLIRuntime; readonly db: LocalSessionDb; readonly model: LanguageModel }): EvalSession {
  const requests = recordRequestSurface(input.model);
  // What the turn under way has said so far; each turn starts a fresh one.
  let current: TurnObservation = { calls: [], error: null, ended: null };

  const events: SessionEvent[] = [];

  const observe = (event: SessionEvent): void => {
    events.push(event);

    if (event.type === 'tool-call') {
      current.calls.push({ toolCallId: event.toolCallId, name: event.toolName, args: v.parse(JsonObjectSchema, event.args), result: null });
    } else if (event.type === 'tool-result') {
      const call = current.calls.find((made) => made.toolCallId === event.toolCallId);

      if (call !== undefined) {
        const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), JsonValueSchema), event.result);

        call.result = parsed.success ? parsed.output : event.result;
        call.outcome = v.parse(ToolOutcomeSchema, event);
      }
    } else if (event.type === 'turn-end') {
      current.ended = event;
    } else if (event.type === 'error') {
      current.error = event.message;
    }
  };

  const session = new LocalAgentSession({ rt: input.rt, db: input.db, model: requests.model, onEvent: observe });

  return {
    session,
    requests,
    events,
    async turn(text) {
      current = { calls: [], error: null, ended: null };
      await session.send(text, { id: crypto.randomUUID() });
      const finished = current.ended;

      if (finished === null) throw new Error(`the session ended no turn for ${JSON.stringify(text.slice(0, 60))}${current.error === null ? '' : `: ${current.error}`}`);

      return { turnId: finished.turnId, turn: finished.turn, calls: current.calls, error: current.error };
    },
    end: () => session.end(),
  };
}

/**
 * Thrown when the runtime handed to a task cannot reach an executor at all.
 *
 * NOT a {@link DegenerateRunError}, deliberately: that type means the AGENT did
 * nothing and is recorded as `inert`, and a runtime with no executors is the
 * HARNESS being broken, which is `errored` (behaviour.eval.ts:281). Conflating
 * them would file a harness fault as an agent observation.
 *
 * This exists because the failure it catches is SILENT by construction.
 * `eval` is built from `router?.getProviders() ?? []`
 * (core/src/tools/builtins.ts:373), so a runtime with no router yields a tool
 * with an empty provider surface and no complaint — every `workspace.*` and
 * `codemode.*` call then fails with `is not a function`, which the ledger
 * records as an ordinary tool result. Two full live runs were graded that way
 * and reported 0.817 and 0.903 tool_outcomes over it.
 *
 * It is checked BEFORE the model is driven, so a broken runtime costs nothing
 * rather than being discovered after a paid episode.
 */
export class DegenerateRuntimeError extends Error {
  constructor(readonly taskId: string, readonly reason: string) {
    super(`degenerate runtime for ${taskId}: ${reason}. The eval must not run: `
      + '`eval` would be built with an empty provider surface, so every '
      + '`workspace.*`/`tools.*` call fails with "is not a function" and scores '
      + 'as an ordinary tool result. Open the workspace through `openWorkspaceCLI` '
      + '(cli-backend/src/open.ts), which registers the inline ExecutorProvider — '
      + 'the runtime `createWorkspace` returns is the BIRTH runtime and registers none.');
    this.name = 'DegenerateRuntimeError';
  }
}

/**
 * Refuse a runtime that cannot execute anything.
 *
 * The assertion sits upstream of every write path: it throws before a session
 * exists, so there is no turn, no ledger row and no record to publish. A check
 * that fails publishes no number.
 */
export function requireExecutorSurface(taskId: string, rt: AgentRuntime): void {
  const router = rt.executionRouter;

  if (!router) throw new DegenerateRuntimeError(taskId, 'rt.executionRouter is absent');
  const providers = router.getProviders();

  if (providers.length === 0) {
    throw new DegenerateRuntimeError(taskId, 'rt.executionRouter has zero registered providers');
  }
}

/** Executor kinds an episode may be measured on: the workspace's own shell, in the episode's scratch folder. An
 *  allowlist rather than a `device` denylist, so a plane added later is refused until someone decides it is fenced. */
const SANDBOXED_EXECUTOR_KINDS: readonly string[] = ['workspace'];

/**
 * Thrown when the runtime handed to an episode can execute on the developer's
 * own machine.
 *
 * NOT a {@link DegenerateRunError}: this is the harness being misconfigured, so
 * it is `errored` rather than an observation about the agent
 * (behaviour.eval.ts:347).
 *
 * The escape it catches was measured, not imagined. A live run left
 * `scratch-add/{add.js,add.test.js}` in a worktree ROOT and `report.txt` /
 * `todos.txt` in the repo root, and the commit that swept them up was refused by
 * `gate:typecheck-coverage`. In the CLI the machine is the workspace: a
 * runtime opened with a bound `cwd` runs its workspace shell in that
 * directory, and an episode reaches every registered provider through
 * `eval` — so a harness that bound the repo handed each episode the
 * developer's filesystem.
 */
export class UnsandboxedRuntimeError extends Error {
  constructor(readonly taskId: string, readonly executor: string) {
    super(`unsandboxed runtime for ${taskId}: executor \`${executor}\` runs on the `
      + 'developer\'s own machine outside the episode\'s folder. The eval must not run: an episode '
      + 'reaches every registered provider through `eval`, and a corpus task that writes files then '
      + 'writes them where its shell starts. Open the workspace in the episode\'s own scratch folder '
      + '(scratchDir, under TMPDIR), never the repo or a folder above it: its writes outside that '
      + 'folder and its own space then wait for an approval nobody here gives.');
    this.name = 'UnsandboxedRuntimeError';
  }
}

/**
 * Refuse a runtime that can reach outside the episode's sandbox.
 *
 * Reads `listExecutors()` rather than `getProviders()` because the codemode
 * surface deliberately drops `kind` (execution/router.ts:38-52), and the kind is
 * the whole question — a name is a namespace, not a claim about which machine
 * runs the command.
 *
 * Checked before the model is driven, beside {@link requireExecutorSurface}: the
 * refusal costs nothing, and discovering it afterwards costs a paid run plus
 * whatever the episode wrote.
 */
/** The folder a CLI runtime works in, or null. Read through a parse of the runtime's own shape rather than a cast:
 *  core's `AgentRuntime` does not declare `cwd`, the CLI's runtime does. */
function boundDirectory(rt: AgentRuntime): string | null {
  const parsed = v.safeParse(v.object({ cwd: v.optional(v.nullable(v.string())) }), rt);

  return parsed.success ? parsed.output.cwd ?? null : null;
}

/** True when `folder` is `repo` or a folder above it, where an episode's shell would work in the developer's tree. */
function holdsRepo(folder: string, repo: string): boolean {
  const from = relative(resolve(folder), resolve(repo));

  return from === '' || (!from.startsWith('..') && !isAbsolute(from));
}

/**
 * Since 2026-10-04 every local workspace's shell is the machine's, in its folder: an episode is fenced by working in
 * its own scratch folder, so the runtime must work in exactly `folder`, which is neither the repo nor above it.
 */
export function requireSandboxedExecutors(taskId: string, rt: AgentRuntime, folder: string): void {
  const bound = boundDirectory(rt);

  if (bound === null || resolve(bound) !== resolve(folder) || holdsRepo(folder, REPO_ROOT)) {
    throw new UnsandboxedRuntimeError(taskId, 'workspace');
  }

  for (const executor of rt.executionRouter?.listExecutors() ?? []) {
    if (!SANDBOXED_EXECUTOR_KINDS.includes(executor.kind)) {
      throw new UnsandboxedRuntimeError(taskId, executor.name);
    }
  }
}

/**
 * Pin the model this suite ANNOUNCED as the profile its routed lanes resolve.
 *
 * WHAT A ROUTED LANE NEEDS. Every model lane on a local runtime reads a turn
 * profile: `rt.judgeModel` / `rt.fastLlm` come from
 * `resolveRoutedLane` (core/src/runtime-builder.ts:115-121) and `rt.llm.complete`
 * routes `reflection` through `ensureProfile()` (cli-backend/src/runtime.ts:
 * 395-420). A runtime with no profile and no resolver leaves all three lanes
 * undefined and throws on the fourth.
 *
 * THE PRODUCT CLOSES THAT HOLE ITSELF, so this function is not what keeps a
 * lane alive. `createCLIRuntime` installs its own authority
 * (cli-backend/src/profile-authority.ts, wired at runtime.ts:405-426), so every
 * runtime from `openWorkspaceCLI` routes by default and `setProfileResolver` has
 * ZERO callers in the product — it survives on `CLIRuntime` as this override.
 *
 * WHY THE OVERRIDE SURVIVES ANYWAY: the cost basis has to be the model the run
 * NAMED. Each live suite announces exactly one model through `liveModelTarget`
 * and prints it as what the run is billed as. The runtime's own default derives
 * its tier from the workspace's `actor_config` — which `createWorkspace` does not
 * seed — and normalizes the spec through the local resolver, so it spells the
 * same model differently (`workers-ai/@cf/...` rather than `@cf/...`). This pin
 * makes the announced string the tier's string, and makes substitution impossible
 * rather than merely unlikely: the catalog declares ONE tier and the provider
 * snapshot lists ONE model, so every other tier aliases `default`
 * (profiles/resolve.ts:5) and a model the banner never named cannot resolve.
 *
 * WHAT IT COST TO LEARN. Measured 2026-08-24 against staging, before the product
 * default existed and before this function did: `E2E Lifecycle > 5-turn
 * conversation` died in `engine.reviewTurn -> extractPattern`, `E2E Lifecycle >
 * MCTS evolution` died 220s in at `converge` (`judge: rt.judgeModel ?? rt.llm`),
 * and `Evolution Proof` lost all six of its tests the same way — eight failures
 * on an unwired harness runtime rather than on anything an agent did. Every one
 * of them is a locked skip, so no credential-free run could ever have seen it.
 *
 * The shape mirrors what a pinned-model session builds rather than inventing a
 * policy: role read live from the workspace's own config so a role change lands
 * on the next lane, work mode `build` as a session starts, and an empty tool
 * surface because these lanes resolve TIERS and never call a tool.
 */
export function installPreTurnProfile(rt: CLIRuntime, llm: LLMProviderConfig): void {
  const catalog: ProfileCatalog = {
    roles: BUILTIN_PROFILE_CATALOG.roles,
    tiers: { default: { model: llm.model } },
  };

  const envelope: ProfileCatalogEnvelope = {
    authority: { kind: 'local' },
    version: 0,
    digest: profileCatalogDigest(catalog),
    catalog,
  };

  // `revision` must change when the availability picture does
  // (profiles/resolve.ts:46-53). This picture is one pinned model for the life
  // of the suite, so the model id IS the revision.
  const provider: ProviderCatalogSnapshot = {
    revision: `eval-pinned:${llm.model}`,
    availableModels: [llm.model],
  };

  const config = rt.actor.config;
  const role = config.getRoleSelection();

  if (!rt.setProfileResolver) {
    throw new Error('this runtime exposes no setProfileResolver, so its model lanes cannot be '
      + 'wired and every judge, fast and reflection call would fail before reaching a model');
  }

  rt.setProfileResolver(() => Promise.resolve(resolveTurnProfile({
    envelope,
    provider,
    roleId: role,
    workMode: 'build',
    availableTools: [],
    activeSkills: [],
  })));
}
