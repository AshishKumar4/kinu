/**
 * The shared library: what I shared, what others shared with me, what is
 * public, and what the people I have exchanged a share with have made public.
 * A row is either a live share — the owner's slate running in the owner's
 * workspace under the members they granted, opened in a new tab — or a
 * blueprint — a committed version with every binding unmapped, forked into a
 * workspace of mine.
 *
 * There is no user-level file list here, because there is no user-level file
 * or blob store to list: `user-schema.ts` declares none, and every file lives
 * in the workspace object that owns it.
 */
import { startTransition, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, BlueprintIcon, GitBranchIcon, GlobeIcon, ShareNetworkIcon, UsersIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { blueprintPagePath, type SharedLibrary, type SharedRow } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import { getSharedLibrary, openLiveShare } from "@/lib/shared-api";
import { ForkDialog } from "@/components/shared/ForkDialog";
import type { WorkspaceEntry } from "@/lib/user-api";

function when(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** A live row opens the running slate in a new tab; the URL is minted per
 *  open because a share that names people carries a short-lived ticket. */
function OpenLive({ row }: { row: SharedRow }) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const open = useCallback(async () => {
    if (row.workspace === undefined || pending) return;
    setPending(true);
    setFailure(null);

    try {
      const { url } = await openLiveShare({ workspace: row.workspace, share: row.share });
      window.open(url, "_blank", "noopener");
    } catch (cause) {
      setFailure(renderThrownChain({ cause }));
    } finally {
      setPending(false);
    }
  }, [row.workspace, row.share, pending]);

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button type="button" onClick={open} disabled={pending || row.workspace === undefined} data-open-live
        className="p-btn-quiet inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs">
        {pending ? <Loader size="sm" /> : <ArrowSquareOutIcon size={13} />} Open
      </button>
      {failure !== null && <span className="p-notice-danger max-w-[16rem] truncate rounded px-2 py-0.5 text-[11px]" title={failure}>{failure}</span>}
    </div>
  );
}

function KindBadge({ row }: { row: SharedRow }) {
  if (row.kind === "live") {
    return <span className="p-badge-info rounded px-1.5 py-0.5 text-[10px]">live{row.visibility === "public" ? " · public" : row.visibility === "users" ? " · people" : ""}</span>;
  }

  return <span className="p-badge-neutral rounded px-1.5 py-0.5 text-[10px]">blueprint</span>;
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
            <li key={`${row.kind}:${row.id}`} className="flex flex-col gap-2 border-b p-border px-5 py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {row.kind === "blueprint"
                    ? <Link to={blueprintPagePath(row.id)} className="p-row-text font-medium p-text hover:p-accent">{row.title}</Link>
                    : <span className="p-row-text font-medium p-text">{row.title}</span>}
                  <KindBadge row={row} />
                </div>
                {row.description && <p className="mt-0.5 p-meta p-text-2 line-clamp-2">{row.description}</p>}
                <p className="mt-1 p-meta p-text-3">
                  {row.owner !== undefined && <>from <span className="p-text-2">{row.owner}</span> · </>}
                  {row.workspace !== undefined && <>in <span className="font-mono p-text-2">{row.workspace}</span> · </>}
                  {row.bindings} {row.kind === "live" ? "member" : "binding"}{row.bindings === 1 ? "" : "s"} · {when(row.createdAt)}
                  {row.users !== undefined && row.users.length > 0 && <> · shared with {row.users.join(", ")}</>}
                </p>
              </div>
              {row.kind === "live" ? <OpenLive row={row} /> : (
                <button type="button" onClick={() => onFork(row)}
                  className="p-btn-quiet inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs">
                  <GitBranchIcon size={13} /> Fork into a workspace
                </button>
              )}
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

  const lists = library;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <header className="flex items-start gap-3">
          <ShareNetworkIcon size={22} className="mt-1 shrink-0 p-text-3" />
          <div>
            <h1 className="p-display text-2xl">Shared</h1>
            <p className="mt-1 text-xs p-text-3">
              A live share runs in its owner's workspace under the members they granted; a blueprint forks into yours with every binding unmapped.
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
        ) : lists !== null && (
          <div className="grid gap-6 lg:grid-cols-2">
            <SharedList heading="My shared" icon={BlueprintIcon} rows={lists.mine} onFork={setForking}
              empty="Nothing shared yet. Open a slate's tab in a workspace and choose Share." />
            <SharedList heading="Shared with me" icon={UsersIcon} rows={lists.received} onFork={setForking}
              empty="No one has named you on a share yet." />
            <SharedList heading="Public" icon={GlobeIcon} rows={lists.public} onFork={setForking}
              empty="Nothing is public yet." />
            <SharedList heading="From people I know" icon={UsersThreeIcon} rows={lists.known} onFork={setForking}
              empty="Nobody you have exchanged a share with has published anything public." />
          </div>
        )}
      </div>
      {forking !== null && <ForkDialog blueprint={forking.id} title={forking.title} onClose={() => setForking(null)} workspaces={workspaces} />}
    </div>
  );
}
