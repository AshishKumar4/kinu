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
  onNotice: (message: string) => void;
}

export function DriveSections({ fixture, workspaces, onNotice }: DriveSectionsProps) {
  const load = useCallback(async (): Promise<SharedLibrary> => fixture ?? await getSharedLibrary(), [fixture]);
  const sections = useAsyncResource(load, undefined, "root");
  const [forking, setForking] = useState<SharedRow | null>(null);
  const shared = lastValue(sections.resource);

  /** Minted per open: a share that names people carries a ticket good for minutes. */
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

  const openAction = (row: SharedRow): TileAction => row.kind === "live"
    ? { label: "Open", icon: <ArrowSquareOutIcon size={14} />, onSelect: () => openLive(row) }
    : { label: "Open", icon: <ArrowSquareOutIcon size={14} />, to: blueprintPagePath(row.id) };

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
