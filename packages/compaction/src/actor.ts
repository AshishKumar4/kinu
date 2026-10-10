import type { LanguageModel } from 'ai';
import type { EnginePorts } from '@better-compact/core';
import type { HostedActor, ModelCallSpend, ModelCallReport, ModelOperationSink, TurnModelSources } from '@kinu.run/core';
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
    // Only a byte-stable replay keeps the ledger's frozen positions.
    onOutcome: ({ outcome }) => {
      if (outcome !== 'replayed') deps.ledger.reset();
    },
    attachments: { files: deps.files },
  });
}

export interface HostedActorCompaction {
  readonly extension: CompactionExtension;
  readonly trigger: { readonly state: CompactionStateStore; readonly key: string };
}

export function hostedActorCompaction(actor: HostedActor, deps: {
  readonly logger: ActorCompactionDeps['logger'];
  readonly models: Pick<TurnModelSources, 'normalize' | 'resolve'>;
  report(actor: HostedActor, report: ModelCallReport): void;
  readonly operations?: ModelOperationSink;
}): HostedActorCompaction {
  const state = createCompactionStateStore(actor.runtime.storage.sql, actor.handle);
  const spec = () => deps.models.normalize(actor.session.profile?.tier.model ?? actor.stores.config.getModel() ?? '');

  return {
    extension: createActorCompaction({
      files: () => actor.runtime, state, ledger: actor.session.dynamic, logger: deps.logger,
      summarizer: () => deps.models.resolve(spec()), modelSpec: spec,
      spend: { report: (report) => deps.report(actor, report), operations: deps.operations },
    }),
    trigger: { state, key: actor.record.actorId },
  };
}
