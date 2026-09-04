/**
 * The behaviour harness: run one task through the real turn spine, then read
 * what the ledger recorded about HOW it was done.
 *
 * WHY THIS DRIVES `LocalAgentSession` IN-PROCESS. Every mechanism this tier
 * measures — steering, the craft loop, the completion gate, the context budget,
 * the file ledger, execution recovery — writes its `run_events` row when a TURN
 * CLOSES, from `closeTurnRun` (core/src/orchestrator/turn-lifecycle.ts:64-116).
 * A bare `generateText` call never closes a turn, so a harness built on one
 * would report a zero denominator for all seven scorers and read as a pass. This
 * is the same spine `kinu exec` uses, with no subprocess and no stdout
 * parsing.
 *
 * WHY IT SEEDS THE VFS AND NOT THE DISK. The workspace filesystem is durable
 * storage, not a directory: `createCLIRuntime` builds the Nimbus workspace
 * filesystem over the agent's own SQLite (`cli-backend/src/runtime.ts:298`), and
 * `WorkspaceBirthConfig` has no `cwd` at all. The `file` tool reads that VFS.
 * Seeding a temp directory on disk would leave the agent looking at an empty
 * workspace and produce exactly the zero-denominator corpus this tier exists to
 * detect — so the tree is written through `rt.storage.vfs`, which is what the
 * tool actually sees, and through the OPENED runtime's copy of it.
 *
 * WHY IT THROWS RATHER THAN RETURNING A ZERO. This is the load-bearing design
 * decision and it is not stylistic. `vitest-evals` writes `task.meta.eval` from
 * exactly two places — `applyAutomaticJudges` (dist/index.mjs:1393) and
 * `appendJudgeScore`, the explicit `toSatisfyJudge` path (:1447) — and BOTH are
 * reachable only from a result `run(...)` handed back. `clearRecordedTaskMeta`
 * (:1229) blanks the metadata at the start of every run, and the catch branch
 * (:1236-1272) writes only `meta.harness` before rethrowing. So a harness that
 * THROWS leaves no score in the emitted artifact, whereas an assertion in the
 * test body executes strictly after both writers and fixes only the verdict.
 *
 * That distinction is the difference between a red test and a clean number: an
 * agent that did nothing must not contribute a score to the pool a downstream
 * average or min-pass-rate gate reads. A failed case contributing the best
 * number in the pool is inverted contamination, not noise. Measured both ways
 * on the emitted JSON — a throwing harness yields `meta.eval` ABSENT with
 * `meta.harness` still PRESENT, so the diagnostic record survives and only the
 * score is withheld.
 *
 * The precondition itself is the one CL-Bench needed: 14 evolution events over
 * 14 turns, every one "ungraded (no follow-up) | 0 tool calls | 1 steps", with
 * 500 steps available and one used. That corpus was inert and its mean_gain of
 * -0.2 read as a measurement.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LanguageModel, ToolSet } from 'ai';
import type { JsonValue } from '@vitest-evals/core';
import * as v from 'valibot';

import type {
  AgentRuntime, AgentsToolAction, AgentsForkDeps, AgentsToolDeps, BuiltinToolName,
  EvalCase, LLMProviderConfig, ProfileCatalog, ProfileCatalogEnvelope,
  ProviderCatalogSnapshot, Shell,
} from '../../packages/core/src/index';
import {
  RunEventRecorder, activePromptSectionOverrides, agentsActionsFor, buildActorTools,
  buildSystemPromptSync, classifyToolFailure, createAgentConfigStore, createFactsStore,
  createAgentsCodemodeProvider, createMemoryCodemodeProvider, createTasksCodemodeProvider,
  currentDateForPrompt, initWorkspaceSchema, isBuiltinToolName, TaskListStore,
  BUILTIN_PROFILE_CATALOG, profileCatalogDigest, resolveAgentTurnProfile,
  WORKSPACE_RUN_ID,
} from '../../packages/core/src/index';
import {
  createDefaultWebSearchProvider, createWebCodemodeProvider,
} from '../../packages/core/src/web/index';
import { createWorkspace } from '../../packages/core/src/identity/index';
import { LocalAgentSession, type SessionEvent } from '../../packages/cli-backend/src/local-session';
import { openWorkspaceCLI } from '../../packages/cli-backend/src/open';
import {
  makeSql, makeWorkspaceSchemaSql, type CLIRuntime,
} from '../../packages/cli-backend/src/runtime';
import { createNodeExecuteToolFactory } from '../../packages/cli-backend/src/execute-tools-factory';
import { createNodeCraftedExecute } from '../../packages/cli-backend/src/craft-executor';
import {
  hardTaskFor, ledgerTotalsFromEvents, recordLiveModelEpisode,
  scoreTrajectory, seedHardTask, verifyHardTask, walkRunEvents,
  type EvalArmState, type EvalScoreRow, type HardTask, type LedgerTotals,
} from '@kinu.run/test-utils';
import { DegenerateRunError } from './episode-failure';

export type { LedgerTotals };

/**
 * THE EVAL AGENT'S SURFACE, BUILT BY THE PRODUCTION ROOTS.
 *
 * Two suites drive `generateText` directly rather than through
 * `LocalAgentSession` — the evolution proof, which needs a turn boundary it
 * controls so it can fire `reviewTurn` per challenge, and the exploration eval,
 * which measures whether the model REACHES for delegation. Both therefore build
 * the surface themselves, and both used to build a DIFFERENT one from the
 * product:
 *
 *   - the tools came from `buildBuiltinTools`, which by construction cannot
 *     hold `agents` (tools/actor-tools.ts: the delegation tool's implementation
 *     IS the search engine, so the factory that emits a node's own surface
 *     cannot register it). The product's actor root is `buildActorTools`. So
 *     every eval that asked "did the model delegate?" asked a model that had no
 *     delegation tool, and a zero was unreadable: model declined, or nothing to
 *     decline?
 *   - the prompt came from a hand-assembled `buildSystemPromptSync` option set.
 *     `agentsActions` was never passed and `agents` was never on
 *     `availableTools`, so `renderAgentStateSection` (prompt.ts:236) skipped the
 *     whole delegation ladder. The model was not shown the surface it was being
 *     scored on reaching for.
 *   - the codemode namespaces production wires as `extraProviders` (`agents.*`,
 *     `web.*`, `memory.*`, `tasks.*`) were absent, so `execute_tools` code the
 *     prompt teaches threw `not a function` inside the eval only.
 *
 * This builds BOTH from the roots `rebuildModelBoundState`
 * (cli-backend/src/local-session.ts:2822) and the turn assembly
 * (local-session.ts:1785) use, with the same deps, so a capability cannot be on
 * one and off the other. `craftedToolExecute` is the load-bearing one and the
 * reason this is a function rather than a literal: measured without it,
 * `workspace.createTool` succeeded, the store grew a row, and
 * `codemode.doubleIt(21)` still failed with "is not a function", because that
 * dep is what makes `craftedTools()` read the store and its absence SKIPS
 * crafted bindings silently rather than erroring. A craft score then recorded a
 * reuse that never executed.
 *
 * DECLARED DIFFERENCES FROM A LIVE SESSION, each named rather than left to be
 * discovered. All are documented non-degrading absences on their own
 * declarations, and none changes the surface the model is SHOWN:
 *   - `costModel` is a `ModelCatalogSession` a session owns; absent, a swarm's
 *     pre-run spend gate blends and says it blended (AgentsForkDeps:267-270).
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
  /** The production system prompt for one turn on this surface. A function
   *  because `activePromptSectionOverrides` is a read the evolution loop can
   *  change between turns, exactly as in the product. */
  systemPrompt(): string;
}

export function buildEvalAgentSurface(deps: EvalAgentSurfaceDeps): EvalAgentSurface {
  const { rt, model, llm } = deps;
  const sql = rt.storage.sql;
  const facts = createFactsStore(sql);
  const taskList = new TaskListStore(sql);
  const config = createAgentConfigStore(sql);
  const webSearch = createDefaultWebSearchProvider({ fetch: globalThis.fetch });
  const fork: AgentsForkDeps = { rt, model };
  const agents: AgentsToolDeps = { mode: 'build', fork };
  const tools = buildActorTools({
    rt,
    craftedToolExecute: createNodeCraftedExecute(),
    createExecuteTool: createNodeExecuteToolFactory({
      extraProviders: [
        createAgentsCodemodeProvider(() => agents),
        createWebCodemodeProvider(webSearch),
        createMemoryCodemodeProvider(() => ({ memory: rt.memory, facts, sql })),
        createTasksCodemodeProvider(taskList, config),
      ],
    }),
    codemodeLoader: { __cli: true },
    agents,
    effectClaims: { sql, turnId: () => WORKSPACE_RUN_ID },
    facts,
    webSearch,
  });
  const builtinTools = Object.keys(tools).filter(isBuiltinToolName);
  const agentsActions = agentsActionsFor(agents);
  return {
    tools,
    builtinTools,
    agentsActions,
    systemPrompt: () => buildSystemPromptSync(rt, {
      executors: rt.executionRouter?.listExecutors() ?? [],
      availableTools: builtinTools,
      agentsActions,
      // No child substrate here: the prompt must not advertise a rung the
      // action would refuse.
      temporaryAsk: false,
      externalTools: [],
      backend: 'cli-local',
      workMode: 'build',
      planSubmissionAvailable: false,
      model: { id: llm.model },
      currentDate: currentDateForPrompt(),
      sectionOverrides: activePromptSectionOverrides(sql),
    }),
  };
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
 * delegation calls now carries the evidence that separates "declined" from "was
 * never asked", and the two stop being the same observation.
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
}

/** The swarm rung's marker in the RENDERED section (section-templates.ts:296):
 *  `action=swarm` appears only when the ladder was rendered WITH the swarm
 *  rung, which is the fact §9.5 wants — not merely that a heading exists. */
const AGENTS_INDEX_MARKER = '- **agents** —';

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

  const observe = (options: ObservedRequest): void => {
    calls += 1;
    for (const entry of options.tools ?? []) offered.add(entry.name);
    const system = options.prompt
      .map((message) => v.safeParse(SYSTEM_MESSAGE, message))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.output.content)
      .join('\n');
    systemChars = Math.max(systemChars, system.length);
    if (system.includes(AGENTS_INDEX_MARKER)) agentsIndexed = true;
  };

  const recording: LanguageModel = model.specificationVersion === 'v2'
    ? ({
      ...model,
      doGenerate: (options) => { observe(options); return model.doGenerate(options); },
      doStream: (options) => { observe(options); return model.doStream(options); },
    } satisfies ModelV2)
    : ({
      ...model,
      doGenerate: (options) => { observe(options); return model.doGenerate(options); },
      doStream: (options) => { observe(options); return model.doStream(options); },
    } satisfies ModelV3);

  return {
    model: recording,
    evidence: () => ({
      calls,
      toolsOffered: [...offered].sort(),
      agentsOffered: offered.has('agents'),
      agentsIndexed,
      systemChars,
    }),
  };
}

/**
 * What one task run produced, as the WIRE shape a judge receives.
 *
 * Structurally JSON — mutable fields and an index signature — because
 * `vitest-evals` constrains a harness output to its own `JsonValue`, and a judge
 * that cannot receive the scores cannot report them. `EvalScoreRow` in
 * `eval-run.ts` is the deliberately readonly PERSISTED shape, and this is the
 * projection of it; the two are kept apart so `eval-run.ts` stays free of any
 * `vitest-evals` import. That is what makes the runner one deletable wrapper
 * rather than a dependency threaded through the record and the statistics.
 *
 * It is JSON-shaped for a second reason: the harness is the only thing holding
 * the workspace's SQLite, so scoring happens there and every judge is pure over
 * this — no database handle escapes into the suite.
 */
export interface BehaviourScoreJson {
  name: string;
  asserts: string;
  eligible: number;
  passed: number;
  rate: number | null;
  detail: string;
  [key: string]: JsonValue;
}

export type BehaviourProvenanceEventJson = Record<string, JsonValue> & {
  runId: string;
  timestamp: string;
  eventIndex: number;
  type: string;
  name?: string;
  durationMs?: number;
  failureClass?: string;
};

export interface BehaviourProvenanceJson {
  totalEvents: number;
  bound: number;
  events: BehaviourProvenanceEventJson[];
  [key: string]: JsonValue;
}

export interface BehaviourOutput {
  taskId: string;
  turns: number;
  toolCalls: number;
  toolNames: string[];
  scores: BehaviourScoreJson[];
  tokensIn: number;
  tokensOut: number;
  reasoningOut: number;
  /**
   * Bounded raw run-event provenance for this episode — what the ledger says
   * happened, with every content-bearing payload stripped. See
   * {@link collectRunEventProvenance}.
   */
  provenance: BehaviourProvenanceJson;
  [key: string]: JsonValue;
}

/**
 * Project the persisted rows onto the wire shape. Fresh literals, so the
 * index-signature target is satisfied without a cast.
 *
 * `measured` IS carried, and that is not cosmetic. This projection originally
 * dropped it, so the raw counts behind every ratio — the reference the candidate
 * was divided by, the target, the floor — reached the run record only inside the
 * `detail` STRING. The first live pilot's numbers had to be recovered by parsing
 * English out of a sentence. A ratio whose baseline does not survive beside it is
 * a ratio nobody can re-derive, which is the whole reason `measured` exists.
 */
function toScoreJson(rows: readonly EvalScoreRow[]): BehaviourScoreJson[] {
  return rows.map((row) => {
    const json: BehaviourScoreJson = {
      name: row.name, asserts: row.asserts, eligible: row.eligible,
      passed: row.passed, rate: row.rate, detail: row.detail,
    };
    return row.measured === undefined ? json : { ...json, measured: { ...row.measured } };
  });
}

/**
 * A small source tree in the agent's VFS, so a task has somewhere to act.
 *
 * `broken.ts` is wrong on purpose and `broken.test.ts` fails against it:
 * `ws-fix-broken` and `ws-recover-cmd` need the first obvious command to FAIL,
 * because execution recovery cannot be measured on a workspace where nothing
 * goes wrong. The TODOs exist so `ws-find-todo` has something real to find
 * rather than confirming an empty result.
 */
export async function seedWorkspaceTree(rt: AgentRuntime): Promise<void> {
  const { vfs } = rt.storage;
  await vfs.mkdir('src', { recursive: true });
  await vfs.writeFile('src/greet.ts', [
    'export function greet(name: string): string {',
    '  // TODO: support a locale argument',
    '  return `Hello, ${name}`;',
    '}',
  ].join('\n') + '\n');
  await vfs.writeFile('src/main.ts', [
    "import { greet } from './greet.ts';",
    '',
    '// TODO: read the name from argv',
    'console.log(greet("world"));',
    '',
    'export const VERSION = 1;',
  ].join('\n') + '\n');
  await vfs.writeFile('src/broken.ts', [
    'export function add(a: number, b: number): number {',
    '  return a - b;',
    '}',
  ].join('\n') + '\n');
  await vfs.writeFile('src/broken.test.ts', [
    "import { test, expect } from 'bun:test';",
    "import { add } from './broken.ts';",
    '',
    "test('add sums', () => { expect(add(2, 3)).toBe(5); });",
  ].join('\n') + '\n');
}

/**
 * What one episode's ledger says it did, off a LOCAL store.
 *
 * ONE REDUCER AND ONE WALK, both the seam's. This function used to declare its
 * own `LedgerTotals` interface and its own field-for-field copy of
 * `walkRunEvents` + `ledgerTotalsFromEvents` — two reducers feeding every
 * denominator in the corpus, which is exactly the drift the seam was written to
 * remove, and the copies had already diverged in their commentary. The
 * store-to-events step is the only thing that was ever local, so it is the only
 * thing left here.
 *
 * `LedgerTotals` is re-exported rather than redeclared because the research and
 * optimization families import it from this module.
 */
export function readLedgerTotals(db: Database): LedgerTotals {
  return ledgerTotalsFromEvents(walkRunEvents(new RunEventRecorder(makeSql(db))));
}

/** How many run events one observation's provenance may carry. A long episode
 *  can produce thousands of rows; the bound keeps a published record a record
 *  rather than a second copy of the ledger, and `totalEvents` beside it says
 *  exactly how much a clipped slice is not showing. */
const PROVENANCE_EVENT_BOUND = 500;

/**
 * The episode's raw run-event trail, bounded and stripped of everything that
 * could quote the prompt or a secret.
 *
 * WHY AT ALL. The published observation used to carry aggregates only — counts
 * with no order, no tool names beyond the flat list, no failure classes — so a
 * reader of the record asking "what did this attempt actually DO" had to reopen
 * the SQLite store named in `transcripts`, and after any retention sweep could
 * not answer at all. This carries the ledger's shape: every event in order,
 * each reduced to its structural facts.
 *
 * WHAT IS DROPPED, deliberately: `userMessage` (the prompt), `args`, `result`,
 * `messages`, `error`/`details` text (an error string can quote file contents),
 * and the model-authored prose fields (`rationale`, `mergedNarrative`,
 * `blindSpots`). What survives is what happened, never what was said. A failed
 * tool call keeps its failure CLASS from `classifyToolFailure` (`exit_127`,
 * `threw`, `denied`, …) so a record can be triaged without reopening anything.
 */
export function collectRunEventProvenance(db: Database): BehaviourProvenanceJson {
  // The seam's walk, for the reason `readLedgerTotals` uses it: this was the
  // second of the two local copies the seam's own docstring names, and a third
  // thing to keep in step with the recorder is how a reader gets a smaller
  // denominator than the episode had. The SORT stays here because it is this
  // record's own requirement — the walk is per-run and a published trail is read
  // in time order.
  const events = walkRunEvents(new RunEventRecorder(makeSql(db)));
  events.sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
    || a.runId.localeCompare(b.runId)
    || a.eventIndex - b.eventIndex);
  const projected = events.map((event): BehaviourProvenanceEventJson => {
    const base = {
      runId: event.runId,
      timestamp: event.timestamp,
      eventIndex: event.eventIndex,
      type: event.type,
    };
    if (event.type !== 'tool_call_end') return base;
    const toolCall: BehaviourProvenanceEventJson = {
      ...base,
      name: event.name,
    };
    if (event.durationMs !== undefined) toolCall.durationMs = event.durationMs;
    const failure = classifyToolFailure(event);
    if (failure) toolCall.failureClass = failure.reason;
    return toolCall;
  });
  return {
    totalEvents: projected.length,
    bound: PROVENANCE_EVENT_BOUND,
    events: projected.slice(0, PROVENANCE_EVENT_BOUND),
  };
}

export interface BehaviourHarnessOptions {
  readonly dir: string;
  readonly model: LanguageModel;
  readonly llm: LLMProviderConfig;
  readonly arm: EvalArmState;
  /** Databases opened so far. The suite closes them in teardown rather than the
   *  harness closing eagerly, because the run record is written last and reads
   *  these stores after every task has finished. */
  readonly opened: Database[];
  /** Observe the episode's events AS THEY LAND. The behaviour suite uses this to
   *  make an in-flight case's progress durable, so a run killed mid-episode
   *  reports what that case got through instead of losing it. Defaults to a
   *  no-op, which is what every non-resumable caller wants. */
  readonly onEvent?: (event: SessionEvent) => void;
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
 * `execute_tools` is built from `router?.getProviders() ?? []`
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
      + '`execute_tools` would be built with an empty provider surface, so every '
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

/** Executor kinds an episode may be measured on: planes whose filesystem is
 *  not the developer's. An allowlist rather than a `laptop` denylist, so a
 *  plane added later is refused until someone decides it is isolated. */
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
 * `gate:typecheck-coverage`. `createCLIRuntime` registers a `laptop`
 * ExecutorProvider rooted at `process.cwd()` unless told not to, and an episode
 * reaches every registered provider through `execute_tools` — so the harness
 * that omitted `hostRoot: null` handed each episode the developer's filesystem.
 */
export class UnsandboxedRuntimeError extends Error {
  constructor(readonly taskId: string, readonly executor: string) {
    super(`unsandboxed runtime for ${taskId}: executor \`${executor}\` runs on the `
      + 'developer\'s own machine. The eval must not run: an episode reaches every '
      + 'registered provider through `execute_tools`, and a corpus task that writes '
      + 'files then writes them into the repo the harness was launched from. Open the '
      + 'workspace with `hostRoot: null` (cli-backend/src/open.ts) — re-rooting the '
      + 'provider is not enough, because `laptop.writeFile` passes an absolute path '
      + 'through and `laptop.exec` can `cd` anywhere.');
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
export function requireSandboxedExecutors(taskId: string, rt: AgentRuntime): void {
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
 * profile: `rt.judgeModel` / `rt.fastLlm` / `rt.advisorLlm` come from
 * `resolveRoutedLane` (core/src/runtime-builder.ts:115-121) and `rt.llm.complete`
 * routes `reflection` through `ensureProfile()` (cli-backend/src/runtime.ts:
 * 395-420). A runtime with no profile and no resolver leaves all three lanes
 * undefined and throws on the fourth.
 *
 * THAT HOLE IS NOW CLOSED IN THE PRODUCT, and this function is no longer what
 * keeps a lane alive. `createCLIRuntime` installs its own authority
 * (cli-backend/src/profile-authority.ts, wired at runtime.ts:405-426), so every
 * runtime from `openWorkspaceCLI` routes by default and `setProfileResolver` has
 * ZERO callers in the product — it survives on `CLIRuntime` as this override.
 *
 * WHY THE OVERRIDE SURVIVES ANYWAY: the cost basis has to be the model the run
 * NAMED. Each live suite announces exactly one model through `liveModelTarget`
 * and prints it as what the run is billed as. The runtime's own default derives
 * its tier from the workspace's `agent_config` — which `createWorkspace` does not
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
  const config = createAgentConfigStore(rt.storage.sql);
  const role = config.getRoleSelection();
  if (!rt.setProfileResolver) {
    throw new Error('this runtime exposes no setProfileResolver, so its model lanes cannot be '
      + 'wired and every judge, fast and reflection call would fail before reaching a model');
  }
  rt.setProfileResolver(() => Promise.resolve(resolveAgentTurnProfile({
    envelope,
    provider,
    activeRoleId: role.kind === 'catalog' ? role.roleId : 'general',
    workMode: 'build',
    availableTools: [],
    activeSkills: [],
  })));
}

/**
 * Refuse a runtime that cannot run a command, for a task whose ground truth IS a
 * command.
 *
 * Separate from {@link requireExecutorSurface} because it is a different fact:
 * `executionRouter` is what the agent's tools reach, and `rt.shell` is what the
 * VERIFIER reaches. A hard task on a shell-less runtime would score every attempt
 * zero for a reason that has nothing to do with the agent, and a corpus of
 * unearned zeros is as useless as one of unearned ones. Checked before the model
 * is driven, so the misconfiguration costs nothing.
 *
 * EXPORTED because the live swarm eval needs the same fact for the same reason: its
 * objective's verifier is `exec-ratio`, which spawns node inside this shell, so a
 * shell-less runtime would report every candidate unmeasurable and the search would
 * conclude that the model found nothing. One check, two callers — a second copy is a
 * second thing to keep in step with `AgentRuntime`.
 */
export function requireVerifierShell(taskId: string, rt: AgentRuntime): Shell {
  const shell = rt.shell;
  if (!shell) {
    throw new DegenerateRuntimeError(taskId,
      'rt.shell is absent, so this task\'s verifier could not run its measurement harness '
      + 'and every attempt would score zero for a reason that is not about the agent');
  }
  return shell;
}

/**
 * Run `task`, score the ledger, and refuse to return an inert trajectory.
 *
 * WHY IT OPENS THE WORKSPACE INSTEAD OF RUNNING THE ONE `createWorkspace`
 * RETURNS. `createWorkspace` is the BIRTH path — production calls it once, from
 * `kinu agent create` (cli/src/agent-create.ts:187), and the runtime it hands
 * back is what `cli-backend/src/open.ts:49-50` calls "degraded inline
 * VFS/Memory/Executor". Every surface that actually RUNS a turn — the chat
 * client, the daemon, `evolve` — goes through `openWorkspaceCLI`, which builds
 * the real one. The difference is not cosmetic: the degraded runtime registers
 * NO `ExecutorProvider`, so it has no `executionRouter` at all, and every
 * `execute_tools` block fails with `workspace.createTool is not a function`.
 * Measured both ways on the same scripted episode — degraded: no `craft_cycle`
 * row and `craft_reuse` eligible 0; opened: `crafted:["doubleIt"]`,
 * `reused:["doubleIt"]`, eligible 1. Three flash runs blamed that zero on the
 * corpus. `initWorkspaceSchema` between the two is what `agent-create.ts:189`
 * does, and without it the workspace is missing tables (`head_journal`, per
 * agent-evals.ts:120-122).
 *
 * WHY `oneShot: true`. It is the literal contract — this harness hands over one
 * task and grades what it leaves behind, with nobody reading the answer — and it
 * is the ONLY thing that arms the completion gate (local-session.ts:1514). An
 * interactive declaration made `completion_honesty` structurally unscoreable.
 *
 * `session.send` is awaited to completion because every row this reads is
 * written on settle: reading before settle would produce the zero denominator
 * this tier exists to eliminate, from a turn that was merely still running. The
 * gate's confirming turn is enqueued AFTER send resolves and runs on the pump,
 * so `settleBackgroundWork` is what lets that turn close and write its row.
 */
export async function runBehaviourTask(
  task: EvalCase, opts: BehaviourHarnessOptions,
): Promise<BehaviourOutput> {
  const workDir = join(opts.dir, task.id);
  mkdirSync(workDir, { recursive: true });

  const dbPath = join(workDir, 'agent.db');
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  opts.opened.push(db);

  await createWorkspace(db, {
    name: `behaviour-${task.id}`,
    purpose: 'A senior engineer working in the given workspace. Prefer real tool calls '
      + 'over describing what you would do, and break independent work apart.',
    llm: opts.llm,
  });
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  // `hostRoot: null`: no `laptop` executor, so the episode's only filesystem is
  // the workspace one this runtime owns. The default plane is rooted at
  // `process.cwd()` — the repo the suite was launched from.
  const { rt } = await openWorkspaceCLI(db, dbPath, { llm: opts.llm, hostRoot: null });

  // Before anything is driven or spent: a runtime that cannot execute is not a
  // measurement of an agent that can, and one that can execute on the
  // developer's machine is not a measurement either.
  requireExecutorSurface(task.id, rt);
  requireSandboxedExecutors(task.id, rt);

  // Seeded through the OPENED runtime's filesystem: the workspace the agent
  // reads is the one this runtime owns, not the inline VFS birth returned.
  const hard: HardTask | undefined = hardTaskFor(task);
  const shell = hard === undefined ? undefined : requireVerifierShell(task.id, rt);
  if (hard !== undefined) await seedHardTask(hard, rt.storage.vfs);
  if (task.tags?.includes('workspace')) await seedWorkspaceTree(rt);

  const session = new LocalAgentSession({
    rt, db, model: opts.model, onEvent: opts.onEvent ?? (() => {}),
    // The arm, not a convenience default: a run whose evolution was off is not a
    // measurement of evolution, and the run record says which it was.
    noAutoEvolve: !opts.arm.evolution,
    oneShot: true,
  });
  await session.send(task.task);
  await session.settleBackgroundWork();

  // WHAT THIS EPISODE COST, registered BEFORE the degenerate check below, because
  // a trajectory that produced nothing gradable still burned the tokens it took
  // to produce nothing: an `inert` episode whose spend is dropped on the throw is
  // the same lie in a smaller font. This suite drives a session rather than
  // calling `generateText`, so the store is the only place its usage exists —
  // `recordLiveModelEpisode` reads it through the workspace-spend seam, which is
  // why the behavioural tier no longer reports `0 model call(s)` over an episode
  // that spent hundreds of thousands of neurons.
  recordLiveModelEpisode(makeSql(db));

  const totals = readLedgerTotals(db);

  // DESIGN C — upstream of both `task.meta.eval` writers, because it throws
  // before `run(...)` returns. A degenerate trajectory is `inert`, never a zero.
  if (totals.turns === 0 || totals.toolCalls === 0) {
    throw new DegenerateRunError(task.id, totals.turns, totals.toolCalls, totals.failures);
  }

  // The OUTCOME, measured over the workspace the agent left behind and nothing
  // else — no trajectory, no model, no judge. It goes in the same `scores` array
  // as the mechanism covariates because `task_outcome` is a row NAME rather than a
  // parallel mechanism, which is what lets it inherit persistence, the paired
  // comparator and admissibility without a second statistics path.
  //
  // Measured AFTER `readLedgerTotals` on purpose: the verifier runs commands
  // through `rt.shell`, and reading the ledger first keeps the turn and tool-call
  // counts a property of the agent's episode rather than of its grading.
  const outcome: EvalScoreRow[] = hard === undefined || shell === undefined
    ? []
    : [await verifyHardTask(hard, {
      vfs: rt.storage.vfs,
      exec: (command) => shell.exec(command),
    })];

  return {
    taskId: task.id,
    turns: totals.turns,
    toolCalls: totals.toolCalls,
    toolNames: totals.toolNames,
    scores: toScoreJson([...outcome, ...scoreTrajectory(makeSql(db))]),
    tokensIn: totals.tokensIn,
    tokensOut: totals.tokensOut,
    reasoningOut: totals.reasoningOut,
    provenance: collectRunEventProvenance(db),
  };
}
