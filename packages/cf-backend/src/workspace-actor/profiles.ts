import {
  ancestorPins, collectWorkspaceAgentsMd, createAgentConfigStore, currentOperationProfile, InstructionApprovalDesk,
  InstructionApprovalStore, loadProfileAuthorityInputs, ownProfileChoices, resolveRoutingProfile, resolveTurnProfile,
  WORKSPACE_RUN_ID, type ActorHandle, type AgentsMdSources, type InstructionTrustResolver, type ModelCatalogSession,
  type ModelRouteResolution, type ModelWindow, type OperationProfile, type PinnedProfile, type ProfileAuthorityInputs,
  type ProfileCatalogEnvelope, type ResolvedTurnProfile, type RunEventRecorder, type WorkMode,
} from '@kinu.run/core';
import type { AccountReads } from '../account-reads';
import type { WorkspaceActorContext } from './context';

/** The workspace's turn as profiles read it: the mode a turn now would run in, and its operation if one is open. */
interface TurnState {
  mode(): Promise<WorkMode>;
  operation(): OperationProfile | null;
}

export interface ActorProfilesDeps {
  readonly context: WorkspaceActorContext;
  readonly account: AccountReads;
  readonly events: () => RunEventRecorder;
  readonly turn: TurnState;
  readonly catalog: ModelCatalogSession;
  /** Profiles the hosted actors' turns bound, by actor id. */
  readonly bound: ReadonlyMap<string, ResolvedTurnProfile>;
}

/**
 * Which profile, tier and model an actor of the workspace runs on, and the owner's instruction trust they read.
 * MODEL_ROUTE_POLICY is read against `routing()`: resolving a model any other way bypasses routing.
 */
export class ActorProfiles {
  /** The last profile a turn or a status read resolved. */
  private settled: ResolvedTurnProfile | null = null;
  private approvalStore: InstructionApprovalStore | null = null;
  private trustResolver: InstructionTrustResolver | null = null;
  private approvalDesk: InstructionApprovalDesk | null = null;

  constructor(readonly deps: ActorProfilesDeps) {}

  /** `record` lets core emit the `profile_resolution` run event; this backend only picks where it goes. */
  inputs(): Promise<ProfileAuthorityInputs> {
    return loadProfileAuthorityInputs({
      envelope: () => this.catalog(),
      provider: () => this.deps.context.models.profileProviderSnapshot(),
      record: (event) => this.deps.events().emit(WORKSPACE_RUN_ID, event),
    });
  }

  catalog(): Promise<ProfileCatalogEnvelope> {
    return this.deps.account.catalog();
  }

  /** The live turn's profile, else one resolved now for durable work without a chat turn. */
  routing(availableTools: readonly string[] = [], preparedMode?: WorkMode): Promise<ResolvedTurnProfile> {
    const { context } = this.deps;

    return resolveRoutingProfile({
      actor: context.actor(),
      resolve: async () => {
        const inputs = await this.inputs();

        return resolveTurnProfile({
          ...inputs,
          ...ownProfileChoices(context.config(), inputs),
          workMode: preparedMode ?? await this.deps.turn.mode(),
          availableTools,
          activeSkills: [],
        });
      },
    });
  }

  /** Resolved now, as this root's or hosted actor's next turn would. */
  async resolve(input: {
    readonly actor: ActorHandle;
    readonly availableTools: readonly string[];
    readonly workMode: WorkMode;
    /** An `ai.run` call's named tier overrides the actor's assignment for this call. */
    readonly explicitTier?: string | undefined;
  }): Promise<{ readonly profile: ResolvedTurnProfile; readonly inputs: ProfileAuthorityInputs }> {
    const inputs = await this.inputs();

    return {
      profile: resolveTurnProfile({
        ...inputs,
        ...ownProfileChoices(input.actor.config, inputs, this.ancestors(input.actor), { explicitTier: input.explicitTier }),
        workMode: input.workMode,
        availableTools: [...input.availableTools],
        activeSkills: [],
      }),
      inputs,
    };
  }

  /** Ancestors' own pins, nearest first, up to the root; none for an agent no one hired, whose own pins are the workspace's. */
  ancestors(actor: ActorHandle): PinnedProfile[] | undefined {
    if (actor.parentActorId === null) return undefined;
    const { context } = this.deps;

    return ancestorPins(actor.parentActorId, { actorId: context.actor().actorId, pins: context.config() }, (id) => {
      const parent = context.host().describe(id);

      return parent === null ? null : { parentActorId: parent.parentActorId, pins: createAgentConfigStore(context.sql(), id, actor.assertCurrent) };
    });
  }

  /** One model of a side route or of its chain, resolved the one way every side model is. */
  forResolution(resolution: Pick<ModelRouteResolution, 'model' | 'reasoningEffort'>) {
    return { spec: resolution.model, ...this.deps.context.models.resolveModelWithEffort(resolution.model, resolution.reasoningEffort) };
  }

  /** The operation the workspace agent's tools now run under: the call's, else its turn's. */
  operation(): OperationProfile | null {
    return currentOperationProfile(this.deps.context.actor()) ?? this.deps.turn.operation();
  }

  /** The profile this actor runs on now: its operation's, else the one its next turn resolves. */
  async current(): Promise<ResolvedTurnProfile> {
    const live = this.operation()?.profile;

    if (live !== undefined) return live;
    const { profile } = await this.resolve({ actor: this.deps.context.actor(), availableTools: [], workMode: 'build' });

    this.settled = profile;

    return profile;
  }

  /** The profile a turn of the workspace agent just assembled, read when nothing runs now. */
  settledOn(profile: ResolvedTurnProfile): void {
    this.settled = profile;
  }

  running(): ResolvedTurnProfile | null {
    return this.operation()?.profile ?? this.deps.bound.get(this.deps.context.actor().actorId) ?? this.settled;
  }

  /** Instruction trust (KINU-N028): one store over actor SQL, scoped to this workspace so a forked or copied root starts
   *  unapproved. */
  approvals(): InstructionApprovalStore {
    const { context } = this.deps;
    this.approvalStore ??= new InstructionApprovalStore(context.runtime().storage.sql, context.actor(), `cf:${context.workspaceName()}`);

    return this.approvalStore;
  }

  trust(): InstructionTrustResolver {
    const store = this.approvals();
    this.trustResolver ??= store.trustOf.bind(store);

    return this.trustResolver;
  }

  /** The workspace's instruction files, read through its sandbox where it has one. */
  agentsMd(window: ModelWindow, trust: InstructionTrustResolver): Promise<AgentsMdSources> {
    const rt = this.deps.context.runtime();

    return collectWorkspaceAgentsMd(rt.storage.vfs, window, trust, rt.executionRouter?.getProvider('computer'));
  }

  /** The owner's queue of instruction files to approve: derived on read, never stored, so the agent cannot fill it. */
  desk(): InstructionApprovalDesk {
    this.approvalDesk ??= new InstructionApprovalDesk({
      agentsMd: (window, trust) => this.agentsMd(window, trust),
      skillsVfs: this.deps.context.runtime().storage.vfs,
      approvals: this.approvals(),
      window: () => this.deps.catalog.window(),
    });

    return this.approvalDesk;
  }
}
