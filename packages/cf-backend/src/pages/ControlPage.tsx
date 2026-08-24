/**
 * `/control` — the admin control plane.
 *
 * Reachable only by a session whose verified email is in `CONTROL_PLANE_ADMINS`;
 * every read behind it answers 404 to anyone else, so a non-operator who guesses
 * this URL gets the same "not an operator" sentence and learns nothing about what
 * is here. The gate is server-side in `control-plane/routes.ts` — this page is a
 * view of an authorized answer, never the thing that decides.
 *
 * ONE PAGE, TABBED, because the tabs are one operator's one job: find the
 * account, find the workspace, see what it is doing, and act. Splitting them
 * across routes would put a page load between two halves of one question.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowLeftIcon, ChartLineIcon, ChatCircleDotsIcon, ClipboardTextIcon, HeartbeatIcon,
  StackIcon, UsersIcon, ShieldCheckIcon,
} from '@phosphor-icons/react';
import {
  fetchAudit, fetchFeedback, fetchIncidents, fetchMetrics, fetchOverview, fetchUserDetail,
  fetchUsers, fetchWorkspaces,
  type ControlAuditRow, type ControlFeedbackRow, type ControlUserRow, type ControlWorkspaceRow,
  type ReconcileReport,
} from '../lib/control-api';
import { METRICS_WINDOWS } from '../control-plane/metrics';
import {
  bytes, Notice, PageWalker, Panel, SectionHeader, Stat, useControlRead, when,
} from '../components/control/panels';
import { type AnalyticsPanel } from '../lib/control-api';
import { WorkspaceDrilldown } from '../components/control/WorkspaceDrilldown';

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

/**
 * ENROLLED IN `scripts/wired.lock.json` — `gate:wired` cannot see this page's
 * consumer, and the absence is the gate's, not the code's. `App.tsx` reaches it
 * through `lazy(() => import('./pages/ControlPage'))`; a dynamic `import()` is
 * an expression that binds no name, so there is no named edge to follow, while
 * a static `import Page from` would be followed. `pages/MCTSExplorer.tsx` is
 * locked for the identical reason. The split is deliberate: every read behind
 * this page answers 404 to non-operators, so its code has no business in the
 * bundle every signed-in user downloads.
 */
export default function ControlPage(): ReactNode {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: TabKey = isTab(raw) ? raw : 'overview';
  // The selected user and workspace live in the URL so an operator can send a
  // colleague the exact view they are looking at, and a reload keeps it.
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
          <h1 className="p-display text-2xl">Control plane</h1>
          <p className="text-xs p-text-3">
            Every account, every workspace, and what the operators of this deployment have done.
            Actions call the same RPCs a workspace's owner calls, and each one is written to the
            audit log before you see its result.
          </p>
        </header>

        <nav className="flex flex-wrap gap-1 border-b p-border pb-2">
          {Object.entries(TABS).map(([key, { label, Icon }]) => (
            <button
              key={key}
              onClick={() => go({ tab: key, user: null, workspace: null })}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors ${
                key === tab ? 'p-accent-bg p-accent' : 'p-text-3 hover:p-text'
              }`}
            >
              <Icon size={13} /> {label}
            </button>
          ))}
        </nav>

        {workspace !== null ? (
          <div className="space-y-3">
            <button
              onClick={() => go({ workspace: null })}
              className="text-xs p-text-3 hover:p-text flex items-center gap-1"
            >
              <ArrowLeftIcon size={12} /> Back
            </button>
            {user === null ? (
              // A workspace name is unique inside one account and nowhere else,
              // so the plane refuses to read one without being told whose it is.
              // Reached only by a hand-edited URL: every row that opens this view
              // carries its owner.
              <Notice tone="warn">
                A workspace has to be opened from a list row, which is what names the
                account that owns it. Pick it from Workspaces or from an account.
              </Notice>
            ) : (
              <WorkspaceDrilldown workspace={workspace} ownerUserId={user} />
            )}
          </div>
        ) : user !== null ? (
          <UserDetailView userId={user} onOpenWorkspace={(name) => go({ workspace: name })}
            onBack={() => go({ user: null })} />
        ) : (
          <TabBody tab={tab} go={go} />
        )}
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

/* ── Overview ────────────────────────────────────────────────────────────── */

function OverviewView(): ReactNode {
  const { load, reload } = useControlRead(fetchOverview, []);
  return (
    <div className="space-y-3">
      <SectionHeader
        title="Fleet"
        hint="Counts from the control-plane index. Every row in it is a copy of state a UserDO owns, so a fresh workspace can appear here a moment after it is created."
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

/* ── Users ───────────────────────────────────────────────────────────────── */

function UsersView({ onOpen }: { onOpen: (userId: string) => void }): ReactNode {
  const [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState(0);
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
                  <span className="font-medium">{u.email}</span>,
                  <span className="tabular-nums">{u.workspaces}</span>,
                  when(u.firstSeenAt), when(u.lastSeenAt),
                ],
              }))}
              empty="No accounts have been observed yet."
            />
            <PageWalker
              status={answer.status} page={page}
              onNext={() => {
                if (answer.status === 'more') { setCursor(answer.next.after); setPage((p) => p + 1); }
              }}
              onFirst={() => { setCursor(null); setPage(0); }}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}

/** The three things a drilldown page can say about the index it is showing. Read
 *  off the server's own report rather than derived, so a continuation page does
 *  not claim a reconcile it did not run. */
const RECONCILE_HINT = {
  ok: 'Reconciled against this account\u2019s own registry on open, so these rows are the registry\u2019s.',
  failed: 'The registry could not be read, so these rows are the index\u2019s own belief.',
  skipped: 'A later page of the walk that reconciled on its first page.',
} satisfies Record<ReconcileReport['status'], string>;

function UserDetailView(
  { userId, onOpenWorkspace, onBack }: {
    userId: string; onOpenWorkspace: (name: string) => void; onBack: () => void;
  },
): ReactNode {
  // Walked like every other list here. An account with more than one page of
  // workspaces previously had every row past the ceiling unreachable, under copy
  // that said the table was the registry's.
  const [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const { load, reload } = useControlRead(() => fetchUserDetail(userId, cursor), [userId, cursor]);
  return (
    <div className="space-y-3">
      <button onClick={onBack} className="text-xs p-text-3 hover:p-text flex items-center gap-1">
        <ArrowLeftIcon size={12} /> All accounts
      </button>
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
                  <span className="font-mono text-xs">{w.name}</span>,
                  w.displayName, when(w.createdAt), when(w.lastSeenAt),
                  w.removedAt === null
                    ? <span className="p-success text-[11px]">live</span>
                    : <span className="p-text-3 text-[11px]">removed {when(w.removedAt)}</span>,
                ],
              }))}
              empty="This account owns no workspaces."
            />
            <PageWalker
              status={detail.workspaces.status} page={page}
              onNext={() => {
                if (detail.workspaces.status === 'more') {
                  setCursor(detail.workspaces.next.after);
                  setPage((p) => p + 1);
                }
              }}
              onFirst={() => { setCursor(null); setPage(0); }}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ── Workspaces ──────────────────────────────────────────────────────────── */

function WorkspacesView(
  { onOpen }: { onOpen: (name: string, userId: string) => void },
): ReactNode {
  const [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState(0);
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
          <label className="flex items-center gap-1.5 text-xs p-text-3">
            <input
              type="checkbox" checked={includeRemoved}
              onChange={(e) => { setIncludeRemoved(e.target.checked); setCursor(null); setPage(0); }}
            />
            Show removed
          </label>
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
                  <span className="font-mono text-xs">{w.name}</span>,
                  w.email.length > 0 ? w.email : <span className="p-text-3">unknown</span>,
                  w.displayName, when(w.lastSeenAt),
                  w.removedAt === null
                    ? <span className="p-success text-[11px]">live</span>
                    : <span className="p-text-3 text-[11px]">removed</span>,
                ],
              }))}
              empty="No workspaces in the index yet."
            />
            <PageWalker
              status={answer.status} page={page}
              onNext={() => {
                if (answer.status === 'more') { setCursor(answer.next.after); setPage((p) => p + 1); }
              }}
              onFirst={() => { setCursor(null); setPage(0); }}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ── Incidents ───────────────────────────────────────────────────────────── */

function IncidentsView(): ReactNode {
  const { load, reload } = useControlRead(fetchIncidents, []);
  return (
    <div className="space-y-3">
      <SectionHeader
        title="Open incidents"
        hint="The synthetic monitor's ledger. Until now it was readable only as email, so an outage nobody saw the mail for was invisible."
        onRefresh={reload}
      />
      <Panel load={load}>
        {(answer) => (
          <Table
            head={['Probe', 'Since', 'Failures', 'Alerted', 'Detail']}
            rows={answer.incidents.map((i) => ({
              key: i.probe,
              cells: [
                <span className="font-mono text-xs">{i.probe}</span>,
                when(i.openedAt),
                <span className="tabular-nums">{i.failures}</span>,
                i.alertedAt === null
                  ? <span className="p-gold text-[11px]">alert owed</span>
                  : when(i.alertedAt),
                <span className="p-text-2 text-xs">{i.detail}</span>,
              ],
            }))}
            empty="Every probe is green."
          />
        )}
      </Panel>
    </div>
  );
}

/* ── Feedback ────────────────────────────────────────────────────────────── */

function FeedbackView(): ReactNode {
  const [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const { load, reload } = useControlRead(() => fetchFeedback(cursor), [cursor]);
  return (
    <div className="space-y-3">
      <SectionHeader
        title="Feedback"
        hint="In-product reports, newest first. Screenshot bytes live in R2; the row carries only the object key."
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
                  <span className="font-mono text-xs">{f.route}</span>,
                  f.workspace ?? <span className="p-text-3">—</span>,
                  f.objectKey === null
                    ? <span className="p-text-3 text-[11px]">note only</span>
                    : <span className="text-[11px] tabular-nums">{bytes(f.bytes)}</span>,
                  <span className="p-text-2 text-xs whitespace-pre-wrap">{f.note}</span>,
                ],
              }))}
              empty="No feedback has been filed yet."
            />
            <PageWalker
              status={answer.status} page={page}
              onNext={() => {
                if (answer.status === 'more') { setCursor(answer.next.after); setPage((p) => p + 1); }
              }}
              onFirst={() => { setCursor(null); setPage(0); }}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ── Metrics ─────────────────────────────────────────────────────────────── */

function MetricsView(): ReactNode {
  const [hours, setHours] = useState(24);
  // A refresh re-asks the server, and `refresh=1` makes the server re-ask
  // Analytics: without it, the button would answer from the same 30-second-old
  // batch and look broken while being correct.
  const { load, reload } = useControlRead(
    (refresh?: boolean) => fetchMetrics(hours, undefined, refresh),
    [hours],
  );
  return (
    <div className="space-y-3">
      <SectionHeader
        title="Fleet metrics"
        hint="From Analytics Engine, sample-interval weighted — an unweighted count under-reports by exactly the sample rate."
        onRefresh={reload}
        actions={
          <select
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            className="text-xs p-card px-2 py-1 rounded-sm"
          >
            {METRICS_WINDOWS.map((w) => (
              <option key={w} value={w}>{w < 24 ? `${String(w)}h` : `${String(w / 24)}d`}</option>
            ))}
          </select>
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
              <section key={name} className="p-card p-4 space-y-2">
                <div className="text-[11px] uppercase tracking-wide p-text-3">{name}</div>
                {panel.status === 'ok' ? (
                  <MetricTable rows={panel.rows} />
                ) : panel.status === 'unconfigured' ? (
                  <div className="text-xs p-text-3">{panel.missing.join(', ')} not set</div>
                ) : (
                  <div className="text-xs p-danger">{panel.reason}</div>
                )}
              </section>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

/** A metric answer, rendered from whatever columns the query aliased. The
 *  columns are the query's business, so this reads them off the first row rather
 *  than hard-coding a set the builder owns. */
function MetricTable({ rows }: { rows: Extract<AnalyticsPanel, { status: 'ok' }>['rows'] }): ReactNode {
  const columns = useMemo(() => Object.keys(rows[0] ?? {}), [rows]);
  if (rows.length === 0) return <div className="text-xs p-text-3">No events in this window.</div>;
  return (
    <table className="w-full text-xs">
      <thead className="p-text-3 border-b p-border">
        <tr>{columns.map((c) => <th key={c} className="text-left py-1 font-medium">{c}</th>)}</tr>
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

/* ── Audit ───────────────────────────────────────────────────────────────── */

function AuditView(): ReactNode {
  const [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const { load, reload } = useControlRead(() => fetchAudit(cursor), [cursor]);
  return (
    <div className="space-y-3">
      <SectionHeader
        title="Admin audit"
        hint="Append-only. Every mutation lands here before its result reaches the operator, including the ones that were refused."
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
                  <span className="font-mono text-xs">{a.operation}</span>,
                  <span className="font-mono text-xs">{a.target}</span>,
                  <span className={a.outcome === 'ok' ? 'p-success text-[11px]'
                    : a.outcome === 'denied' ? 'p-gold text-[11px]' : 'p-danger text-[11px]'}>
                    {a.outcome}
                  </span>,
                  <span className="p-text-2 text-xs">{a.detail}</span>,
                ],
              }))}
              empty="No admin action has been taken on this deployment."
            />
            <PageWalker
              status={answer.status} page={page}
              onNext={() => {
                if (answer.status === 'more') { setCursor(answer.next.after); setPage((p) => p + 1); }
              }}
              onFirst={() => { setCursor(null); setPage(0); }}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ── One table, used by every list ───────────────────────────────────────── */

interface TableRow {
  key: string;
  cells: ReactNode[];
  onClick?: () => void;
}

function Table(
  { head, rows, empty }: { head: string[]; rows: TableRow[]; empty: string },
): ReactNode {
  if (rows.length === 0) {
    return <section className="p-card p-8 text-center text-xs p-text-3">{empty}</section>;
  }
  return (
    <section className="p-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs p-text-3 border-b p-border">
          <tr>{head.map((h) => <th key={h} className="text-left px-4 py-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              onClick={row.onClick}
              className={`border-b p-border last:border-b-0 ${
                row.onClick === undefined ? '' : 'cursor-pointer p-card-hover'
              }`}
            >
              {row.cells.map((cell, index) => (
                <td key={index} className="px-4 py-3 align-top">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
