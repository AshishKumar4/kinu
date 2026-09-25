/**
 * Release lane dispatch: ledger actions, no-engine record_* twins, and engine actions gated on
 * `releases.engine`. Reached only through the `release.*` codemode namespace (release/codemode.ts).
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
} from './index';
import type { ReleaseToolAction } from '../tools/registry';
import { KinuError } from '../obs/index';

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
  /** Execution engine beneath the ledger. When wired, manual transitions into engine-owned
   *  states and record_check / record_deployment are refused. */
  engine?: Pick<ReleaseEngine, 'apply' | 'runChecks' | 'preview' | 'deploy' | 'rollback'>;
}

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
  | Awaited<ReturnType<ReleaseEngine['rollback']>>;

interface ReleaseEngineContext {
  readonly releases: ReleaseToolDeps;
  readonly args: ReleaseActionInput;
}

/** Engine-driven actions; refuses without an engine or a change. */
async function runReleaseEngineAction(ctx: ReleaseEngineContext): Promise<ReleaseActionResult> {
  const engine = ctx.releases.engine;

  if (!engine) {
    throw new KinuError('unsupported', `action=${ctx.args.action} needs the execution engine, which this backend does not provide — the ledger actions (update/transition/record_check) remain available`);
  }

  if (!ctx.args.changeId) throw new KinuError('bad_input', `${ctx.args.action} requires changeId`);

  switch (ctx.args.action) {
    case 'apply':
      return await engine.apply(ctx.args.changeId);
    case 'run_checks':
      if (!ctx.args.checks?.length) throw new KinuError('bad_input', 'run_checks requires checks: [{ name, command }]');

      return await engine.runChecks(
        ctx.args.changeId,
        ctx.args.checks.map((c) => ({ name: c.name ?? '', command: c.command ?? '' })),
      );
    case 'preview':
      if (ctx.args.port == null) throw new KinuError('bad_input', 'preview requires port (the port your server listens on)');

      return await engine.preview(ctx.args.changeId, {
        port: ctx.args.port,
        startCommand: ctx.args.startCommand === '' ? undefined : ctx.args.startCommand,
      });
    case 'deploy':
      if (!ctx.args.deployment?.environment) throw new KinuError('bad_input', 'deploy requires deployment.environment (local | staging | production)');

      return await engine.deploy(ctx.args.changeId, {
        environment: ctx.args.deployment.environment,
        command: ctx.args.deployment.command === '' ? undefined : ctx.args.deployment.command,
      });
    case 'rollback':
      return await engine.rollback(ctx.args.changeId, ctx.args.deployment?.command ? { command: ctx.args.deployment.command } : undefined);
    // Ledger actions were already taken by `runReleaseLedgerAction`.
    case 'bind_source':
    case 'board':
    case 'create':
    case 'record_check':
    case 'record_deployment':
    case 'request_approval':
    case 'transition':
    case 'update':
      throw new KinuError('bad_input', `unknown engine action: ${ctx.args.action}`);
  }
}

/** Dispatch one release action. A refused one throws its `KinuError`, which a program receives as a `Refusal`. */
export async function runReleaseAction(
  releases: ReleaseToolDeps,
  args: ReleaseActionInput,
): Promise<ReleaseActionResult> {
  switch (args.action) {
    case 'board':
      return await releases.board();
    case 'bind_source': {
      const b = args.binding ?? {};

      if (b.kind !== 'local' && b.kind !== 'github') throw new KinuError('bad_input', 'binding.kind must be local or github');

      if (!b.label) throw new KinuError('bad_input', 'binding.label is required');

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
      if (!args.bindingId || !args.userPrompt) throw new KinuError('bad_input', 'create requires bindingId and userPrompt');

      return await releases.create({ bindingId: args.bindingId, userPrompt: args.userPrompt, plan: args.plan });
    case 'update':
      if (!args.changeId) throw new KinuError('bad_input', 'update requires changeId');

      return await releases.update(args.changeId, {
        plan: args.plan,
        summary: args.summary,
        patch: args.patch,
        previewUrl: args.previewUrl,
      });
    case 'transition':
      if (!args.changeId || !args.status) throw new KinuError('bad_input', 'transition requires changeId and status');

      if (releases.engine && isEngineOwnedTransitionTarget(args.status)) {
        throw new KinuError('denied',
          `status '${args.status}' is earned by execution, not asserted — ` +
          `use action=apply / run_checks / deploy / rollback to get there for real`);
      }

      return await releases.transition(args.changeId, args.status);
    case 'record_check':
      if (!args.changeId || !args.check?.name || !args.check.status) throw new KinuError('bad_input', 'record_check requires changeId, check.name, and check.status');

      if (releases.engine) {
        throw new KinuError('denied',
          'checks are recorded from REAL check results — use action=run_checks; ' +
          'the pass/fail comes from the actual command output');
      }

      return await releases.recordCheck(args.changeId, {
        name: args.check.name,
        status: args.check.status,
        stdout: args.check.stdout,
        stderr: args.check.stderr,
        durationMs: args.check.durationMs,
      });
    case 'request_approval':
      if (!args.changeId || !args.approvalType) throw new KinuError('bad_input', 'request_approval requires changeId and approvalType');

      // A rollback approval binds its command; `rollback()` recomputes the same digest before executing.
      return args.approvalType === 'rollback'
        ? await releases.requestApproval(args.changeId, args.approvalType, {
          command: args.deployment?.command ?? null,
        })
        : await releases.requestApproval(args.changeId, args.approvalType);
    case 'record_deployment':
      if (!args.changeId || !args.deployment?.environment) throw new KinuError('bad_input', 'record_deployment requires changeId and deployment.environment');

      if (releases.engine) {
        throw new KinuError('denied',
          'deployments are recorded from REAL deploy results — use action=deploy; ' +
          'the version id and rollback target come from the actual command output');
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
      return await runReleaseEngineAction({ releases, args });
    }
  }
}
