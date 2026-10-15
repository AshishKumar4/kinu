/**
 * Picks a workspace of the caller's for a shared slate. Fork: a copy of its code lands there, and nothing else, no data,
 * connection, person or lend (security §1.6); a part that ran with someone's lend comes as its look only. Edit (someone
 * added with Edit): that workspace's agent changes the shared slate itself, for everyone using it. One workspace skips
 * the choice.
 */
import { Effect } from "effect";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import { GitForkIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import { detach, showing } from "@kinu.run/core/obs";
import { workspaceDisplayTitle, type ForkPreview, type WorkspaceEntry } from "@kinu.run/core";
import { FilledButton } from "@/components/ui/FilledButton";
import { inputCls } from "@/components/ui/form";
import { Modal } from "@/components/ui/Modal";
import { nameOf, names } from "@/components/sharing/words";
import { forkRoom, readForkPreview } from "@/lib/room-client";
import { listWorkspaces } from "@/lib/user-api";

const NEW_WORKSPACE = "\u0000new";

/** A shared slate, by where its room is. */
export interface RoomSlate {
  readonly workspace: string;
  readonly slate: string;
}

/** Where the editor's agent works on the shared slate: its chat, with the slate attached. */
const editPath = (workspace: string, room: RoomSlate) =>
  `/workspace/${encodeURIComponent(workspace)}?edit=${encodeURIComponent(`${room.workspace}/${room.slate}`)}`;

/** Where a fork opens: the workspace it landed in, with the forked slate open. */
const forkedPath = (workspace: string, slate: string) => `/workspace/${encodeURIComponent(workspace)}?slate=${encodeURIComponent(slate)}`;

/** What a fork brings and leaves, from its preview. */
function ForkTerms({ preview }: { preview: ForkPreview }) {
  const owner = nameOf(preview.owner);
  const lent = preview.parts.some((part) => part.lent);
  const needs = [...new Set(preview.parts.flatMap((part) => (part.needs === null ? [] : [part.needs.title])))];

  return (
    <div className="space-y-2 p-row-text p-text-2">
      <p>You get its code as it is now, in a workspace of yours. Nothing else comes with it: no data, connections, or anything {owner} lends.</p>
      {lent && <p data-fork-lent>Parts that use {owner}&apos;s servers come as their look only; your agent can build them on your own.</p>}
      {needs.length > 0 && <p data-fork-needs className="p-meta p-text-3">It asks for your own {names(needs)} where a part first needs it.</p>}
    </div>
  );
}

export function ForkDialog({ room, title, mode, onClose, workspaces, create }: {
  room: RoomSlate;
  title: string;
  mode: "fork" | "edit";
  onClose: () => void;
  /** A fixture roster; absent, the dialog reads the account's own. */
  workspaces?: readonly WorkspaceEntry[];
  /** Makes the new workspace it lands in: in the app's shell the roster's, so the sidebar lists it at once. */
  create: (mission: string) => Promise<WorkspaceEntry>;
}) {
  const navigate = useNavigate();
  const [roster, setRoster] = useState<readonly WorkspaceEntry[] | null>(workspaces ?? null);
  const [preview, setPreview] = useState<ForkPreview | null>(null);
  const [target, setTarget] = useState<string>(workspaces?.[0]?.name ?? NEW_WORKSPACE);
  const [mission, setMission] = useState(title);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const failed = showing((chain) => { if (mounted) setErr(chain); });

    const listed = workspaces !== undefined ? Effect.void : Effect.catchCause(Effect.flatMap(Effect.promise(() => listWorkspaces()), (list) => {
      const only = list.entries.length === 1 ? list.entries[0] : undefined;

      if (!mounted) return Effect.void;

      // One workspace to edit in: no choice to make.
      if (mode === "edit" && only !== undefined) return Effect.promise(async () => navigate(editPath(only.name, room)));

      return Effect.sync(() => {
        setRoster(list.entries);
        setTarget(list.entries[0]?.name ?? NEW_WORKSPACE);
      });
    }), failed);

    const previewed = mode !== "fork" ? Effect.void
      : Effect.catchCause(Effect.map(Effect.promise(() => readForkPreview(room.workspace, room.slate)), (read) => { if (mounted) setPreview(read); }), failed);

    detach(Effect.all([listed, previewed], { concurrency: "unbounded", discard: true }));

    return () => { mounted = false; };
  }, [workspaces, mode, room, navigate]);

  const submit = useCallback(() => detach(Effect.gen(function* () {
    if (busy) return;

    setBusy(true);
    setErr(null);

    return yield* Effect.catchCause(Effect.gen(function* () {
      const workspace = target === NEW_WORKSPACE ? (yield* Effect.promise(async () => create(mission))).name : target;

      if (mode === "edit") {
        yield* Effect.promise(async () => navigate(editPath(workspace, room)));

        return;
      }

      const forked = yield* Effect.promise(async () => forkRoom(room.workspace, room.slate, workspace));

      yield* Effect.promise(async () => navigate(forkedPath(forked.workspace, forked.slate)));
    }), showing((chain) => {
      setErr(chain);
      setBusy(false);
    }));
  })), [busy, target, mission, mode, room, navigate, create]);

  const ready = roster !== null && (mode === "edit" || preview !== null);
  const verb = mode === "fork" ? "Fork" : "Edit";

  return (
    <Modal
      title={mode === "fork" ? `Fork ${title}` : `Edit ${title} with your agent`}
      icon={mode === "fork" ? <GitForkIcon size={18} className="p-accent" /> : <PencilSimpleIcon size={18} className="p-accent" />}
      onClose={onClose}
      busy={busy}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <FilledButton data-fork-submit onClick={submit} disabled={busy || !ready || (target === NEW_WORKSPACE && mission.trim() === "")}>
          {busy ? <><Loader size="sm" /><span className="ml-1">{mode === "fork" ? "Forking…" : "Opening…"}</span></> : verb}
        </FilledButton>
      </>}
    >
      {mode === "fork" && preview !== null && <ForkTerms preview={preview} />}
      {mode === "edit" && <p className="p-row-text p-text-2">Your agent in the workspace you choose changes {title} for everyone using it, with your own AI.</p>}
      {!ready && err === null && <div className="flex justify-center py-4"><Loader size="sm" /></div>}
      {roster !== null && (
        <fieldset className="space-y-1" aria-label="Workspace">
          {roster.map((entry) => (
            <label key={entry.name} className={`flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-sm ${target === entry.name ? "p-border p-elevated" : "border-transparent p-card-hover"}`}>
              <input type="radio" name="fork-target" value={entry.name} checked={target === entry.name} onChange={() => setTarget(entry.name)} disabled={busy} />
              <span className="min-w-0 flex-1 truncate p-text">{workspaceDisplayTitle(entry)}</span>
              <span className="p-meta p-text-4 font-mono">{entry.name}</span>
            </label>
          ))}
          <label className={`flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-sm ${target === NEW_WORKSPACE ? "p-border p-elevated" : "border-transparent p-card-hover"}`}>
            <input type="radio" name="fork-target" value={NEW_WORKSPACE} checked={target === NEW_WORKSPACE} onChange={() => setTarget(NEW_WORKSPACE)} disabled={busy} />
            <span className="p-text">New workspace</span>
          </label>
          {target === NEW_WORKSPACE && (
            <div className="space-y-1 pl-1 pt-1">
              <label className="block p-meta p-text-3" htmlFor="fork-mission">What the new workspace is for</label>
              <input id="fork-mission" value={mission} onChange={(event) => setMission(event.target.value)} className={inputCls} disabled={busy} />
            </div>
          )}
        </fieldset>
      )}
      {err !== null && <div role="alert" className="p-notice-danger rounded-md px-3 py-2 text-xs">{err}</div>}
    </Modal>
  );
}
