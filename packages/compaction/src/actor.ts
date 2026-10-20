import type { LanguageModel } from 'ai';
import type { EnginePorts } from '@better-compact/core';
import { DynamicContextLedger, type ModelCallSpend, type ModelCallReport, type ModelOperationSink, type ResolvedTurnProfile, type SeatedActor, type TurnModelSources } from '@kinu.run/core';
import { diagnostics, KinuError } from '@kinu.run/core/obs';
import type { AttachmentDeps } from './attachments';
import { createCompactionExtension, type CompactionExtension, type EphemeralContextPlane } from './extension';
import { createCompactionStateStore, createVfsTranscriptStore, type CompactionStateStore } from './stores';
import { createModelSummarizer } from './summarizer';

export interface ActorCompactionDeps {
  readonly files: AttachmentDeps['files'];
  readonly state: Pick<CompactionStateStore, 'plans' | 'archive'>;
  readonly ledger: EphemeralContextPlane & { reset(): void };
  readonly logger: EnginePorts['logger'];
  readonly summarizer: () => LanguageModel;
  readonly spend: Omit<ModelCallSpend, 'source'>;
  readonly modelSpec?: () => string;
  /** The actor's file ledger: a compaction ends every read's authority to edit, as what it showed may be gone from view. */
  readonly reads?: { forgetReads(): void };
}

export const compactionDiagnostics: EnginePorts['logger'] = {
  info: (message) => { diagnostics.event('compaction.info', { message }); },
  debug: (message) => { diagnostics.event('compaction.debug', { message }); },
  warn: (message) => { diagnostics.failure('compaction.degraded', new KinuError('unavailable', message)); },
  error: (message) => { diagnostics.failure('compaction.failed', new KinuError('io', message)); },
};

export function createActorCompaction(deps: ActorCompactionDeps): CompactionExtension {
  return createCompactionExtension({
    ports: { transcripts: createVfsTranscriptStore(() => deps.files().storage.vfs), plans: deps.state.plans, logger: deps.logger },
    archive: deps.state.archive,
    summarize: createModelSummarizer(deps.summarizer, { source: 'compaction', ...deps.spend }, deps.modelSpec),
    ephemeral: deps.ledger,
    // Only a byte-stable replay keeps the ledger's frozen positions, and what reads showed in view.
    onOutcome: ({ outcome }) => {
      if (outcome === 'replayed') return;
      deps.ledger.reset();
      deps.reads?.forgetReads();
    },
    attachments: { files: deps.files },
  });
}

export interface HostedActorCompaction {
  readonly extension: CompactionExtension;
  readonly trigger: { readonly state: CompactionStateStore; readonly key: string };
}

/** A seated actor compacts over its own files; the turn it compacts for is its session's, where its turn runs here. */
export function hostedActorCompaction(actor: SeatedActor, deps: {
  readonly logger: ActorCompactionDeps['logger'];
  readonly models: Pick<TurnModelSources, 'normalize' | 'resolve'>;
  report(actor: SeatedActor, report: ModelCallReport): void;
  readonly operations?: ModelOperationSink;
  /** The turn's profile, dynamic block and file ledger, where its turn runs here; elsewhere none, and its own config
   *  names its model. */
  readonly turn?: { readonly profile: () => ResolvedTurnProfile | null; readonly ledger: DynamicContextLedger; readonly reads?: ActorCompactionDeps['reads'] };
}): HostedActorCompaction {
  const state = createCompactionStateStore(actor.runtime.storage.sql, actor.handle);
  const spec = () => deps.models.normalize(deps.turn?.profile()?.tier.model ?? actor.stores.config.getModel() ?? '');

  return {
    extension: createActorCompaction({
      files: () => actor.runtime, state, ledger: deps.turn?.ledger ?? new DynamicContextLedger(), logger: deps.logger,
      summarizer: () => deps.models.resolve(spec()), modelSpec: spec, ...(deps.turn?.reads !== undefined && { reads: deps.turn.reads }),
      spend: { report: (report) => deps.report(actor, report), operations: deps.operations },
    }),
    trigger: { state, key: actor.record.actorId },
  };
}
