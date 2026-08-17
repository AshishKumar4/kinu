/**
 * The agent's settable knobs, as one plane.
 *
 * Each pair is a read and a write over `agent_config`, and each write is a
 * trust boundary: the value arrives from an operator surface, so the
 * validation belongs with the store, not with whichever transport happened to
 * carry it. It used to live in the transports, which is why the same setter
 * validated on one backend and did not on another.
 *
 * What genuinely differs per backend is what a change INVALIDATES — a cached
 * ToolSet on one, the model-bound session state on another — so that is the
 * one thing a caller supplies (`onChanged`).
 */

import * as v from 'valibot';
import { DEFAULT_CONFIG } from '../config.js';
import type { AgentConfigStore, ShellApprovalMode } from '../config/store.js';
import { REASONING_EFFORTS } from '../strategy/effort.js';

const SHELL_APPROVAL_MODES: readonly ShellApprovalMode[] = ['strict', 'allow_all', 'deny_all'];
const ReasoningEffortSchema = v.picklist(REASONING_EFFORTS);
const ShellApprovalModeSchema = v.picklist(SHELL_APPROVAL_MODES);
const ArrayBoundarySchema = v.array(v.unknown());
const SkillNamesSchema = v.array(v.string());

export interface SetModelDeps {
  readonly config: AgentConfigStore;
  /** The backend's provider catalogue: resolve a spec to its canonical form,
   *  or throw if it names nothing. Validating here rather than on the next
   *  turn is the point — an unknown provider is a config-time error. */
  readonly normalize: (spec: string) => string;
  /** Drop whatever the old model bound (tool cache, model-bound session). */
  readonly onChanged: () => void;
}

export interface MctsConfigView {
  explorationConstant: number;
  maxIterations: number;
  maxDepth: number;
  branchBudget: number;
}

export interface EvolutionConfigView {
  reviewModel: string | null;
  autoPromoteScaffold: boolean;
  gepaEvalBudget: number;
  shadowSampleRate: number;
  scaffoldExploreShare: number;
}

/** The stored model spec, or null when unset (the registry picks a default). */
export function getStoredModelSpec(config: AgentConfigStore) {
  return { spec: config.getModel() };
}

/** Validate, store and invalidate. Effective on the next turn. */
export function setModel(deps: SetModelDeps, spec: string) {
  try {
    const normalized = deps.normalize(spec);
    deps.config.setModel(normalized);
    deps.onChanged();
    return { ok: true, spec: normalized };
  } catch (err) {
    throw new Error(`setModel(${spec}) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function getReasoningEffort(config: AgentConfigStore) {
  return { effort: config.getReasoningEffort() };
}

export function setReasoningEffort<Effort>(config: AgentConfigStore, effort: Effort) {
  const parsed = v.safeParse(ReasoningEffortSchema, effort);
  if (!parsed.success) throw new Error(`Invalid reasoning effort: ${String(effort)}`);
  config.setReasoningEffort(parsed.output);
  return { ok: true, effort: parsed.output };
}

export function getShellApprovalMode(config: AgentConfigStore) {
  return { mode: config.getShellApprovalMode() };
}

/**
 * How the `run` builtin handles 'gate' decisions from the approval-gate
 * review. Effective on the next turn, once `onChanged` has dropped the tool
 * surface the old mode built.
 *
 *   strict     — default; put gate decisions to the owner (sudo on their
 *                laptop, a force-push, a publish). Commands whose only harm
 *                is local to the agent's own workspace or sandbox are not
 *                gate decisions in the first place — see safety/approval-gate.ts.
 *   allow_all  — treat gate decisions as warn (logged + executed). Trusted
 *                dev environments only. Prefer a standing grant: it is the
 *                same convenience scoped to one rule on one executor.
 *   deny_all   — reject gate AND warn (env-dump, secret-file-read).
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

/**
 * The standing grants: every rule the owner has said "always" to, and where.
 *
 * This is the revoke surface. A grant is one line — `rm-recursive` on
 * `laptop` — so what it bought is legible without reading any code, and
 * dropping the line is the whole of taking it back. Grants never widen what a
 * command can reach; they only stop the gate asking again.
 */
export function getShellApprovalGrants(config: AgentConfigStore) {
  return { grants: config.getShellApprovalGrants() };
}

/** Revoke grants. The owner's own answers arrive here from the queue's
 *  'always' button and the CLI's "stop asking" option; this is how they are
 *  taken back. No `onChanged`: unlike the approval MODE, a grant binds nothing
 *  at tool-build time — the gate reads grants live, so a revocation takes
 *  effect on the very next command. */
export function revokeShellApprovalGrants<Grants>(config: AgentConfigStore, grants: Grants) {
  const parsed = v.safeParse(v.array(v.object({ rule: v.string(), executor: v.string() })), grants);
  if (!parsed.success) throw new Error('grants must be an array of { rule, executor }');
  config.revokeShellApproval(parsed.output);
  return { ok: true, grants: config.getShellApprovalGrants() };
}

/** Skills pinned always-active for this agent. Empty means none. */
export function getAlwaysActiveSkills(config: AgentConfigStore) {
  return { names: config.getAlwaysActiveSkills() };
}

/** Pin a set of skills. An empty list clears the pin. */
export function setAlwaysActiveSkills<Names>(config: AgentConfigStore, names: Names) {
  const array = v.safeParse(ArrayBoundarySchema, names);
  if (!array.success) throw new Error('names must be a string array');
  const parsed = v.safeParse(SkillNamesSchema, array.output);
  if (!parsed.success) throw new Error('names must contain only strings');
  config.setAlwaysActiveSkills(parsed.output);
  return { ok: true, names: config.getAlwaysActiveSkills() };
}

/** Effective MCTS knobs: stored overrides over the engine defaults — exactly
 *  what the think path and lifetime evolution will run with. */
export function getMctsConfig(config: AgentConfigStore): MctsConfigView {
  const o = config.getMctsOverrides();
  const d = DEFAULT_CONFIG.mcts;
  return {
    explorationConstant: o.explorationWeight ?? d.explorationWeight,
    maxIterations: o.budget ?? d.budget,
    maxDepth: o.maxDepth ?? d.maxDepth,
    branchBudget: o.branches ?? d.branches,
  };
}

export function setMctsConfig(config: AgentConfigStore, view: Partial<MctsConfigView>): Partial<MctsConfigView> {
  config.setMctsOverrides({
    explorationWeight: view.explorationConstant,
    budget: view.maxIterations,
    maxDepth: view.maxDepth,
    branches: view.branchBudget,
  });
  return view;
}

/** The self-evolution knobs: who judges the agent, whether a proven scaffold
 *  promotes itself, and how much each loop may spend. */
export function getEvolutionConfig(config: AgentConfigStore): EvolutionConfigView {
  return {
    reviewModel: config.getReviewModel(),
    autoPromoteScaffold: config.getAutoPromoteScaffold(),
    gepaEvalBudget: config.getGepaEvalBudget(),
    shadowSampleRate: config.getShadowSampleRate(),
    scaffoldExploreShare: config.getScaffoldExploreShare(),
  };
}

/** Set any subset of the evolution knobs. Returns the EFFECTIVE config, so a
 *  caller sees what a clamped value actually became. */
export function setEvolutionConfig(
  config: AgentConfigStore,
  view: Partial<EvolutionConfigView>,
): EvolutionConfigView {
  if (view.reviewModel !== undefined) config.setReviewModel(view.reviewModel);
  if (view.autoPromoteScaffold !== undefined) config.setAutoPromoteScaffold(view.autoPromoteScaffold);
  if (view.gepaEvalBudget !== undefined) config.setGepaEvalBudget(view.gepaEvalBudget);
  if (view.shadowSampleRate !== undefined) config.setShadowSampleRate(view.shadowSampleRate);
  if (view.scaffoldExploreShare !== undefined) config.setScaffoldExploreShare(view.scaffoldExploreShare);
  return getEvolutionConfig(config);
}
