// Local HeadRuntime backing the `agents` fork action: each head runs in-process as
// a logical actor of the forked workspace, with actor-keyed rows in the one store
// (no per-head scratch database), so a head can take a claimed turn.

import type { ToolSet } from 'ai';
import { type HeadRuntime, type HeadGrounding, type HeadInput, type HeadSeat,
type WebSearchProvider,
type RouteModelBinder, type ResolvedTurnProfile,
type PublishHeadStream,
type MissionGovernor, type ModelCallSink, type ModelOperationSink,
type HostedActor, type WriteObserver,
runHeadSplit, HeadController, REAL_CLOCK, type HeadJournal,
codemodeSurface, actorNamespaces, hostedSurfaceActor, SURFACE_POLICY, headMergeLLM, spawnSeatedHead,
localMissionScope, type ToolSurfaceNarrowing, } from '@kinu.run/core'
import type { CLIRuntime } from './runtime';
import { createNodeCodemodeToolFactory } from './codemode-tool-factory';

export interface CLIHeadRuntimeDeps {
  /** Profile the merge's `judge` route resolves against; read per merge. */
  profile: () => Promise<ResolvedTurnProfile>;
  bindMergeModel: RouteModelBinder;
  parentRuntime: CLIRuntime;
  webSearch: WebSearchProvider;
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
      codemodeTool: (seat) => hostedCodemodeTool(seat.actor, deps.webSearch),
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

/**
 * `eval` over one hosted actor, a head or a swarm node, as a confined copy's programs reach it
 * (`SURFACE_POLICY.confined`): everything binds off the actor's own handle, stores and runtime, never the parent's (a
 * fork must not move its parent's program state), and it never inherits the authority to delegate.
 */
export function hostedCodemodeTool(
  actor: HostedActor, search: WebSearchProvider,
): (finished: ToolSet, reach: ToolSurfaceNarrowing) => ToolSet[string] {
  // A program here runs in this process, which holds no Browser Run socket client.
  const surface = hostedSurfaceActor(actor, {
    web: { search, files: actor.runtime.storage, browser: null },
    conversations: actor.stores.conversationSearch,
    vectorStore: null,
  });

  return (finished, reach) => createNodeCodemodeToolFactory({ namespaces: actorNamespaces(surface, SURFACE_POLICY.confined), reach })(codemodeSurface(actor.runtime, finished));
}
