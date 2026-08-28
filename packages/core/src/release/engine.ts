/**
 * ReleaseEngine — the execution engine beneath the release
 * governance ledger.
 *
 * The ledger (sql-store.ts) records what happened; the engine MAKES it
 * happen, grounded in real command execution inside the agent's sandbox
 * container:
 *
 *   apply     → the change's stored unified diff is applied for real in a
 *               per-change git working copy (`/workspace/releases/<id>`),
 *               committed, and the commit sha recorded. For `github` sources
 *               the repo is cloned and a `kinu/<changeId>` branch created.
 *   runChecks → declared build/test/lint commands run via sandbox exec; each
 *               check row's pass/fail comes from the ACTUAL exit code. All
 *               green advances validating → preview_ready; any failure blocks.
 *   preview   → optionally starts a server in the workdir, then exposes the
 *               port through the existing preview-proxy path and binds the
 *               real URL to the change.
 *   deploy    → gated on an APPROVED approval of the matching type. Runs the
 *               deploy command (workerVersionId parsed from real output,
 *               e.g. wrangler's "Current Version ID:") or promotes the
 *               verified preview (workerVersionId = the real HEAD sha).
 *   rollback  → gated on an approved 'rollback' approval. A git-sha target is
 *               restored with `git reset --hard`, VERIFIED via
 *               `git rev-parse HEAD`, and redeployed when a deploy command
 *               exists; a platform-version-id target (e.g. a wrangler UUID)
 *               is rolled back by the explicit rollback command instead —
 *               only then does the ledger state flip.
 *
 * The engine owns the transitions into validating / preview_ready /
 * applying / deployed / rolled_back (see isEngineOwnedTransitionTarget) —
 * those states are earned by execution, never asserted.
 */

import type {
  ReleaseApproval,
  ReleaseCheck,
  ReleaseDetail,
  ReleaseChange,
  ReleaseStatus,
  ReleaseDeployment,
  ReleaseSource,
} from './types';
import { shellQuote } from '../utils/shell';
import { validateReleasePatchTargets } from './path-safety';
import {
  approvalTypeForEnvironment,
  deployApprovalDigest,
  deployTargetAsCommand,
} from './approval-digest';

// ── Seams ────────────────────────────────────────────────────────────────

/** Raw execution surface — adapted from the sandbox executor's raw handle
 *  (cf-backend) so pass/fail is grounded in real exit codes, not the lossy
 *  LLM-facing tool strings. */
export interface ReleaseExec {
  exec(command: string, opts?: { cwd?: string; timeout?: number }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  writeFile(path: string, content: string): Promise<void>;
  /** Existing preview-proxy/exposePort path. The implementation verifies a
   *  listener before returning a URL. */
  exposePort(port: number, name?: string): Promise<{ url: string } | { error: string }>;
}

/** Ledger surface — the existing governance store, unchanged. The engine
 *  writes through it so every execution result lands on the same board the
 *  UI and approvals already read. */
export interface ReleaseLedger {
  detail(changeId: string): Promise<ReleaseDetail>;
  update(
    changeId: string,
    patch: { plan?: string | null; summary?: string | null; patch?: string | null; previewUrl?: string | null },
  ): Promise<ReleaseChange>;
  transition(changeId: string, to: ReleaseStatus): Promise<ReleaseChange>;
  recordCheck(changeId: string, input: {
    name: string;
    status: ReleaseCheck['status'];
    stdout?: string | null;
    stderr?: string | null;
    durationMs?: number | null;
  }): Promise<ReleaseCheck>;
  recordDeployment(changeId: string, input: {
    environment: ReleaseDeployment['environment'];
    workerVersionId?: string | null;
    deploymentId?: string | null;
    rollbackTarget?: string | null;
  }): Promise<ReleaseDeployment>;
}

export interface ReleaseEngineOptions {
  /** null → no execution substrate (sandbox not configured). Every action
   *  then returns an honest actionable error instead of fake progress. */
  exec: ReleaseExec | null;
  ledger: ReleaseLedger;
  /** Git auth for `github` sources: the value for an
   *  `AUTHORIZATION: Basic …` http.extraheader, or null when the user has
   *  no GitHub credential stored. */
  gitHubAuth?: () => Promise<string | null>;
  /** Root for per-change working copies. Lives under /workspace so the
   *  existing R2 workspace backup covers it. */
  workRoot?: string;
}

// ── Results (discriminated so the agent tool can relay them verbatim) ──────

export type ApplyResult =
  | { ok: true; workdir: string; commit: string; status: ReleaseStatus }
  | { ok: false; error: string };

export interface CheckRunResult {
  name: string;
  status: 'passed' | 'failed';
  exitCode: number;
  durationMs: number;
}

export type RunChecksResult =
  | { ok: true; allPassed: boolean; results: CheckRunResult[]; status: ReleaseStatus }
  | { ok: false; error: string };

export type PreviewResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

export type DeployResult =
  | {
      ok: true;
      environment: ReleaseDeployment['environment'];
      workerVersionId: string | null;
      deploymentId: string | null;
      rollbackTarget: string | null;
      status: ReleaseStatus;
    }
  | { ok: false; error: string };

export type RollbackResult =
  | { ok: true; restored: string; verified: boolean; status: ReleaseStatus }
  | { ok: false; error: string };

// ── Internals ──────────────────────────────────────────────────────────────

const NOT_CONFIGURED =
  'No execution substrate: this deployment has no sandbox container, so release changes cannot be applied, ' +
  'checked, previewed, or deployed for real. Add the @cloudflare/sandbox binding and Container to ' +
  'wrangler.jsonc first (see docs/EXECUTION-LAYER-SPEC.md).';

const DEFAULT_WORK_ROOT = '/workspace/releases';
const GIT = `git -c user.name=Kinu -c user.email=kinu@agent -c core.hooksPath=/dev/null`;
const OUTPUT_CAP = 20_000;
const APPLY_TIMEOUT_MS = 120_000;
const CLONE_TIMEOUT_MS = 300_000;
/**
 * `runChecks` runs whatever command the caller named, so this bound is only
 * honest if it clears the longest check this repository itself declares. That is
 * `scripts/bench-corpus.ts`'s `lean-verify` at 900_000 ms; its `core-tests` and
 * `core-typecheck` entries declare 180_000. It was 300_000, under the first of
 * those, and a check killed by this bound is recorded `failed` with no exit code
 * — indistinguishable from a check that ran and found a real defect, which is a
 * release gate reporting a fault it never observed.
 *
 * What those checks actually cost, measured here on a warm tree: `bun run check`
 * 11.1 s, `bun run test` 46 s, `bash scripts/verify-lean.sh` 5.5 s. So the
 * declaration this derives from is loose by orders of magnitude on a warm run,
 * and the case it covers is a COLD one — `lake build` from an empty
 * `.lake`, and a container clone that has none of it. That figure is PENDING
 * MEASUREMENT: nothing in the tree records a cold Lean build, and it is the only
 * thing that would turn this bound from generous into exact. Until then the bound
 * is deliberately on the generous side of a declaration rather than the tight side
 * of a warm measurement, because the two failure modes are not symmetric — too
 * generous costs a stuck check its wall clock, too tight fabricates a defect.
 */
const CHECK_TIMEOUT_MS = 900_000;
const DEPLOY_TIMEOUT_MS = 600_000;
const MAX_CHECKS_PER_RUN = 8;

function cap(text: string): string {
  return text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}\n…[truncated]` : text;
}

function isSafeChangeId(id: string): boolean {
  return /^pc-[A-Za-z0-9_-]{6,64}$/.test(id);
}

/** wrangler ≥3 prints "Current Version ID: <uuid>"; older prints
 *  "Current Deployment ID: <uuid>". Both are REAL deploy identities. */
export function parseDeployOutput(output: string) {
  const version = /Current Version ID:\s*([0-9a-z][0-9a-z-]{7,})/i.exec(output)
    ?? /\bVersion ID:\s*([0-9a-z][0-9a-z-]{7,})/i.exec(output);
  const deployment = /Current Deployment ID:\s*([0-9a-z][0-9a-z-]{7,})/i.exec(output)
    ?? /\bDeployment ID:\s*([0-9a-z][0-9a-z-]{7,})/i.exec(output);
  return { versionId: version?.[1] ?? null, deploymentId: deployment?.[1] ?? null };
}

function hasApproved(approvals: ReleaseApproval[], type: ReleaseApproval['approvalType']): boolean {
  return approvals.some((a) => a.approvalType === type && a.decision === 'approved');
}

function combinedOutput(res: { stdout: string; stderr: string; exitCode: number }): string {
  return [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
}

// ── Engine ─────────────────────────────────────────────────────────────────

export class ReleaseEngine {
  private readonly exec: ReleaseExec | null;
  private readonly ledger: ReleaseLedger;
  private readonly gitHubAuth?: () => Promise<string | null>;
  private readonly workRoot: string;

  constructor(opts: ReleaseEngineOptions) {
    this.exec = opts.exec;
    this.ledger = opts.ledger;
    this.gitHubAuth = opts.gitHubAuth;
    this.workRoot = opts.workRoot ?? DEFAULT_WORK_ROOT;
  }

  workdirFor(changeId: string): string {
    return `${this.workRoot}/${changeId}`;
  }

  private async requireDetail(changeId: string): Promise<
    | { ok: true; detail: ReleaseDetail; exec: ReleaseExec }
    | { ok: false; error: string }
  > {
    if (!isSafeChangeId(changeId)) return { ok: false, error: `invalid release change id: ${changeId}` };
    if (!this.exec) return { ok: false, error: NOT_CONFIGURED };
    const detail = await this.ledger.detail(changeId);
    return { ok: true, detail, exec: this.exec };
  }

  private async run(
    exec: ReleaseExec,
    command: string,
    opts?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return exec.exec(command, { timeout: APPLY_TIMEOUT_MS, ...opts });
  }

  private async pathExists(exec: ReleaseExec, path: string): Promise<boolean> {
    const res = await this.run(exec, `test -e ${shellQuote(path)} && echo yes || echo no`);
    return res.stdout.includes('yes');
  }

  private async headSha(exec: ReleaseExec, workdir: string): Promise<string | null> {
    const res = await this.run(exec, `${GIT} rev-parse HEAD`, { cwd: workdir });
    if (res.exitCode !== 0) return null;
    const sha = res.stdout.trim();
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
  }

  /** Clone (or fetch-refresh) the github working copy and check out the
   *  change branch on a pristine base. Returns an error string on failure. */
  private async ensureGithubWorkdir(
    exec: ReleaseExec,
    changeId: string,
    binding: ReleaseSource,
    workdir: string,
  ): Promise<string | null> {
    if (!binding.repoUrl) return 'github source binding has no repoUrl';
    const auth = (await this.gitHubAuth?.()) ?? null;
    const branch = binding.defaultBranch ?? 'main';
    // The credential never enters argv (visible to every sandbox process via
    // /proc/*/cmdline): it lands in a 0600 config file that network git
    // commands pick up through GIT_CONFIG_GLOBAL, removed when done.
    const authFile = `/tmp/${changeId}.gitauth`;
    const netGit = auth ? `GIT_CONFIG_GLOBAL=${shellQuote(authFile)} ${GIT}` : GIT;
    if (auth) {
      await exec.writeFile(authFile, `[http]\n\textraheader = AUTHORIZATION: ${auth}\n`);
      await this.run(exec, `chmod 600 ${shellQuote(authFile)}`);
    }
    try {
      const hasRepo = await this.pathExists(exec, `${workdir}/.git`);
      if (!hasRepo) {
        await this.run(exec, `rm -rf ${shellQuote(workdir)} && mkdir -p ${shellQuote(this.workRoot)}`);
        const clone = await this.run(
          exec,
          `${netGit} clone --depth 50 --branch ${shellQuote(branch)} ${shellQuote(binding.repoUrl)} ${shellQuote(workdir)}`,
          { timeout: CLONE_TIMEOUT_MS },
        );
        if (clone.exitCode !== 0) {
          const out = combinedOutput(clone);
          const authy = /authentication|could not read|403|401|terminal prompts disabled/i.test(out);
          if (authy && !auth) {
            return (
              `git clone of ${binding.repoUrl} failed and no GitHub credential is stored. ` +
              `Add a GitHub token as a credential named 'github' (a fine-grained PAT with contents read/write ` +
              `for this repo), then retry apply.\n${cap(out)}`
            );
          }
          return `git clone failed (exit ${clone.exitCode}):\n${cap(out)}`;
        }
      } else {
        // The pristine base below is origin/<branch> — fetch its CURRENT tip
        // so a re-apply never builds on a stale clone.
        const fetched = await this.run(
          exec,
          `${netGit} fetch origin ${shellQuote(branch)}`,
          { cwd: workdir, timeout: CLONE_TIMEOUT_MS },
        );
        if (fetched.exitCode !== 0) return `git fetch failed (exit ${fetched.exitCode}):\n${cap(combinedOutput(fetched))}`;
      }
      // Pristine base for every (re-)apply: drop local drift, rebuild the
      // change branch from the fetched default branch tip.
      const checkout = await this.run(
        exec,
        `${GIT} reset --hard && ${GIT} clean -fd && ${GIT} checkout -B ${shellQuote(`kinu/${changeId}`)} ${shellQuote(`origin/${branch}`)}`,
        { cwd: workdir },
      );
      if (checkout.exitCode !== 0) return `git checkout failed (exit ${checkout.exitCode}):\n${cap(combinedOutput(checkout))}`;
      return null;
    } finally {
      if (auth) await this.run(exec, `rm -f ${shellQuote(authFile)}`);
    }
  }

  /** Init (or reset) the local working copy. First apply snapshots whatever
   *  base files the agent staged into the workdir as the rollback anchor;
   *  re-applies reset back to that base so the stored patch stays the single
   *  source of truth. */
  private async ensureLocalWorkdir(exec: ReleaseExec, workdir: string): Promise<string | null> {
    const hasRepo = await this.pathExists(exec, `${workdir}/.git`);
    if (!hasRepo) {
      const init = await this.run(
        exec,
        `mkdir -p ${shellQuote(workdir)} && cd ${shellQuote(workdir)} && ${GIT} init -b main && ${GIT} add -A && ${GIT} commit --allow-empty -m 'base snapshot'`,
      );
      if (init.exitCode !== 0) return `git init failed (exit ${init.exitCode}):\n${cap(combinedOutput(init))}`;
      return null;
    }
    const base = await this.run(exec, `${GIT} rev-list --max-parents=0 HEAD`, { cwd: workdir });
    const baseSha = base.stdout.trim().split('\n').pop()?.trim();
    if (base.exitCode !== 0 || !baseSha) return `could not resolve base commit:\n${cap(combinedOutput(base))}`;
    const reset = await this.run(exec, `${GIT} reset --hard ${shellQuote(baseSha)} && ${GIT} clean -fd`, { cwd: workdir });
    if (reset.exitCode !== 0) return `git reset to base failed (exit ${reset.exitCode}):\n${cap(combinedOutput(reset))}`;
    return null;
  }

  /** Walk the change to `patching` through allowed lifecycle edges. */
  private async normalizeToPatching(change: ReleaseChange): Promise<string | null> {
    const steps = new Map<ReleaseStatus, readonly ReleaseStatus[]>([
      ['draft', ['planning', 'patching']],
      ['planning', ['patching']],
      ['patching', []],
      ['validating', ['patching']],
      ['preview_ready', ['patching']],
      ['awaiting_approval', ['preview_ready', 'patching']],
      ['failed', ['patching']],
    ]);
    const path = steps.get(change.status);
    if (!path) return `cannot apply a change in terminal status '${change.status}'`;
    for (const next of path) await this.ledger.transition(change.id, next);
    return null;
  }

  // ── 1. Apply — the diff is applied for real ─────────────────────────────

  async apply(changeId: string): Promise<ApplyResult> {
    const pre = await this.requireDetail(changeId);
    if (!pre.ok) return pre;
    const { detail, exec } = pre;
    const { change, binding } = detail;
    if (!binding) return { ok: false, error: `change ${changeId} has no source binding` };
    if (!change.patch?.trim()) {
      return { ok: false, error: 'change has no patch — store the unified diff first (action=update with patch), then apply' };
    }
    // BEFORE the working copy is set up, let alone written: the protected-path
    // rule is an authority question, and answering it after a clone has already
    // run is answering it late. `validateReleasePatchPath` has existed and been
    // exported this whole time; nothing on the apply path ever called it, so a
    // patch naming `.env`, `.ssh/`, `wrangler.jsonc` or `.git/` applied with no
    // inspection at all.
    const forbidden = validateReleasePatchTargets(change.patch);
    if (forbidden) {
      await this.ledger.recordCheck(changeId, { name: 'apply patch', status: 'failed', stderr: cap(forbidden) });
      return { ok: false, error: forbidden };
    }

    const statusErr = await this.normalizeToPatching(change);
    if (statusErr) return { ok: false, error: statusErr };
    const workdir = this.workdirFor(changeId);
    const setupErr = binding.kind === 'github'
      ? await this.ensureGithubWorkdir(exec, changeId, binding, workdir)
      : await this.ensureLocalWorkdir(exec, workdir);
    if (setupErr) {
      await this.ledger.recordCheck(changeId, { name: 'apply patch', status: 'failed', stderr: cap(setupErr) });
      return { ok: false, error: setupErr };
    }

    const patchPath = `/tmp/${changeId}.patch`;
    const patchText = change.patch.endsWith('\n') ? change.patch : `${change.patch}\n`;
    await exec.writeFile(patchPath, patchText);

    const started = Date.now();
    const applied = await this.run(exec, `${GIT} apply --whitespace=nowarn ${shellQuote(patchPath)}`, { cwd: workdir });
    if (applied.exitCode !== 0) {
      await this.ledger.recordCheck(changeId, {
        name: 'apply patch',
        status: 'failed',
        stdout: cap(applied.stdout),
        stderr: cap(applied.stderr || `git apply exited ${applied.exitCode}`),
        durationMs: Date.now() - started,
      });
      return {
        ok: false,
        error:
          `git apply failed (exit ${applied.exitCode}) in ${workdir}:\n${cap(combinedOutput(applied))}\n` +
          `If the patch modifies files that are not in the working copy yet, stage the base files there first.`,
      };
    }

    const commit = await this.run(
      exec,
      `${GIT} add -A && ${GIT} commit -m ${shellQuote(`release change ${changeId}`)}`,
      { cwd: workdir },
    );
    if (commit.exitCode !== 0) {
      const out = combinedOutput(commit);
      const empty = /nothing to commit|nothing added to commit/i.test(out);
      await this.ledger.recordCheck(changeId, {
        name: 'apply patch',
        status: 'failed',
        stderr: cap(empty ? 'patch produced no file changes' : out),
        durationMs: Date.now() - started,
      });
      return { ok: false, error: empty ? 'patch produced no file changes' : `git commit failed:\n${cap(out)}` };
    }

    const sha = await this.headSha(exec, workdir);
    if (!sha) return { ok: false, error: 'applied and committed, but could not resolve the commit sha' };

    await this.ledger.recordCheck(changeId, {
      name: 'apply patch',
      status: 'passed',
      stdout: cap(`commit ${sha}\n${combinedOutput(commit)}`),
      durationMs: Date.now() - started,
    });
    const updated = await this.ledger.transition(changeId, 'validating');
    return { ok: true, workdir, commit: sha, status: updated.status };
  }

  // ── 2. Checks — pass/fail from real exit codes ──────────────────────────

  async runChecks(changeId: string, checks: Array<{ name: string; command: string }>): Promise<RunChecksResult> {
    const pre = await this.requireDetail(changeId);
    if (!pre.ok) return pre;
    const { detail, exec } = pre;
    if (detail.change.status !== 'validating') {
      return { ok: false, error: `checks run in status 'validating' (current: '${detail.change.status}') — apply the change first` };
    }
    const cleaned = checks
      .map((c) => ({ name: String(c.name ?? '').trim().slice(0, 120), command: String(c.command ?? '').trim() }))
      .filter((c) => c.name && c.command);
    if (cleaned.length === 0) return { ok: false, error: 'no checks given — pass checks: [{ name, command }]' };
    if (cleaned.length > MAX_CHECKS_PER_RUN) return { ok: false, error: `too many checks (max ${MAX_CHECKS_PER_RUN} per run)` };

    const workdir = this.workdirFor(changeId);
    if (!(await this.pathExists(exec, workdir))) {
      return { ok: false, error: `working copy ${workdir} is gone (the container filesystem was recycled) — re-run apply first` };
    }

    const results: CheckRunResult[] = [];
    for (const check of cleaned) {
      const started = Date.now();
      const res = await this.run(exec, check.command, { cwd: workdir, timeout: CHECK_TIMEOUT_MS });
      const durationMs = Date.now() - started;
      const status = res.exitCode === 0 ? 'passed' as const : 'failed' as const;
      await this.ledger.recordCheck(changeId, {
        name: check.name,
        status,
        stdout: cap(res.stdout),
        stderr: cap(res.stderr || (status === 'failed' ? `exit ${res.exitCode}` : '')),
        durationMs,
      });
      results.push({ name: check.name, status, exitCode: res.exitCode, durationMs });
    }

    const allPassed = results.every((r) => r.status === 'passed');
    const updated = allPassed
      ? await this.ledger.transition(changeId, 'preview_ready')
      : detail.change;
    return { ok: true, allPassed, results, status: updated.status };
  }

  // ── 3. Preview — a real URL through the preview proxy ───────────────────

  async preview(changeId: string, opts: { port: number; startCommand?: string }): Promise<PreviewResult> {
    const pre = await this.requireDetail(changeId);
    if (!pre.ok) return pre;
    const { detail, exec } = pre;
    const status = detail.change.status;
    if (!['validating', 'preview_ready', 'awaiting_approval'].includes(status)) {
      return { ok: false, error: `preview runs after apply (status 'validating'/'preview_ready', current: '${status}')` };
    }
    const port = Math.round(Number(opts.port));
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return { ok: false, error: `invalid port: ${opts.port}` };

    const workdir = this.workdirFor(changeId);
    if (opts.startCommand?.trim()) {
      if (!(await this.pathExists(exec, workdir))) {
        return { ok: false, error: `working copy ${workdir} is gone — re-run apply first` };
      }
      const log = `/tmp/${changeId}-srv.log`;
      const started = await this.run(
        exec,
        `nohup sh -c ${shellQuote(opts.startCommand.trim())} > ${shellQuote(log)} 2>&1 & echo started`,
        { cwd: workdir },
      );
      if (started.exitCode !== 0) {
        return { ok: false, error: `failed to launch server:\n${cap(combinedOutput(started))}` };
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    const exposed = await exec.exposePort(port, `pc-${changeId}`);
    if ('error' in exposed) return { ok: false, error: exposed.error };
    await this.ledger.update(changeId, { previewUrl: exposed.url });
    return { ok: true, url: exposed.url };
  }

  // ── 4. Deploy — approval-gated, real version ids ────────────────────────

  async deploy(
    changeId: string,
    opts: { environment: ReleaseDeployment['environment']; command?: string },
  ): Promise<DeployResult> {
    const pre = await this.requireDetail(changeId);
    if (!pre.ok) return pre;
    const { detail, exec } = pre;
    const { change, binding, approvals, deployments } = detail;
    const environment = opts.environment;
    if (!['local', 'staging', 'production'].includes(environment)) {
      return { ok: false, error: `invalid environment: ${environment}` };
    }

    const requiredApproval = approvalTypeForEnvironment(environment);
    if (!hasApproved(approvals, requiredApproval)) {
      return {
        ok: false,
        error:
          `deploy to ${environment} requires an APPROVED '${requiredApproval}' approval. ` +
          `Use action=request_approval, then the owner approves it on the Releases surface.`,
      };
    }
    if (change.status !== 'awaiting_approval' && change.status !== 'applying') {
      return { ok: false, error: `deploy runs from 'awaiting_approval' (current: '${change.status}')` };
    }

    const workdir = this.workdirFor(changeId);
    const command = opts.command?.trim() || deployTargetAsCommand(binding?.deployTarget ?? null);

    // Digest-bound approval (SPEC §7.3): the owner approved deploying THIS
    // patch via THIS declared command. Recompute the digest of what is about
    // to run and require an approved approval bound to it — a patch mutated or
    // a deploy command injected after approval fails closed here.
    const expectedDigest = deployApprovalDigest({
      approvalType: requiredApproval,
      patch: change.patch,
      command,
    });
    const digestBound = approvals.some(
      (a) => a.approvalType === requiredApproval && a.decision === 'approved' && a.argumentDigest === expectedDigest,
    );
    if (!digestBound) {
      return {
        ok: false,
        error:
          `deploy to ${environment} rejected: the approved '${requiredApproval}' approval was for different ` +
          `arguments (the patch or deploy command changed after approval). Request a fresh approval for the ` +
          `current change and command, then deploy.`,
      };
    }
    if (!command && !change.previewUrl) {
      return {
        ok: false,
        error:
          'no deploy command available (pass deployment.command or set the binding deployTarget to a command ' +
          'like "bunx wrangler deploy") and no preview URL to promote — run preview first',
      };
    }
    if (change.status === 'awaiting_approval') await this.ledger.transition(changeId, 'applying');
    const priorVersion = deployments.find((d) => d.workerVersionId)?.workerVersionId ?? null;

    let workerVersionId: string | null;
    let deploymentId: string | null;
    if (command) {
      if (!(await this.pathExists(exec, workdir))) {
        await this.ledger.transition(changeId, 'failed');
        return { ok: false, error: `working copy ${workdir} is gone — re-run apply, checks, and approval flow` };
      }
      const started = Date.now();
      const res = await this.run(exec, command, { cwd: workdir, timeout: DEPLOY_TIMEOUT_MS });
      const output = combinedOutput(res);
      await this.ledger.recordCheck(changeId, {
        name: `deploy (${environment})`,
        status: res.exitCode === 0 ? 'passed' : 'failed',
        stdout: cap(res.stdout),
        stderr: cap(res.stderr),
        durationMs: Date.now() - started,
      });
      if (res.exitCode !== 0) {
        await this.ledger.transition(changeId, 'failed');
        return { ok: false, error: `deploy command exited ${res.exitCode}:\n${cap(output)}` };
      }
      const parsed = parseDeployOutput(output);
      workerVersionId = parsed.versionId ?? (await this.headSha(exec, workdir));
      deploymentId = parsed.deploymentId;
    } else {
      // Promote the verified preview: the deployed artifact IS the working
      // copy the preview URL serves; its identity is the real HEAD sha.
      const sha = await this.headSha(exec, workdir);
      if (!sha) {
        return { ok: false, error: `cannot resolve the working-copy commit in ${workdir} — re-run apply first` };
      }
      workerVersionId = sha;
      deploymentId = change.previewUrl;
    }

    const rollbackTarget = priorVersion ?? (await (async () => {
      const res = await this.run(exec, `${GIT} rev-parse HEAD~1`, { cwd: workdir });
      const sha = res.stdout.trim();
      return res.exitCode === 0 && /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
    })());

    await this.ledger.recordDeployment(changeId, { environment, workerVersionId, deploymentId, rollbackTarget });
    const updated = await this.ledger.transition(changeId, 'deployed');
    return { ok: true, environment, workerVersionId, deploymentId, rollbackTarget, status: updated.status };
  }

  // ── 5. Rollback — restore, VERIFY, then flip the ledger ─────────────────

  async rollback(changeId: string, opts?: { command?: string }): Promise<RollbackResult> {
    const pre = await this.requireDetail(changeId);
    if (!pre.ok) return pre;
    const { detail, exec } = pre;
    const { change, binding, approvals, deployments } = detail;
    if (change.status !== 'deployed') {
      return { ok: false, error: `rollback runs from 'deployed' (current: '${change.status}')` };
    }
    if (!hasApproved(approvals, 'rollback')) {
      return {
        ok: false,
        error: "rollback requires an APPROVED 'rollback' approval — use action=request_approval with approvalType=rollback",
      };
    }
    const latest = deployments[0];
    if (!latest?.rollbackTarget) {
      return { ok: false, error: 'no rollback target recorded on the latest deployment — nothing to restore' };
    }
    const target = latest.rollbackTarget;
    const isCommitTarget = /^[0-9a-f]{7,40}$/.test(target);
    const explicitCommand = opts?.command?.trim() || null;
    const platformCommand = isCommitTarget ? null : explicitCommand;
    if (!isCommitTarget && !platformCommand) {
      return {
        ok: false,
        error:
          `rollback target ${target} is a platform version id, not a git commit — no git reset can restore it. ` +
          `Pass deployment.command with an explicit rollback command (e.g. "bunx wrangler rollback ${target}")`,
      };
    }

    // Digest-bound approval, the same rule `deploy()` already enforces. Without
    // it `hasApproved` was the whole gate: any approved rollback could be spent
    // on whatever `opts.command` the caller passed, and the model's release tool
    // is one of the callers. `platformCommand` is null for a commit target,
    // which is the same "no command — restore this target with git" the approval
    // recorded, so a git rollback needs no new ceremony and a platform rollback
    // must have had ITS command approved.
    const expectedDigest = deployApprovalDigest({
      approvalType: 'rollback',
      patch: change.patch,
      command: platformCommand,
    });
    const digestBound = approvals.some(
      (a) => a.approvalType === 'rollback' && a.decision === 'approved' && a.argumentDigest === expectedDigest,
    );
    if (!digestBound) {
      return {
        ok: false,
        error:
          "rollback rejected: the approved 'rollback' approval was for different arguments (the patch or the "
          + 'rollback command changed after approval). Request a fresh rollback approval for this command, '
          + 'then roll back.',
      };
    }

    const workdir = this.workdirFor(changeId);
    if (!(await this.pathExists(exec, `${workdir}/.git`))) {
      if (binding?.kind === 'github') {
        const err = await this.ensureGithubWorkdir(exec, changeId, binding, workdir);
        if (err) return { ok: false, error: `working copy lost and re-clone failed: ${err}` };
      } else {
        return {
          ok: false,
          error:
            `working copy ${workdir} is gone (container filesystem recycled) and the source is local, so the ` +
            `recorded rollback target ${target} cannot be restored automatically — re-apply the prior state manually`,
        };
      }
    }

    const started = Date.now();

    // Platform-version-id target: the explicit command IS the rollback —
    // there is nothing for git to restore, so no git reset runs at all.
    if (platformCommand) {
      const res = await this.run(exec, platformCommand, { cwd: workdir, timeout: DEPLOY_TIMEOUT_MS });
      await this.ledger.recordCheck(changeId, {
        name: 'rollback',
        status: res.exitCode === 0 ? 'passed' : 'failed',
        stdout: cap(res.stdout),
        stderr: cap(res.stderr || (res.exitCode !== 0 ? `rollback command exited ${res.exitCode}` : '')),
        durationMs: Date.now() - started,
      });
      if (res.exitCode !== 0) {
        return { ok: false, error: `rollback command exited ${res.exitCode}:\n${cap(combinedOutput(res))}` };
      }
      await this.ledger.recordDeployment(changeId, {
        environment: latest.environment,
        workerVersionId: target,
        deploymentId: `rollback of ${latest.workerVersionId ?? latest.id}`,
        rollbackTarget: latest.workerVersionId,
      });
      const updated = await this.ledger.transition(changeId, 'rolled_back');
      return { ok: true, restored: target, verified: true, status: updated.status };
    }

    const reset = await this.run(exec, `${GIT} reset --hard ${shellQuote(target)} && ${GIT} clean -fd`, { cwd: workdir });
    if (reset.exitCode !== 0) {
      return {
        ok: false,
        error: `git reset --hard ${target} failed (exit ${reset.exitCode})\n${cap(combinedOutput(reset))}`,
      };
    }
    const restoredSha = await this.headSha(exec, workdir);
    const verified = restoredSha != null && (restoredSha === target || restoredSha.startsWith(target) || target.startsWith(restoredSha));
    if (!verified) {
      await this.ledger.recordCheck(changeId, {
        name: 'rollback',
        status: 'failed',
        stderr: cap(`expected HEAD ${target}, got ${restoredSha ?? 'unknown'}`),
        durationMs: Date.now() - started,
      });
      return { ok: false, error: `rollback NOT verified: expected HEAD ${target}, got ${restoredSha ?? 'unknown'}` };
    }

    // Re-deploy the restored state when a deploy command exists; a promoted
    // preview serves the workdir directly, so the reset already took effect.
    const command = explicitCommand ?? deployTargetAsCommand(binding?.deployTarget ?? null);
    let redeployNote = 'preview workdir restored in place';
    if (command) {
      const res = await this.run(exec, command, { cwd: workdir, timeout: DEPLOY_TIMEOUT_MS });
      if (res.exitCode !== 0) {
        await this.ledger.recordCheck(changeId, {
          name: 'rollback',
          status: 'failed',
          stdout: cap(res.stdout),
          stderr: cap(res.stderr || `redeploy exited ${res.exitCode}`),
          durationMs: Date.now() - started,
        });
        return { ok: false, error: `restored ${target} but redeploy failed (exit ${res.exitCode}):\n${cap(combinedOutput(res))}` };
      }
      redeployNote = `redeployed via: ${command}`;
    }

    await this.ledger.recordCheck(changeId, {
      name: 'rollback',
      status: 'passed',
      stdout: cap(`restored ${restoredSha} (target ${target}); ${redeployNote}`),
      durationMs: Date.now() - started,
    });
    await this.ledger.recordDeployment(changeId, {
      environment: latest.environment,
      workerVersionId: restoredSha,
      deploymentId: `rollback of ${latest.workerVersionId ?? latest.id}`,
      rollbackTarget: latest.workerVersionId,
    });
    const updated = await this.ledger.transition(changeId, 'rolled_back');
    return { ok: true, restored: restoredSha, verified: true, status: updated.status };
  }
}
