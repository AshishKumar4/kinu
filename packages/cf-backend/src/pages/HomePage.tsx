/**
 * The mission-first home screen — the mock's NEW WORKSPACE view.
 *
 * One question in the product's serif voice, one card that answers it (the
 * mission, which seeds SOUL.md and titles the workspace), and two quiet cards
 * beside it: setup links, recent workspaces. The title is derived
 * automatically — a deterministic provisional from the mission, replaced by a
 * generated title moments later — so there is no name field to fill in.
 */
import { type FormEvent, useState, useTransition } from "react";
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
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";

export default function HomePage() {
  const [mission, setMission] = useState("");
  const { entries: workspaces, error: rosterError } = useWorkspaceRoster();
  const listFailed = rosterError !== null;
  const { hasModels, busy, err, create } = useCreateWorkspace();
  const [, startTransition] = useTransition();

  /** React owns the async action; the workspace hook owns its visible error. */
  const submit = (event?: FormEvent): void => {
    event?.preventDefault();
    startTransition(async () => {
      await create(mission);
    });
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

        <form onSubmit={submit} className="p-focus min-w-0 overflow-hidden rounded-2xl border p-border bg-[var(--c-input-bg)] shadow-[0_18px_55px_-42px_rgba(0,0,0,.75)] transition-[border-color,box-shadow]">
          <div className="px-6 pt-5">
            <label htmlFor="workspace-mission" className="block text-[12.5px] font-semibold p-text-3">
              {MISSION_LABEL}
            </label>
            <textarea
              id="workspace-mission"
              value={mission}
              onChange={(event) => setMission(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={MISSION_PLACEHOLDER}
              rows={6}
              autoFocus
              disabled={busy}
              className="block min-h-[168px] w-full resize-none bg-transparent pb-4 pt-3 text-[15px] leading-[1.7] p-text outline-none focus-visible:!outline-none placeholder:p-text-3 disabled:opacity-60"
            />
          </div>
          {hasModels === false && (
            <div className="px-6 pb-4">
              <CloudflareAIConnectNotice returnTo="/" message={CONNECT_AI_MESSAGE} />
            </div>
          )}
          {err && (
            <div className="mx-6 mb-4 rounded-md px-3 py-2 text-xs p-notice-danger">{err}</div>
          )}
          <div className="flex flex-col items-start gap-4 px-6 pb-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-[390px] text-[11.5px] leading-[1.5] p-text-4">
              {MISSION_HELP}
            </p>
            <FilledButton
              type="submit"
              disabled={busy || !mission.trim() || hasModels === false}
              className="!h-10 !rounded-full px-5 text-[13px]"
            >
              {busy && <Loader size="sm" />}
              Create workspace
            </FilledButton>
          </div>
        </form>

        <aside className="order-3 min-w-0 lg:order-none">
          <div className="rounded-[14px] border p-border p-surface px-[18px] py-4">
            <div className="mb-2.5 text-xs font-semibold p-text-4">Setup</div>
            <Link to="/user/settings" className="block py-[5px] text-[13px] p-gold transition-colors hover:p-accent">
              Model providers →
            </Link>
            <a href="/install" className="block py-[5px] text-[13px] p-gold transition-colors hover:p-accent">
              Install the CLI →
            </a>
          </div>
        </aside>

        {(listFailed || workspaces.length > 0) && (
          <section aria-label="Recent workspaces" className="order-2 min-w-0 lg:order-none">
            <div className="mb-2.5 flex items-center justify-between gap-3 px-1">
              <span className="font-mono text-[10px] uppercase tracking-[.14em] p-text-4">Recent</span>
              {listFailed && <span className="text-[11px] p-warning">couldn't load</span>}
            </div>
            <div className="overflow-hidden rounded-[14px] border p-border p-surface">
              {workspaces.slice(0, 5).map((agent, index) => (
                <Link
                  key={agent.name}
                  to={`/workspace/${agent.name}`}
                  className={`flex items-center justify-between gap-3 px-[18px] py-3 text-[13.5px] p-text transition-colors hover:p-gold hover:p-elevated ${index > 0 ? 'border-t border-dashed border-[var(--c-dash)]' : ''}`}
                >
                  <span className="truncate">{agent.displayName || agent.name}</span>
                  <span aria-hidden="true" className="p-text-4">→</span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
