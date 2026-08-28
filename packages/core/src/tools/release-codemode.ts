/**
 * `release.*` — the governed release lane, projected into the codemode
 * sandbox.
 *
 * Left the top-level tool surface: a governed, high-blast-radius, occasional
 * lane (self-modifying deploys) does not earn a standing choice on every
 * turn it is not the answer to. The machinery — the ledger, the approval
 * gate, the execution engine — is untouched; only the caller changed, from a
 * dedicated schema to this namespace's members, both funneling into the SAME
 * `runReleaseAction` dispatcher (tools/release-tool.ts) so there is one
 * implementation and one gate.
 *
 * Two halves, never both on one actor: where an execution engine drives the
 * working copy, apply/runChecks/preview/deploy/rollback earn their results
 * from real command output and the record_* ledger twins are refused as
 * assertions of what was never run. Where no engine is wired, the agent runs
 * the commands itself with `run`/`execute_tools` and recordCheck/
 * recordDeployment are the only way the ledger learns what happened. Which
 * half exists is read from `deps().engine`, same as the schema used to gate
 * on it.
 *
 * Flow with an engine: bindSource → create → update (store the unified
 * diff) → apply → runChecks → preview → requestApproval → deploy; rollback
 * reverts a bad deploy.
 * Flow without one: bindSource → create → update → transition →
 * recordCheck → requestApproval → recordDeployment, running every command
 * yourself first.
 */

import * as v from 'valibot';
import type { CodemodeProvider } from './sandbox-contract';
import { RELEASE_STATUSES } from '../release/index';
import { releaseToolActions, TOOL_REACH, type ReleaseToolAction } from './registry';
import { runReleaseAction, type ReleaseActionInput, type ReleaseToolDeps } from './release-tool';

/** Per-action sandbox declaration + description. Split into two records
 *  because a script sends member-specific arguments, not the flat native
 *  schema — `runReleaseAction` reassembles them into ReleaseActionInput. */
// Terse on purpose: "engine backends only" / "no-engine backends only" are
// never said per member — which half exists is ALREADY the fact that the
// member appears in the declaration at all (releaseToolActions(hasEngine)),
// so restating it on every line would be pure repetition within any one
// actor's actual rendering (it only ever sees one half).
const MEMBER_TYPES = {
  board: '  /** Every bound source and its changes. */\n  board(): Promise<unknown>;',
  bind_source: '  /** Bind a source repo (local checkout or GitHub) this workspace can change. */\n  bindSource(input: { kind: "local" | "github"; label: string; repoUrl?: string; defaultBranch?: string; localDeviceId?: string; localRoot?: string; deployTarget?: string }): Promise<unknown>;',
  create: '  /** Start a change against a bound source. */\n  create(input: { bindingId: string; userPrompt: string; plan?: string }): Promise<unknown>;',
  update: '  /** Store the plan/summary/unified-diff patch for a change. */\n  update(changeId: string, patch: { plan?: string; summary?: string; patch?: string; previewUrl?: string }): Promise<unknown>;',
  transition: `  /** Move to a new status; engine-owned targets are refused (earned by apply/runChecks/deploy instead). */\n  transition(changeId: string, status: ${RELEASE_STATUSES.map((s) => `"${s}"`).join(' | ')}): Promise<unknown>;`,
  request_approval: '  /** Ask the owner to approve a change. */\n  requestApproval(changeId: string, approvalType: "apply" | "deploy_staging" | "deploy_production" | "rollback"): Promise<unknown>;',
  record_check: '  /** Record a check YOU ran — the ledger has no other way to learn it happened. */\n  recordCheck(changeId: string, check: { name: string; status: "pending" | "running" | "passed" | "failed" | "skipped"; stdout?: string; stderr?: string; durationMs?: number }): Promise<unknown>;',
  record_deployment: '  /** Record a deployment YOU ran. */\n  recordDeployment(changeId: string, deployment: { environment: "local" | "staging" | "production"; workerVersionId?: string; deploymentId?: string; rollbackTarget?: string }): Promise<unknown>;',
  apply: '  /** Apply the stored patch for real — commit sha earned from the working copy. */\n  apply(changeId: string): Promise<unknown>;',
  run_checks: '  /** Run build/test/lint commands for real; pass/fail from real exit codes. */\n  runChecks(changeId: string, checks: Array<{ name: string; command: string }>): Promise<unknown>;',
  preview: '  /** Expose a live preview URL for the port your server listens on. */\n  preview(changeId: string, opts: { port: number; startCommand?: string }): Promise<unknown>;',
  deploy: '  /** Deploy for real; verified against actual command output. */\n  deploy(changeId: string, deployment: { environment: "local" | "staging" | "production"; command?: string }): Promise<unknown>;',
  rollback: '  /** Revert a bad deploy for real. */\n  rollback(changeId: string, opts?: { command?: string }): Promise<unknown>;',
} satisfies Record<ReleaseToolAction, string>;

const MEMBER_DESCRIPTIONS = {
  board: 'The board: every bound source and its changes.',
  bind_source: 'Bind a source repo (local checkout or GitHub) this workspace can change.',
  create: 'Start a change against a bound source.',
  update: 'Store the plan/summary/unified-diff patch for a change.',
  transition: 'Move a change to a new lifecycle status (engine-owned targets refused).',
  request_approval: 'Ask the owner to approve a change.',
  record_check: 'No-engine backends only: record a check you ran yourself.',
  record_deployment: 'No-engine backends only: record a deployment you ran yourself.',
  apply: 'Engine backends only: apply the stored patch for real.',
  run_checks: 'Engine backends only: run checks for real; pass/fail from real exit codes.',
  preview: 'Engine backends only: expose a live preview URL.',
  deploy: 'Engine backends only: deploy for real, verified against command output.',
  rollback: 'Engine backends only: revert a bad deploy for real.',
} satisfies Record<ReleaseToolAction, string>;

/** camelCase member name for each snake_case action — the codemode
 *  vocabulary matches every other namespace here (workspace.readFile,
 *  agents.hire), while the dispatcher keeps the original action strings. */
const MEMBER_NAMES = {
  board: 'board',
  bind_source: 'bindSource',
  create: 'create',
  update: 'update',
  transition: 'transition',
  request_approval: 'requestApproval',
  record_check: 'recordCheck',
  record_deployment: 'recordDeployment',
  apply: 'apply',
  run_checks: 'runChecks',
  preview: 'preview',
  deploy: 'deploy',
  rollback: 'rollback',
} satisfies Record<ReleaseToolAction, string>;

function renderTypes(actions: readonly ReleaseToolAction[]): string {
  return [
    'export declare const release: {',
    ...actions.map((action) => MEMBER_TYPES[action]),
    '};',
    '',
  ].join('\n');
}

function parseInput<TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: { value: unknown },
): v.InferOutput<TSchema> | undefined {
  const result = v.safeParse(schema, input.value);
  return result.success ? result.output : undefined;
}

const StringSchema = v.string();
const BindingSchema: v.GenericSchema<NonNullable<ReleaseActionInput['binding']>> = v.object({
  kind: v.optional(v.picklist(['local', 'github'])),
  label: v.optional(v.string()),
  repoUrl: v.optional(v.nullable(v.string())),
  defaultBranch: v.optional(v.nullable(v.string())),
  localDeviceId: v.optional(v.nullable(v.string())),
  localRoot: v.optional(v.nullable(v.string())),
  deployTarget: v.optional(v.nullable(v.string())),
});
const UpdateSchema = v.object({
  plan: v.optional(v.nullable(v.string())),
  summary: v.optional(v.nullable(v.string())),
  patch: v.optional(v.nullable(v.string())),
  previewUrl: v.optional(v.nullable(v.string())),
});
const StatusSchema = v.picklist(RELEASE_STATUSES);
const ApprovalTypeSchema = v.picklist(['apply', 'deploy_staging', 'deploy_production', 'rollback']);
const CheckSchema: v.GenericSchema<NonNullable<ReleaseActionInput['check']>> = v.object({
  name: v.optional(v.string()),
  status: v.optional(v.picklist(['pending', 'running', 'passed', 'failed', 'skipped'])),
  stdout: v.optional(v.nullable(v.string())),
  stderr: v.optional(v.nullable(v.string())),
  durationMs: v.optional(v.nullable(v.number())),
});
const DeploymentSchema: v.GenericSchema<NonNullable<ReleaseActionInput['deployment']>> = v.object({
  environment: v.optional(v.picklist(['local', 'staging', 'production'])),
  workerVersionId: v.optional(v.nullable(v.string())),
  deploymentId: v.optional(v.nullable(v.string())),
  rollbackTarget: v.optional(v.nullable(v.string())),
  command: v.optional(v.string()),
});
const ChecksSchema: v.GenericSchema<NonNullable<ReleaseActionInput['checks']>> = v.array(
  v.object({ name: v.optional(v.string()), command: v.optional(v.string()) }),
);
const PreviewSchema = v.object({
  port: v.optional(v.number()),
  startCommand: v.optional(v.string()),
});
const RollbackSchema = v.object({ command: v.optional(v.string()) });

/** Marshal a member's positional call args into the ReleaseActionInput shape
 *  runReleaseAction reads a slice of. Each branch matches the member's own
 *  declared signature above. */
function toActionInput(action: ReleaseToolAction, args: unknown[]): ReleaseActionInput {
  switch (action) {
    case 'board':
      return { action };
    case 'bind_source':
      return { action, binding: parseInput(BindingSchema, { value: args[0] }) };
    case 'create': {
      const input = parseInput(v.object({
        bindingId: v.optional(v.string()),
        userPrompt: v.optional(v.string()),
        plan: v.optional(v.nullable(v.string())),
      }), { value: args[0] });
      return {
        action,
        bindingId: input?.bindingId,
        userPrompt: input?.userPrompt,
        plan: input?.plan,
      };
    }
    case 'update': {
      const patch = parseInput(UpdateSchema, { value: args[1] });
      return {
        action,
        changeId: parseInput(StringSchema, { value: args[0] }),
        plan: patch?.plan,
        summary: patch?.summary,
        patch: patch?.patch,
        previewUrl: patch?.previewUrl,
      };
    }
    case 'transition':
      return {
        action,
        changeId: parseInput(StringSchema, { value: args[0] }),
        status: parseInput(StatusSchema, { value: args[1] }),
      };
    case 'request_approval':
      return {
        action,
        changeId: parseInput(StringSchema, { value: args[0] }),
        approvalType: parseInput(ApprovalTypeSchema, { value: args[1] }),
      };
    case 'record_check':
      return {
        action,
        changeId: parseInput(StringSchema, { value: args[0] }),
        check: parseInput(CheckSchema, { value: args[1] }),
      };
    case 'record_deployment':
      return {
        action,
        changeId: parseInput(StringSchema, { value: args[0] }),
        deployment: parseInput(DeploymentSchema, { value: args[1] }),
      };
    case 'apply':
      return { action, changeId: parseInput(StringSchema, { value: args[0] }) };
    case 'run_checks':
      return {
        action,
        changeId: parseInput(StringSchema, { value: args[0] }),
        checks: parseInput(ChecksSchema, { value: args[1] }),
      };
    case 'preview': {
      const opts = parseInput(PreviewSchema, { value: args[1] });
      return {
        action,
        changeId: parseInput(StringSchema, { value: args[0] }),
        port: opts?.port,
        startCommand: opts?.startCommand,
      };
    }
    case 'deploy':
      return {
        action,
        changeId: parseInput(StringSchema, { value: args[0] }),
        deployment: parseInput(DeploymentSchema, { value: args[1] }),
      };
    case 'rollback': {
      const opts = parseInput(RollbackSchema, { value: args[1] });
      return {
        action,
        changeId: parseInput(StringSchema, { value: args[0] }),
        deployment: opts?.command ? { command: opts.command } : undefined,
      };
    }
  }
}

/**
 * Build the codemode provider exposing `release.*`. `deps` is a thunk, read
 * per call, so a re-bound release engine lands without rebuilding the tool —
 * same convention as `createAgentsCodemodeProvider`. Its action set is read
 * once at construction: which half of the lane exists (engine vs
 * record-only) is structural for this actor's lifetime, the same thing that
 * decided the old schema's action enum.
 */
export function createReleaseCodemodeProvider(deps: () => ReleaseToolDeps): CodemodeProvider {
  const hasEngine = !!deps().engine;
  const actions = releaseToolActions(hasEngine);
  const tools: CodemodeProvider['tools'] = {};

  for (const action of actions) {
    tools[MEMBER_NAMES[action]] = {
      description: MEMBER_DESCRIPTIONS[action],
      execute: async (...args: unknown[]) => runReleaseAction(deps(), toActionInput(action, args)),
    };
  }

  return {
    name: TOOL_REACH.release.codemode,
    types: renderTypes(actions),
    tools,
    positionalArgs: true,
  };
}

// Re-exported so callers that only need the dispatcher (tests, a future
// owner-facing surface) do not have to import tools/release-tool.ts directly.
export { runReleaseAction, type ReleaseActionInput, type ReleaseToolDeps } from './release-tool';
