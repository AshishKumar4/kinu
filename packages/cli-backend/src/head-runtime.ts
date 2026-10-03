// Local HeadRuntime backing the `agents` fork action: each head runs in-process as
// a logical actor of the forked workspace, with actor-keyed rows in the one store
// (no per-head scratch database), so a head can take a claimed turn.

import type { LanguageModel, ToolSet } from 'ai';
import {
  type HeadRuntime, type HeadGrounding, type HeadInput, type HeadSeat,
  type WebSearchProvider, type CodemodeProvider,
  type RouteModelBinder, type ResolvedTurnProfile,
  type PublishHeadStream,
  type MissionGovernor, type ModelCallSink, type ModelOperationSink,
  type HostedActor, type WriteObserver,
  runHeadSplit, HeadController, REAL_CLOCK, type HeadJournal,
  codemodeSurface, createDbCodemodeProvider, createStateCodemodeProvider,
  headMergeLLM, spawnSeatedHead,
  localMissionScope,
} from '@kinu.run/core';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';
import type { CLIRuntime } from './runtime';
import { createNodeCodemodeToolFactory } from './codemode-tool-factory';

export interface CLIHeadRuntimeDeps {
  /** Read per spawn: a resolver session claims its model on first turn, so it may
   *  not exist when the runtime is built. */
  model: () => LanguageModel;
  /** Profile the merge's `judge` route resolves against; read per merge. */
  profile: () => Promise<ResolvedTurnProfile>;
  bindMergeModel: RouteModelBinder;
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
  hostHead: (input: HeadInput, writes: WriteObserver) => Promise<HeadSeat>;
}

export function createCLIHeadRuntime(deps: CLIHeadRuntimeDeps): HeadRuntime {
  const runtime: HeadRuntime = {
    spawnHead: async (input) => spawnSeatedHead(input, {
      seat: deps.hostHead,
      model: async () => headModel(input, deps),
      codemodeTool: (seat) => hostedCodemodeTool(seat.actor, deps.codemodeExtras()),
      webSearch: deps.webSearch,
      split: () => (request) => runHeadSplit(new HeadController(createCLIHeadRuntime(deps), deps.journal(), REAL_CLOCK), input, request),
      mission: () => localMissionScope(deps.governor(), input.missionLabels ?? []),
      reportStep: (headId, seq, step) => deps.journal().appendStep(headId, seq, step),
      reportDelta: (kind, delta) => deps.publishHeadStream?.({ headId: input.id, kind, delta }),
    }),
    mergeLLM: headMergeLLM({
      profile: deps.profile,
      bindMergeModel: deps.bindMergeModel,
      reportModelCall: deps.reportModelCall,
      operations: deps.operations,
    }),
  };

  return deps.grounding ? { ...runtime, grounding: deps.grounding } : runtime;
}

/** A bad spec degrades to the session model (spec null) rather than failing the head. */
function headModel(input: HeadInput, deps: CLIHeadRuntimeDeps) {
  if (!input.model || !deps.resolveModel) return { model: deps.model(), spec: null };

  try {
    return { model: deps.resolveModel(input.model), spec: input.model };
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

    return { model: deps.model(), spec: null };
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

  return (finished) => sandbox(codemodeSurface(actor.runtime, finished));
}
