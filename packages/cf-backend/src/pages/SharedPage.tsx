/**
 * The shared library: what I published and what others named me on. Every row
 * is a blueprint — a committed slate version with every binding unmapped — and
 * its one action forks it into a workspace of mine. Public and "from people I
 * know" are later lists on this same page.
 */
import { startTransition, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import { BlueprintIcon, GitBranchIcon, ShareNetworkIcon, UsersIcon } from "@phosphor-icons/react";
import { blueprintPagePath, type SharedLibrary, type SharedRow } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import { getSharedLibrary } from "@/lib/shared-api";
import { ForkDialog } from "@/components/shared/ForkDialog";
import type { WorkspaceEntry } from "@/lib/user-api";

function when(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function SharedList({ heading, icon: Icon, rows, empty, onFork }: {
  heading: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  rows: readonly SharedRow[];
  empty: string;
  onFork: (row: SharedRow) => void;
}) {
  return (
    <section className="p-card overflow-hidden" aria-label={heading}>
      <header className="flex items-center gap-3 border-b p-border px-5 py-4">
        <Icon size={16} className="shrink-0 p-text-3" />
        <h2 className="p-title p-text">{heading}</h2>
        <span className="ml-auto p-meta p-text-3 tabular-nums">{rows.length}</span>
      </header>
      {rows.length === 0 ? (
        <p className="px-5 py-6 text-xs p-text-3">{empty}</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-2 border-b p-border px-5 py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-4">
              <div className="min-w-0 flex-1">
                <Link to={blueprintPagePath(row.id)} className="p-row-text font-medium p-text hover:p-accent">{row.title}</Link>
                {row.description && <p className="mt-0.5 p-meta p-text-2 line-clamp-2">{row.description}</p>}
                <p className="mt-1 p-meta p-text-3">
                  {row.owner !== undefined && <>from <span className="p-text-2">{row.owner}</span> · </>}
                  {row.workspace !== undefined && <>in <span className="font-mono p-text-2">{row.workspace}</span> · </>}
                  {row.bindings} binding{row.bindings === 1 ? "" : "s"} · {when(row.createdAt)}
                  {row.users !== undefined && row.users.length > 0 && <> · shared with {row.users.join(", ")}</>}
                </p>
              </div>
              <button type="button" onClick={() => onFork(row)}
                className="p-btn-quiet inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs">
                <GitBranchIcon size={13} /> Fork into a workspace
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function SharedPage({ fixture, workspaces }: {
  /** Signed-out sample content for the gallery. */
  fixture?: SharedLibrary;
  workspaces?: readonly WorkspaceEntry[];
} = {}) {
  const [library, setLibrary] = useState<SharedLibrary | null>(fixture ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [forking, setForking] = useState<SharedRow | null>(null);

  const refresh = useCallback(() => {
    if (fixture !== undefined) return;
    setErr(null);
    startTransition(async () => {
      try { setLibrary(await getSharedLibrary()); }
      catch (cause) { setErr(renderThrownChain({ cause })); }
    });
  }, [fixture]);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <header className="flex items-start gap-3">
          <ShareNetworkIcon size={22} className="mt-1 shrink-0 p-text-3" />
          <div>
            <h1 className="p-display text-2xl">Shared</h1>
            <p className="mt-1 text-xs p-text-3">
              Blueprints are committed slate versions with every binding unmapped. A fork runs in your workspace, with your connections.
            </p>
          </div>
        </header>
        {err && (
          <div className="p-notice-danger flex items-center justify-between gap-3 rounded-md px-3 py-2 text-xs">
            <span className="min-w-0 truncate">{err}</span>
            <button type="button" onClick={refresh} className="shrink-0 underline">retry</button>
          </div>
        )}
        {library === null && err === null ? (
          <div className="flex items-center justify-center py-12"><Loader size="base" /></div>
        ) : library !== null && (
          <>
            <SharedList heading="My shared" icon={BlueprintIcon} rows={library.mine} onFork={setForking}
              empty="Nothing published yet. Open a slate's tab in a workspace and choose Share to publish a blueprint." />
            <SharedList heading="Shared with me" icon={UsersIcon} rows={library.received} onFork={setForking}
              empty="No one has named you on a blueprint yet." />
          </>
        )}
      </div>
      {forking !== null && <ForkDialog blueprint={forking.id} title={forking.title} onClose={() => setForking(null)} workspaces={workspaces} />}
    </div>
  );
}
