/**
 * What the live suites share: the agent surface built by the production roots,
 * the step and session recorders their turns write through, the request-surface
 * probe, and the refusals that stop a runtime which cannot execute, or can
 * execute on the developer's own machine, before any model is driven.
 */
import type { LanguageModel, ModelMessage, StepResult, ToolSet } from 'ai';
import * as v from 'valibot';

import type {
  AgentRuntime, AgentsToolAction, AgentsSwarmDeps, AgentsToolDeps, BuiltinToolName,
  LLMProviderConfig, ProfileCatalog, ProfileCatalogEnvelope, RuntimeFacts,
  ProviderCatalogSnapshot, ToolCallRecord,
} from '../../packages/core/src/index';
import {
  artifactOverrides, currentArtifacts, agentsActionsFor, buildActorTools,
  buildSystemPromptSync, createFactsStore,
  createAgentsCodemodeProvider, createMemoryCodemodeProvider, createTasksCodemodeProvider,
  isBuiltinToolName, JsonObjectSchema, collectDynamicContext, currentDateForPrompt, DynamicContextLedger, readMemoryTail,
  projectJsonValue, failedToolOutcome, TaskListStore,
  BUILTIN_PROFILE_CATALOG, profileCatalogDigest, resolveAgentTurnProfile,
  WORKSPACE_RUN_ID, ConversationSearchStore, BackgroundJobRunner, BACKGROUNDABLE_TOOLS, narrowToolSurface,
} from '../../packages/core/src/index';
import { renderThrownChain } from '../../packages/core/src/obs/index';
import { synthesizeToolFallback } from '../../packages/core/src/utils/evidence-window';
import {
  createDefaultWebSearchProvider, restBrowserRunAccess, createWebCodemodeProvider,
} from '../../packages/core/src/web/index';
import type { CLIRuntime } from '../../packages/cli-backend/src/runtime';
import { createNodeCodemodeToolFactory } from '../../packages/cli-backend/src/codemode-tool-factory';
import { hostedCodemodeTool } from '../../packages/cli-backend/src/head-runtime';
import { liveModelCallSink } from '@kinu.run/test-utils';
import { isAbsolute, relative, resolve } from 'node:path';

/** The repository this suite runs from: an episode's folder is never it, nor a folder above it. */
const REPO_ROOT = resolve(import.meta.dir, '..', '..');

/**
 * THE EVAL AGENT'S SURFACE, BUILT BY THE PRODUCTION ROOTS.
 *
 * Two suites drive `generateText` directly rather than through
 * `LocalAgentSession` — the evolution proof, which needs a turn boundary it
 * controls so it can fire `reviewTurn` per challenge, and the exploration eval,
 * which measures whether the model REACHES for delegation. Both therefore build
 * the surface themselves, and a surface assembled by hand diverges from the
 * product in three ways that each corrupt a score silently:
 *
 *   - `buildBuiltinTools` by construction cannot hold `agents`
 *     (delegation/actor-tools.ts: the delegation tool's implementation IS the search
 *     engine, so the factory that emits a node's own surface cannot register
 *     it). The product's actor root is `buildActorTools`. Ask "did the model
 *     delegate?" of a model that has no delegation tool and the zero is
 *     unreadable: model declined, or nothing to decline?
 *   - a hand-assembled `buildSystemPromptSync` option set that passes no
 *     `agentsActions` and leaves `agents` off `availableTools` makes
 *     `renderAgentStateSection` (prompt.ts:236) skip the whole delegation
 *     ladder. The model is then not shown the surface it is being scored on
 *     reaching for.
 *   - without the codemode namespaces production wires as `extraProviders`
 *     (`agents.*`, `web.*`, `memory.*`, `tasks.*`), `eval` code the
 *     prompt teaches throws `not a function` inside the eval only.
 *
 * This builds BOTH from the roots `rebuildModelBoundState`
 * (cli-backend/src/local-session.ts:2822) and the turn assembly
 * (local-session.ts:1785) use, with the same deps, so a capability cannot be on
 * one and off the other. Crafted tools reach the program through the surface's
 * `craftedTools()`, which reads the store per program; when a seam skipped
 * them, `workspace.createTool` succeeded, the store grew a row, and
 * `tools.doubleIt(21)` failed with "is not a function". A craft score then
 * recorded a reuse that never executed.
 *
 * DECLARED DIFFERENCES FROM A LIVE SESSION, each named rather than left to be
 * discovered. All are documented non-degrading absences on their own
 * declarations, and none changes the surface the model is SHOWN:
 *   - `costModel` is a `ModelCatalogSession` a session owns; absent, a swarm's
 *     pre-run spend gate blends and says it blended (AgentsSwarmDeps:267-270).
 *   - `heads` strategy options are not wired, because a local head runs over a
 *     FORK of the session's own CLIRuntime. `defaultOptions` has no consumer in
 *     the shipped tree anyway: declared at agents-tool.ts:299, produced by
 *     fork-deps.ts:145, read nowhere.
 *   - `temporaryAsk` is `false`, because the eval session wires no team deps —
 *     the same structural absence a session with no child substrate has, so the
 *     prompt never advertises a rung the action would refuse.
 * `report` stays unwired: the conformance manifest declares it absent on the
 * `cli` root, so wiring it here would make the eval surface WIDER than the
 * product's.
 */
export interface EvalAgentSurfaceDeps {
  /** The runtime `openWorkspaceCLI` returned — the real one, not birth's
   *  degraded inline VFS/Memory/Executor. */
  readonly rt: CLIRuntime;
  /** The model this surface's turns will run on. Held because `agents` needs a
   *  model to expand a search with; the same value the caller drives. */
  readonly model: LanguageModel;
  /** The workspace's provider config, for the prompt's runtime-context model
   *  line — the one production renders from its effective spec. */
  readonly llm: LLMProviderConfig;
}

export interface EvalAgentSurface {
  /** What `generateText` is handed. */
  readonly tools: ToolSet;
  /** The builtin names on it, which is also what the prompt is rendered from. */
  readonly builtinTools: readonly BuiltinToolName[];
  /** The `agents` actions this surface's deps actually wire, from the same
   *  `agentsActionsFor` the tool's own input enum is built from. */
  readonly agentsActions: readonly AgentsToolAction[];
  /**
   * One turn's first request as production frames it: the system prompt, and the history with the dynamic block
   * (backend, model, directory, date, live state) woven before the turn's input by the ledger the step pipeline
   * uses. Per call, because the promoted artifacts and the memory tail change between turns, exactly as in
   * the product.
   */
  request(history: readonly ModelMessage[]): Promise<{ readonly system: string; readonly messages: ModelMessage[] }>;
}

export function buildEvalAgentSurface(deps: EvalAgentSurfaceDeps): EvalAgentSurface {
  const { rt, model, llm } = deps;
  const sql = rt.storage.sql;
  const facts = createFactsStore(sql, rt.actor);
  const taskList = new TaskListStore(sql, rt.actor, <T>(write: () => T) => rt.storage.transactionSync(write));
  const config = rt.actor.config;

  const webSearch = createDefaultWebSearchProvider({
    fetch: globalThis.fetch.bind(globalThis), browser: restBrowserRunAccess({ env: process.env, fetch: globalThis.fetch.bind(globalThis) }),
  });

  // As the CLI session builds `web.*`: no browser session in this process.
  const web = () => createWebCodemodeProvider({ provider: webSearch, files: rt.storage });

  // This builds a TOOL SURFACE — the tools, the action enum and the system
  // prompt — for arms that assert their shape. It holds no session, and local
  // node hosting is session-bound by design (`LocalAgentSession.hostNode`: the
  // session is a node's client fan-out and turn queue). So the seat REFUSES
  // rather than returning something. An arm that means to drive the swarm rung
  // has a target and passes `target.hostNode` (see `swarm.eval.ts`); one that
  // reaches it through this surface would otherwise run every node on the
  // caller's own actor, which is the failure this refusal prevents.
  const swarm: AgentsSwarmDeps = {
    rt,
    model: () => model,
    reportModelCall: liveModelCallSink(sql, rt.actor),
    // A node's eval and web as the CLI session builds them.
    nodeCodemode: (actor) => hostedCodemodeTool(actor, [web()]),
    webSearch,
    hostNode: () => Promise.reject(new Error(
      'this eval surface builds tools without a session, so it cannot seat a swarm node; '
      + 'drive the rung through a target that implements hostNode',
    )),
  };

  // The live rungs measure swarms, which the eval accounts have turned on.
  const agents: AgentsToolDeps = { mode: 'build', swarm, swarms: true };

  // No session takes a wake here, so its calls run inline: the raw surface, over a runner nothing detaches into.
  const { raw: tools } = buildActorTools({
    rt,
    conversations: new ConversationSearchStore(sql, rt.actor, (sessionId) => rt.stores.history.transcript(sessionId)),
    codemode: createNodeCodemodeToolFactory({
      reach: narrowToolSurface(undefined),
      extraProviders: [
        createAgentsCodemodeProvider(() => agents),
        web(),
        createMemoryCodemodeProvider(() => ({ memory: rt.memory, facts, actor: rt.actor, conversations: new ConversationSearchStore(sql, rt.actor, (sessionId) => rt.stores.history.transcript(sessionId)) })),
        createTasksCodemodeProvider(taskList, config),
      ],
    }),
    agents,
    // No session stream persists this harness's calls, so none is waited for.
    effectClaims: { sql, actor: rt.actor, turnId: () => WORKSPACE_RUN_ID, durable: () => Promise.resolve() },
    facts,
    webSearch,
    jobs: {
      jobRunner: new BackgroundJobRunner({ store: rt.stores.jobs, fiber: rt.schedule.fiber.bind(rt.schedule), inbox: { send: async () => 'undelivered' } }),
      backgroundable: BACKGROUNDABLE_TOOLS,
      mode: () => 'build',
    },
  });

  const builtinTools = Object.keys(tools).filter(isBuiltinToolName);
  const agentsActions = agentsActionsFor(agents);

  const backend = 'cli-local';

  return {
    tools,
    builtinTools,
    agentsActions,
    request: async (history) => {
      const system = buildSystemPromptSync(rt, {
        executors: rt.executionRouter?.listExecutors() ?? [],
        availableTools: builtinTools,
        agentsActions,
        // No child substrate here: the prompt must not advertise a rung the
        // action would refuse.
        temporaryAsk: false,
        backend,
        model: { id: llm.model },
        sectionOverrides: artifactOverrides(currentArtifacts(sql, rt.actor)).sections,
      });

      const runtime: RuntimeFacts = { backend, model: { id: llm.model }, cwd: rt.cwd ?? undefined, date: currentDateForPrompt() };

      const dynamic = collectDynamicContext({
        rt, stores: rt.stores, tools,
        profile: { workMode: 'build', allowedTools: Object.keys(tools) },
        runtime,
        memoryTail: await readMemoryTail(rt.memory),
        missingCapabilities: [],
      });

      const messages = [...history];
      const woven = new DynamicContextLedger().weave(messages, dynamic, { at: Math.max(0, messages.length - 1), firstStep: true });

      return { system, messages: woven ?? messages };
    },
  };
}

/**
 * The tool-traffic half of one `generateText` turn, collected the same way by
 * every suite that drives the inner API.
 *
 * Four suites spelled this `onStepFinish` inline beside their own system prompt
 * and message list, and the block is the part that has to agree: a record whose
 * `args` is not parsed through `JsonObjectSchema`, or whose result is not
 * projected through `projectJsonValue`, is a row the ledger scorers read
 * differently. One closure, so the turn drivers cannot drift from each other or
 * from what the ledger expects a record to carry. The system prompt, the
 * messages and the store writes stay with the caller: those are what differ.
 */
export interface StepToolCallLog {
  readonly records: ToolCallRecord[];
  steps: number;
  onStepFinish(step: Pick<StepResult<ToolSet>, 'toolCalls' | 'content'>): void;
}

export function createStepToolCallLog(): StepToolCallLog {
  const log: StepToolCallLog = {
    records: [],
    steps: 0,
    onStepFinish(step) {
      log.steps += 1;
      const byId = new Map<string, ToolCallRecord>();

      for (const call of step.toolCalls) {
        const record: ToolCallRecord = { name: call.toolName, args: v.parse(JsonObjectSchema, call.input), result: null };
        log.records.push(record);
        byId.set(call.toolCallId, record);
      }

      for (const part of step.content) {
        if (part.type !== 'tool-result' && part.type !== 'tool-error') continue;
        const record = byId.get(part.toolCallId);

        if (!record) continue;

        if (part.type === 'tool-result') {
          if (part.preliminary) continue;
          record.result = projectJsonValue({ value: part.output });
          record.outcome = { success: true };
        } else {
          record.result = { error: renderThrownChain({ cause: part.error }) };
          record.outcome = failedToolOutcome({ cause: part.error });
        }
      }
    },
  };

  return log;
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
  /** Provider calls observed. Zero means the episode never reached the model,
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
  evidence(): RequestSurfaceEvidence;
}

/** The I/O-boundary check for this wrapper's input. `LanguageModel` unions a
 *  bare model-id STRING with the two resolved specifications, and only the
 *  resolved ones carry a spec tag — so a successful parse IS the proof of
 *  resolution, and it doubles as the type guard the branches below need. */
const RESOLVED_LANGUAGE_MODEL = v.object({
  specificationVersion: v.picklist(['v2', 'v3']),
});

function isResolvedLanguageModel(model: LanguageModel): model is ModelV2 | ModelV3 {
  return v.safeParse(RESOLVED_LANGUAGE_MODEL, model).success;
}

/** The system message both model specifications agree on: role tag plus plain
 *  text. Parsing each prompt message against it is how the ladder probe reads
 *  the system block without reaching into representation. */
const SYSTEM_MESSAGE = v.object({ role: v.literal('system'), content: v.string() });

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
export function recordRequestSurface(model: LanguageModel): RecordedRequestSurface {
  if (!isResolvedLanguageModel(model)) {
    throw new Error(
      'recordRequestSurface needs a resolved LanguageModel, not a model id string: '
      + 'a string is resolved inside the SDK, where the request cannot be observed');
  }

  const offered = new Set<string>();
  let calls = 0;
  let systemChars = 0;
  let agentsIndexed = false;
  let runtimeFacts = true;

  const observe = (options: ObservedRequest): void => {
    calls += 1;

    for (const entry of options.tools ?? []) offered.add(entry.name);

    const system = options.prompt
      .flatMap((message) => {
        const parsed = v.safeParse(SYSTEM_MESSAGE, message);

        return parsed.success ? [parsed.output.content] : [];
      })
      .join('\n');

    systemChars = Math.max(systemChars, system.length);

    if (system.includes(AGENTS_INDEX_MARKER)) agentsIndexed = true;

    if (!JSON.stringify(options.prompt).includes(RUNTIME_SECTION_MARKER)) runtimeFacts = false;
  };

  const recording: LanguageModel = model.specificationVersion === 'v2'
    ? ({
      ...model,
      doGenerate: (options) => {
        observe(options);

        return model.doGenerate(options);
      },
      doStream: (options) => {
        observe(options);

        return model.doStream(options);
      },
    } satisfies ModelV2)
    : ({
      ...model,
      doGenerate: (options) => {
        observe(options);

        return model.doGenerate(options);
      },
      doStream: (options) => {
        observe(options);

        return model.doStream(options);
      },
    } satisfies ModelV3);

  return {
    model: recording,
    evidence: () => ({
      calls,
      toolsOffered: [...offered].sort(),
      agentsOffered: offered.has('agents'),
      agentsIndexed,
      systemChars,
      runtimeFacts: calls > 0 && runtimeFacts,
    }),
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

  rt.setProfileResolver(() => Promise.resolve(resolveAgentTurnProfile({
    envelope,
    provider,
    activeRoleId: role,
    workMode: 'build',
    availableTools: [],
    activeSkills: [],
  })));
}

/**
 * A `generateText` result's answer as a turn records it. Some models (e.g. Kimi K2.5) end on a tool-call step
 * with no trailing text, and the SDK puts only the final step's text in `result.text`.
 */
export function collectStepText(result: {
  text: string;
  steps: ReadonlyArray<{
    text: string;
    toolResults: Parameters<typeof synthesizeToolFallback>[0][number]['toolResults'];
  }>;
}): string {
  if (result.text) return result.text;
  const textParts = result.steps.flatMap((step) => (step.text ? [step.text] : []));

  if (textParts.length > 0) return textParts.join('\n\n');

  return synthesizeToolFallback(result.steps) || '(no response)';
}
