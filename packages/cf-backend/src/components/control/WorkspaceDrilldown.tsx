/**
 * One workspace, as an operator sees it, plus the controls that act on it.
 *
 * EVERY CONTROL HERE IS A PROXY. The button sends a named action to
 * `POST /api/control/actions`, which calls the `@callable` the workspace's own
 * Durable Object already implements. No control computes a change, which is why
 * the admin path and the owner's own path cannot drift.
 *
 * The destructive one — removing a workspace — asks for the name to be retyped.
 * That is not ceremony: this panel is reached from a list where the row above
 * belongs to a different account, and the action tears down the workspace's
 * Durable Object, its SQLite and its sandbox.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { Button } from '@cloudflare/kumo';
import { TrashIcon, WarningIcon } from '@phosphor-icons/react';
import { FilledButton } from '../ui/FilledButton';
import { Modal } from '../ui/Modal';
import { inputCls } from '../ui/form';
import {
  fetchWorkspaceDetail, runAction,
  type ControlAction, type JsonValue, type Panel as PanelValue,
} from '../../lib/control-api';
import { Notice, Panel, SectionHeader, useControlRead } from './panels';

/** A settled panel's rows, or the reason there are none. Every panel of the
 *  drilldown arrives in this shape so one down surface never blanks the page. */
function PanelBlock({ title, panel }: { title: string; panel: PanelValue }): ReactNode {
  return (
    <section className="p-card p-4 space-y-2">
      <div className="text-[11px] uppercase tracking-wide p-text-3">{title}</div>
      {panel.status === 'ok'
        ? <Rows value={panel.value} />
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
 * returned", so the count is honest about not knowing what the rows mean.
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

export function WorkspaceDrilldown(
  { workspace, ownerUserId, onChanged }: {
    workspace: string;
    /** Present when the caller came from a user drilldown, which is the only
     *  place a removal is offered — removing a workspace needs the owning
     *  UserDO, and a workspace row with no known owner cannot name one. */
    ownerUserId?: string;
    onChanged?: () => void;
  },
): ReactNode {
  const { load, reload } = useControlRead(() => fetchWorkspaceDetail(workspace), [workspace]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'warn' | 'danger'; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
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

  return (
    <div className="space-y-4">
      <SectionHeader
        title={workspace}
        hint="Read live from this workspace's own Durable Object. Every control below calls the same RPC the owner's UI does."
        onRefresh={reload}
      />

      {result !== null && (
        <Notice tone={result.tone === 'ok' ? 'ok' : result.tone === 'warn' ? 'warn' : 'danger'}>
          {result.text}
        </Notice>
      )}

      <Panel load={load}>
        {(detail) => (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm" variant="ghost" disabled={busy}
                onClick={() => void act({ action: 'jobs.clear', workspace })}
              >
                Clear settled jobs
              </Button>
              <Button
                size="sm" variant="ghost" disabled={busy}
                onClick={() => void act({ action: 'shell_grants.revoke', workspace })}
              >
                Revoke shell grants
              </Button>
              {ownerUserId !== undefined && (
                <button
                  disabled={busy}
                  onClick={() => { setTypedName(''); setConfirmRemove(true); }}
                  className="text-xs p-danger hover:underline flex items-center gap-1 px-2 py-1"
                >
                  <TrashIcon size={12} /> Remove workspace
                </button>
              )}
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <PanelBlock title="Recent runs" panel={detail.runs} />
              <PanelBlock title="Activity + spend" panel={detail.activity} />
              <PanelBlock title="Background jobs" panel={detail.jobs} />
              <PanelBlock title="Deferred approvals" panel={detail.approvals} />
              <PanelBlock title="Pending device consents" panel={detail.consents} />
              <PanelBlock title="Executors" panel={detail.executors} />
              <PanelBlock title="Standing shell grants" panel={detail.shellGrants} />
            </div>
          </div>
        )}
      </Panel>

      {confirmRemove && ownerUserId !== undefined && (
        <Modal
          title="Remove this workspace"
          icon={<TrashIcon size={18} className="p-danger" />}
          onClose={() => setConfirmRemove(false)}
          busy={busy}
          footer={<>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
            <FilledButton
              danger
              disabled={busy || typedName !== workspace}
              onClick={() => void act({
                action: 'workspace.remove', workspace, userId: ownerUserId, confirm: typedName,
              }).then((ok) => { if (ok) setConfirmRemove(false); })}
            >
              {busy ? 'Removing…' : 'Remove'}
            </FilledButton>
          </>}
        >
          <div className="space-y-3">
            <p className="text-xs p-text-2 leading-relaxed">
              This tears down the workspace's Durable Object — its conversation, its
              model choice, its scaffold, its triggers and its sandbox — and drops it
              from its owner's registry. It belongs to another account and it cannot
              be undone.
            </p>
            <label className="block text-xs p-text-3">
              Type <span className="font-mono p-text">{workspace}</span> to confirm
              <input
                className={`${inputCls} mt-1`}
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
                autoFocus
              />
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}
