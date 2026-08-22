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
import { FilledButton } from "@/components/ui/FilledButton";
import { KinuMark } from "@/components/ui/KinuLogo";
import { CloudflareAIConnectNotice } from "@/components/CloudflareAIConnectNotice";
import {
  CONNECT_AI_MESSAGE,
  MISSION_HELP,
  MISSION_LABEL,
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
      <main className="mx-auto grid min-h-full w-full max-w-[1080px] grid-cols-1 content-start gap-6 px-6 py-[clamp(72px,12vh,132px)] md:px-10 lg:grid-cols-[minmax(0,680px)_300px]">
        <header className="col-span-full mb-3">
          <div className="mb-3.5 flex items-center gap-2.5">
            <KinuMark size={22} />
            <span className="font-mono text-[10px] uppercase tracking-[.2em] p-text-4">New workspace</span>
          </div>
          <h1 className="font-serif text-[clamp(38px,4vw,46px)] font-medium leading-[1.12] tracking-[-.015em] p-text">
            What is this workspace for?
          </h1>
        </header>

        <form onSubmit={submit} className="min-w-0 overflow-hidden rounded-[14px] border p-border p-surface">
          <label htmlFor="workspace-mission" className="block px-5 pt-4 text-xs font-semibold p-text-4">
            {MISSION_LABEL}
          </label>
          <textarea
            id="workspace-mission"
            value={mission}
            onChange={(event) => setMission(event.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
            placeholder={MISSION_PLACEHOLDER}
            rows={7}
            autoFocus
            disabled={busy}
            className="block min-h-40 w-full resize-y bg-transparent px-5 pb-5 pt-3 text-[15px] leading-[1.7] p-text outline-none placeholder:p-text-3 disabled:opacity-60"
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
              {MISSION_HELP}
            </p>
            <FilledButton
              type="submit"
              disabled={busy || !mission.trim() || hasModels === false}
              className="!h-9 !rounded-lg px-5 text-[13px]"
            >
              {busy && <Loader size="sm" />}
              Create workspace
            </FilledButton>
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
