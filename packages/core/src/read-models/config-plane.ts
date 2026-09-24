/** Agent config writes validate here because each is a trust boundary; `onChanged` is the per-backend part. */

import * as v from 'valibot';
import { DEFAULT_CONFIG } from '../config';
import type { AgentConfigStore, ShellApprovalMode } from '../config/store';
import type { ApprovalGrant } from '../safety/approval-gate';
import type { JsonValue } from '../utils/json';
import { REASONING_EFFORTS, type ReasoningEffort } from '../strategy/effort';
import { ADVISOR_SEVERITIES, type AdvisorSeverity } from '../advisor/review';

const SHELL_APPROVAL_MODES: readonly ShellApprovalMode[] = ['strict', 'allow_all', 'deny_all'];

const ReasoningEffortSchema = v.picklist(REASONING_EFFORTS);

const ShellApprovalModeSchema = v.picklist(SHELL_APPROVAL_MODES);

const ArrayBoundarySchema = v.array(v.unknown());

const SkillNamesSchema = v.array(v.string());

const AdvisorSeveritySchema = v.picklist(ADVISOR_SEVERITIES);

export interface SetModelDeps {
  readonly config: AgentConfigStore;
  /** Resolve a spec to its canonical form or throw: an unknown provider is a config-time error. */
  readonly normalize: (spec: string) => string;
  /** Drop whatever the old model bound (tool cache, model-bound session). */
  readonly onChanged: () => void;
}

/** MCTS knobs a user may set. No depth field: a depth cap beside a budget spells the same limit
 * twice; depth is owned by {@link DEFAULT_CONFIG} and, for a swarm, its preset. */
export interface MctsConfigView {
  explorationConstant: number;
  maxIterations: number;
  branchBudget: number;
}

export interface EvolutionConfigView {
  autoPromoteScaffold: boolean;
  gepaEvalBudget: number;
  shadowSampleRate: number;
  scaffoldExploreShare: number;
  advisorEnabled: boolean;
  /** Lowest severity that reaches the conversation; below it a note becomes a Changelog row. */
  advisorMinSeverity: AdvisorSeverity;
}

export function getStoredModelSpec(config: AgentConfigStore) {
  return { spec: config.getModel() };
}

export function setModel(deps: SetModelDeps, spec: string) {
  try {
    const normalized = deps.normalize(spec);
    deps.config.setModel(normalized);
    deps.onChanged();

    return { ok: true, spec: normalized };
  } catch (error) {
    throw new Error(`setModel(${spec}) failed`, { cause: error });
  }
}

export function getReasoningEffort(config: AgentConfigStore) {
  return { effort: config.getReasoningEffort() };
}

export function getProviderAccounts(config: AgentConfigStore) {
  return { accounts: config.getProviderAccounts() };
}

export function setProviderAccount(config: AgentConfigStore, provider: JsonValue, account: JsonValue) {
  const parsed = v.safeParse(v.tuple([v.string(), v.nullable(v.string())]), [provider, account]);

  if (!parsed.success) throw new Error('setProviderAccount takes a provider id and an account name or null');
  config.setProviderAccount(parsed.output[0], parsed.output[1]);

  return { ok: true as const, accounts: config.getProviderAccounts() };
}

export interface ReasoningEffortWrite<Effort extends ReasoningEffort | null> { ok: true; effort: Effort }

/** Null clears the setting: the tier's level applies again. */
export function setReasoningEffort(config: AgentConfigStore, effort: null): ReasoningEffortWrite<null>;
/** Wire input: the parameter stays as wide as a transport can deliver, so this setter validates. */
export function setReasoningEffort(config: AgentConfigStore, effort: JsonValue): ReasoningEffortWrite<ReasoningEffort>;
export function setReasoningEffort(config: AgentConfigStore, effort: JsonValue): ReasoningEffortWrite<ReasoningEffort | null> {
  if (effort === null) {
    config.setReasoningEffort(null);

    return { ok: true, effort: null };
  }

  const parsed = v.safeParse(ReasoningEffortSchema, effort);

  if (!parsed.success) throw new Error(`Invalid reasoning effort: ${v.is(v.string(), effort) ? effort : JSON.stringify(effort)}`);
  config.setReasoningEffort(parsed.output);

  return { ok: true, effort: parsed.output };
}

export function getShellApprovalMode(config: AgentConfigStore) {
  return { mode: config.getShellApprovalMode() };
}

/**
 * How `shell` handles 'gate' decisions; effective next turn, after `onChanged`.
 * strict (default): ask the owner. allow_all: treat as warn (trusted dev only). deny_all: reject gate and warn.
 */
export function setShellApprovalMode(
  deps: { config: AgentConfigStore; onChanged: () => void },
  mode: string,
) {
  const parsed = v.safeParse(ShellApprovalModeSchema, mode);

  if (!parsed.success) throw new Error(`invalid mode: ${mode}`);
  deps.config.setShellApprovalMode(parsed.output);
  deps.onChanged();

  return { ok: true, mode: parsed.output };
}

/** Standing grants (rule + executor): the revoke surface. Grants never widen reach; they only stop
 * the gate asking again. */
export function getShellApprovalGrants(config: AgentConfigStore) {
  return { grants: config.getShellApprovalGrants() };
}

/** No `onChanged`: the gate reads grants live, so a revocation applies to the next command. */
export function revokeShellApprovalGrants(config: AgentConfigStore, grants: readonly ApprovalGrant[]) {
  const parsed = v.safeParse(v.array(v.object({ rule: v.string(), executor: v.string() })), grants);

  if (!parsed.success) throw new Error('grants must be an array of { rule, executor }');
  config.revokeShellApproval(parsed.output);

  return { ok: true, grants: config.getShellApprovalGrants() };
}

export function getAlwaysActiveSkills(config: AgentConfigStore) {
  return { names: config.getAlwaysActiveSkills() };
}

/** An empty list clears the pin. */
export function setAlwaysActiveSkills(config: AgentConfigStore, names: JsonValue | readonly JsonValue[]) {
  const array = v.safeParse(ArrayBoundarySchema, names);

  if (!array.success) throw new Error('names must be a string array');
  const parsed = v.safeParse(SkillNamesSchema, array.output);

  if (!parsed.success) throw new Error('names must contain only strings');
  config.setAlwaysActiveSkills(parsed.output);

  return { ok: true, names: config.getAlwaysActiveSkills() };
}

export function getMctsConfig(config: AgentConfigStore): MctsConfigView {
  const o = config.getMctsOverrides();
  const d = DEFAULT_CONFIG.mcts;

  return {
    explorationConstant: o.explorationWeight ?? d.explorationWeight,
    maxIterations: o.budget ?? d.budget,
    branchBudget: o.branches ?? d.branches,
  };
}

/** Returns the effective config: what a clamped value became. */
export function setMctsConfig(config: AgentConfigStore, view: Partial<MctsConfigView>): MctsConfigView {
  config.setMctsOverrides({
    explorationWeight: view.explorationConstant,
    budget: view.maxIterations,
    branches: view.branchBudget,
  });

  return getMctsConfig(config);
}

export function getEvolutionConfig(config: AgentConfigStore): EvolutionConfigView {
  return {
    autoPromoteScaffold: config.getAutoPromoteScaffold(),
    gepaEvalBudget: config.getGepaEvalBudget(),
    shadowSampleRate: config.getShadowSampleRate(),
    scaffoldExploreShare: config.getScaffoldExploreShare(),
    advisorEnabled: config.getAdvisorEnabled(),
    advisorMinSeverity: config.getAdvisorMinSeverity(),
  };
}

/** Returns the effective config: what a clamped value became. */
export function setEvolutionConfig(
  config: AgentConfigStore,
  view: Partial<EvolutionConfigView>,
): EvolutionConfigView {
  if (view.autoPromoteScaffold !== undefined) config.setAutoPromoteScaffold(view.autoPromoteScaffold);

  if (view.gepaEvalBudget !== undefined) config.setGepaEvalBudget(view.gepaEvalBudget);

  if (view.shadowSampleRate !== undefined) config.setShadowSampleRate(view.shadowSampleRate);

  if (view.scaffoldExploreShare !== undefined) config.setScaffoldExploreShare(view.scaffoldExploreShare);

  if (view.advisorEnabled !== undefined) config.setAdvisorEnabled(view.advisorEnabled);

  if (view.advisorMinSeverity !== undefined) {
    config.setAdvisorMinSeverity(v.parse(AdvisorSeveritySchema, view.advisorMinSeverity));
  }

  return getEvolutionConfig(config);
}

