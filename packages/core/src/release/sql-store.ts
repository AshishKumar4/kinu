import { nanoid } from '../utils/nanoid';
import * as v from 'valibot';
import {
  RELEASE_STATUSES,
  type ReleaseApproval,
  type ReleaseCheck,
  type ReleaseDetail,
  type ReleaseChange,
  type ReleaseStatus,
  type ReleaseDeployment,
  type ReleaseSource,
  type ReleaseSourceKind,
} from './types';
import { assertReleaseTransition } from './lifecycle';
import { deployApprovalDigest, deployTargetAsCommand } from './approval-digest';
import { assertGithubRepoUrl, redactReleaseDiff } from './path-safety';
import type { SqlExec, SqlValue } from '../types/primitives';

/** The largest diff this ledger stores. A refusal rather than a truncation:
 *  the stored bytes are the ones `git apply` runs, and half a hunk is not a
 *  smaller change, it is a broken one. */
const MAX_PATCH_CHARS = 250_000;

export interface ReleaseSqlStore {
  all<Output>(schema: v.GenericSchema<Output>, query: string, ...bindings: SqlValue[]): Output[];
  run(query: string, ...bindings: SqlValue[]): void;
}

export interface ReleaseStoreOptions {
  now?: () => number;
  id?: (prefix: string, size: number) => string;
  validateAgentName?: (name: string) => void;
}

export interface ReleaseSourceInput {
  kind: ReleaseSourceKind;
  label: string;
  repoUrl?: string | null;
  defaultBranch?: string | null;
  localDeviceId?: string | null;
  localRoot?: string | null;
  deployTarget?: string | null;
}

export interface ReleaseBoard {
  bindings: ReleaseSource[];
  changes: ReleaseChange[];
  checks: ReleaseCheck[];
  approvals: ReleaseApproval[];
  deployments: ReleaseDeployment[];
}

export function releaseSqlFromExec(sql: SqlExec): ReleaseSqlStore {
  return {
    all<Output>(schema: v.GenericSchema<Output>, query: string, ...bindings: SqlValue[]): Output[] {
      return sql.exec(query, ...bindings).toArray().map((row) => v.parse(schema, row));
    },
    run(query: string, ...bindings: SqlValue[]): void {
      sql.exec(query, ...bindings);
    },
  };
}

export function initReleaseTables(sql: SqlExec): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS release_sources (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL CHECK (kind IN ('local', 'github')),
      label           TEXT NOT NULL,
      repo_url        TEXT,
      default_branch  TEXT,
      local_device_id TEXT,
      local_root      TEXT,
      deploy_target   TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_release_sources_kind ON release_sources (kind)`);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS release_changes (
      id          TEXT PRIMARY KEY,
      agent_name  TEXT NOT NULL,
      binding_id  TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN (
        'draft', 'planning', 'patching', 'validating', 'preview_ready', 'awaiting_approval',
        'applying', 'deployed', 'rejected', 'rolled_back', 'failed'
      )),
      user_prompt TEXT NOT NULL,
      plan        TEXT,
      summary     TEXT,
      patch       TEXT,
      preview_url TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      FOREIGN KEY (binding_id) REFERENCES release_sources(id)
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_release_changes_agent ON release_changes (agent_name, updated_at DESC)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_release_changes_source ON release_changes (binding_id, updated_at DESC)`);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS release_checks (
      id          TEXT PRIMARY KEY,
      change_id   TEXT NOT NULL,
      name        TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('pending', 'running', 'passed', 'failed', 'skipped')),
      stdout      TEXT,
      stderr      TEXT,
      duration_ms INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      FOREIGN KEY (change_id) REFERENCES release_changes(id)
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_release_checks_change ON release_checks (change_id, updated_at DESC)`);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS release_approvals (
      id              TEXT PRIMARY KEY,
      change_id       TEXT NOT NULL,
      approval_type   TEXT NOT NULL CHECK (approval_type IN ('apply', 'deploy_staging', 'deploy_production', 'rollback')),
      decision        TEXT NOT NULL CHECK (decision IN ('pending', 'approved', 'rejected')),
      approved_by     TEXT,
      note            TEXT,
      argument_digest TEXT NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL,
      decided_at      INTEGER,
      FOREIGN KEY (change_id) REFERENCES release_changes(id)
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_release_approvals_change ON release_approvals (change_id, created_at DESC)`);
  // Live-table migration: bind the argument digest (SPEC §7.3) on stores that
  // predate the column. Existing rows get '' — an empty digest never matches a
  // recomputed one, so a stale approval fails closed and is re-requested.
  const approvalColumns = sql.exec(`PRAGMA table_info(release_approvals)`).toArray()
    .map((row) => v.parse(v.object({ name: v.string() }), row));
  if (!approvalColumns.some((c) => c.name === 'argument_digest')) {
    sql.exec(`ALTER TABLE release_approvals ADD COLUMN argument_digest TEXT NOT NULL DEFAULT ''`);
  }

  sql.exec(`
    CREATE TABLE IF NOT EXISTS release_deployments (
      id                TEXT PRIMARY KEY,
      change_id         TEXT NOT NULL,
      environment       TEXT NOT NULL CHECK (environment IN ('local', 'staging', 'production')),
      worker_version_id TEXT,
      deployment_id     TEXT,
      rollback_target   TEXT,
      deployed_at       INTEGER NOT NULL,
      FOREIGN KEY (change_id) REFERENCES release_changes(id)
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_release_deployments_change ON release_deployments (change_id, deployed_at DESC)`);
}

function cleanOptional<Value>(value: Value, max = 512): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function cleanRequired<Value>(value: Value, label: string, max: number): string {
  const text = cleanOptional(value, max);
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function cleanLabel<Value>(value: Value, fallback: string): string {
  return cleanOptional(value, 120) ?? fallback;
}

const NullableString = v.nullable(v.string());
const NullableNumber = v.nullable(v.number());
const SourceRowSchema = v.object({
  id: v.string(),
  kind: v.picklist(['local', 'github']),
  label: v.string(),
  repo_url: NullableString,
  default_branch: NullableString,
  local_device_id: NullableString,
  local_root: NullableString,
  deploy_target: NullableString,
  created_at: v.number(),
  updated_at: v.number(),
});
const ChangeRowSchema = v.object({
  id: v.string(),
  agent_name: v.string(),
  binding_id: v.string(),
  status: v.picklist(RELEASE_STATUSES),
  user_prompt: v.string(),
  plan: NullableString,
  summary: NullableString,
  patch: NullableString,
  preview_url: NullableString,
  created_at: v.number(),
  updated_at: v.number(),
});
const CheckRowSchema = v.object({
  id: v.string(),
  change_id: v.string(),
  name: v.string(),
  status: v.picklist(['pending', 'running', 'passed', 'failed', 'skipped']),
  stdout: NullableString,
  stderr: NullableString,
  duration_ms: NullableNumber,
  created_at: v.number(),
  updated_at: v.number(),
});
const ApprovalRowSchema = v.object({
  id: v.string(),
  change_id: v.string(),
  approval_type: v.picklist(['apply', 'deploy_staging', 'deploy_production', 'rollback']),
  decision: v.picklist(['pending', 'approved', 'rejected']),
  approved_by: NullableString,
  note: NullableString,
  argument_digest: v.string(),
  created_at: v.number(),
  decided_at: NullableNumber,
});
const DeploymentRowSchema = v.object({
  id: v.string(),
  change_id: v.string(),
  environment: v.picklist(['local', 'staging', 'production']),
  worker_version_id: NullableString,
  deployment_id: NullableString,
  rollback_target: NullableString,
  deployed_at: v.number(),
});
const IdRowSchema = v.object({ id: v.string() });
const DeployTargetRowSchema = v.object({ deploy_target: NullableString });

type SourceRow = v.InferOutput<typeof SourceRowSchema>;
type ChangeRow = v.InferOutput<typeof ChangeRowSchema>;
type CheckRow = v.InferOutput<typeof CheckRowSchema>;
type ApprovalRow = v.InferOutput<typeof ApprovalRowSchema>;
type DeploymentRow = v.InferOutput<typeof DeploymentRowSchema>;

function mapReleaseSource(r: SourceRow): ReleaseSource {
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    repoUrl: r.repo_url,
    defaultBranch: r.default_branch,
    localDeviceId: r.local_device_id,
    localRoot: r.local_root,
    deployTarget: r.deploy_target,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapReleaseChange(r: ChangeRow): ReleaseChange {
  return {
    id: r.id,
    agentName: r.agent_name,
    bindingId: r.binding_id,
    status: r.status,
    userPrompt: r.user_prompt,
    plan: r.plan,
    summary: r.summary,
    patch: r.patch,
    previewUrl: r.preview_url,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapReleaseCheck(r: CheckRow): ReleaseCheck {
  return {
    id: r.id,
    changeId: r.change_id,
    name: r.name,
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const APPROVAL_COLUMNS =
  'id, change_id, approval_type, decision, approved_by, note, argument_digest, created_at, decided_at';

function mapReleaseApproval(r: ApprovalRow): ReleaseApproval {
  return {
    id: r.id,
    changeId: r.change_id,
    approvalType: r.approval_type,
    decision: r.decision,
    approvedBy: r.approved_by,
    note: r.note,
    argumentDigest: r.argument_digest,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

function mapReleaseDeployment(r: DeploymentRow): ReleaseDeployment {
  return {
    id: r.id,
    changeId: r.change_id,
    environment: r.environment,
    workerVersionId: r.worker_version_id,
    deploymentId: r.deployment_id,
    rollbackTarget: r.rollback_target,
    deployedAt: r.deployed_at,
  };
}

export class ReleaseStore {
  private readonly now: () => number;
  private readonly makeId: (prefix: string, size: number) => string;
  private readonly validateAgentName?: (name: string) => void;

  constructor(private readonly sql: ReleaseSqlStore, opts: ReleaseStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.makeId = opts.id ?? ((prefix, size) => `${prefix}-${nanoid(size)}`);
    this.validateAgentName = opts.validateAgentName;
  }

  listSourceBindings(): ReleaseSource[] {
    return this.sql.all(
      SourceRowSchema,
      `SELECT id, kind, label, repo_url, default_branch, local_device_id, local_root, deploy_target, created_at, updated_at
       FROM release_sources ORDER BY updated_at DESC`,
    ).map(mapReleaseSource);
  }

  upsertSourceBinding(input: ReleaseSourceInput & { id?: string }): ReleaseSource {
    const kind = input.kind;
    if (kind !== 'local' && kind !== 'github') throw new Error('source binding kind must be local or github');
    const label = cleanLabel(input.label, 'Kinu source');
    const id = input.id && /^psb-[A-Za-z0-9_-]{6,64}$/.test(input.id) ? input.id : this.makeId('psb', 10);
    const repoUrl = cleanOptional(input.repoUrl);
    const defaultBranch = cleanOptional(input.defaultBranch) ?? 'main';
    // A branch value that starts with a dash parses as a git flag wherever it
    // reaches a positional argument (notably `fetch origin <branch>`), so the
    // ref is validated here, the last point before the value is durable.
    if (defaultBranch.startsWith('-') || /\s/.test(defaultBranch) || defaultBranch.includes('..')) {
      throw new Error(`invalid defaultBranch ${JSON.stringify(defaultBranch)}: must not start with '-', contain whitespace, or contain '..'`);
    }
    const localDeviceId = cleanOptional(input.localDeviceId);
    const localRoot = cleanOptional(input.localRoot);
    const deployTarget = cleanOptional(input.deployTarget);
    if (kind === 'github' && !repoUrl) throw new Error('github source binding requires repoUrl');
    // The credential this binding's kind names is a GITHUB credential, and
    // `apply` installs it as an HTTP authorization header before cloning
    // whatever this URL says. So the URL decides where a GitHub token is sent,
    // and a nonempty-string check decided nothing: `kind: 'github'` with a
    // repoUrl pointing anywhere meant the token went there. Refused at the
    // ledger, which is the last point before the value is durable.
    if (kind === 'github' && repoUrl) assertGithubRepoUrl(repoUrl);
    if (kind === 'local' && !localRoot) throw new Error('local source binding requires localRoot');
    const now = this.now();
    this.sql.run(
      `INSERT INTO release_sources
         (id, kind, label, repo_url, default_branch, local_device_id, local_root, deploy_target, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         label = excluded.label,
         repo_url = excluded.repo_url,
         default_branch = excluded.default_branch,
         local_device_id = excluded.local_device_id,
         local_root = excluded.local_root,
         deploy_target = excluded.deploy_target,
         updated_at = excluded.updated_at`,
      id, kind, label, repoUrl, defaultBranch, localDeviceId, localRoot, deployTarget, now, now,
    );
    const row = this.sql.all(
      SourceRowSchema,
      `SELECT id, kind, label, repo_url, default_branch, local_device_id, local_root, deploy_target, created_at, updated_at
       FROM release_sources WHERE id = ?`,
      id,
    )[0];
    if (!row) throw new Error('failed to upsert release source');
    return mapReleaseSource(row);
  }

  createChange(agentName: string, input: { bindingId: string; userPrompt: string; plan?: string | null }): ReleaseChange {
    this.validateAgentName?.(agentName);
    const binding = this.sql.all(IdRowSchema, `SELECT id FROM release_sources WHERE id = ?`, input.bindingId)[0];
    if (!binding) throw new Error(`unknown release source: ${input.bindingId}`);
    const prompt = cleanRequired(input.userPrompt, 'userPrompt', 4000);
    const plan = cleanOptional(input.plan, 12000);
    const id = this.makeId('pc', 12);
    const now = this.now();
    this.sql.run(
      `INSERT INTO release_changes
         (id, agent_name, binding_id, status, user_prompt, plan, summary, patch, preview_url, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, ?, NULL, NULL, NULL, ?, ?)`,
      id, agentName, input.bindingId, prompt, plan, now, now,
    );
    const change = this.getChange(id);
    if (!change) throw new Error('failed to create release change');
    return change;
  }

  listChanges(agentName?: string, limit = 20): ReleaseChange[] {
    if (agentName) this.validateAgentName?.(agentName);
    const n = Math.max(1, Math.min(limit, 100));
    const rows = agentName
      ? this.sql.all(
          ChangeRowSchema,
          `SELECT id, agent_name, binding_id, status, user_prompt, plan, summary, patch, preview_url, created_at, updated_at
           FROM release_changes WHERE agent_name = ? ORDER BY updated_at DESC LIMIT ?`,
          agentName, n,
        )
      : this.sql.all(
          ChangeRowSchema,
          `SELECT id, agent_name, binding_id, status, user_prompt, plan, summary, patch, preview_url, created_at, updated_at
           FROM release_changes ORDER BY updated_at DESC LIMIT ?`,
          n,
        );
    // Redacted HERE, on the DISPLAY read. `getChange` (and so `detail`, and so
    // everything the engine applies) returns the stored bytes untouched: a diff
    // that is redacted in storage is a diff `git apply` writes the redaction
    // marker into. See `updateChange`.
    return rows.map(mapReleaseChange).map((change) => (
      change.patch === null ? change : { ...change, patch: redactReleaseDiff(change.patch) }
    ));
  }

  getChange(changeId: string): ReleaseChange | null {
    const row = this.sql.all(
      ChangeRowSchema,
      `SELECT id, agent_name, binding_id, status, user_prompt, plan, summary, patch, preview_url, created_at, updated_at
       FROM release_changes WHERE id = ?`,
      changeId,
    )[0];
    return row ? mapReleaseChange(row) : null;
  }

  updateChange(
    changeId: string,
    patch: { plan?: string | null; summary?: string | null; patch?: string | null; previewUrl?: string | null },
  ): ReleaseChange {
    const existing = this.getChange(changeId);
    if (!existing) throw new Error(`unknown release change: ${changeId}`);
    const nextPlan = patch.plan === undefined ? existing.plan : cleanOptional(patch.plan, 12000);
    const nextSummary = patch.summary === undefined ? existing.summary : cleanOptional(patch.summary, 4000);
    // VERBATIM. This column is the one the engine writes to a file and hands to
    // `git apply`, so anything done to it here is done to the bytes that land in
    // the repository: a redacted ADDED line applies the literal marker into the
    // target file, a redacted REMOVED line no longer matches the working tree
    // and breaks its hunk, and a truncation cuts a valid patch mid-hunk.
    // Redaction belongs to the display read (`listChanges`), and an oversized
    // patch is refused rather than silently shortened into a broken one.
    if (patch.patch != null && String(patch.patch).length > MAX_PATCH_CHARS) {
      throw new Error(
        `patch is ${String(String(patch.patch).length)} characters, over the ${String(MAX_PATCH_CHARS)} `
        + 'limit — split the change rather than truncating the diff',
      );
    }
    const nextPatch = patch.patch === undefined ? existing.patch : (patch.patch == null ? null : String(patch.patch));
    const nextPreviewUrl = patch.previewUrl === undefined ? existing.previewUrl : cleanOptional(patch.previewUrl, 2048);
    this.sql.run(
      `UPDATE release_changes
       SET plan = ?, summary = ?, patch = ?, preview_url = ?, updated_at = ?
       WHERE id = ?`,
      nextPlan, nextSummary, nextPatch, nextPreviewUrl, this.now(), changeId,
    );
    const updated = this.getChange(changeId);
    if (!updated) throw new Error(`unknown release change after update: ${changeId}`);
    return updated;
  }

  transitionChange(changeId: string, to: ReleaseStatus): ReleaseChange {
    const existing = this.getChange(changeId);
    if (!existing) throw new Error(`unknown release change: ${changeId}`);
    const transition = assertReleaseTransition(existing.status, to);
    if (!transition.ok) throw new Error(transition.error);
    this.sql.run(
      `UPDATE release_changes SET status = ?, updated_at = ? WHERE id = ?`,
      to, this.now(), changeId,
    );
    const updated = this.getChange(changeId);
    if (!updated) throw new Error(`unknown release change after transition: ${changeId}`);
    return updated;
  }

  recordCheck(
    changeId: string,
    input: { name: string; status: ReleaseCheck['status']; stdout?: string | null; stderr?: string | null; durationMs?: number | null },
  ): ReleaseCheck {
    if (!this.getChange(changeId)) throw new Error(`unknown release change: ${changeId}`);
    const status = input.status;
    if (!['pending', 'running', 'passed', 'failed', 'skipped'].includes(status)) throw new Error('invalid check status');
    const id = this.makeId('pcc', 10);
    const now = this.now();
    this.sql.run(
      `INSERT INTO release_checks
         (id, change_id, name, status, stdout, stderr, duration_ms, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      changeId,
      cleanRequired(input.name, 'name', 120),
      status,
      cleanOptional(input.stdout, 120_000),
      cleanOptional(input.stderr, 120_000),
      input.durationMs == null ? null : Math.max(0, Math.round(Number(input.durationMs))),
      now,
      now,
    );
    return this.sql.all(
      CheckRowSchema,
      `SELECT id, change_id, name, status, stdout, stderr, duration_ms, created_at, updated_at FROM release_checks WHERE id = ?`,
      id,
    )
      .map(mapReleaseCheck)[0]!;
  }

  /** The binding's declared deploy command for a change (null when the binding
   *  carries a bare environment label or no target) — the reviewable command a
   *  deploy approval binds (SPEC §7.3). */
  private deployCommandForChange(change: ReleaseChange): string | null {
    const row = this.sql.all(
      DeployTargetRowSchema,
      `SELECT deploy_target FROM release_sources WHERE id = ?`, change.bindingId,
    )[0];
    return deployTargetAsCommand(row?.deploy_target ?? null);
  }

  requestApproval(
    changeId: string,
    approvalType: ReleaseApproval['approvalType'],
    opts?: { command?: string | null },
  ): ReleaseApproval {
    const existing = this.getChange(changeId);
    if (!existing) throw new Error(`unknown release change: ${changeId}`);
    if (!['apply', 'deploy_staging', 'deploy_production', 'rollback'].includes(approvalType)) throw new Error('invalid approval type');
    if (existing.status === 'preview_ready') this.transitionChange(changeId, 'awaiting_approval');
    else if (existing.status !== 'awaiting_approval' && approvalType !== 'rollback') {
      throw new Error(`approval requires preview_ready or awaiting_approval status, got ${existing.status}`);
    }
    const id = this.makeId('pca', 10);
    const now = this.now();
    // Bind the reviewable identity (patch + the command that will run). deploy
    // and rollback both recompute this and reject a mismatch, so an approval
    // can't be redirected to a mutated patch or an injected command.
    //
    // A ROLLBACK binds its OWN command. Both used to hash
    // `deployCommandForChange`, which is the command a DEPLOY runs — so the
    // digest a rollback approval carried described something the rollback would
    // never execute, and `rollback()` (unlike `deploy()`) never checked it
    // anyway. An approved rollback could then be spent on any command the caller
    // passed, and the model's release tool is a caller. `null` here means "the
    // git restore this target implies", which is what a commit-target rollback
    // runs and what `rollback()` recomputes for one.
    const digest = deployApprovalDigest({
      approvalType,
      patch: existing.patch,
      command: opts?.command !== undefined
        ? opts.command
        : (approvalType === 'rollback' ? null : this.deployCommandForChange(existing)),
    });
    this.sql.run(
      `INSERT INTO release_approvals
         (id, change_id, approval_type, decision, approved_by, note, argument_digest, created_at, decided_at)
       VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL)`,
      id, changeId, approvalType, digest, now,
    );
    return this.sql.all(
      ApprovalRowSchema,
      `SELECT ${APPROVAL_COLUMNS} FROM release_approvals WHERE id = ?`, id,
    ).map(mapReleaseApproval)[0]!;
  }

  decideApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    approvedBy: string,
    note?: string | null,
  ): ReleaseApproval {
    if (decision !== 'approved' && decision !== 'rejected') throw new Error('decision must be approved or rejected');
    this.sql.run(
      `UPDATE release_approvals
       SET decision = ?, approved_by = ?, note = ?, decided_at = ?
       WHERE id = ? AND decision = 'pending'`,
      decision, cleanRequired(approvedBy, 'approvedBy', 200), cleanOptional(note, 2000), this.now(), approvalId,
    );
    const row = this.sql.all(
      ApprovalRowSchema,
      `SELECT ${APPROVAL_COLUMNS} FROM release_approvals WHERE id = ?`, approvalId,
    ).map(mapReleaseApproval)[0];
    if (!row) throw new Error(`unknown release change approval: ${approvalId}`);
    return row;
  }

  recordDeployment(
    changeId: string,
    input: { environment: ReleaseDeployment['environment']; workerVersionId?: string | null; deploymentId?: string | null; rollbackTarget?: string | null },
  ): ReleaseDeployment {
    if (!this.getChange(changeId)) throw new Error(`unknown release change: ${changeId}`);
    if (!['local', 'staging', 'production'].includes(input.environment)) throw new Error('invalid deployment environment');
    const id = this.makeId('pcd', 10);
    const deployedAt = this.now();
    this.sql.run(
      `INSERT INTO release_deployments
         (id, change_id, environment, worker_version_id, deployment_id, rollback_target, deployed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      changeId,
      input.environment,
      cleanOptional(input.workerVersionId, 200),
      cleanOptional(input.deploymentId, 200),
      cleanOptional(input.rollbackTarget, 200),
      deployedAt,
    );
    return this.sql.all(
      DeploymentRowSchema,
      `SELECT id, change_id, environment, worker_version_id, deployment_id, rollback_target, deployed_at
       FROM release_deployments WHERE id = ?`,
      id,
    ).map(mapReleaseDeployment)[0]!;
  }

  /** Full ledger view of ONE change — the engine's read surface. */
  detail(changeId: string): ReleaseDetail {
    const change = this.getChange(changeId);
    if (!change) throw new Error(`unknown release change: ${changeId}`);
    const bindingRow = this.sql.all(
      SourceRowSchema,
      `SELECT id, kind, label, repo_url, default_branch, local_device_id, local_root, deploy_target, created_at, updated_at
       FROM release_sources WHERE id = ?`,
      change.bindingId,
    )[0];
    const checks = this.sql.all(
      CheckRowSchema,
      `SELECT id, change_id, name, status, stdout, stderr, duration_ms, created_at, updated_at
       FROM release_checks WHERE change_id = ? ORDER BY updated_at DESC`,
      changeId,
    ).map(mapReleaseCheck);
    const approvals = this.sql.all(
      ApprovalRowSchema,
      `SELECT ${APPROVAL_COLUMNS} FROM release_approvals WHERE change_id = ? ORDER BY created_at DESC`,
      changeId,
    ).map(mapReleaseApproval);
    const deployments = this.sql.all(
      DeploymentRowSchema,
      `SELECT id, change_id, environment, worker_version_id, deployment_id, rollback_target, deployed_at
       FROM release_deployments WHERE change_id = ? ORDER BY deployed_at DESC, id DESC`,
      changeId,
    ).map(mapReleaseDeployment);
    return {
      change,
      binding: bindingRow ? mapReleaseSource(bindingRow) : null,
      checks,
      approvals,
      deployments,
    };
  }

  board(agentName?: string, limit = 20): ReleaseBoard {
    const changes = this.listChanges(agentName, limit);
    const ids = changes.map((c) => c.id);
    if (ids.length === 0) {
      return { bindings: this.listSourceBindings(), changes, checks: [], approvals: [], deployments: [] };
    }
    const marks = ids.map(() => '?').join(',');
    const checks = this.sql.all(
      CheckRowSchema,
      `SELECT id, change_id, name, status, stdout, stderr, duration_ms, created_at, updated_at
       FROM release_checks WHERE change_id IN (${marks}) ORDER BY updated_at DESC`,
      ...ids,
    ).map(mapReleaseCheck);
    const approvals = this.sql.all(
      ApprovalRowSchema,
      `SELECT ${APPROVAL_COLUMNS} FROM release_approvals WHERE change_id IN (${marks}) ORDER BY created_at DESC`,
      ...ids,
    ).map(mapReleaseApproval);
    const deployments = this.sql.all(
      DeploymentRowSchema,
      `SELECT id, change_id, environment, worker_version_id, deployment_id, rollback_target, deployed_at
       FROM release_deployments WHERE change_id IN (${marks}) ORDER BY deployed_at DESC`,
      ...ids,
    ).map(mapReleaseDeployment);
    return { bindings: this.listSourceBindings(), changes, checks, approvals, deployments };
  }
}

export function createReleaseStore(
  sql: ReleaseSqlStore,
  opts?: ReleaseStoreOptions,
): ReleaseStore {
  return new ReleaseStore(sql, opts);
}
