/**
 * The Drive root above the file listing: the owner's slates and blueprints,
 * what others shared with the owner, and what the owner shared. Owns the one
 * library read those four sections come from and every action a tile offers,
 * so the page composes them without knowing how a share opens or ends.
 */
import { startTransition, useCallback, useState } from "react";
import { ArrowSquareOutIcon, CopyIcon, GitBranchIcon, ProhibitIcon } from "@phosphor-icons/react";
import {
  blueprintPagePath, shortAge, type OwnedSlate, type SharedLibrary, type SharedRow,
} from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import { getSharedLibrary, openLiveShare, revokeLiveShare } from "@/lib/shared-api";
import { useAsyncResource, lastValue } from "@/hooks/use-async-resource";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { DriveTileSection, type DriveTile, type TileAction } from "@/components/drive/DriveTiles";
import { ForkDialog } from "@/components/shared/ForkDialog";
import type { SharedLibraryProps } from "@/components/shared/SharedLibrary";

/** Every slate the owner holds, wherever it runs. A slate opens in its own
 *  workspace, on its own surface. */
function slateTiles(slates: readonly OwnedSlate[]): DriveTile[] {
  return slates.map((slate) => {
    const href = `/workspace/${encodeURIComponent(slate.workspace)}?slate=${encodeURIComponent(slate.id)}`;

    return {
      key: `${slate.workspace}:${slate.id}`,
      kind: "slate",
      name: slate.title,
      meta: [slate.workspace],
      visibility: slate.visibility,
      to: href,
      actions: [{ label: "Open", icon: <ArrowSquareOutIcon size={14} />, to: href }],
    };
  });
}

/** A share as a tile: how old it is, and whose workspace it runs in. A
 *  blueprint's name is its page, which is the link anyone holding it opens. */
function shareTile(row: SharedRow, actions: readonly TileAction[]): DriveTile {
  const age = shortAge(row.createdAt);
  const meta: string[] = [];
  const where = row.owner ?? row.workspace;

  if (age !== null) meta.push(age);

  if (where !== undefined) meta.push(where);

  return {
    key: `${row.kind}:${row.id}`,
    kind: row.kind === "live" ? "live" : "blueprint",
    name: row.title,
    meta,
    visibility: row.visibility,
    to: row.kind === "blueprint" ? blueprintPagePath(row.id) : undefined,
    actions,
  };
}

interface DriveSectionsProps extends SharedLibraryProps {
  /** Where a refusal lands: the page's notice, since the sections hold no dialog of their own. */
  onNotice: (message: string) => void;
}

export function DriveSections({ fixture, workspaces, onNotice }: DriveSectionsProps) {
  const load = useCallback(async (): Promise<SharedLibrary> => fixture ?? await getSharedLibrary(), [fixture]);
  const sections = useAsyncResource(load, undefined, "root");
  const [forking, setForking] = useState<SharedRow | null>(null);
  const shared = lastValue(sections.resource);

  /** A live share opens on its own host, under a URL minted per open: a share
   *  that names people carries a ticket that is good for minutes. */
  const openLive = (row: SharedRow): void => {
    const workspace = row.workspace;

    if (workspace === undefined) return;
    startTransition(async () => {
      try {
        const { url } = await openLiveShare({ workspace, share: row.share });
        window.open(url, "_blank", "noopener");
      } catch (cause) {
        onNotice(renderThrownChain({ cause }));
      }
    });
  };

  const stopSharing = (row: SharedRow): void => {
    const workspace = row.workspace;

    if (workspace === undefined) return;
    startTransition(async () => {
      try {
        await revokeLiveShare({ workspace, share: row.share });
        sections.reload();
      } catch (cause) {
        onNotice(renderThrownChain({ cause }));
      }
    });
  };

  /** How a row opens: a live share through a URL minted now, a blueprint as
   *  the page its link addresses. */
  const openAction = (row: SharedRow): TileAction => row.kind === "live"
    ? { label: "Open", icon: <ArrowSquareOutIcon size={14} />, onSelect: () => openLive(row) }
    : { label: "Open", icon: <ArrowSquareOutIcon size={14} />, to: blueprintPagePath(row.id) };

  /** What a row of mine offers: open it, hand on its link, fork it, end it.
   *  A blueprint ends only from the workspace that published it, so this menu
   *  does not offer that. */
  const myActions = (row: SharedRow): TileAction[] => {
    const actions: TileAction[] = [openAction(row)];

    if (row.kind === "blueprint") {
      actions.push({ label: "Copy link", icon: <CopyIcon size={14} />, copy: new URL(blueprintPagePath(row.id), window.location.origin).toString() });
    }

    actions.push({ label: "Fork", icon: <GitBranchIcon size={14} />, onSelect: () => setForking(row) });

    if (row.kind === "live") actions.push({ label: "Stop sharing", icon: <ProhibitIcon size={14} />, onSelect: () => stopSharing(row) });

    return actions;
  };

  const receivedActions = (row: SharedRow): TileAction[] => [
    openAction(row),
    { label: "Import", icon: <GitBranchIcon size={14} />, onSelect: () => setForking(row) },
  ];

  return (
    <>
      {sections.resource.status === "error" && (
        <LoadFailure what="your slates and shares" message={sections.resource.message} onRetry={sections.reload} />
      )}

      {shared !== null && (
        <>
          <DriveTileSection title="Slates" empty="No slates yet. A workspace builds one for you." tiles={slateTiles(shared.slates)} />
          <DriveTileSection title="Blueprints" empty="No blueprints yet. Publish a slate version to make one."
            tiles={shared.mine.filter((row) => row.kind === "blueprint").map((row) => shareTile(row, myActions(row)))} />
          <DriveTileSection title="Shared with you" empty="Nothing shared with you yet."
            tiles={shared.received.map((row) => shareTile(row, receivedActions(row)))} />
          <DriveTileSection title="Shared by you" empty="You have shared nothing yet."
            tiles={shared.mine.map((row) => shareTile(row, myActions(row)))} />
        </>
      )}

      {forking !== null && (
        forking.kind === "live"
          ? <ForkDialog live={{ share: forking.share, workspace: forking.workspace ?? "" }} title={forking.title}
            onClose={() => setForking(null)} workspaces={workspaces} />
          : <ForkDialog blueprint={forking.id} title={forking.title} onClose={() => setForking(null)} workspaces={workspaces} />
      )}
    </>
  );
}
