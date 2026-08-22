/**
 * The mission-first home screen — the mock's NEW WORKSPACE view.
 *
 * One question in the product's serif voice, one card that answers it (the
 * mission, which seeds SOUL.md and titles the workspace), and two quiet cards
 * beside it: setup links, recent workspaces. The title is derived
 * automatically — a deterministic provisional from the mission, replaced by a
 * generated title moments later — so there is no name field to fill in.
 */
import { type FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import { CloudflareAIConnectNotice } from "@/components/CloudflareAIConnectNotice";
import {
  CONNECT_AI_MESSAGE,
  MISSION_PLACEHOLDER,
  useCreateWorkspace,
} from "@/hooks/use-create-workspace";
import { listWorkspaces, type WorkspaceEntry } from "@/lib/user-api";

export default function HomePage() {
  const [mission, setMission] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [workspaceTotal, setWorkspaceTotal] = useState(0);
  const [listFailed, setListFailed] = useState(false);
  const { hasModels, busy, err, create } = useCreateWorkspace();

  useEffect(() => {
    listWorkspaces().then((w) => { setWorkspaces(w.entries); setWorkspaceTotal(w.total); setListFailed(false); }).catch(() => setListFailed(true));
  }, []);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    void create(mission);
  };

  return (
    <div className="h-full overflow-y-auto p-bg">
      {/* The mock's grid: a 520px mission column and a 250px side column,
          centered, with the headline spanning both. */}
      <main className="mx-auto grid min-h-full w-full max-w-[810px] grid-cols-[minmax(0,1fr)] content-center gap-5 px-8 py-8 lg:grid-cols-[minmax(0,520px)_250px]">
        <header className="col-span-full mb-1.5">
          <div className="mb-3.5 flex items-center gap-2.5">
            <span aria-hidden="true" className="inline-block font-serif text-[22px] leading-none text-[var(--c-accent)] rotate-12">❯</span>
            <span className="font-mono text-[10px] uppercase tracking-[.2em] p-text-4">New workspace</span>
          </div>
          {/* The product's serif voice — the mock's 36px Newsreader headline. */}
          <h1 className="font-serif font-medium text-[36px] leading-tight tracking-[-.01em] p-text">
            What is this workspace for?
          </h1>
        </header>

        {/* Mission card */}
        <form onSubmit={submit} className="min-w-0 overflow-hidden rounded-[14px] border p-border p-surface">
          <label htmlFor="workspace-mission" className="block px-5 pt-4 text-xs font-semibold p-text-4">
            Mission
          </label>
          <textarea
            id="workspace-mission"
            value={mission}
            onChange={(event) => setMission(event.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
            placeholder={MISSION_PLACEHOLDER}
            rows={6}
            autoFocus
            disabled={busy}
            className="block min-h-28 w-full resize-y bg-transparent px-5 pb-4 pt-2.5 text-[14.5px] leading-[1.65] p-text outline-none placeholder:p-text-3 disabled:opacity-60"
          />
          {hasModels === false && (
            <div className="px-5 pb-3">
              <CloudflareAIConnectNotice returnTo="/" message={CONNECT_AI_MESSAGE} />
            </div>
          )}
          {err && (
            <div className="mx-5 mb-3 rounded-md px-3 py-2 text-xs p-notice-danger">{err}</div>
          )}
          <div className="flex items-center justify-between gap-4 border-t p-border p-sidebar px-5 py-3">
            <p className="text-[11.5px] leading-snug p-text-4">
              Becomes the workspace's SOUL.md. Nothing runs until the first message.
            </p>
            <button
              type="submit"
              disabled={busy || !mission.trim() || hasModels === false}
              className="inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full bg-[var(--c-accent)] px-[18px] text-[13px] font-semibold text-[var(--c-accent-on)] transition-colors hover:bg-[var(--c-accent-fg)] disabled:bg-[var(--c-fill)] disabled:p-text-4"
            >
              {busy && <Loader size="sm" />}
              Create workspace
            </button>
          </div>
        </form>

        {/* Setup + Recent */}
        <aside className="flex min-w-0 flex-col gap-3.5">
          <div className="rounded-[14px] border p-border p-surface px-[18px] py-4">
            <div className="mb-2.5 text-xs font-semibold p-text-4">Setup</div>
            <Link to="/user/settings" className="block py-[5px] text-[13px] p-gold transition-colors hover:p-accent">
              Model providers →
            </Link>
            <a href="/install" className="block py-[5px] text-[13px] p-gold transition-colors hover:p-accent">
              Install the CLI →
            </a>
          </div>

          {(listFailed || workspaces.length > 0) && (
            <div className="rounded-[14px] border p-border p-surface px-[18px] py-4">
              <div className="mb-2.5 flex items-center justify-between gap-3">
                <span className="text-xs font-semibold p-text-4">Recent{workspaces.length > 0 ? ` · ${workspaceTotal}` : ""}</span>
                {listFailed && <span className="text-[11px] p-warning">couldn't load</span>}
              </div>
              <div className="space-y-0.5">
                {workspaces.slice(0, 5).map((agent) => (
                  <Link
                    key={agent.name}
                    to={`/workspace/${agent.name}`}
                    className="block truncate rounded-md px-1 py-1 text-[13.5px] p-text transition-colors hover:p-gold"
                  >
                    {agent.displayName || agent.name}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
