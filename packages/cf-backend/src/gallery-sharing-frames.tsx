/** Sharing's frames: blueprints, live shares, slate parts, the share dialog and the Drive page. */
import { useMemo } from "react";
import { Route, Routes } from "react-router-dom";
import { sharedBuildRefusal } from "@kinu.run/core";
import { KinuError, refusalOf } from "@kinu.run/core/obs";
import { SLATE_GALLERY_URL } from "@/gallery-slate-fallback";
import BlueprintPage from "@/pages/BlueprintPage";
import { ShareSlateDialog } from "@/components/slates/ShareSlateDialog";
import type { BlueprintInspection, BlueprintView, OwnedLiveShare, SlateReach } from "@kinu.run/core";
import { JsonObjectSchema, JsonValueSchema, type JsonValue, type SlateOperation } from "@kinu.run/core";
import { answeringRpc, type WorkspaceAnswers } from "@/lib/workspace-rpc";
import * as v from "valibot";
import { LIVE_SHARE, NOW } from "@/gallery-data";
import { STUB, WORK_ANSWERS } from "@/gallery-shared";
import { APP_ROUTES } from "@kinu.run/core";
import { DrivePageFrame } from "@/gallery-drive";
import { ForkReachPanel } from "@/components/slates/ForkReachPanel";
import { GalleryAppFrame, galleryEntry } from "@/gallery-listings";
import { PART_PREVIEWS_ENTRY, PartFrameFrame, PartHostFrame, PartPreviewsFrame, PartStatesFrame, SHARED_LIVE_ENTRY, SharedLiveFrame, partFrameEntry } from "@/gallery-parts";
import { exploreFrame } from "./gallery-explore";
import { framed, type FrameTable } from "@/gallery-shared";

const BLUEPRINT_REACHES = ["mcp.github", "workspace", "memory", "slates.digest"];

const BLUEPRINT_ID = "api-worker~k7Qm2pV9xRt3aB4c~mfrq6zk3p2xw7ha";

const BLUEPRINT_VIEW: BlueprintView = {
  id: BLUEPRINT_ID,
  title: "Issue triage",
  description: "Reads the open issues of a repository, groups them by area, and writes a triage note into workspace memory every morning.",
  reaches: BLUEPRINT_REACHES,
  entries: [
    { path: "package.json", kind: "file", included: true },
    { path: "src", kind: "directory", included: true },
    { path: "src/server.ts", kind: "file", included: true },
    { path: "src/triage.ts", kind: "file", included: true },
    { path: "src/config.ts", kind: "file", included: true },
    { path: "assets", kind: "directory", included: true },
    { path: "assets/logo.svg", kind: "file", included: true },
  ],
  warnings: [{ path: "src/config.ts", line: 4, pattern: "aws-access-key", message: "AWS access key id" }],
  createdAt: NOW - 3 * 864e5,
};

const BLUEPRINT_INSPECTION: BlueprintInspection = {
  slate: "issue-triage", version: "v2k9q1c7xw4m", title: BLUEPRINT_VIEW.title, description: BLUEPRINT_VIEW.description,
  entries: [...BLUEPRINT_VIEW.entries, { path: "scratch", kind: "directory", included: false }, { path: "scratch/notes.md", kind: "file", included: false }],
  reaches: BLUEPRINT_REACHES, warnings: BLUEPRINT_VIEW.warnings,
};

/** As core draws it: every member classified, each mutating one's risk worded for the visibility, and the digest slate behind the peer hop. */
const RISK = (body: string) => ({ public: `${body} Anyone who opens this share can trigger it.`, users: `${body} Anyone you named on this share can trigger it.` });

const NO_RISK = { public: "", users: "" };

const SHARE_GRAPH: SlateReach = {
  revision: "r2",
  slate: "issue-triage",
  slates: ["issue-triage", "digest"],
  namespaces: [
    { slate: "issue-triage", namespace: "mcp.github", title: "GitHub", members: [
      { member: "read_issue", impact: "observe", risk: NO_RISK },
      { member: "create_issue", impact: "externalSend", risk: RISK("Calls create_issue on GitHub with your credentials. The server does not mark it read-only, so it can create or change data there.") },
    ] },
    { slate: "issue-triage", namespace: "workspace", title: "workspace", members: [
      { member: "fs.text", impact: "observe", risk: NO_RISK },
      { member: "fs.write", impact: "mutate", risk: RISK("Writes, edits or deletes files in workspace api-worker as you.") },
    ] },
    { slate: "issue-triage", namespace: "memory", title: "memory", members: [
      { member: "recall", impact: "observe", risk: NO_RISK },
      { member: "remember", impact: "mutate", risk: RISK("Changes your workspace memory as you: notes and remembered facts your agent reads back later.") },
    ] },
    { slate: "issue-triage", namespace: "agent", title: "agent", members: [
      { member: "send", impact: "externalSend", risk: RISK("Sends agent.send out of workspace api-worker as you: your agent reads it and acts on it.") },
    ] },
    { slate: "issue-triage", namespace: "ai", title: "ai", members: [
      { member: "run", impact: "execute", risk: RISK("Runs a model call on your inference. Every call spends it.") },
    ] },
    { slate: "issue-triage", namespace: "slates.digest", title: "slates.digest", members: [
      { member: "summary", impact: "observe", risk: NO_RISK },
    ] },
    { slate: "digest", namespace: "workspace", title: "workspace", members: [
      { member: "fs.text", impact: "observe", risk: NO_RISK },
    ] },
  ],
};

/** Its team's share: Pat edits it, Sam uses it, and Pat's last change stopped it on the owner's access. */
const TEAM_SHARE: OwnedLiveShare = {
  ...LIVE_SHARE, id: "live-team-2", visibility: "users", handle: "8b2e5d1f40", users: ["pat@example.com", "sam@example.com"], editors: ["pat@example.com"],
  createdAt: NOW - 2 * 864e5, grantRevision: "r1", editedBy: "pat@example.com", views: { viewers: 2, opens: 7, signedOutOpens: 0 },
};

/** A shared slate whose own files do not build alone: its preview refuses it, in the server's words. */
const SHARED_REFUSAL = sharedBuildRefusal("issue-triage");

/** The slate's own reads, as its workspace answers them: `first` is its first share, before anyone has it. */
function shareAnswers(first: boolean): WorkspaceAnswers {
  const reads: Partial<Record<SlateOperation["op"], JsonValue>> = {
    graph: v.parse(JsonValueSchema, SHARE_GRAPH),
    liveShares: v.parse(JsonValueSchema, first ? [] : [LIVE_SHARE, TEAM_SHARE]),
    history: { versions: [{ id: "v1a8f3k2mz9q" }, { id: "v2k9q1c7xw4m" }], next: null },
    shares: [{ id: "k7Qm2pV9xRt3aB4c", slate: "issue-triage", publication: "p1", createdAt: NOW - 3 * 864e5, revokedAt: null, users: ["pat@example.com"] }],
    inspect: v.parse(JsonValueSchema, BLUEPRINT_INSPECTION),
    ...(first && { preview: { url: SLATE_GALLERY_URL, port: 8789, sized: false } }),
  };

  return {
    ...WORK_ANSWERS,
    slate: (operation) => {
      const value = reads[operation.op];

      if (value !== undefined) return { ok: true, value };

      // The shared slate's own preview refuses as it would for its viewers.
      return { ok: false, ...refusalOf(new KinuError("bad_input", operation.op === "preview" ? SHARED_REFUSAL : `This frame answers no slate ${operation.op}.`)) };
    },
  };
}

/** Live mode with capability graph and one public share, or blueprint mode at inspection (`sharedialog-blueprint`). */
function ShareDialogFrame({ mode, first = false }: { mode: "live" | "blueprint"; first?: boolean }) {
  const rpc = useMemo(() => answeringRpc(shareAnswers(first)), [first]);

  return (
    <div className="h-screen p-bg p-text">
      <ShareSlateDialog workspace="api-worker" slate="issue-triage" title="Issue triage" rpc={rpc} onClose={() => {}} opensOn={mode} />
    </div>
  );
}

/** Routed so `useParams` names the id; `&viewer=signedout` renders the sign-in branch. */
function BlueprintFrame() {
  const signedOut = new URLSearchParams(location.search).get("viewer") === "signedout";

  STUB.set(`/api/shared/blueprint/${encodeURIComponent(BLUEPRINT_ID)}`, v.parse(JsonObjectSchema, BLUEPRINT_VIEW));
  STUB.set("/api/auth/me", { user: signedOut ? null : { email: "me@example.com", signedInWith: "Google" } });

  return (
    <Routes>
      <Route path="/shared/blueprint/:id" element={<BlueprintPage />} />
    </Routes>
  );
}

/** `&path=` opens a Drive frame at that folder. */
const drivePathAsked = (): string => `${APP_ROUTES.drive}${new URLSearchParams(location.search).get("path") ?? ""}`;

/** This module's frames, by `?frame=`: gallery.tsx mounts the one asked for. */
export const sharingFrames: FrameTable = {
  blueprint: () => framed(<BlueprintFrame />, [`/shared/blueprint/${encodeURIComponent(BLUEPRINT_ID)}`]),
  // `&path=/projects/ops` opens a folder; `shared` is the other tab; `drive-recipient` holds only what others shared.
  drive: () => framed(<DrivePageFrame />, [drivePathAsked()]),
  slates: () => framed(<DrivePageFrame />, [APP_ROUTES.slates]),
  shared: () => framed(<DrivePageFrame />, [APP_ROUTES.shared]),
  "drive-empty": () => framed(<DrivePageFrame />, [APP_ROUTES.drive]),
  "drive-wide": () => framed(<DrivePageFrame />, [drivePathAsked()]),
  "drive-recipient": () => framed(<DrivePageFrame />, [APP_ROUTES.drive]),
  // `&slate=<slate>`'s own page.
  "gallery-slate": () => framed(<GalleryAppFrame />, [galleryEntry(new URLSearchParams(location.search))]),
  // A slate's personal parts, hosted by an app page; and one part's frame, inside the slate's page.
  "part-host": () => framed(<PartHostFrame />),
  "part-host-refused": () => framed(<PartHostFrame />),
  "part-states": () => framed(<PartStatesFrame />),
  "shared-live": () => framed(<SharedLiveFrame />, [SHARED_LIVE_ENTRY]),
  "shared-live-signed-out": () => framed(<SharedLiveFrame />, [SHARED_LIVE_ENTRY]),
  "part-frame": () => framed(<PartFrameFrame />, [partFrameEntry(new URLSearchParams(location.search))]),
  "part-previews": () => framed(<PartPreviewsFrame />, [PART_PREVIEWS_ENTRY]),
  sharedialog: () => framed(<ShareDialogFrame mode="live" />),
  "sharedialog-blueprint": () => framed(<ShareDialogFrame mode="blueprint" />),
  "sharedialog-first": () => framed(<ShareDialogFrame mode="live" first />),
  "fork-reach": () => framed(<div className="h-screen w-[720px] p-sidebar p-text"><ForkReachPanel title="Issue triage" reaches={BLUEPRINT_REACHES} onOpen={() => {}} /></div>),
  explore: () => exploreFrame("explore"),
  "explore-workspace": () => exploreFrame("explore-workspace"),
};
