/** Access is gated server-side in `control-plane/routes.ts`; non-operators get 404. */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowLeftIcon, ChartLineIcon, ChatCircleDotsIcon, ClipboardTextIcon, HeartbeatIcon,
  StackIcon, UsersIcon, ShieldCheckIcon,
} from '@phosphor-icons/react';
import {
  fetchAudit, fetchFeedback, fetchIncidents, fetchMetrics, fetchOverview, fetchUserDetail,
  fetchUsers, fetchWorkspaces, type ReconcileReport,
} from '../lib/control-api';
import {
  METRICS_WINDOWS, type AnalyticsResult, type ControlAuditRow, type ControlFeedbackRow, type ControlUserRow,
  type ControlWorkspaceRow,
} from '@kinu.run/core/control-plane';
import { formatBytes, workspaceDisplayTitle, type SeekCursor } from '@kinu.run/core';
import {
  Notice, PageWalker, Panel, SectionHeader, Stat, useControlRead, when,
} from '../components/control/panels';
import { WorkspaceDrilldown } from '../components/control/WorkspaceDrilldown';
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Checkbox } from "@/components/ui/Check";
import { Surface } from "@/components/ui/Surface";
import { Tabs } from "@/components/ui/Tabs";

const TABS = {
  overview: { label: 'Overview', Icon: ShieldCheckIcon },
  users: { label: 'Users', Icon: UsersIcon },
  workspaces: { label: 'Workspaces', Icon: StackIcon },
  incidents: { label: 'Incidents', Icon: HeartbeatIcon },
  feedback: { label: 'Feedback', Icon: ChatCircleDotsIcon },
  metrics: { label: 'Metrics', Icon: ChartLineIcon },
  audit: { label: 'Audit', Icon: ClipboardTextIcon },
} as const;

type TabKey = keyof typeof TABS;

function isTab(value: string | null): value is TabKey {
  return value !== null && Object.hasOwn(TABS, value);
}

/** Enrolled in `scripts/wired.lock.json`: `gate:wired` cannot follow the lazy `import()` in `App.tsx`. */
export default function ControlPage(): ReactNode {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: TabKey = isTab(raw) ? raw : 'overview';
  // Selection lives in the URL so a view is shareable and survives reload.
  const user = params.get('user');
  const workspace = params.get('workspace');

  const go = useCallback((next: Partial<Record<'tab' | 'user' | 'workspace', string | null>>) => {
    const merged = new URLSearchParams(params);

    for (const [key, value] of Object.entries(next)) {
      if (value === null) merged.delete(key); else merged.set(key, value);
    }

    setParams(merged, { replace: false });
  }, [params, setParams]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <header className="space-y-1">
          <h1 className="t-page-title">Control plane</h1>
          <p className="t-meta p-text-3">
            Every account and workspace on this deployment. Each operator action runs through an
            owner RPC and is written to the audit log before its result shows.
          </p>
        </header>

        <Tabs label="Control" current={tab} onChoose={(key) => go({ tab: key, user: null, workspace: null })}
          items={Object.entries(TABS).map(([key, { label, Icon }]) => ({ id: key, label, icon: Icon }))} />

        {workspace !== null && (
          <div className="space-y-3">
            <Button variant="ghost" size="sm" onClick={() => go({ workspace: null })} icon={<ArrowLeftIcon size={14} />}> Back
            </Button>
            {user === null ? (
              // Workspace names are unique only per account, so the owner is required.
              <Notice tone="warn">
                Open a workspace from the Workspaces tab or an account row.
              </Notice>
            ) : (
              <WorkspaceDrilldown workspace={workspace} ownerUserId={user} />
            )}
          </div>
        )}
        {workspace === null && user !== null && (
          <UserDetailView userId={user} onOpenWorkspace={(name) => go({ workspace: name })}
            onBack={() => go({ user: null })} />
        )}
        {workspace === null && user === null && <TabBody tab={tab} go={go} />}
      </div>
    </div>
  );
}

function TabBody(
  { tab, go }: {
    tab: TabKey;
    go: (next: Partial<Record<'tab' | 'user' | 'workspace', string | null>>) => void;
  },
): ReactNode {
  switch (tab) {
    case 'overview': return <OverviewView />;
    case 'users': return <UsersView onOpen={(userId) => go({ user: userId })} />;
    case 'workspaces': return <WorkspacesView onOpen={(name, userId) => go({ workspace: name, user: userId })} />;
    case 'incidents': return <IncidentsView />;
    case 'feedback': return <FeedbackView />;
    case 'metrics': return <MetricsView />;
    case 'audit': return <AuditView />;
  }
}

function OverviewView(): ReactNode {
  const { load, reload } = useControlRead(fetchOverview, []);

  return (
    <div className="space-y-3">
      <SectionHeader
        title="Fleet"
        hint="Counts come from the control-plane index. New workspaces can take a moment to appear."
        onRefresh={reload}
      />
      <Panel load={load}>
        {(o) => (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Accounts" value={String(o.users)} hint={`${String(o.activeUsers24h)} in 24h · ${String(o.activeUsers7d)} in 7d`} />
            <Stat label="Workspaces" value={String(o.workspaces)} hint={`${String(o.workspacesRemoved)} removed`} />
            <Stat label="Feedback reports" value={String(o.feedback)} />
            <Stat label="Admin actions" value={String(o.auditEntries)} hint={`last ${when(o.lastAdminActionAt)}`} />
          </div>
        )}
      </Panel>
    </div>
  );
}

type WalkedPage = { readonly status: 'end' } | { readonly status: 'more'; readonly next: SeekCursor };

function usePageWalk() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const next = (answer: WalkedPage): void => {
    if (answer.status === 'end') return;

    setCursor(answer.next.after);
    setPage((shown) => shown + 1);
  };

  const first = (): void => { setCursor(null); setPage(0); };

  return { cursor, page, next, first };
}

function UsersView({ onOpen }: { onOpen: (userId: string) => void }): ReactNode {
  const { cursor, page, next, first } = usePageWalk();
  const { load, reload } = useControlRead(() => fetchUsers(cursor), [cursor]);

  return (
    <div className="space-y-3">
      <SectionHeader title="Accounts" hint="Most recently seen first." onRefresh={reload} />
      <Panel load={load}>
        {(answer) => (
          <div className="space-y-2">
            <Table
              head={['Email', 'Workspaces', 'First seen', 'Last seen']}
              rows={answer.items.map((u: ControlUserRow) => ({
                key: u.userId,
                onClick: () => onOpen(u.userId),
                cells: [
                  <strong>{u.email}</strong>,
                  <span className="tabular-nums">{u.workspaces}</span>,
                  when(u.firstSeenAt), when(u.lastSeenAt),
                ],
              }))}
              empty="No accounts have been observed yet."
            />
            <PageWalker
              status={answer.status} page={page}
              onNext={() => next(answer)}
              onFirst={first}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}

/** Read from the server's report so a continuation page does not claim a reconcile it did not run. */
const RECONCILE_HINT = {
  ok: 'Matched to this account\u2019s registry when opened.',
  failed: 'The account registry was unavailable. These rows come from the index.',
  skipped: 'Checked against the account\u2019s registry on the first page only.',
} satisfies Record<ReconcileReport['status'], string>;

function UserDetailView(
  { userId, onOpenWorkspace, onBack }: {
    userId: string; onOpenWorkspace: (name: string) => void; onBack: () => void;
  },
): ReactNode {
  const { cursor, page, next, first } = usePageWalk();
  const { load, reload } = useControlRead(() => fetchUserDetail(userId, cursor), [userId, cursor]);

  return (
    <div className="space-y-3">
      <Button variant="ghost" size="sm" onClick={onBack} icon={<ArrowLeftIcon size={14} />}> All accounts
      </Button>
      <Panel load={load}>
        {(detail) => (
          <div className="space-y-3">
            <SectionHeader
              title={detail.user?.email ?? userId}
              hint={RECONCILE_HINT[detail.reconcile.status]}
              onRefresh={reload}
            />
            {detail.reconcile.status === 'failed' && (
              <Notice tone="warn">
                {detail.reconcile.reason} Nothing was changed in the index.
              </Notice>
            )}
            <Table
              head={['Workspace', 'Title', 'Created', 'Last seen', 'State']}
              rows={detail.workspaces.items.map((w: ControlWorkspaceRow) => ({
                key: `${w.userId}/${w.name}`,
                onClick: () => onOpenWorkspace(w.name),
                cells: [
                  workspaceDisplayTitle(w), when(w.createdAt), when(w.lastSeenAt),
                  w.removedAt === null
                    ? <span className="t-status p-success">live</span>
                    : <span className="t-status p-text-3">removed {when(w.removedAt)}</span>,
                ],
              }))}
              empty="This account owns no workspaces."
            />
            <PageWalker
              status={detail.workspaces.status} page={page}
              onNext={() => next(detail.workspaces)}
              onFirst={first}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}

function WorkspacesView(
  { onOpen }: { onOpen: (name: string, userId: string) => void },
): ReactNode {
  const { cursor, page, next, first } = usePageWalk();
  const [includeRemoved, setIncludeRemoved] = useState(false);

  const { load, reload } = useControlRead(
    () => fetchWorkspaces({ cursor, includeRemoved }), [cursor, includeRemoved],
  );

  return (
    <div className="space-y-3">
      <SectionHeader
        title="Workspaces" hint="Across every account, most recently seen first."
        onRefresh={reload}
        actions={
          <Checkbox checked={includeRemoved} onChange={(on) => { setIncludeRemoved(on); first(); }} label="Show removed" />
        }
      />
      <Panel load={load}>
        {(answer) => (
          <div className="space-y-2">
            <Table
              head={['Workspace', 'Owner', 'Title', 'Last seen', 'State']}
              rows={answer.items.map((w: ControlWorkspaceRow) => ({
                key: `${w.userId}/${w.name}`,
                onClick: () => onOpen(w.name, w.userId),
                cells: [
                  <span className="t-meta t-mono">{w.name}</span>,
                  workspaceDisplayTitle(w), when(w.lastSeenAt),
                  w.removedAt === null
                    ? <span className="t-status p-success">live</span>
                    : <span className="t-status p-text-3">removed</span>,
                ],
              }))}
              empty="No workspaces in the index yet."
            />
            <PageWalker
              status={answer.status} page={page}
              onNext={() => next(answer)}
              onFirst={first}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}

function IncidentsView(): ReactNode {
  const { load, reload } = useControlRead(fetchIncidents, []);

  return (
    <div className="space-y-3">
      <SectionHeader
        title="Open incidents"
        hint="Synthetic monitor probes, newest first."
        onRefresh={reload}
      />
      <Panel load={load}>
        {(answer) => (
          <Table
            head={['Probe', 'Since', 'Failures', 'Alerted', 'Detail']}
            rows={answer.incidents.map((i) => ({
              key: i.probe,
              cells: [
                <span className="t-meta t-mono">{i.probe}</span>,
                when(i.openedAt),
                <span className="tabular-nums">{i.failures}</span>,
                i.alertedAt === null
                  ? <span className="t-status p-accent-fg">alert owed</span>
                  : when(i.alertedAt),
                <span className="t-meta p-text-2">{i.detail}</span>,
              ],
            }))}
            empty="Every probe is green."
          />
        )}
      </Panel>
    </div>
  );
}

/** A Gallery report carries no screenshot: its route is the listing's page and its note the reason. */
function feedbackAttachment(f: ControlFeedbackRow): ReactNode {
  if (f.kind === 'gallery_report') return <span className="p-text-3 t-status">Gallery report</span>;

  return f.bytes === null
    ? <span className="p-text-3 t-status">note only</span>
    : <span className="t-meta tabular-nums">{formatBytes(f.bytes)}</span>;
}

function FeedbackView(): ReactNode {
  const { cursor, page, next, first } = usePageWalk();
  const { load, reload } = useControlRead(() => fetchFeedback(cursor), [cursor]);

  return (
    <div className="space-y-3">
      <SectionHeader
        title="Feedback"
        hint="Reports, newest first."
        onRefresh={reload}
      />
      <Panel load={load}>
        {(answer) => (
          <div className="space-y-2">
            <Table
              head={['When', 'From', 'Route', 'Workspace', 'Screenshot', 'Note']}
              rows={answer.items.map((f: ControlFeedbackRow) => ({
                key: f.id,
                cells: [
                  when(f.createdAt), f.email,
                  <span className="t-meta t-mono">{f.route}</span>,
                  f.workspace ?? <span className="p-text-3">—</span>,
                  feedbackAttachment(f),
                  <span className="t-meta p-text-2 whitespace-pre-wrap">{f.note}</span>,
                ],
              }))}
              empty="No feedback has been filed yet."
            />
            <PageWalker
              status={answer.status} page={page}
              onNext={() => next(answer)}
              onFirst={first}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}

function MetricsView(): ReactNode {
  const [hours, setHours] = useState(24);

  const { load, reload } = useControlRead(() => fetchMetrics(hours), [hours]);

  return (
    <div className="space-y-3">
      <SectionHeader
        title="Fleet metrics"
        hint="Analytics Engine weights samples by interval. Raw counts under-report by the sample rate."
        onRefresh={reload}
        actions={
          <Select label="Window" size="sm" value={String(hours)} onChange={(next) => setHours(Number(next))}
            options={METRICS_WINDOWS.map((w) => ({ value: String(w), label: w < 24 ? `${String(w)}h` : `${String(w / 24)}d` }))} />
        }
      />
      <Panel load={load}>
        {(metrics) => metrics.missing.length > 0 ? (
          <Notice tone="muted">
            Analytics is not configured on this deployment: {metrics.missing.join(', ')} not set.
            Every other view here is unaffected.
          </Notice>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {Object.entries(metrics.panels).map(([name, panel]) => (
              <Surface look="panel" as="section" key={name} className="p-4 space-y-2">
                <div className="t-label">{name}</div>
                <PanelBody panel={panel} />
              </Surface>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function PanelBody({ panel }: { panel: AnalyticsResult }): ReactNode {
  if (panel.status === 'ok') return <MetricTable rows={panel.rows} />;

  if (panel.status === 'unconfigured') return <div className="t-meta p-text-3">{panel.missing.join(', ')} not set</div>;

  return <div className="t-meta p-danger">{panel.reason}</div>;
}

function MetricTable({ rows }: { rows: Extract<AnalyticsResult, { status: 'ok' }>['rows'] }): ReactNode {
  const columns = useMemo(() => Object.keys(rows[0] ?? {}), [rows]);

  if (rows.length === 0) return <div className="t-meta p-text-3">No events in this window.</div>;

  return (
    <table className="t-meta w-full">
      <thead className="p-text-3 border-b p-border">
        <tr>{columns.map((c) => <th key={c} className="t-status text-left py-1">{c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index} className="border-b p-border last:border-b-0">
            {columns.map((c) => (
              <td key={c} className="py-1 tabular-nums p-text-2">
                {row[c] === null ? '—' : String(row[c])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** `pending` is a never-recorded settlement and reads as a failure. */
const AUDIT_TONE: Record<ControlAuditRow['outcome'], string> = {
  ok: 't-status p-success',
  denied: 't-status p-accent-fg',
  failed: 't-status p-danger',
  pending: 't-status p-danger',
};

function AuditView(): ReactNode {
  const { cursor, page, next, first } = usePageWalk();
  const { load, reload } = useControlRead(() => fetchAudit(cursor), [cursor]);

  return (
    <div className="space-y-3">
      <SectionHeader
        title="Admin audit"
        hint="Append-only. Kinu logs every action, including refusals."
        onRefresh={reload}
      />
      <Panel load={load}>
        {(answer) => (
          <div className="space-y-2">
            <Table
              head={['When', 'Operator', 'Operation', 'Target', 'Outcome', 'Detail']}
              rows={answer.items.map((a: ControlAuditRow) => ({
                key: a.id,
                cells: [
                  when(a.at), a.actorEmail,
                  <span className="t-meta t-mono">{a.operation}</span>,
                  <span className="t-meta t-mono">{a.target}</span>,
                  <span className={AUDIT_TONE[a.outcome]}>
                    {a.outcome}
                  </span>,
                  <span className="t-meta p-text-2">{a.detail}</span>,
                ],
              }))}
              empty="No operator has acted on this deployment."
            />
            <PageWalker
              status={answer.status} page={page}
              onNext={() => next(answer)}
              onFirst={first}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}

interface TableRow {
  key: string;
  cells: ReactNode[];
  onClick?: () => void;
}

function Table(
  { head, rows, empty }: { head: string[]; rows: TableRow[]; empty: string },
): ReactNode {
  if (rows.length === 0) {
    return <Surface look="panel" as="section" className="t-meta p-8 text-center p-text-3">{empty}</Surface>;
  }

  return (
    <Surface look="panel" as="section" className="overflow-x-auto">
      <table className="t-body w-full">
        <thead className="t-meta p-text-3 border-b p-border">
          <tr>{head.map((h) => <th key={h} className="t-status text-left px-4 py-2">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              onClick={row.onClick}
              data-opens={row.onClick === undefined ? undefined : ''}
              className="border-b p-border last:border-b-0"
            >
              {row.cells.map((cell, index) => (
                <td key={index} className="px-4 py-3 align-top">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Surface>
  );
}
