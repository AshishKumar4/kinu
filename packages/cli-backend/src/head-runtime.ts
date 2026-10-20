// Local HeadRuntime: each head of a branching run is an in-process actor of the workspace, seated by its host, with
// actor-keyed rows in the one store, so it takes a claimed turn as any agent does.

import { type HeadRuntime, type HeadGrounding, type HeadInput, type HeadSeat,
type WebSearchProvider,
type RouteModelBinder, type ResolvedTurnProfile,
type PublishHeadStream,
type MissionGovernor, type ModelCallSink, type ModelOperationSink,
type SeatedActor, type WriteObserver,
runHeadSplit, HeadController, REAL_CLOCK, type HeadJournal,
actorNamespaces, hostedSurfaceActor, SURFACE_POLICY, headMergeLLM, spawnSeatedHead,
localMissionScope, type CodemodeBuilder, } from '@kinu.run/core'
import { createNodeCodemodeToolFactory } from './codemode-tool-factory';

export interface CLIHeadRuntimeDeps {
  /** Profile the merge's `judge` route resolves against; read per merge. */
  profile: () => Promise<ResolvedTurnProfile>;
  bindMergeModel: RouteModelBinder;
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
      codemode: (seat) => hostedCodemodeTool(seat.actor, deps.webSearch),
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
 * `eval` over one hosted actor, a head or a swarm node: everything binds off the actor's own handle, stores and
 * runtime, never the parent's (a fork must not move its parent's program state), and it never inherits the authority
 * to delegate. A node's programs report where its native `report` does.
 */
export function hostedCodemodeTool(actor: SeatedActor, search: WebSearchProvider): CodemodeBuilder {
  return (codemode, reach) => {
    // A program here runs in this process, which holds no Browser Run socket client; it runs the store operations its
    // native tools run.
    const surface = hostedSurfaceActor(actor, {
      web: { search, files: actor.runtime.storage, browser: null },
      stores: codemode.stores,
      // Mail is the cloud account's (docs/MAIL.md §3); a local run has none.
      mail: null,
      // A head or a swarm node, whose run ends with it, holds no wait on its owner.
      ownerWaits: null,
    });

    const reported = codemode.report;

    return createNodeCodemodeToolFactory({
      namespaces: actorNamespaces(surface, SURFACE_POLICY.program, reported === undefined ? {} : { report: () => reported }), reach,
    })(codemode);
  };
}
