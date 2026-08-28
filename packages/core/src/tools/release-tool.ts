/**
 * The release lane's dispatch logic — the ledger (board/bind_source/create/
 * update/transition/request_approval), the no-engine record_* twins, and the
 * engine-driven apply/run_checks/preview/deploy/rollback actions, gated on
 * the SAME `releases.engine` presence the schema gates on (see the release
 * doctrine block in tools/registry.ts).
 *
 * This was the body of a native `release` tool; it is now reached ONLY
 * through the `release.*` codemode namespace (tools/release-codemode.ts) —
 * this file holds the ONE implementation both the codemode members and any
 * future caller share, mirroring tools/agents-tool.ts's dispatchAgentsAction.
 */
import {
  isEngineOwnedTransitionTarget,
  type ReleaseApproval,
  type ReleaseBoard,
  type ReleaseChange,
  type ReleaseCheck,
  type ReleaseEngine,
  type ReleaseStatus,
  type ReleaseDeployment,
  type ReleaseSource,
} from '../release/index';
import type { ReleaseToolAction } from './registry';
import { renderThrownChain } from '../obs/index';

export interface ReleaseToolDeps {
  board(): Promise<ReleaseBoard>;
  bindSource(input: {
    kind: 'local' | 'github';
    label: string;
    repoUrl?: string | null;
    defaultBranch?: string | null;
    localDeviceId?: string | null;
    localRoot?: string | null;
    deployTarget?: string | null;
  }): Promise<ReleaseSource>;
  create(input: { bindingId: string; userPrompt: string; plan?: string | null }): Promise<ReleaseChange>;
  update(changeId: string, patch: { plan?: string | null; summary?: string | null; patch?: string | null; previewUrl?: string | null }): Promise<ReleaseChange>;
  transition(changeId: string, status: ReleaseStatus): Promise<ReleaseChange>;
  recordCheck(changeId: string, input: {
    name: string;
    status: ReleaseCheck['status'];
    stdout?: string | null;
    stderr?: string | null;
    durationMs?: number | null;
  }): Promise<ReleaseCheck>;
  requestApproval(
    changeId: string,
    approvalType: ReleaseApproval['approvalType'],
    opts?: { command?: string | null },
  ): Promise<ReleaseApproval>;
  recordDeployment(changeId: string, input: {
    environment: ReleaseDeployment['environment'];
    workerVersionId?: string | null;
    deploymentId?: string | null;
    rollbackTarget?: string | null;
  }): Promise<ReleaseDeployment>;
  /** Execution engine beneath the ledger (apply/run_checks/preview/deploy/
   *  rollback grounded in real sandbox execution). When wired, the tool
   *  refuses manual transitions into engine-owned states and refuses
   *  record_deployment — those results are EARNED via the engine actions.
   *  Absent on backends without an execution substrate. */
  engine?: Pick<ReleaseEngine, 'apply' | 'runChecks' | 'preview' | 'deploy' | 'rollback'>;
}

/** The one input shape every release action reads a slice of. */
export interface ReleaseActionInput {
  action: ReleaseToolAction;
  binding?: {
    kind?: 'local' | 'github';
    label?: string;
    repoUrl?: string | null;
    defaultBranch?: string | null;
    localDeviceId?: string | null;
    localRoot?: string | null;
    deployTarget?: string | null;
  };
  changeId?: string;
  bindingId?: string;
  userPrompt?: string;
  plan?: string | null;
  summary?: string | null;
  patch?: string | null;
  previewUrl?: string | null;
  status?: ReleaseStatus;
  check?: { name?: string; status?: ReleaseCheck['status']; stdout?: string | null; stderr?: string | null; durationMs?: number | null };
  approvalType?: ReleaseApproval['approvalType'];
  deployment?: {
    environment?: ReleaseDeployment['environment'];
    workerVersionId?: string | null;
    deploymentId?: string | null;
    rollbackTarget?: string | null;
    command?: string;
  };
  checks?: Array<{ name?: string; command?: string }>;
  port?: number;
  startCommand?: string;
}

export type ReleaseActionResult =
  | ReleaseBoard
  | ReleaseSource
  | ReleaseChange
  | ReleaseCheck
  | ReleaseApproval
  | ReleaseDeployment
  | Awaited<ReturnType<ReleaseEngine['apply']>>
  | Awaited<ReturnType<ReleaseEngine['runChecks']>>
  | Awaited<ReturnType<ReleaseEngine['preview']>>
  | Awaited<ReturnType<ReleaseEngine['deploy']>>
  | Awaited<ReturnType<ReleaseEngine['rollback']>>
  | { error: string };

/** Dispatch one release action. Never throws — every failure comes back as
 *  `{ error }` so a codemode caller sees a value, not an exception. */
export async function runReleaseAction(
  releases: ReleaseToolDeps,
  args: ReleaseActionInput,
): Promise<ReleaseActionResult> {
  try {
    switch (args.action) {
      case 'board':
        return await releases.board();
      case 'bind_source': {
        const b = args.binding ?? {};
        if (b.kind !== 'local' && b.kind !== 'github') return { error: 'binding.kind must be local or github' };
        if (!b.label) return { error: 'binding.label is required' };
        return await releases.bindSource({
          kind: b.kind,
          label: b.label,
          repoUrl: b.repoUrl,
          defaultBranch: b.defaultBranch,
          localDeviceId: b.localDeviceId,
          localRoot: b.localRoot,
          deployTarget: b.deployTarget,
        });
      }
      case 'create':
        if (!args.bindingId || !args.userPrompt) return { error: 'create requires bindingId and userPrompt' };
        return await releases.create({ bindingId: args.bindingId, userPrompt: args.userPrompt, plan: args.plan });
      case 'update':
        if (!args.changeId) return { error: 'update requires changeId' };
        return await releases.update(args.changeId, {
          plan: args.plan,
          summary: args.summary,
          patch: args.patch,
          previewUrl: args.previewUrl,
        });
      case 'transition':
        if (!args.changeId || !args.status) return { error: 'transition requires changeId and status' };
        if (releases.engine && isEngineOwnedTransitionTarget(args.status)) {
          return {
            error:
              `status '${args.status}' is earned by execution, not asserted — ` +
              `use action=apply / run_checks / deploy / rollback to get there for real`,
          };
        }
        return await releases.transition(args.changeId, args.status);
      case 'record_check':
        if (!args.changeId || !args.check?.name || !args.check.status) return { error: 'record_check requires changeId, check.name, and check.status' };
        return await releases.recordCheck(args.changeId, {
          name: args.check.name,
          status: args.check.status,
          stdout: args.check.stdout,
          stderr: args.check.stderr,
          durationMs: args.check.durationMs,
        });
      case 'request_approval':
        if (!args.changeId || !args.approvalType) return { error: 'request_approval requires changeId and approvalType' };
        // A rollback approval binds the command it authorises, so the owner is
        // approving a specific restore rather than the word "rollback".
        // `deployment.command` is where the caller already states it, and
        // `rollback()` recomputes the same digest before executing.
        return args.approvalType === 'rollback'
          ? await releases.requestApproval(args.changeId, args.approvalType, {
            command: args.deployment?.command ?? null,
          })
          : await releases.requestApproval(args.changeId, args.approvalType);
      case 'record_deployment':
        if (!args.changeId || !args.deployment?.environment) return { error: 'record_deployment requires changeId and deployment.environment' };
        if (releases.engine) {
          return {
            error:
              'deployments are recorded from REAL deploy results — use action=deploy; ' +
              'the version id and rollback target come from the actual command output',
          };
        }
        return await releases.recordDeployment(args.changeId, {
          environment: args.deployment.environment,
          workerVersionId: args.deployment.workerVersionId,
          deploymentId: args.deployment.deploymentId,
          rollbackTarget: args.deployment.rollbackTarget,
        });
      case 'apply':
      case 'run_checks':
      case 'preview':
      case 'deploy':
      case 'rollback': {
        const engine = releases.engine;
        if (!engine) {
          return { error: `action=${args.action} needs the execution engine, which this backend does not provide — the ledger actions (update/transition/record_check) remain available` };
        }
        if (!args.changeId) return { error: `${args.action} requires changeId` };
        switch (args.action) {
          case 'apply':
            return await engine.apply(args.changeId);
          case 'run_checks':
            if (!args.checks?.length) return { error: 'run_checks requires checks: [{ name, command }]' };
            return await engine.runChecks(
              args.changeId,
              args.checks.map((c) => ({ name: c.name ?? '', command: c.command ?? '' })),
            );
          case 'preview':
            if (args.port == null) return { error: 'preview requires port (the port your server listens on)' };
            return await engine.preview(args.changeId, {
              port: args.port,
              startCommand: args.startCommand || undefined,
            });
          case 'deploy':
            if (!args.deployment?.environment) return { error: 'deploy requires deployment.environment (local | staging | production)' };
            return await engine.deploy(args.changeId, {
              environment: args.deployment.environment,
              command: args.deployment.command || undefined,
            });
          case 'rollback':
            return await engine.rollback(args.changeId, args.deployment?.command ? { command: args.deployment.command } : undefined);
        }
      }
    }
  } catch (err) {
    return { error: renderThrownChain({ cause: err }) };
  }
}
