// Local HeadRuntime backing the `agents` fork action: each head runs in-process as
// a logical actor of the forked workspace, with actor-keyed rows in the one store
// (no per-head scratch database), so a head can take a claimed turn.

import type { LanguageModel, ToolSet } from 'ai';
import {
  type HeadRuntime, type HeadGrounding, type SpawnedHead, type HeadInput, type HeadReport,
  type WebSearchProvider, type CodemodeProvider,
  type HeadMergeModelBinder, type ResolvedTurnProfile,
  type PublishHeadStream,
  type MissionGovernor, type ModelCallSink, type ModelOperationSink,
  type DynamicContext, type HostedActor, type ProfileAuthorityInputs, type WorkMode, type WriteObserver,
  HeadCapture, runHeadInference, runHeadSplit, buildHeadToolSet, HeadController, REAL_CLOCK, type HeadJournal,
  createDbCodemodeProvider, createStateCodemodeProvider,
  headMergeLLM,
  localMissionScope,
} from '@kinu.run/core';
import { diagnostics, toKinuError, renderThrownChain } from '@kinu.run/core/obs';
import type { CLIRuntime } from './runtime';
import { createNodeCodemodeToolFactory } from './codemode-tool-factory';

/** One head's seat: the runtime objects its claimed loop runs on. Local twin of core's `HostedNodeSeat`. */
export interface HostedHeadSeat {
  readonly actor: HostedActor;
  readonly runId: string;
  readonly profile: (input: { readonly availableTools: readonly string[]; readonly workMode: WorkMode })
  => Promise<{ readonly profile: ResolvedTurnProfile; readonly inputs: ProfileAuthorityInputs }>;
  readonly dynamic: (profile: ResolvedTurnProfile, tools: ToolSet) => DynamicContext;
  /** Drop this head's runtime objects and retire its directory row. */
  release: () => Promise<void>;
}

export interface CLIHeadRuntimeDeps {
  /** Read per spawn: a resolver session claims its model on first turn, so it may
   *  not exist when the runtime is built. */
  model: () => LanguageModel;
  /** Profile the merge's `judge` route resolves against; read per merge. */
  profile: () => Promise<ResolvedTurnProfile>;
  bindMergeModel: HeadMergeModelBinder;
  /** Per-head model spec resolver. Absent or unresolvable falls back to `model`:
   *  one fork's bad spec should not fail the whole split. */
  resolveModel?: (spec: string) => LanguageModel;
  parentRuntime: CLIRuntime;
  webSearch: WebSearchProvider;
  /** Extra codemode namespaces, without `agents.*`/`agent.*`: a head never inherits authority to delegate. */
  codemodeExtras: () => CodemodeProvider[];
  /** Grounds head outcomes and the merge. Omit ⇒ neutral scores + n=1 merge. */
  grounding?: HeadGrounding;
  /** Read per head: the runtime is built before the governor exists. */
  governor: () => MissionGovernor;
  /** Read per head, for the same reason as `governor`. */
  journal: () => HeadJournal;
  publishHeadStream?: PublishHeadStream;
  /** Merge synthesis cost only. Head inference is aggregated from `head_journal`,
   *  and `summarizeCost` folds only head reports, so this is the merge's sole count. */
  reportModelCall: ModelCallSink;
  /** Merge call start/end rows; paired with `reportModelCall` so a cost never lacks its operation. */
  operations?: ModelOperationSink;
  /**
   * Seat one head as a logical actor. A factory: concurrent heads sharing one actor
   * would share one claim ledger. `writes` is the run's `HeadCapture.files`; without
   * it `fileChanges` reports nothing for a head that rewrote the tree.
   */
  hostHead: (input: HeadInput, writes: WriteObserver) => Promise<HostedHeadSeat>;
}

export function createCLIHeadRuntime(deps: CLIHeadRuntimeDeps): HeadRuntime {
  const runtime: HeadRuntime = {
    async spawnHead(input: HeadInput): Promise<SpawnedHead> {
      const abort = new AbortController();

      return {
        id: input.id,
        run: () => runLocalHead(input, deps, abort.signal),
        async abort(reason: string) { abort.abort(new Error(reason)); },
      };
    },
    mergeLLM: headMergeLLM({
      profile: deps.profile,
      bindMergeModel: deps.bindMergeModel,
      reportModelCall: deps.reportModelCall,
      operations: deps.operations,
    }),
  };

  return deps.grounding ? { ...runtime, grounding: deps.grounding } : runtime;
}

/** A bad spec degrades to the session model rather than failing the head. */
function headModel(input: HeadInput, deps: CLIHeadRuntimeDeps): LanguageModel {
  if (!input.model || !deps.resolveModel) return deps.model();

  try {
    return deps.resolveModel(input.model);
  } catch (err) {
    diagnostics.failure(
      'head.model_resolve_failed',
      toKinuError({
        doing: "resolving the model this head named, so it runs on the session's model instead",
        cause: err,
        otherwise: 'bad_input',
      }),
      { headId: input.id, model: input.model },
    );

    return deps.model();
  }
}

/**
 * `eval` over one hosted actor: `state.*` and `db` bind off the actor's own handle and stores, never the
 * parent's (a fork must not move its parent's program state), and code routes through its own runtime.
 */
export function hostedCodemodeTool(actor: HostedActor, extras: readonly CodemodeProvider[]): (finished: ToolSet) => ToolSet[string] {
  const sandbox = createNodeCodemodeToolFactory({
    extraProviders: [
      ...extras,
      createStateCodemodeProvider(actor.handle.programState),
      createDbCodemodeProvider(actor.stores.appData),
    ],
  });

  return (finished) => sandbox({
    native: finished,
    craftedTools: () => ({}),
    providers: actor.runtime.executionRouter?.getProviders() ?? [],
  });
}

/** Run one head in-process on a seat from the root's host; release keeps its rows. */
async function runLocalHead(input: HeadInput, deps: CLIHeadRuntimeDeps, signal: AbortSignal): Promise<HeadReport> {
  const capture = new HeadCapture();
  // `HeadReport.fileChanges` comes only from this observer, so the seat must wrap it.
  const seat = await deps.hostHead(input, capture.files);

  try {
    const rt = seat.actor.runtime;

    const tools = buildHeadToolSet({
      input,
      capture,
      rt,
      history: seat.actor.stores.history,
      codemodeTool: hostedCodemodeTool(seat.actor, deps.codemodeExtras()),
      webSearch: deps.webSearch,
      split: (request) => runHeadSplit(new HeadController(createCLIHeadRuntime(deps), deps.journal(), REAL_CLOCK), input, request),
    });

    const mission = localMissionScope(deps.governor(), input.missionLabels ?? []);
    const journal = deps.journal();

    const inferenceOptions: Parameters<typeof runHeadInference>[1] = {
      actor: seat.actor,
      clock: REAL_CLOCK,
      runId: seat.runId,
      profile: seat.profile,
      dynamic: seat.dynamic,
      model: headModel(input, deps), tools, capture,
      workspaceLayout: 'shared-workspace',
      signal,
      isAborted: () => signal.aborted,
      abortReason: () => signal.aborted ? renderThrownChain({ cause: signal.reason }) : null,
      reportStep: (seq, step) => journal.appendStep(input.id, seq, step),
      reportDelta: (kind, delta) => deps.publishHeadStream?.({ headId: input.id, kind, delta }),
    };

    if (mission) inferenceOptions.mission = mission;

    return await runHeadInference(input, inferenceOptions);
  } finally {
    await seat.release();
  }
}
