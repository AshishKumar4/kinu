/** Agent config writes validate here because each is a trust boundary; `onChanged` is the per-backend part. */

import { Effect } from 'effect';
import { settleSync } from '../obs/effect';
import * as v from 'valibot';
import type { AgentConfigStore, ShellApprovalMode } from '../config/store';
import type { ApprovalGrant } from '../safety/approval-gate';
import type { JsonValue } from '../utils/json';
import { ReasoningEffortSchema, type ReasoningEffort } from '../providers/reasoning-effort';
import { ADVISOR_SEVERITIES, type AdvisorSeverity } from '../advisor/review';

const SHELL_APPROVAL_MODES: readonly ShellApprovalMode[] = ['strict', 'allow_all', 'deny_all'];

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

export interface EvolutionConfigView {
  /** The agent learns from its turns; on by default. */
  learning: boolean;
  advisorEnabled: boolean;
  /** Lowest severity that reaches the conversation; below it a note becomes a Changelog row. */
  advisorMinSeverity: AdvisorSeverity;
}

export const EvolutionConfigViewSchema: v.GenericSchema<EvolutionConfigView> = v.object({
  learning: v.boolean(),
  advisorEnabled: v.boolean(),
  advisorMinSeverity: v.picklist(ADVISOR_SEVERITIES),
});

/** The workspace's stored model, as each surface reads it over the wire. */
export const StoredModelSpecSchema = v.object({ spec: v.nullable(v.string()) });

export function getStoredModelSpec(config: AgentConfigStore): v.InferOutput<typeof StoredModelSpecSchema> {
  return { spec: config.getModel() };
}

export const SetModelResultSchema = v.object({ ok: v.literal(true), spec: v.string() });

export function setModel(deps: SetModelDeps, spec: string) {
  const normalized = deps.normalize(spec);
  deps.config.setModel(normalized);
  deps.onChanged();

  return { ok: true, spec: normalized };
}

/** The reasoning effort a workspace holds; null where its tier decides. */
export const ReasoningEffortViewSchema = v.object({ effort: v.nullable(ReasoningEffortSchema) });

export function getReasoningEffort(config: AgentConfigStore): v.InferOutput<typeof ReasoningEffortViewSchema> {
  return { effort: config.getReasoningEffort() };
}

/** The account each provider's calls use, by provider. */
export const ProviderAccountsSchema = v.object({ accounts: v.record(v.string(), v.string()) });

export function getProviderAccounts(config: AgentConfigStore): v.InferOutput<typeof ProviderAccountsSchema> {
  return { accounts: config.getProviderAccounts() };
}

export function setProviderAccount(config: AgentConfigStore, provider: JsonValue, account: JsonValue) {
  return settleSync(Effect.gen(function* () {
    const parsed = v.safeParse(v.tuple([v.string(), v.nullable(v.string())]), [provider, account]);

    if (!parsed.success) return yield* Effect.die(new Error('setProviderAccount takes a provider id and an account name or null'));
    config.setProviderAccount(parsed.output[0], parsed.output[1]);

    return { ok: true as const, accounts: config.getProviderAccounts() };
  }));
}

export interface ReasoningEffortWrite<Effort extends ReasoningEffort | null> { ok: true; effort: Effort }

/** A reasoning-effort write as a client reads it: null when the write cleared it. */
export const ReasoningEffortWriteSchema = v.object({ ok: v.literal(true), effort: v.nullable(ReasoningEffortSchema) });

/** Null clears the setting: the tier's level applies again. */
export function setReasoningEffort(config: AgentConfigStore, effort: null): ReasoningEffortWrite<null>;
/** Wire input: the parameter stays as wide as a transport can deliver, so this setter validates. */
export function setReasoningEffort(config: AgentConfigStore, effort: JsonValue): ReasoningEffortWrite<ReasoningEffort>;
export function setReasoningEffort(config: AgentConfigStore, effort: JsonValue): ReasoningEffortWrite<ReasoningEffort | null> {
  return settleSync(Effect.gen(function* () {
    if (effort === null) {
      config.setReasoningEffort(null);

      return { ok: true, effort: null };
    }

    const parsed = v.safeParse(ReasoningEffortSchema, effort);

    if (!parsed.success) return yield* Effect.die(new Error(`Invalid reasoning effort: ${v.is(v.string(), effort) ? effort : JSON.stringify(effort)}`));
    config.setReasoningEffort(parsed.output);

    return { ok: true, effort: parsed.output };
  }));
}

export function getShellApprovalMode(config: AgentConfigStore) {
  return { mode: config.getShellApprovalMode() };
}

/**
 * How `shell` handles 'gate' decisions; effective next turn, after `onChanged`.
 * strict (default): ask the owner. allow_all: treat as warn (trusted dev only). deny_all: reject gate and warn.
 */
export function setShellApprovalMode(
  /** `onChanged`: a host that holds a built tool surface rebuilds it; one that builds a turn's tools per turn holds none. */
  deps: { config: AgentConfigStore; onChanged?: () => void },
  mode: string,
) {
  return settleSync(Effect.gen(function* () {
    const parsed = v.safeParse(ShellApprovalModeSchema, mode);

    if (!parsed.success) return yield* Effect.die(new Error(`invalid mode: ${mode}`));
    deps.config.setShellApprovalMode(parsed.output);
    deps.onChanged?.();

    return { ok: true, mode: parsed.output };
  }));
}

/** Standing grants (rule + executor): the revoke surface. Grants never widen reach; they only stop
 * the gate asking again. */
export function getShellApprovalGrants(config: AgentConfigStore) {
  return { grants: config.getShellApprovalGrants() };
}

/** No `onChanged`: the gate reads grants live, so a revocation applies to the next command. */
export function revokeShellApprovalGrants(config: AgentConfigStore, grants: readonly ApprovalGrant[]) {
  return settleSync(Effect.gen(function* () {
    const parsed = v.safeParse(v.array(v.object({ rule: v.string(), executor: v.string() })), grants);

    if (!parsed.success) return yield* Effect.die(new Error('grants must be an array of { rule, executor }'));
    config.revokeShellApproval(parsed.output);

    return { ok: true, grants: config.getShellApprovalGrants() };
  }));
}

export function getAlwaysActiveSkills(config: AgentConfigStore) {
  return { names: config.getAlwaysActiveSkills() };
}

/** An empty list clears the pin. */
export function setAlwaysActiveSkills(config: AgentConfigStore, names: JsonValue | readonly JsonValue[]) {
  return settleSync(Effect.gen(function* () {
    const array = v.safeParse(ArrayBoundarySchema, names);

    if (!array.success) return yield* Effect.die(new Error('names must be a string array'));
    const parsed = v.safeParse(SkillNamesSchema, array.output);

    if (!parsed.success) return yield* Effect.die(new Error('names must contain only strings'));
    config.setAlwaysActiveSkills(parsed.output);

    return { ok: true, names: config.getAlwaysActiveSkills() };
  }));
}

export function getEvolutionConfig(config: AgentConfigStore): EvolutionConfigView {
  return {
    learning: config.getLearning(),
    advisorEnabled: config.getAdvisorEnabled(),
    advisorMinSeverity: config.getAdvisorMinSeverity(),
  };
}

/** Returns the effective config: what a clamped value became. */
export function setEvolutionConfig(
  config: AgentConfigStore,
  view: Partial<EvolutionConfigView>,
): EvolutionConfigView {
  if (view.learning !== undefined) config.setLearning(view.learning);

  if (view.advisorEnabled !== undefined) config.setAdvisorEnabled(view.advisorEnabled);

  if (view.advisorMinSeverity !== undefined) {
    config.setAdvisorMinSeverity(v.parse(AdvisorSeveritySchema, view.advisorMinSeverity));
  }

  return getEvolutionConfig(config);
}

