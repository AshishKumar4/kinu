/**
 * One workspace for operators. Every control proxies a named action to the DO's own `@callable`,
 * confirms first, and binds to the owner the server resolved (`detail.userId`), never the URL.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { Button } from '@cloudflare/kumo';
import { TrashIcon, WarningIcon } from '@phosphor-icons/react';
import { FilledButton } from '../ui/FilledButton';
import { Modal } from '../ui/Modal';
import { inputCls } from '../ui/form';
import {
  BackgroundJobRowSchema, DeferredApprovalRowSchema, fetchWorkspaceDetail, panelRows, runAction,
  type BackgroundJobRow, type ControlAction, type DeferredApprovalRow, type JsonValue,
  type Panel as PanelValue,
} from '../../lib/control-api';
import { Notice, Panel, SectionHeader, useControlRead, when } from './panels';

/** Every panel arrives in this shape so one down surface never blanks the page. */
function PanelBlock(
  { title, panel, children }: { title: string; panel: PanelValue; children?: ReactNode },
): ReactNode {
  return (
    <section className="p-card p-4 space-y-2">
      <div className="p-eyebrow">{title}</div>
      {panel.status === 'ok'
        ? children ?? <Rows value={panel.value} />
        : (
          <div className="text-xs p-danger flex items-start gap-1.5">
            <WarningIcon size={12} className="mt-0.5 shrink-0" />
            <span className="min-w-0">{panel.reason}</span>
          </div>
        )}
    </section>
  );
}

/** Generic count + JSON: re-implementing the workspace page's renderers would drift. */
function Rows({ value }: { value: JsonValue }): ReactNode {
  const count = Array.isArray(value) ? value.length : null;

  return (
    <>
      <div className="text-lg p-display tabular-nums">
        {count ?? '—'}
      </div>
      <pre className="p-annotation p-text-3 overflow-x-auto max-h-40 whitespace-pre-wrap">
        {JSON.stringify(value, null, 2)}
      </pre>
    </>
  );
}

const WORKSPACE_CONTROLS = [
  {
    action: 'jobs.clear',
    label: 'Clear settled jobs',
    body: (workspace: string) => `Drop every settled background job from ${workspace}. Running jobs are untouched.`,
  },
  {
    action: 'shell_grants.revoke',
    label: 'Revoke shell grants',
    body: (workspace: string) => `Revoke every standing shell-approval grant in ${workspace}. The agent will have to ask again for each command.`,
  },
] as const;

const JOB_CONTROLS = [
  {
    action: 'job.cancel',
    label: 'Cancel',
    title: 'Cancel this job',
    body: (job: BackgroundJobRow, workspace: string) => `Stop ${job.kind} (${job.id}) in ${workspace}. Only a running job can be cancelled.`,
  },
  {
    action: 'job.retry',
    label: 'Retry',
    title: 'Retry this job',
    body: (job: BackgroundJobRow, workspace: string) => `Run ${job.kind} (${job.id}) in ${workspace} again as a new job. Kinu refuses to retry a job that succeeded.`,
  },
  {
    action: 'job.dismiss',
    label: 'Dismiss',
    title: 'Dismiss this job',
    body: (job: BackgroundJobRow, workspace: string) => `Drop ${job.kind} (${job.id}) from ${workspace}'s job list. The work is not undone.`,
  },
] as const;

const JOB_STATUS_TONE: Record<BackgroundJobRow['status'], string> = {
  running: 'p-accent p-t-status',
  completed: 'p-success p-t-status',
  failed: 'p-danger p-t-status',
  cancelled: 'p-danger p-t-status',
};

/** Holds the action itself, so the modal cannot describe one thing and send another. */
interface PendingControl {
  action: ControlAction;
  title: string;
  body: string;
  danger: boolean;
}

export function WorkspaceDrilldown(
  { workspace, ownerUserId, onChanged }: {
    workspace: string;
    /** The read echoes back the owner it proved; controls bind to that. */
    ownerUserId: string;
    onChanged?: () => void;
  },
): ReactNode {
  const { load, reload } = useControlRead(
    () => fetchWorkspaceDetail(ownerUserId, workspace), [ownerUserId, workspace],
  );

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'warn' | 'danger'; text: string } | null>(null);
  const [pending, setPending] = useState<PendingControl | null>(null);
  const [typedName, setTypedName] = useState('');

  const act = useCallback(async (action: ControlAction) => {
    setBusy(true);
    setResult(null);
    const answer = await runAction(action);
    setBusy(false);

    if (answer.status === 'ok') {
      setResult({
        tone: answer.value.outcome === 'ok' ? 'ok' : 'warn',
        text: answer.value.detail,
      });
      reload();
      onChanged?.();

      return answer.value.outcome === 'ok';
    }

    setResult({
      tone: answer.status === 'stale-auth' ? 'warn' : 'danger',
      text: answer.status === 'stale-auth'
        // The step-up window is five minutes; hitting it is expected, not an error.
        ? `${answer.reason} Sign in again, then retry.`
        : answer.reason,
    });

    return false;
  }, [onChanged, reload]);

  const confirm = useCallback((control: PendingControl) => {
    setTypedName('');
    setPending(control);
  }, []);

  const runPending = useCallback(async () => {
    if (pending === null) return;
    const ok = await act(pending.action);

    if (ok) setPending(null);
  }, [act, pending]);

  const retypeRequired = pending?.action.action === 'workspace.remove';
  const confirmBlocked = busy || (retypeRequired && typedName !== workspace);
  const confirmWord = pending?.danger === true ? 'Remove' : 'Confirm';

  return (
    <div className="space-y-4">
      <SectionHeader
        title={workspace}
        hint="Live from this workspace's Durable Object. Every control below calls the owner's own RPC."
        onRefresh={reload}
      />

      {result !== null && (
        <Notice tone={result.tone}>
          {result.text}
        </Notice>
      )}

      <Panel load={load}>
        {(detail) => {
          // Bind to the owner the server resolved, not the requested one.
          const userId = detail.userId;
          const jobs = panelRows(detail.jobs, BackgroundJobRowSchema);
          const approvals = panelRows(detail.approvals, DeferredApprovalRowSchema);

          return (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                {WORKSPACE_CONTROLS.map((control) => (
                  <Button
                    key={control.action}
                    size="sm" variant="ghost" disabled={busy}
                    onClick={() => confirm({
                      action: { action: control.action, userId, workspace },
                      title: control.label,
                      body: control.body(workspace),
                      danger: false,
                    })}
                  >
                    {control.label}
                  </Button>
                ))}
                <button
                  disabled={busy}
                  onClick={() => confirm({
                    action: { action: 'workspace.remove', userId, workspace, confirm: '' },
                    title: 'Remove this workspace',
                    body: 'This removes the workspace and everything in it: its conversation, model, scaffold, triggers, and sandbox. It belongs to another account and cannot be undone.',
                    danger: true,
                  })}
                  className="text-xs p-danger hover:underline flex items-center gap-1 px-2 py-1"
                >
                  <TrashIcon size={12} /> Remove workspace
                </button>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <PanelBlock title="Recent runs" panel={detail.runs} />
                <PanelBlock title="Activity + spend" panel={detail.activity} />
                <PanelBlock title="Background jobs" panel={detail.jobs}>
                  <JobRows
                    rows={jobs} busy={busy}
                    onPick={(control) => { confirm(control); }}
                    userId={userId} workspace={workspace}
                  />
                </PanelBlock>
                <PanelBlock title="Deferred approvals" panel={detail.approvals}>
                  <ApprovalRows
                    rows={approvals} busy={busy}
                    onPick={(control) => { confirm(control); }}
                    userId={userId} workspace={workspace}
                  />
                </PanelBlock>
                <PanelBlock title="Pending device consents" panel={detail.consents} />
                <PanelBlock title="Executors" panel={detail.executors} />
                <PanelBlock title="Standing shell grants" panel={detail.shellGrants} />
              </div>
            </div>
          );
        }}
      </Panel>

      {pending !== null && (
        <Modal
          title={pending.title}
          icon={pending.danger ? <TrashIcon size={18} className="p-danger" /> : undefined}
          onClose={() => setPending(null)}
          busy={busy}
          footer={<>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </Button>
            <FilledButton danger={pending.danger} disabled={confirmBlocked} onClick={() => void runPending()}>
              {busy ? 'Working…' : confirmWord}
            </FilledButton>
          </>}
        >
          <div className="space-y-3">
            <p className="text-xs p-text-2 leading-relaxed">{pending.body}</p>
            <p className="p-meta p-text-3">
              Account <span className="font-mono p-text">{pending.action.userId}</span>
            </p>
            {retypeRequired && (
              <label className="block text-xs p-text-3">
                Type <span className="font-mono p-text">{workspace}</span> to confirm
                <input
                  className={`${inputCls} mt-1`}
                  value={typedName}
                  onChange={(e) => {
                    setTypedName(e.target.value);
                    setPending((current) => current === null || current.action.action !== 'workspace.remove'
                      ? current
                      : { ...current, action: { ...current.action, confirm: e.target.value } });
                  }}
                  autoFocus
                />
              </label>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

/** `null` rows: panel down or unknown shape; never render that as an empty table. */
function JobRows(
  { rows, busy, userId, workspace, onPick }: {
    rows: BackgroundJobRow[] | null;
    busy: boolean;
    userId: string;
    workspace: string;
    onPick: (control: PendingControl) => void;
  },
): ReactNode {
  if (rows === null) {
    return <div className="text-xs p-text-3">This job list could not be read.</div>;
  }

  if (rows.length === 0) return <div className="text-xs p-text-3">No background jobs.</div>;

  return (
    <ul className="space-y-2">
      {rows.map((job) => (
        <li key={job.id} className="space-y-1 border-b p-border last:border-b-0 pb-2 last:pb-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="p-annotation p-text-2">{job.kind}</span>
            <span className={JOB_STATUS_TONE[job.status]}>
              {job.status}
            </span>
            <span className="p-meta p-text-3">{when(job.createdAt)}</span>
            {(job.resumeAttempts ?? 0) > 0 && (
              <span className="p-t-status p-warning">
                interrupted {job.resumeAttempts}x
                {job.resumeAfter != null && job.resumeAfter > Date.now()
                  ? `, next attempt ${when(job.resumeAfter)}` : ''}
              </span>
            )}
          </div>
          {job.label !== null && <div className="text-xs p-text-2">{job.label}</div>}
          {job.error !== null && <div className="p-row-text p-danger">{job.error}</div>}
          <div className="flex gap-1.5">
            {JOB_CONTROLS.map((control) => (
              <Button
                key={control.action}
                size="sm" variant="ghost" disabled={busy}
                onClick={() => onPick({
                  action: { action: control.action, userId, workspace, jobId: job.id },
                  title: control.title,
                  body: control.body(job, workspace),
                  danger: false,
                })}
              >
                {control.label}
              </Button>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** `always` is a standing grant, so each answer is its own button. */
function ApprovalRows(
  { rows, busy, userId, workspace, onPick }: {
    rows: DeferredApprovalRow[] | null;
    busy: boolean;
    userId: string;
    workspace: string;
    onPick: (control: PendingControl) => void;
  },
): ReactNode {
  if (rows === null) {
    return <div className="text-xs p-text-3">This approval list could not be read.</div>;
  }

  if (rows.length === 0) return <div className="text-xs p-text-3">No command is waiting on the owner.</div>;

  return (
    <ul className="space-y-2">
      {rows.map((approval) => (
        <li key={approval.id} className="space-y-1 border-b p-border last:border-b-0 pb-2 last:pb-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="p-t-status p-text-3">{approval.status}</span>
            <span className="p-annotation p-text-2">{approval.executor}</span>
            <span className="p-meta p-text-3">{when(approval.requestedAt)}</span>
          </div>
          <div className="font-mono text-xs p-text whitespace-pre-wrap break-all">{approval.command}</div>
          <div className="p-row-text p-text-3">{approval.reason}</div>
          <div className="flex gap-1.5">
            {APPROVAL_ANSWERS.map(({ decision, label, body }) => (
              <Button
                key={decision}
                size="sm" variant="ghost"
                disabled={busy || approval.status !== 'queued'}
                onClick={() => onPick({
                  action: {
                    action: 'approvals.decide', userId, workspace,
                    ids: [approval.id], decision,
                  },
                  title: `${label} this command`,
                  body: `${body}\n\n${approval.command}\n\non ${approval.executor}, in ${workspace}.`,
                  danger: decision === 'always',
                })}
              >
                {label}
              </Button>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** `always` outlives the command it was asked for. */
const APPROVAL_ANSWERS = [
  { decision: 'approved', label: 'Approve', body: 'Let this one command run:' },
  { decision: 'denied', label: 'Deny', body: 'Refuse this command:' },
  {
    decision: 'always', label: 'Always',
    body: 'Approve this command and grant standing approval for the same rules on this executor:',
  },
] as const satisfies readonly {
  decision: Extract<ControlAction, { action: 'approvals.decide' }>['decision'];
  label: string;
  body: string;
}[];
