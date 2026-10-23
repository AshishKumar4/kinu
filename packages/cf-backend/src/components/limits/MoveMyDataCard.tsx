/**
 * Settings › Account › Move my data (the owner's board, deploy B): what moves to a Kinu of your own and what stays,
 * and "Download everything": each workspace's archive, which `kinu import <file>` restores, and the Drive as zips.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Cause, Effect } from "effect";
import { DownloadSimpleIcon, HardDrivesIcon, KeyIcon, SquaresFourIcon } from "@phosphor-icons/react";
import { detach, renderThrownChain } from "@kinu.run/core/obs";
import { listWorkspaces } from "@/lib/user-api";
import { getLimits } from "@/lib/limits-api";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { zipWholeDrive } from "@/lib/drive-api";
import { downloadWorkspaceArchive, saveBlob } from "@/lib/workspace-archive";
import { useWorkspaceRpc } from "@/hooks/use-chat-owner";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/form";
import { Group } from "@/components/ui/Group";
import { ProgressBar } from "@/components/ui/Meter";
import { RunYourOwn } from "./limit-words";

/** Every workspace of the account, walked page by page. */
function everyWorkspace(): Effect.Effect<readonly { readonly name: string; readonly displayName: string }[]> {
  return Effect.gen(function* () {
    const all: { readonly name: string; readonly displayName: string }[] = [];
    let cursor: string | null = null;

    do {
      const page = yield* Effect.promise(() => listWorkspaces({ cursor }));

      all.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor !== null);

    return all;
  });
}

/** Where the download stands: the workspace it is on, then the Drive, then done or stopped. */
type Moving =
  | { readonly phase: "idle" }
  | { readonly phase: "workspaces"; readonly list: readonly { readonly name: string; readonly displayName: string }[]; readonly at: number }
  | { readonly phase: "drive"; readonly read: number; readonly of: number }
  | { readonly phase: "done"; readonly workspaces: number; readonly zips: number }
  | { readonly phase: "failed"; readonly why: string };

/** One workspace's archive over its own socket, mounted while it is the one being downloaded. */
function ArchiveRun({ name, onDone, onFailed }: { name: string; onDone: () => void; onFailed: (why: string) => void }) {
  const { rpc, connectionStatus } = useWorkspaceRpc(name);
  // Once per mount: the socket's status settles more than once, and the archive is downloaded once.
  const started = useRef(false);

  useEffect(() => {
    if (started.current || (connectionStatus !== "connected" && connectionStatus !== "error")) return;
    started.current = true;

    if (connectionStatus === "error") {
      onFailed(`${name} could not be reached.`);

      return;
    }

    detach(Effect.catchCause(
      Effect.map(downloadWorkspaceArchive(rpc, name, () => undefined), () => onDone()),
      (failed) => Effect.sync(() => onFailed(`${name}: ${renderThrownChain({ cause: Cause.squash(failed) })}`)),
    ));
  }, [connectionStatus, rpc, name, onDone, onFailed]);

  return null;
}

/** One thing that moves: its name, and what of it moves and how, below it. */
function MovesRow({ icon, name, children }: { icon: ReactNode; name: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="t-body block p-text">{name}</span>
        <span className="t-meta block p-text-3">{children}</span>
      </span>
    </div>
  );
}

/** Where a free tier binds the account or an operator lifted it: on a deployment with no free tier, nothing. */
export function MoveMyDataSlot() {
  const limits = useAsyncResource(getLimits);
  const report = lastValue(limits.resource);

  if (report === null || (report.class !== "invited" && report.limits.length === 0)) return null;

  return <MoveMyDataCard />;
}

function MoveMyDataCard() {
  const [moving, setMoving] = useState<Moving>({ phase: "idle" });
  const busy = moving.phase === "workspaces" || moving.phase === "drive";

  const drive = (workspaces: number) => Effect.catchCause(Effect.gen(function* () {
    setMoving({ phase: "drive", read: 0, of: 0 });
    const zips = yield* Effect.promise(() => zipWholeDrive(saveBlob, (read, of) => setMoving({ phase: "drive", read, of })));

    setMoving({ phase: "done", workspaces, zips });
  }), (failed) => Effect.sync(() => setMoving({ phase: "failed", why: `Drive: ${renderThrownChain({ cause: Cause.squash(failed) })}` })));

  const start = () => Effect.catchCause(Effect.gen(function* () {
    const list = yield* everyWorkspace();

    if (list.length === 0) return yield* drive(0);
    setMoving({ phase: "workspaces", list, at: 0 });
  }), (failed) => Effect.sync(() => setMoving({ phase: "failed", why: renderThrownChain({ cause: Cause.squash(failed) }) })));

  // Handed to the workspace being downloaded, which calls it once its archive is saved.
  const next = useCallback(() => {
    if (moving.phase !== "workspaces") return;

    if (moving.at + 1 < moving.list.length) setMoving({ ...moving, at: moving.at + 1 });
    else detach(drive(moving.list.length));
  }, [moving]);

  const current = moving.phase === "workspaces" ? moving.list[moving.at] : undefined;

  return (
    <Card title="Move my data">
      <div className="space-y-4" data-move-my-data-card={moving.phase}>
        <p className="t-meta p-text-3">What a Kinu of your own takes from here. Your account here stays as it is until you delete it.</p>
        <Group>
          <MovesRow icon={<SquaresFourIcon size={16} className="p-text-2" />} name="Workspaces">
            Chats, files, memory and slates, an archive each: <code className="font-mono">kinu import</code> takes each one there.
          </MovesRow>
          <MovesRow icon={<HardDrivesIcon size={16} className="p-text-2" />} name="Drive">Your files and skills, as zips.</MovesRow>
          <div className="flex items-start gap-3 px-4 py-3"><KeyIcon size={16} className="mt-0.5 shrink-0 p-text-3" /><span className="t-body min-w-0 flex-1 p-text-2">Keys and sign-ins don&apos;t move: add them again there.</span></div>
        </Group>
        {current !== undefined && moving.phase === "workspaces" && (
          <div className="space-y-2" role="status">
            <p className="t-body p-text">Downloading {current.displayName} · {moving.at + 1} of {moving.list.length} workspaces</p>
            <ProgressBar value={moving.at} max={moving.list.length} label="Downloading your workspaces" />
            <ArchiveRun key={current.name} name={current.name} onDone={next} onFailed={(why) => setMoving({ phase: "failed", why })} />
          </div>
        )}
        {moving.phase === "drive" && (
          <div className="space-y-2" role="status">
            <p className="t-body p-text">Downloading your Drive · {moving.read} of {moving.of} files</p>
            <ProgressBar value={moving.read} max={moving.of} label="Downloading your Drive" />
          </div>
        )}
        {moving.phase === "done" && <p className="t-meta p-text-2" role="status">Downloaded {moving.workspaces} workspaces and your Drive in {moving.zips} zip{moving.zips === 1 ? "" : "s"}.</p>}
        {moving.phase === "failed" && <p className="t-meta p-danger" role="alert">The download stopped. {moving.why}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" icon={<DownloadSimpleIcon size={12} />} disabled={busy} onClick={() => detach(start())}>Download everything</Button>
          <RunYourOwn variant="ghost" />
        </div>
      </div>
    </Card>
  );
}
