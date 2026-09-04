/**
 * One workspace, as an operator sees it, plus the controls that act on it.
 *
 * EVERY CONTROL HERE IS A PROXY. The button sends a named action to
 * `POST /api/control/actions`, which calls the `@callable` the workspace's own
 * Durable Object already implements. No control computes a change, which is why
 * the admin path and the owner's own path cannot drift.
 *
 * EVERY CONTROL ASKS FIRST. Not ceremony: this panel is reached from a list where
 * the row above belongs to a different account, so the confirmation names the
 * account, the workspace and the exact thing about to happen. The destructive
 * one — removing a workspace — additionally asks for the name to be retyped,
 * because it tears down the Durable Object, its SQLite and its sandbox.
 *
 * EVERY CONTROL IS BOUND TO THE OWNER THE READ RESOLVED. `detail.userId` is what
 * the server proved when it answered, never the address bar: a workspace name is
 * unique inside one account and `OrchestratorAgent` is addressed globally, so the
 * pair is the address and the name alone is a guess.
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

/** A settled panel's rows, or the reason there are none. Every panel of the
 *  drilldown arrives in this shape so one down surface never blanks the page. */
function PanelBlock(
  { title, panel, children }: { title: string; panel: PanelValue; children?: ReactNode },
): ReactNode {
  return (
    <section className="p-card p-4 space-y-2">
      <div className="text-[11px] uppercase tracking-wide p-text-3">{title}</div>
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

/**
 * A panel's value, as a count plus its JSON.
 *
 * Deliberately generic over the payload: re-implementing the seven renderers the
 * workspace page already has would be a second view of the same data that drifts
 * from the first. `JsonValue` is the parsed domain type for "whatever that RPC
 * returned", so the count is honest about not knowing what the rows mean. The
 * two panels an operator ACTS on are the exception below — a button needs a row
 * id, and a `<pre>` does not have one.
 */
function Rows({ value }: { value: JsonValue }): ReactNode {
  const count = Array.isArray(value) ? value.length : null;
  return (
    <>
      <div className="text-lg p-display tabular-nums">
        {count === null ? '—' : count}
      </div>
      <pre className="text-[10.5px] p-text-3 font-mono overflow-x-auto max-h-40 whitespace-pre-wrap">
        {JSON.stringify(value, null, 2)}
      </pre>
    </>
  );
}

/** A control an operator has picked but not yet confirmed. Held as the ACTION
 *  itself, so the modal cannot describe one thing and send another. */
interface PendingControl {
  action: ControlAction;
  title: string;
  body: string;
  danger: boolean;
}

export function WorkspaceDrilldown(
  { workspace, ownerUserId, onChanged }: {
    workspace: string;
    /** The account that owns this workspace, as the list row named it. The read
     *  itself is resolved through this pair and echoes back the owner it proved,
     *  which is what the controls bind to. */
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
        // The step-up window is five minutes, so an operator with a tab open
        // will hit this. It is an expected path, not an error.
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

  // The one action that needs more than a click: the typed name must equal the
  // workspace name exactly. A prefix is not the name.
  const retypeRequired = pending?.action.action === 'workspace.remove';
  const confirmBlocked = busy || (retypeRequired && typedName !== workspace);

  return (
    <div className="space-y-4">
      <SectionHeader
        title={workspace}
        hint="Live from this workspace's Durable Object. Every control below calls the owner's own RPC."
        onRefresh={reload}
      />

      {result !== null && (
        <Notice tone={result.tone === 'ok' ? 'ok' : result.tone === 'warn' ? 'warn' : 'danger'}>
          {result.text}
        </Notice>
      )}

      <Panel load={load}>
        {(detail) => {
          // The owner the SERVER resolved, not the one this component was asked
          // for. They agree today; binding to the proven one keeps them agreeing.
          const userId = detail.userId;
          const jobs = panelRows(detail.jobs, BackgroundJobRowSchema);
          const approvals = panelRows(detail.approvals, DeferredApprovalRowSchema);
          return (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm" variant="ghost" disabled={busy}
                  onClick={() => confirm({
                    action: { action: 'jobs.clear', userId, workspace },
                    title: 'Clear settled jobs',
                    body: `Drop every settled background job from ${workspace}. Running jobs are untouched.`,
                    danger: false,
                  })}
                >
                  Clear settled jobs
                </Button>
                <Button
                  size="sm" variant="ghost" disabled={busy}
                  onClick={() => confirm({
                    action: { action: 'shell_grants.revoke', userId, workspace },
                    title: 'Revoke shell grants',
                    body: `Revoke every standing shell-approval grant in ${workspace}. The agent will have to ask again for each command.`,
                    danger: false,
                  })}
                >
                  Revoke shell grants
                </Button>
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
              {busy ? 'Working…' : pending.danger ? 'Remove' : 'Confirm'}
            </FilledButton>
          </>}
        >
          <div className="space-y-3">
            <p className="text-xs p-text-2 leading-relaxed">{pending.body}</p>
            <p className="text-[11px] p-text-3">
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

/**
 * Background jobs, as rows an operator can act on.
 *
 * `null` rows means the panel is down or answered in a shape this page does not
 * know; the panel above it already says which, and inventing an empty table here
 * would report "no jobs" about a list that failed to load.
 */
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
            <span className="font-mono text-[11px] p-text-2">{job.kind}</span>
            <span className={job.status === 'running' ? 'p-gold text-[11px]'
              : job.status === 'completed' ? 'p-success text-[11px]' : 'p-danger text-[11px]'}>
              {job.status}
            </span>
            <span className="text-[11px] p-text-3">{when(job.createdAt)}</span>
            {(job.resumeAttempts ?? 0) > 0 && (
              // An operator looking at a job that has been running a long time
              // needs the one fact the row could never show: whether it is stuck
              // or whether the platform keeps interrupting it.
              <span className="text-[11px] p-warning">
                interrupted {job.resumeAttempts}x
                {job.resumeAfter != null && job.resumeAfter > Date.now()
                  ? `, next attempt ${when(job.resumeAfter)}` : ''}
              </span>
            )}
          </div>
          {job.label !== null && <div className="text-xs p-text-2">{job.label}</div>}
          {job.error !== null && <div className="text-[11px] p-danger">{job.error}</div>}
          <div className="flex gap-1.5">
            <Button
              size="sm" variant="ghost" disabled={busy}
              onClick={() => onPick({
                action: { action: 'job.cancel', userId, workspace, jobId: job.id },
                title: 'Cancel this job',
                body: `Stop ${job.kind} (${job.id}) in ${workspace}. Only a running job can be cancelled.`,
                danger: false,
              })}
            >
              Cancel
            </Button>
            <Button
              size="sm" variant="ghost" disabled={busy}
              onClick={() => onPick({
                action: { action: 'job.retry', userId, workspace, jobId: job.id },
                title: 'Retry this job',
                body: `Re-drive ${job.kind} (${job.id}) in ${workspace} as a new job. Kinu refuses to retry a job that succeeded.`,
                danger: false,
              })}
            >
              Retry
            </Button>
            <Button
              size="sm" variant="ghost" disabled={busy}
              onClick={() => onPick({
                action: { action: 'job.dismiss', userId, workspace, jobId: job.id },
                title: 'Dismiss this job',
                body: `Drop ${job.kind} (${job.id}) from ${workspace}'s job list. The work is not undone.`,
                danger: false,
              })}
            >
              Dismiss
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Deferred approvals, as rows an operator can decide. Each answer is its own
 *  button because `always` is a standing grant rather than a flag on `approved`,
 *  and an operator must be able to see which of the three they are giving. */
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
  if (rows.length === 0) return <div className="text-xs p-text-3">Nothing is parked on the owner.</div>;
  return (
    <ul className="space-y-2">
      {rows.map((approval) => (
        <li key={approval.id} className="space-y-1 border-b p-border last:border-b-0 pb-2 last:pb-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] p-text-3">{approval.status}</span>
            <span className="font-mono text-[11px] p-text-2">{approval.executor}</span>
            <span className="text-[11px] p-text-3">{when(approval.requestedAt)}</span>
          </div>
          <div className="font-mono text-xs p-text whitespace-pre-wrap break-all">{approval.command}</div>
          <div className="text-[11px] p-text-3">{approval.reason}</div>
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

/** The three answers `DeferredApprovalStore.decide` accepts, with what each one
 *  actually does. `always` is the one worth spelling out: it outlives the
 *  command it was asked for. */
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
