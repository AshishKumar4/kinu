// One turn assembly for every actor kind on every backend; a backend supplies only the sources.

import type { LanguageModel, ToolSet } from 'ai';
import { Effect } from 'effect';
import type { ModelWindow } from '../context-window';
import type { KinuExtension } from '../extension';
import { readMemoryTail } from '../memory/note';
import type { SpendGate } from '../mission-budget';
import { buildSystemPromptSync, renderUnverifiedInstructions, type SystemPromptOptions } from '../prompt';
import type { AgentsMdSources } from '../prompting/agents-md';
import type { MediaModality } from '../prompting/attachment-sanitizer';
import type { PromptBackend, PromptIdentity } from '../prompting/surface';
import { withOperationProfile, type OperationProfile } from '../profiles/operation';
import { effectiveRoleCatalog } from '../profiles/catalog';
import { ownProfileChoices, resolveAgentTurnProfile, type PinnedProfile, type ProfileAuthorityInputs, type ResolvedTurnProfile } from '../profiles/resolve';
import { TierIdSchema, type TierId } from '../types/profile';
import type { JsonObject } from '../utils/json';
import * as v from 'valibot';
import { reasoningEffortOptions } from '../providers/effort';
import { KinuError, settleSync } from '../obs/index';
import type { CountableRequest, InputTokenCount } from '../providers/input-tokens';
import { parseModelSpec, type CacheRetention } from '../providers/types';
import type { ModelCallSpend, ModelOperationSink } from '../events/model-call';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ActiveSkillSet } from '../skills/types';
import { withTaskPlan, type TaskPlanContext } from '../tools/task-plan-scope';
import { withToolText, type ToolTextOverrides } from '../tools/tool-text';
import { BUILTIN_TOOL_NAMES, type AgentsToolAction, type BuiltinToolName } from '../tools/registry';
import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
import type { InstructionTrustResolver } from '../types/instruction-trust';
import { callableToolNames, toolsForInvocation } from '../execution/work-mode';
import type { WorkMode } from '../types/turn';
import type { ActorExecutionInput } from './actor-session';
import type { ModelCatalogSession } from './model-catalog';
import { measureCompactionTrigger, type CompactionTriggerReader } from './turn-context';
import { activatedSkillsBlock, filterToolSetBySkills, resolveTurnSkills, splitTurnSkills, type TurnSkillSurface, type TurnSkillsConfig } from './turn-surface';

export interface TurnModelSources {
  readonly catalog: Pick<ModelCatalogSession, 'window' | 'windowFor' | 'warm' | 'acceptedMedia'>;
  normalize(spec: string): string;
  resolve(spec: string): LanguageModel;
  readonly routed?: {
    credentialFor(spec: string): Promise<string | null>;
    countInputTokens(spec: string, request: CountableRequest): Promise<InputTokenCount>;
  };
}

/** Asked per turn, never captured. */
export interface TurnAssemblySources {
  readonly rt: AgentRuntime;
  readonly backend: PromptBackend;
  readonly config: PinnedProfile & { getCacheRetention(): CacheRetention };
  readonly models: TurnModelSources;
  skills(userText: string, roleSkills: readonly string[], limits: ModelWindow): Promise<TurnSkillSurface>;
  profileInputs(): Promise<ProfileAuthorityInputs>;
  /** The pins a caller read before its turn opened, so the turn reads them once; read here when absent. */
  readonly choices?: ReturnType<typeof ownProfileChoices>;
  ancestors?(): readonly PinnedProfile[];
  toolset(workMode: WorkMode): ToolSet;
  /** MCP and extension tools, reachable only through `eval`. */
  externalTools(window: ModelWindow): Promise<ToolSet>;
  /** Non-builtin tools of `toolset` (`report`, `submit_plan`). */
  wiredToolNames(workMode: WorkMode): readonly string[];
  /** Namespaces reachable only inside `eval`. */
  codemodeCapabilities(workMode: WorkMode): readonly string[];
  agentsActions(workMode: WorkMode): readonly AgentsToolAction[];
  temporaryAsk(): boolean;
  soul(): Promise<string | undefined>;
  agentsMd(window: ModelWindow): Promise<AgentsMdSources>;
  identity(): Promise<PromptIdentity>;
  artifacts(): { readonly sections: Readonly<Record<string, string>>; readonly tools: ToolTextOverrides };
  executors(): ReturnType<NonNullable<AgentRuntime['executionRouter']>['listExecutors']>;
  taskPlan(): TaskPlanContext | null;
  /** The conversation extensions keep their state under (`conversationKey`). */
  conversationKey(): string;
  /** Guards and charges each model step. */
  readonly budget?: SpendGate;
  readonly operations?: ModelOperationSink;
  readonly scaffoldSpend: ModelCallSpend;
  readonly attachmentBudget: NonNullable<ActorExecutionInput['chat']['attachments']>['budget'];
  readonly observeStream?: ActorExecutionInput['chat']['observeStream'];
  readonly paceStep?: ActorExecutionInput['chat']['paceStep'];
  extensions(): readonly KinuExtension[];
  dynamic(turn: { readonly memoryTail: string | undefined; readonly activeSkills: ActiveSkillSet | null }): ActorExecutionInput['dynamic'];
  operation(profile: ResolvedTurnProfile, inputs: ProfileAuthorityInputs): OperationProfile;
  /** Binds the resolved profile; `toolset` is read again after it. */
  settle?(profile: ResolvedTurnProfile, inputs: ProfileAuthorityInputs): void | Promise<void>;
  /** A run's brief in place of its role's section. */
  brief?(callable: readonly string[]): { readonly id: string; readonly label: string; readonly instructions: string };
}

/** A one-shot run brings its tools and brief; the actor brings the rest. */
export type RunTurnSources = Omit<TurnAssemblySources, 'toolset' | 'externalTools' | 'wiredToolNames' | 'codemodeCapabilities' | 'brief'>;

export function vfsTurnSkills(vfs: VFS, config: TurnSkillsConfig, trust: InstructionTrustResolver): TurnAssemblySources['skills'] {
  return (userText, roleSkills, limits) => resolveTurnSkills({ vfs, config, userText, roleSkills, trust, limits });
}

export interface TurnAssemblyRequest {
  readonly userText: string;
  readonly workMode: WorkMode;
  readonly explicitTier?: TierId;
  /** Overrides the tier's model. */
  readonly model?: string;
}

export interface AssembledTurn {
  readonly execution: Omit<ActorExecutionInput, 'task'>;
  readonly profile: ResolvedTurnProfile;
  readonly profileInputs: ProfileAuthorityInputs;
  readonly operation: OperationProfile;
  readonly externalTools: ToolSet;
  readonly activeSkills: ActiveSkillSet | null;
  readonly window: ModelWindow;
}

const TurnTierMetadataSchema = v.object({ profile_tier: v.optional(TierIdSchema) });

export function metadataTier(metadata: JsonObject | undefined): TierId | undefined {
  if (metadata === undefined) return undefined;
  const parsed = v.safeParse(TurnTierMetadataSchema, metadata);

  return parsed.success ? parsed.output.profile_tier : undefined;
}

/** The key a conversation's extension state (compaction's plans and archives) is kept under. */
export function conversationKey(affinity: string, conversation: string): string {
  return `${affinity}:${conversation}`;
}

/** What a turn is before its tools are known, resolved once: the bundle a facet is sent and the turn it assembles
 *  read the same choices. Neither the tier nor a role's imposed mode depends on the tools. */
interface TurnDraft {
  readonly profileInputs: ProfileAuthorityInputs;
  readonly ancestors: readonly PinnedProfile[];
  readonly choices: ReturnType<typeof ownProfileChoices>;
  readonly roleSkills: readonly string[];
  readonly drafted: ResolvedTurnProfile;
  readonly served: string;
  readonly limits: ModelWindow;
}

async function draftTurn(sources: Pick<TurnAssemblySources, 'profileInputs' | 'choices' | 'config' | 'ancestors' | 'models'>, request: TurnAssemblyRequest): Promise<TurnDraft> {
  const profileInputs = await sources.profileInputs();
  const ancestors = sources.ancestors?.() ?? [];
  const choices = sources.choices ?? ownProfileChoices(sources.config, profileInputs, ancestors.length === 0 ? undefined : ancestors, request.explicitTier === undefined ? {} : { explicitTier: request.explicitTier });
  const drafted = resolveAgentTurnProfile({ ...profileInputs, ...choices, workMode: request.workMode, availableTools: [], activeSkills: [] });
  const served = sources.models.normalize(request.model ?? drafted.tier.model);

  return {
    profileInputs, ancestors, choices, drafted, served,
    roleSkills: effectiveRoleCatalog(profileInputs.envelope.catalog)[choices.activeRoleId]?.skills ?? [],
    limits: sources.models.catalog.window(served),
  };
}

/** Effect-free: a measure between turns assembles too. */
export async function assembleActorTurn(sources: TurnAssemblySources, request: TurnAssemblyRequest): Promise<AssembledTurn> {
  const { models } = sources;
  // The tier never depends on the tools, so the drafted model is the served one.
  const { profileInputs, choices, roleSkills, drafted, served: spec, limits } = await draftTurn(sources, request);

  const { available: availableSkills, activeSkills } = await sources.skills(request.userText, roleSkills, limits);

  const builtins = filterToolSetBySkills(sources.toolset(drafted.workMode), activeSkills);
  const external = await sources.externalTools(limits);

  const profile = resolveAgentTurnProfile({
    ...profileInputs,
    ...choices,
    workMode: request.workMode,
    availableTools: [
      ...Object.keys(builtins).filter((name) => BUILTIN_TOOL_NAMES.has(name)),
      ...Object.keys(external),
      ...sources.wiredToolNames(drafted.workMode),
      ...sources.codemodeCapabilities(drafted.workMode),
    ],
    activeSkills: activeSkills?.active.map((skill) => skill.name) ?? [],
  });

  const operation = sources.operation(profile, profileInputs);
  await sources.settle?.(profile, profileInputs);
  const allowed = new Set(profile.allowedTools);
  const { workMode } = profile;
  // Read again: the resolved mode may be narrower, and a settled profile rebuilds its tools.
  const callable = pick(sources.settle === undefined && workMode === drafted.workMode ? builtins : filterToolSetBySkills(sources.toolset(workMode), activeSkills), allowed);
  const artifacts = sources.artifacts();
  const taskPlan = sources.taskPlan();
  const invocable = toolsForInvocation(workMode, withToolText(callable, artifacts.tools));
  const tools = withOperationProfile(taskPlan === null ? invocable : withTaskPlan(invocable, taskPlan), operation);
  const externalTools = allowed.has('eval') ? pick(external, allowed) : {};
  const { pinned, invoked } = splitTurnSkills(activeSkills);

  const [window, agentsMd, soul, identity, memoryTail] = await Promise.all([
    models.catalog.windowFor(spec), sources.agentsMd(limits), sources.soul(), sources.identity(), readMemoryTail(sources.rt.memory),
    models.catalog.warm(profile.tier.fallbacks.map((fallback) => fallback.model)),
  ]);

  const prompt: SystemPromptOptions = {
    executors: sources.executors(),
    availableTools: Object.keys(callable).filter((name): name is BuiltinToolName => BUILTIN_TOOL_NAMES.has(name)),
    agentsActions: allowed.has('agents') ? [...sources.agentsActions(workMode)] : [],
    temporaryAsk: sources.temporaryAsk(),
    backend: sources.backend,
    roleSection: sources.brief?.(callableToolNames(workMode, callable)) ?? profile.role,
    model: { id: spec },
    sectionOverrides: artifacts.sections,
    identity,
    agentsMd,
    ...(availableSkills.lines.length > 0 && { availableSkills }),
    ...(pinned && { activeSkills: pinned }),
    ...(soul !== undefined && { soulOverride: soul }),
  };

  const { provider, modelId } = parseModelSpec(spec);
  const providerOptions = reasoningEffortOptions(profile.tier.reasoningEffort, provider);

  const chat: ActorExecutionInput['chat'] = {
    model: models.resolve(spec),
    modelSpec: spec,
    // Without `modelOutputLimit` the whole window reads as the answer's allowance.
    modelContext: { id: spec, contextWindow: window.contextWindow, modelOutputLimit: window.modelOutputLimit },
    system: buildSystemPromptSync(sources.rt, prompt),
    attachments: { accepts: models.catalog.acceptedMedia(spec), vfs: sources.rt.storage.vfs, budget: sources.attachmentBudget },
    tools,
    conversationKey: sources.conversationKey(),
    cache: { providerId: provider, modelId, retention: sources.config.getCacheRetention() },
    ...(sources.budget !== undefined && { budget: sources.budget }),
    ...(sources.operations !== undefined && { operations: sources.operations }),
    ...(sources.observeStream !== undefined && { observeStream: sources.observeStream }),
    ...(sources.paceStep !== undefined && { paceStep: sources.paceStep }),
    ...(providerOptions !== undefined && { providerOptions }),
    ...routedChat(models, spec, profile),
  };

  return {
    execution: {
      loopVersion: await sources.rt.identity.scaffold.version(),
      chat,
      extensions: sources.extensions(),
      dynamic: sources.dynamic({ memoryTail, activeSkills: activeSkills ?? null }),
      // Out of the cached prefix.
      instructions: renderUnverifiedInstructions({ agentsMd, activeSkills: pinned }),
      activated: invoked ? activatedSkillsBlock(invoked) : null,
      scaffoldSpend: sources.scaffoldSpend,
    },
    profile, profileInputs, operation, externalTools, activeSkills: activeSkills ?? null, window,
  };
}

function routedChat(models: TurnModelSources, spec: string, profile: ResolvedTurnProfile): Partial<ActorExecutionInput['chat']> {
  const { routed } = models;

  if (routed === undefined) return {};

  return {
    credentialOf: (fallback: string) => routed.credentialFor(fallback),
    countInputTokens: (counted: CountableRequest) => routed.countInputTokens(spec, counted),
    retries: profile.retries,
    fallbacks: profile.tier.fallbacks.map(({ model, reasoningEffort }) => {
      const fallback = models.normalize(model);
      const fallbackProvider = parseModelSpec(fallback).provider;

      return {
        spec: fallback,
        accepts: models.catalog.acceptedMedia(model),
        window: models.catalog.window(model),
        bind: () => ({ model: models.resolve(fallback), provider: fallbackProvider, providerOptions: reasoningEffortOptions(reasoningEffort, fallbackProvider) }),
      };
    }),
  };
}

/** The trigger measured over the durable history, under `key`. */
export function withCompactionTrigger(
  execution: Omit<ActorExecutionInput, 'task'>, state: CompactionTriggerReader, key: string, historyLength: number,
): Omit<ActorExecutionInput, 'task'> {
  const measured = measureCompactionTrigger(state, key, historyLength);

  return {
    ...execution,
    chat: {
      ...execution.chat,
      transformTrigger: measured.trigger,
      ...(measured.providerReportedTokens !== undefined && { providerReportedTokens: measured.providerReportedTokens }),
    },
  };
}

function pick(tools: ToolSet, allowed: ReadonlySet<string>): ToolSet {
  return Object.fromEntries(Object.entries(tools).filter(([name]) => allowed.has(name)));
}

/** Pins as values, so they cross an isolate. */
export interface PinValues {
  readonly roleSelection: ReturnType<PinnedProfile['getRoleSelection']>;
  readonly assignedTier: ReturnType<PinnedProfile['getAssignedTier']>;
  readonly model: ReturnType<PinnedProfile['getModel']>;
  readonly reasoningEffort: ReturnType<PinnedProfile['getReasoningEffort']>;
}

/** An actor's turn sources read once where they live, as JSON, for an agent facet that assembles the turn. */
export interface TurnSourcesBundle {
  readonly backend: PromptBackend;
  readonly model: string;
  readonly executors: ReturnType<TurnAssemblySources['executors']>;
  readonly profileInputs: ProfileAuthorityInputs;
  readonly ancestors: readonly PinValues[];
  readonly skills: TurnSkillSurface;
  readonly wiredToolNames: readonly string[];
  readonly codemodeCapabilities: readonly string[];
  readonly agentsActions: readonly AgentsToolAction[];
  readonly temporaryAsk: boolean;
  readonly soul: string | null;
  readonly identity: PromptIdentity;
  readonly agentsMd: AgentsMdSources;
  readonly artifacts: ReturnType<TurnAssemblySources['artifacts']>;
  readonly conversationKey: string;
  readonly models: Readonly<Record<string, { readonly window: ModelWindow; readonly media: readonly MediaModality[] }>>;
}

export async function materializeTurnSources(sources: TurnAssemblySources, request: TurnAssemblyRequest): Promise<TurnSourcesBundle> {
  const { models } = sources;
  const { profileInputs, ancestors, roleSkills, drafted: { tier, workMode }, served, limits } = await draftTurn(sources, request);
  const specs = [served, ...tier.fallbacks.map((fallback) => models.normalize(fallback.model))];
  await models.catalog.warm(specs);

  const [skills, soul, identity, agentsMd, windows] = await Promise.all([
    sources.skills(request.userText, roleSkills, limits), sources.soul(), sources.identity(), sources.agentsMd(limits),
    Promise.all(specs.map(async (spec) => [spec, { window: await models.catalog.windowFor(spec), media: [...models.catalog.acceptedMedia(spec)] }] as const)),
  ]);

  return {
    backend: sources.backend,
    model: served,
    executors: sources.executors(),
    profileInputs,
    ancestors: ancestors.map((pins) => ({
      roleSelection: pins.getRoleSelection(), assignedTier: pins.getAssignedTier(), model: pins.getModel(), reasoningEffort: pins.getReasoningEffort(),
    })),
    skills,
    wiredToolNames: sources.wiredToolNames(workMode),
    codemodeCapabilities: sources.codemodeCapabilities(workMode),
    agentsActions: sources.agentsActions(workMode),
    temporaryAsk: sources.temporaryAsk(),
    soul: soul ?? null,
    identity,
    agentsMd,
    artifacts: sources.artifacts(),
    conversationKey: sources.conversationKey(),
    models: Object.fromEntries(windows),
  };
}

/** What the assembling isolate supplies itself. */
export type LocalTurnSources = Omit<TurnAssemblySources,
  'backend' | 'executors' | 'profileInputs' | 'ancestors' | 'skills' | 'wiredToolNames' | 'codemodeCapabilities' | 'agentsActions' | 'temporaryAsk'
  | 'soul' | 'identity' | 'agentsMd' | 'artifacts' | 'conversationKey' | 'models' | 'toolset' | 'externalTools'> & {
  readonly models: Omit<TurnModelSources, 'catalog'>;
};

/**
 * The bundle's sources, answered from it. It was read for one tier's models: a model it does not hold is refused,
 * never answered with another model's window or with no media.
 */
export function turnSourcesFromBundle(bundle: TurnSourcesBundle, local: LocalTurnSources): Omit<TurnAssemblySources, 'toolset' | 'externalTools'> {
  const read = (spec = bundle.model) => bundle.models[local.models.normalize(spec)];
  const unread = (spec = bundle.model) => new KinuError('missing', `The turn's sources were read for ${Object.keys(bundle.models).join(', ')}, not ${spec}.`);

  const catalog: TurnModelSources['catalog'] = {
    window(spec) {
      const model = read(spec);

      if (model !== undefined) return model.window;

      return settleSync(Effect.fail(unread(spec)));
    },
    windowFor: async (spec) => catalog.window(spec),
    warm: async () => {},
    acceptedMedia(spec) {
      const model = read(spec);

      if (model !== undefined) return new Set(model.media);

      return settleSync(Effect.fail(unread(spec)));
    },
  };

  return {
    ...local,
    backend: bundle.backend,
    executors: () => bundle.executors,
    models: { ...local.models, catalog },
    profileInputs: async () => bundle.profileInputs,
    ancestors: () => bundle.ancestors.map((values): PinnedProfile => ({
      getRoleSelection: () => values.roleSelection,
      getAssignedTier: () => values.assignedTier,
      getModel: () => values.model,
      getReasoningEffort: () => values.reasoningEffort,
    })),
    skills: async () => bundle.skills,
    wiredToolNames: () => bundle.wiredToolNames,
    codemodeCapabilities: () => bundle.codemodeCapabilities,
    agentsActions: () => bundle.agentsActions,
    temporaryAsk: () => bundle.temporaryAsk,
    soul: async () => bundle.soul ?? undefined,
    identity: async () => bundle.identity,
    agentsMd: async () => bundle.agentsMd,
    artifacts: () => bundle.artifacts,
    conversationKey: () => bundle.conversationKey,
  };
}
