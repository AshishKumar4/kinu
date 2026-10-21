/**
 * `/shared/blueprint/:id`: read-only, no workspace chrome; the viewer may have no account.
 * A secret-shaped scan hit is reported by location, never content.
 */
import { FRAME_PAGE, PageHeader } from "@/components/ui/PageHeader";
import { type WorkspaceEntry } from '@kinu.run/core';
import { Button } from "@/components/ui/Button";
import { showing, detach } from "@kinu.run/core/obs";
import { Effect } from "effect";
import { useEffect, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { Loader } from "@/components/ui/Loader";
import { FileIcon, FolderIcon, GitBranchIcon, LinkIcon, WarningIcon, type Icon } from "@phosphor-icons/react";
import type { BlueprintView } from "@kinu.run/core";
import { KinuLogo } from "@/components/ui/KinuLogo";
import { ForkDialog } from "@/components/shared/ForkDialog";
import { personReaches, reachConnection } from "@/components/slates/ForkReachPanel";
import { registerWorkspace } from "@/lib/user-api";
import { getBlueprint, signedInEmail } from "@/lib/shared-api";

export function SecretWarning({ warnings, children }: { warnings: BlueprintView["warnings"]; children: ReactNode }) {
  if (warnings.length === 0) return null;

  return (
    <div className="t-meta p-notice-warning rounded-md px-3 py-2" role="alert">
      <p className="flex items-center gap-2 font-medium"><WarningIcon size={14} /> Possible secrets in the source</p>
      <p className="mt-1 opacity-90">{children}</p>
      <ul className="mt-2 space-y-px font-mono">
        {warnings.map((warning) => (
          <li key={`${warning.path}:${warning.line}:${warning.pattern}`}>{warning.path}:{warning.line}: {warning.message}</li>
        ))}
      </ul>
    </div>
  );
}

const ENTRY_ICON: Record<BlueprintView["entries"][number]["kind"], Icon> = {
  file: FileIcon,
  directory: FolderIcon,
  symlink: LinkIcon,
};

function BlueprintBody({ view }: { view: BlueprintView }) {
  return (
    <>
      <section className="space-y-2" aria-label="What it reaches">
        <h2 className="t-label">What a fork calls, as you</h2>
        {personReaches(view.reaches).length === 0 ? (
          <p className="t-meta p-text-3">It was published calling nothing of its publisher&apos;s. A fork runs on its own.</p>
        ) : (
          <ul className="p-card space-y-1 px-4 py-3">
            {personReaches(view.reaches).map((namespace) => (
              <li key={namespace} className="t-body flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono p-text">{namespace}</span>
                <span className="t-meta p-text-2">{reachConnection(namespace).text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <SecretWarning warnings={view.warnings}>
        A blueprint never carries your connected credentials, but it can carry text someone pasted into the source. These lines look like secrets. Check them before you use this blueprint.
      </SecretWarning>
      <section className="space-y-2" aria-label="Files">
        <h2 className="t-label">Files</h2>
        <ul className="t-meta t-mono p-card px-4 py-3">
          {view.entries.map((entry) => {
            const depth = entry.path.split("/").length - 1;
            const EntryIcon = ENTRY_ICON[entry.kind];

            return (
              <li key={entry.path} className="flex items-center gap-2 py-px p-text-2" style={{ paddingLeft: `${depth * 14}px` }}>
                <EntryIcon size={12} className="p-text-3" />
                {entry.path.split("/").at(-1)}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

export default function BlueprintPage({ fixture, viewer, workspaces }: {
  fixture?: BlueprintView;
  viewer?: string | null;
  workspaces?: readonly WorkspaceEntry[];
} = {}) {
  const { id = "" } = useParams();
  const [view, setView] = useState<BlueprintView | null>(fixture ?? null);
  const [email, setEmail] = useState<string | null | undefined>(viewer);
  const [err, setErr] = useState<string | null>(null);
  const [forking, setForking] = useState(false);

  useEffect(() => {
    if (fixture !== undefined) return;
    let live = true;
    const failed = showing((chain) => { if (live) setErr(chain); });

    detach(Effect.all([
      Effect.catchCause(Effect.map(Effect.promise(() => getBlueprint(id)), (loaded) => { if (live) setView(loaded); }), failed),
      Effect.catchCause(Effect.map(Effect.promise(() => signedInEmail()), (who) => { if (live) setEmail(who); }), failed),
    ], { concurrency: 'unbounded' }));

    return () => { live = false; };
  }, [fixture, id]);

  const fork = () => {
    if (email === null) {
      const login = new URL("/login", location.origin);
      login.searchParams.set("return_to", location.pathname + location.search);
      location.assign(login.toString());

      return;
    }

    setForking(true);
  };

  return (
    <div className="min-h-screen p-bg p-text">
      <header className="flex h-14 items-center justify-between border-b p-border px-5">
        <a href="/" aria-label="Kinu home" className="flex items-center"><KinuLogo /></a>
        <span className="t-meta p-text-3">Shared blueprint</span>
      </header>
      <main className={FRAME_PAGE}>
        <PageHeader icon={<GitBranchIcon size={22} />} title={view?.title ?? "Blueprint"}>
          {view !== null && (
            <Button variant="primary" onClick={fork} disabled={email === undefined}>
              <GitBranchIcon size={15} /> Fork into Kinu
            </Button>
          )}
        </PageHeader>
        <div className="mt-8 space-y-6">
          {err && <div className="t-meta p-notice-danger rounded-md px-3 py-2">{err}</div>}
          {view === null && err === null && <div className="flex justify-center py-16"><Loader size="base" /></div>}
          {view !== null && (
            <>
              <div>
                {view.description && <p className="t-body p-text-2">{view.description}</p>}
                <p className="t-meta mt-1 p-text-3">A fork runs in your workspace, as you, on your own connections. Nothing of the publisher's comes with it.</p>
              </div>
              <BlueprintBody view={view} />
            </>
          )}
        </div>
      </main>
      {/* Outside the shell: no sidebar lists the new workspace, so it is only registered. */}
      {forking && view !== null && <ForkDialog blueprint={view.id} title={view.title} onClose={() => setForking(false)} workspaces={workspaces}
        create={(mission) => registerWorkspace(undefined, mission.trim())} />}
    </div>
  );
}
