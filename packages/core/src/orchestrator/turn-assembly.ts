// One turn assembly for every actor kind on every backend; a backend supplies only the sources.

import type { ServedStores } from '../tools/actor-stores';
import type { ModelAttemptIdentity } from '../providers/attempt-identity';
import type { LanguageModel, ToolSet } from 'ai';
import { Effect } from 'effect';
import type { ModelWindow } from '../context-window';
import type { KinuExtension } from '../extension';
import type { Fact } from '../memory/facts';
import type { MailInContext } from '../mail/in-context';
import type { ActiveRoster } from '../types/dynamic-context';
import type { SpendGate } from '../mission-budget';
import { buildSystemPromptParts, renderUnverifiedInstructions, systemPromptText, type SystemPromptOptions } from '../prompt';
import type { AgentsMdSources } from '../prompting/agents-md';
import type { MediaModality } from '../prompting/attachment-sanitizer';
import type { PromptBackend, PromptIdentity } from '../prompting/surface';
import { withOperationProfile, type OperationProfile } from '../profiles/operation';
import { effectiveRoleCatalog } from '../profiles/catalog';
import { ownProfileChoices, resolveTurnProfile, type PinnedProfile, type ProfileAuthorityInputs, type ResolvedTurnProfile } from '../profiles/resolve';
import type { FrozenAuthority } from './turn-facts';
import type { TierId } from '../types/profile';
import { reasoningEffortOptions } from '../providers/effort';
import { KinuError, settleSync } from '../obs/index';
import type { CountableRequest, InputTokenCount } from '../providers/input-tokens';
import { parseModelSpec, type CacheRetention } from '../providers/types';
import type { ModelCallSpend, ModelOperationSink } from '../events/model-call';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ActiveSkillSet } from '../skills/types';
import type { DiscoverOpts } from '../skills/discover';
import { withTaskPlan, type TaskPlanContext } from '../tools/task-plan-scope';
import { withToolText, type ToolTextOverrides } from '../tools/tool-text';
import { withFamilyToolNotes } from '../prompting/tool-families';
import { resolvePromptModelProfile } from '../prompting/model-profile';
import { BUILTIN_TOOL_NAMES, type BuiltinToolName } from '../tools/registry';
import type { AgentsOp } from '../operations/agents';
import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
import type { InstructionTrustResolver } from '../types/instruction-trust';
import { callableToolNames, toolsForInvocation } from '../execution/work-mode';
import type { WorkMode } from '../types/turn';
import type { ActorExecutionInput } from './actor-session';
import type { ModelCatalogSession } from './model-catalog';
import type { CompactionTriggerReader } from './turn-context';
import { activatedSkillsBlock, filterToolSetBySkills, resolveTurnSkills, splitTurnSkills, type TurnSkillSurface, type TurnSkillsConfig } from './turn-surface';

export interface TurnModelSources {
  readonly catalog: Pick<ModelCatalogSession, 'window' | 'windowFor' | 'warm' | 'acceptedMedia' | 'callsTools'>;
  normalize(spec: string): string;
  resolve(spec: string): LanguageModel;
  readonly routed?: {
    attemptFor(spec: string): Promise<ModelAttemptIdentity | null>;
    countInputTokens(spec: string, request: CountableRequest): Promise<InputTokenCount>;
  };
}

/** Asked per turn, never captured. */
/** What a turn reads once, so every step's block is the same bytes. */
export interface TurnReads {
  readonly memoryTail: string | undefined;
  readonly activeSkills: ActiveSkillSet | null;
  readonly accountFacts?: readonly Fact[];
  readonly mail?: ActiveRoster<MailInContext>;
}

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
  /** The turn's tools in `workMode`, and the store operations they run. */
  toolset(workMode: WorkMode): TurnTools;
  /** MCP and extension tools, reachable only through `eval`. */
  externalTools(): Promise<ToolSet>;
  /** Non-builtin tools of `toolset` (`report`, `submit_plan`, `reply_to_comment`). */
  wiredToolNames(workMode: WorkMode): readonly string[];
  /** Namespaces reachable only inside `eval`. */
  codemodeCapabilities(workMode: WorkMode): readonly string[];
  agentsActions(workMode: WorkMode): readonly AgentsOp[];
  temporaryAsk(): boolean;
  soul(): Promise<string | undefined>;
  agentsMd(window: ModelWindow): Promise<AgentsMdSources>;
  identity(): Promise<PromptIdentity>;
  /** `versions`: the promoted versions the bodies are, which the turn's admission records. */
  artifacts(): { readonly sections: Readonly<Record<string, string>>; readonly tools: ToolTextOverrides; readonly versions: readonly string[] };
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
  dynamic(turn: TurnReads): ActorExecutionInput['dynamic'];
  /** The account's facts, read once per turn so every step renders the same block; absent where no account is wired.
   *  A read that fails answers none, and the turn goes on. */
  accountFacts?(): Promise<readonly Fact[]>;
  /** The agent's unread mail, read once per turn as the facts are; absent where it has no box, and a failed read none. */
  mail?(): Promise<ActiveRoster<MailInContext> | undefined>;
  /** MEMORY.md's tail, read once per turn so every step renders the same block. */
  memoryTail(): Promise<string | undefined>;
  operation(profile: ResolvedTurnProfile, inputs: ProfileAuthorityInputs): OperationProfile;
  /** Binds the resolved profile; `toolset` is read again after it. */
  settle?(profile: ResolvedTurnProfile, inputs: ProfileAuthorityInputs): void | Promise<void>;
  /** A run's brief in place of its role's section. */
  brief?(callable: readonly string[]): { readonly id: string; readonly label: string; readonly instructions: string };
}

/** A turn's tools and the store operations they run; null where its tools are served elsewhere (an agent's isolate,
 *  which runs the workspace's). */
export interface TurnTools {
  readonly tools: ToolSet;
  readonly stores: ServedStores | null;
}

/** A one-shot run brings its tools and brief; the actor brings the rest. */
export type RunTurnSources = Omit<TurnAssemblySources, 'toolset' | 'externalTools' | 'wiredToolNames' | 'codemodeCapabilities' | 'brief'>;

/** `hides`: the skills this turn's reader does not index yet (`dreamSkillsHidden`). */
export function vfsTurnSkills(vfs: VFS, config: TurnSkillsConfig, trust: InstructionTrustResolver, hides?: DiscoverOpts['hides']): TurnAssemblySources['skills'] {
  return (userText, roleSkills, limits) => resolveTurnSkills({ vfs, config, userText, roleSkills, trust, limits, ...(hides !== undefined && { hides }) });
}

export interface TurnAssemblyRequest {
  readonly userText: string;
  readonly workMode: WorkMode;
  readonly explicitTier?: TierId;
  /** Overrides the tier's model. */
  readonly model?: string;
  /** A recovered execution's authority, as it froze at its bind: it assembles on it and drafts nothing from the current
   *  settings, so a setting changed since cannot answer it differently. */
  readonly frozen?: FrozenAuthority;
  /** A person reads this turn's answer where its `<slate-ui>` pages are drawn (the web chat), not an agent or a terminal. */
  readonly pagesInAnswer?: boolean;
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
  if (request.frozen !== undefined) return frozenDraft(sources, request.frozen);
  const profileInputs = await sources.profileInputs();
  const ancestors = sources.ancestors?.() ?? [];
  const choices = sources.choices ?? ownProfileChoices(sources.config, profileInputs, ancestors.length === 0 ? undefined : ancestors, request.explicitTier === undefined ? {} : { explicitTier: request.explicitTier });
  const drafted = resolveTurnProfile({ ...profileInputs, ...choices, workMode: request.workMode, availableTools: [], activeSkills: [] });
  const served = sources.models.normalize(request.model ?? drafted.tier.model);

  return {
    profileInputs, ancestors, choices, drafted, served,
    roleSkills: effectiveRoleCatalog(profileInputs.envelope.catalog)[choices.roleId]?.skills ?? [],
    limits: sources.models.catalog.window(served),
  };
}

/** A recovered execution's draft, read from what it froze alone: its role's skills from the catalog it bound, its
 *  model the one its tier served. Nothing of the current settings is read. */
function frozenDraft(sources: Pick<TurnAssemblySources, 'models' | 'choices'>, frozen: FrozenAuthority): TurnDraft {
  const { profile, inputs } = frozen;
  const served = sources.models.normalize(profile.tier.model);

  return {
    profileInputs: inputs, ancestors: [], drafted: profile, served,
    choices: { roleId: profile.role.id, ...sources.choices },
    roleSkills: effectiveRoleCatalog(inputs.envelope.catalog)[profile.role.id]?.skills ?? [],
    limits: sources.models.catalog.window(served),
  };
}

/** The turn's profile over what it can reach: its builtins, its external tools, its wired names and its eval namespaces. */
function resolvedTurnProfile(sources: TurnAssemblySources, turn: Pick<TurnDraft, 'profileInputs' | 'choices' | 'drafted'> & {
  readonly workMode: WorkMode;
  readonly builtins: ToolSet;
  readonly external: ToolSet;
  readonly activeSkills: ActiveSkillSet | undefined;
}): ResolvedTurnProfile {
  const { drafted } = turn;

  return resolveTurnProfile({
    ...turn.profileInputs,
    ...turn.choices,
    workMode: turn.workMode,
    availableTools: [
      ...Object.keys(turn.builtins).filter((name) => BUILTIN_TOOL_NAMES.has(name)),
      ...Object.keys(turn.external),
      ...sources.wiredToolNames(drafted.workMode),
      ...sources.codemodeCapabilities(drafted.workMode),
    ],
    activeSkills: turn.activeSkills?.active.map((skill) => skill.name) ?? [],
  });
}

/** Effect-free: a measure between turns assembles too. */
/** What every step of the turn renders the same bytes of: MEMORY.md's tail, the account's facts and the agent's mail. */
async function readTurnOnce(sources: TurnAssemblySources, activeSkills: ActiveSkillSet | undefined): Promise<TurnReads> {
  const [memoryTail, accountFacts, mail] = await Promise.all([sources.memoryTail(), sources.accountFacts?.(), sources.mail?.()]);

  return { memoryTail, activeSkills: activeSkills ?? null, ...(accountFacts !== undefined && { accountFacts }), ...(mail !== undefined && { mail }) };
}

export async function assembleActorTurn(sources: TurnAssemblySources, request: TurnAssemblyRequest): Promise<AssembledTurn> {
  const { models } = sources;
  const { frozen } = request;
  // The tier never depends on the tools, so the drafted model is the served one; a frozen execution's is the one it froze.
  const { profileInputs, choices, roleSkills, drafted, served: spec, limits } = await draftTurn(sources, request);

  const { available: availableSkills, activeSkills } = await sources.skills(request.userText, roleSkills, limits);

  const skilled = (offered: TurnTools): TurnTools => ({ ...offered, tools: filterToolSetBySkills(offered.tools, activeSkills) });
  const drafting = skilled(sources.toolset(drafted.workMode));
  const builtins = drafting.tools;
  const external = await sources.externalTools();

  const profile = frozen?.profile ?? resolvedTurnProfile(sources, { profileInputs, choices, workMode: request.workMode, drafted, builtins, external, activeSkills });

  const operation = sources.operation(profile, profileInputs);
  await sources.settle?.(profile, profileInputs);
  const allowed = new Set(profile.allowedTools);
  const { workMode } = profile;
  // Read again: the resolved mode may be narrower, and a settled profile rebuilds its tools.
  const offered = sources.settle === undefined && workMode === drafted.workMode ? drafting : skilled(sources.toolset(workMode));
  const callable = pick(offered.tools, allowed);
  const artifacts = sources.artifacts();
  const taskPlan = sources.taskPlan();
  // Evolved text, written for this agent, wins over its family's.
  const invocable = toolsForInvocation(workMode, withToolText(withFamilyToolNotes(callable, resolvePromptModelProfile({ id: spec }).family), artifacts.tools));
  const tools = withOperationProfile(taskPlan === null ? invocable : withTaskPlan(invocable, taskPlan), operation);
  const externalTools = allowed.has('eval') ? pick(external, allowed) : {};
  const { pinned, invoked } = splitTurnSkills(activeSkills);

  const [window, agentsMd, soul, identity, reads] = await Promise.all([
    models.catalog.windowFor(spec), sources.agentsMd(limits), sources.soul(), sources.identity(), readTurnOnce(sources, activeSkills),
    models.catalog.warm(profile.tier.fallbacks.map((fallback) => fallback.model)),
  ]);

  const prompt: SystemPromptOptions = {
    executors: sources.executors(),
    availableTools: Object.keys(callable).filter((name): name is BuiltinToolName => BUILTIN_TOOL_NAMES.has(name)),
    agentsActions: allowed.has('agents') ? [...sources.agentsActions(workMode)] : [],
    temporaryAsk: sources.temporaryAsk(),
    backend: sources.backend,
    roleSection: sources.brief?.(callableToolNames(workMode, callable)) ?? profile.role,
    model: { id: spec, seesImages: models.catalog.acceptedMedia(spec).has('image') },
    sectionOverrides: artifacts.sections,
    identity,
    agentsMd,
    ...(availableSkills.lines.length > 0 && { availableSkills }),
    ...(pinned && { activeSkills: pinned }),
    ...(soul !== undefined && { soulOverride: soul }),
    ...(request.pagesInAnswer === true && { pagesInAnswer: true }),
  };

  const { provider, modelId } = parseModelSpec(spec);
  const providerOptions = reasoningEffortOptions(profile.tier.reasoningEffort, spec);

  const system = buildSystemPromptParts(sources.rt, prompt);

  const chat: ActorExecutionInput['chat'] = {
    model: models.resolve(spec),
    modelSpec: spec,
    // Without `modelOutputLimit` the whole window reads as the answer's allowance.
    modelContext: { id: spec, contextWindow: window.contextWindow, modelOutputLimit: window.modelOutputLimit, callsTools: models.catalog.callsTools(spec) },
    system: systemPromptText(system),
    systemShared: system.shared.length,
    attachments: { accepts: models.catalog.acceptedMedia(spec), vfs: sources.rt.storage.vfs, planes: sources.rt.planes, budget: sources.attachmentBudget },
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
      dynamic: sources.dynamic(reads),
      // Out of the cached prefix.
      instructions: renderUnverifiedInstructions({ agentsMd, activeSkills: pinned }),
      activated: invoked ? activatedSkillsBlock(invoked) : null,
      scaffoldSpend: sources.scaffoldSpend,
      stores: offered.stores,
      artifactVersions: artifacts.versions,
    },
    profile, profileInputs, operation, externalTools, activeSkills: activeSkills ?? null, window,
  };
}

function routedChat(models: TurnModelSources, spec: string, profile: ResolvedTurnProfile): Partial<ActorExecutionInput['chat']> {
  const { routed } = models;

  if (routed === undefined) return {};

  return {
    attemptOf: (fallback: string) => routed.attemptFor(fallback),
    countInputTokens: (counted: CountableRequest) => routed.countInputTokens(spec, counted),
    retries: profile.retries,
    fallbacks: profile.tier.fallbacks.map(({ model, reasoningEffort }) => {
      const fallback = models.normalize(model);
      const fallbackProvider = parseModelSpec(fallback).provider;

      return {
        spec: fallback,
        accepts: models.catalog.acceptedMedia(model),
        window: models.catalog.window(model),
        bind: () => ({ model: models.resolve(fallback), provider: fallbackProvider, providerOptions: reasoningEffortOptions(reasoningEffort, fallback) }),
      };
    }),
  };
}

/** The trigger measured over the durable history, under `key`. */
export function withCompactionTrigger(
  execution: Omit<ActorExecutionInput, 'task'>, state: CompactionTriggerReader, key: string, historyLength: number,
): Omit<ActorExecutionInput, 'task'> {
  const measured = state.takeTrigger(key, historyLength);

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
interface PinValues {
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
  readonly agentsActions: readonly AgentsOp[];
  readonly temporaryAsk: boolean;
  readonly soul: string | null;
  readonly identity: PromptIdentity;
  readonly agentsMd: AgentsMdSources;
  readonly memoryTail: string | null;
  readonly artifacts: ReturnType<TurnAssemblySources['artifacts']>;
  readonly conversationKey: string;
  readonly models: Readonly<Record<string, { readonly window: ModelWindow; readonly media: readonly MediaModality[]; readonly callsTools: boolean | undefined }>>;
}

export async function materializeTurnSources(sources: TurnAssemblySources, request: TurnAssemblyRequest): Promise<TurnSourcesBundle> {
  const { models } = sources;
  const { profileInputs, ancestors, roleSkills, drafted: { tier, workMode }, served, limits } = await draftTurn(sources, request);
  const specs = [served, ...tier.fallbacks.map((fallback) => models.normalize(fallback.model))];
  await models.catalog.warm(specs);

  const [skills, soul, identity, agentsMd, memoryTail, windows] = await Promise.all([
    sources.skills(request.userText, roleSkills, limits), sources.soul(), sources.identity(), sources.agentsMd(limits), sources.memoryTail(),
    Promise.all(specs.map(async (spec) => [spec, {
      window: await models.catalog.windowFor(spec), media: [...models.catalog.acceptedMedia(spec)], callsTools: models.catalog.callsTools(spec),
    }] as const)),
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
    memoryTail: memoryTail ?? null,
    artifacts: sources.artifacts(),
    conversationKey: sources.conversationKey(),
    models: Object.fromEntries(windows),
  };
}

/** What the assembling isolate supplies itself. */
export type LocalTurnSources = Omit<TurnAssemblySources,
  'backend' | 'executors' | 'profileInputs' | 'ancestors' | 'skills' | 'wiredToolNames' | 'codemodeCapabilities' | 'agentsActions' | 'temporaryAsk'
  | 'soul' | 'identity' | 'agentsMd' | 'memoryTail' | 'artifacts' | 'conversationKey' | 'models' | 'toolset' | 'externalTools'> & {
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
    callsTools(spec) {
      const model = read(spec);

      if (model !== undefined) return model.callsTools;

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
    memoryTail: async () => bundle.memoryTail ?? undefined,
    artifacts: () => bundle.artifacts,
    conversationKey: () => bundle.conversationKey,
  };
}
