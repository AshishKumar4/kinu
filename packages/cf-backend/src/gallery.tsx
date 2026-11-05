/**
 * Design-system gallery: the real components over mock data, so signed-in surfaces can be screenshotted without auth.
 * Served by gallery.vite.config.ts; `?frame=` selects a frame (full list: the dispatch in `mount()`). /api/user/* GETs are stubbed in-page.
 */
import { ActivityView } from "@/gallery-activity-log";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { answerPictures } from "@kinu.run/core/web/picture-src";
import { galleryPicture } from "@/gallery-pictures";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { diagnostics, renderThrownChain, toKinuError } from "@kinu.run/core/obs";
import "virtual:kinu-theme.css";
import "./index.css";
import { approvalDocument, authDocument, installDocument, loginDocument } from "@kinu.run/core";
import { CompactPreviewGallery } from "./gallery-preview-tabs";
import { assistantHomeFrame, focusWorkspaceFrame } from "./gallery-assistant";
import { exploreFrame } from "./gallery-explore";
import { ACTIVITY_SURFACE } from "@kinu.run/core";
import { SlateFallbackFrame } from "@/gallery-slate-fallback";
import { CacheBlock, LogBlock } from "@/components/surfaces/ActivitySurface";
import { ComputerPreviewFrame, SecretPasteFrame } from "@/gallery-secrets";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AgentsNavProvider } from "@/hooks/use-agents-nav";
import { APP_ROUTES } from "@kinu.run/core";
import { startTheme } from "@/hooks/use-theme";
import { WorkspaceRosterProvider } from "@/hooks/use-workspace-roster";
import { DevicesFrame, PluginsFrame, SetupModalFrame, UserMcpFrame, WelcomeFrame, WorkspacesFrame } from "@/gallery-account";
import { CharactersFrame } from "@/gallery-characters";
import { AccountProvider } from "@/hooks/use-account";
import { DrivePageFrame } from "@/gallery-drive";
import { GalleryAppFrame, galleryEntry } from "@/gallery-listings";
import { PART_PREVIEWS_ENTRY, PartFrameFrame, partFrameEntry, PartHostFrame, PartPreviewsFrame, PartStatesFrame, SHARED_LIVE_ENTRY, SHARED_SLATE_PAGE, sharedSlateDocument, SharedLiveFrame } from "@/gallery-parts";
import { ForkReachPanel } from "@/components/slates/ForkReachPanel";
import ConnectedPage from "@/pages/ConnectedPage";
import { serveGalleryRpc } from "@/gallery-agent-stub";
import { CONNECTED_AT, ProviderWaitFrame, WELCOME_ROUTE, appShellFrame, controlFrame, deployFrame, homeFrame, settingsFrame, updatesFrame, userSettingsStateFrame } from "@/gallery-account-frames";
import { ACTIVITY_CACHE_SHOWN, ACTIVITY_CLEAN, ACTIVITY_FRESH, ACTIVITY_LOG, ACTIVITY_SNAPSHOT, activityRpc } from "@/gallery-activity-frames";
import { ChatCodeFrame, ChatEmptyFrame, ChatFrame, ChatHistoryFrame, ChatLoadingFrame, ChatSlateFrame, ChatSteerFrame, ClientContinuityFrame, ComposerFrame, HistoryAuthorityFrame, JobStreamingFrame, ProvenanceFrame, QualityLiveFrame, QualityRetryFrame, RosterAuthorityFrame, StreamingFrame, ToolCallsFrame, ToolRunScaleFrame, TranscriptFrame, snapshotRaceFrame } from "@/gallery-chat-frames";
import { WORKSPACE_PAGE_NAME, frame } from "@/gallery-data";
import { GALLERY_ANSWERS, MCTS_TREES, Shell, WORK_ANSWERS, forkRpc, galleryRpc, workspacePageWire } from "@/gallery-shared";
import { BLUEPRINT_ID, BLUEPRINT_REACHES, BlueprintFrame, ShareDialogFrame } from "@/gallery-sharing-frames";
import { ForkLiveFrame, OpenConfigDisclosures, RUNNING_ACTIVITY, mctsExplorerFrame, mergeFirstRpc, pinnedLiveStage, provePresetRpc, refusedRunRpc, runningSwarmRpc, stoppedRunRpc, swarmFanInRpc } from "@/gallery-swarm-frames";
import { All, DESIGN_FRAMES, FeedbackFrame, FeedbackSecretsFrame, GalleryModal, errorBoundaryFrame, feedbackRoutedFrame, lazyRouteFrame } from "@/gallery-chrome-frames";
import { AgentFrame, AgentTabFrame, ApprovalsFrame, DeviceSandboxFrame, PlanReviewFrame, SlatePreviewFrame, WorkEmptyFrame, WorkFrame, driveFrame, previewTabsFrame, seedFrameTranscript, workspacePageFrame, workspaceShellFrame } from "@/gallery-workspace-frames";
// The page-wide stand-ins, installed before the first frame mounts.
import "@/gallery-stubs";

declare global {
  interface Window {
    __kinuTerminalInput?: string[];
    /** The window the shell was last told: the query's at the socket's birth, then each resize frame. */
    __kinuTerminalWindow?: { cols: number; rows: number };
    /** With `terminalopen=held`, opens the terminal sockets the frame is holding. */
    __kinuOpenTerminals?: () => void;
    /** Every directory the Files frame was asked to list, in order. */
    __kinuListings?: string[];
    /** With `resize=held`, answers the computer's resize under way. */
    __kinuEndResize?: () => void;
  }
}

/* The signed-out pages: the real document text written into this window, so the gates audit the shipped cascade and scripts. */

/** The install command is production's, not this dev server's. */
function publicDocument(name: string): string | null {
  const install = `curl -fsSL 'https://kinu.run/install.sh' | bash`;

  if (name === SHARED_SLATE_PAGE) return sharedSlateDocument();

  if (name === "login") {
    return loginDocument([
      { href: "/auth/cloudflare/start?return_to=%2F", label: "Cloudflare" },
      { href: "/auth/github/start?return_to=%2F", label: "GitHub" },
    ]);
  }

  if (name === "loginfail") {
    return authDocument("Sign in failed", `
      <p class="lede">Kinu could not finish signing you in. Return to sign in and try again.</p>
      <p class="muted">Failure stage: <code>token_request</code></p>
      <p class="muted">Reason: <code>provider_rejected_client</code></p>
      <div class="providers"><a class="provider" href="/login?prompt=login">Return to sign in</a></div>
    `);
  }

  if (name === "install") return installDocument(install);

  if (name === "approve") {
    return approvalDocument("Connect the Kinu CLI", `
      <p>A terminal asked to sign in to your Kinu account.</p>
      <dl>
        <div><dt>Terminal</dt><dd>mrwhite0racle@workshop</dd></div>
        <div><dt>Code</dt><dd><code>KJ4-9QF</code></dd></div>
        <div><dt>Expires</dt><dd>in 9 minutes</dd></div>
      </dl>
      <form method="post"><button type="submit">Approve this terminal</button></form>
      <p class="muted">Approve only if this code matches the one in your terminal.</p>
    `);
  }

  return null;
}

/** `document.write`, not innerHTML: the page's theme bootstrap and scripts must run, and injected `<script>` never does. */
function writeDocument(html: string): void {
  document.open();
  document.write(html);
  document.close();
}

/** Routed: the surface builds its full-screen permalink from the route's `agentId`. */
const EXPLORATION_FRAMES = {
  forks: true, forkconfig: true, forkmerge: true, forkpreset: true,
  forkfanin: true, forkrefused: true, forkrunning: true, forklive: true,
} satisfies Record<string, true>;

const GALLERY_WORKSPACE = "api-worker";

function explore(node: React.ReactNode, entries: string[], frameName: string) {
  if (frameName in EXPLORATION_FRAMES) {
    return {
      entries: [`/workspace/${GALLERY_WORKSPACE}`],
      node: <Routes><Route path="/workspace/:agentId" element={node} /></Routes>,
    };
  }

  return { node, entries };
}

/** Leaves the address bar alone: recovery ends in `location.reload()`, and a rewritten path would get Vite's SPA fallback `index.html`. */
declare global {
  interface Window {
    /** The reloads frame's loads waiting for an answer, oldest first: the test answers them in the order it chooses. */
    __reloads?: ((count: number) => void)[];
  }
}

async function mount() {
  // Every frame's pictures are the gallery's own files: its server holds no picture routes.
  answerPictures(galleryPicture);
  const document_ = publicDocument(frame);

  if (document_ !== null) {
    writeDocument(document_);

    return;
  }

  let node: React.ReactNode;
  let entries = ["/"];

  // `&path=` opens a Drive frame at that folder.
  const drivePathAsked = `${APP_ROUTES.drive}${new URLSearchParams(location.search).get("path") ?? ""}`;

  // Frames fully fixed by name; `entries` is the MemoryRouter location for frames that read a route param.
  const fixtureFrames = new Map<string, { node: React.ReactNode; entries: string[] }>([
    ["activity", { node: <Shell surface={ACTIVITY_SURFACE} rpc={activityRpc(ACTIVITY_SNAPSHOT)} />, entries: ["/"] }],
    ["secretpaste", { node: <SecretPasteFrame />, entries: ["/"] }],
    ["computerpreview", { node: <ComputerPreviewFrame />, entries: ["/"] }],
    ["activityclean", { node: <Shell surface={ACTIVITY_SURFACE} rpc={activityRpc(ACTIVITY_CLEAN)} />, entries: ["/"] }],
    ["activityempty", { node: <Shell surface={ACTIVITY_SURFACE} rpc={activityRpc(ACTIVITY_FRESH)} />, entries: ["/"] }],
    ["activitycache", { node: <div className="p-6 max-w-2xl"><CacheBlock cacheHit={ACTIVITY_CACHE_SHOWN} /></div>, entries: ["/"] }],
    ["blueprint", { node: <BlueprintFrame />, entries: [`/shared/blueprint/${encodeURIComponent(BLUEPRINT_ID)}`] }],
    ["chat-slate", { node: <ChatSlateFrame />, entries: ["/"] }],
    ["jobstreaming", { node: <JobStreamingFrame />, entries: ["/"] }],
    // `&path=/projects/ops` opens a folder; `shared` is the other tab; `drive-recipient` holds only what others shared.
    ["drive", { node: <DrivePageFrame />, entries: [drivePathAsked] }],
    ["slates", { node: <DrivePageFrame />, entries: [APP_ROUTES.slates] }],
    ["shared", { node: <DrivePageFrame />, entries: [APP_ROUTES.shared] }],
    ["drive-empty", { node: <DrivePageFrame />, entries: [APP_ROUTES.drive] }],
    ["drive-wide", { node: <DrivePageFrame />, entries: [drivePathAsked] }],
    ["drive-recipient", { node: <DrivePageFrame />, entries: [APP_ROUTES.drive] }],
    // `&slate=<slate>`'s own page.
    ["gallery-slate", { node: <GalleryAppFrame />, entries: [galleryEntry(new URLSearchParams(location.search))] }],
    // A slate's personal parts, hosted by an app page; and one part's frame, inside the slate's page.
    ["part-host", { node: <PartHostFrame />, entries: ["/"] }],
    ["part-host-refused", { node: <PartHostFrame />, entries: ["/"] }],
    ["part-states", { node: <PartStatesFrame />, entries: ["/"] }],
    ["shared-live", { node: <SharedLiveFrame />, entries: [SHARED_LIVE_ENTRY] }],
    ["shared-live-signed-out", { node: <SharedLiveFrame />, entries: [SHARED_LIVE_ENTRY] }],
    ["part-frame", { node: <PartFrameFrame />, entries: [partFrameEntry(new URLSearchParams(location.search))] }],
    ["part-previews", { node: <PartPreviewsFrame />, entries: [PART_PREVIEWS_ENTRY] }],
    ["providerwait", { node: <ProviderWaitFrame />, entries: ["/"] }],
    ["sharedialog", { node: <ShareDialogFrame mode="live" />, entries: ["/"] }],
    ["sharedialog-blueprint", { node: <ShareDialogFrame mode="blueprint" />, entries: ["/"] }],
    ["sharedialog-first", { node: <ShareDialogFrame mode="live" first />, entries: ["/"] }],
    ["fork-reach", {
      node: (
        <div className="h-screen w-[720px] p-sidebar p-text">
          <ForkReachPanel title="Issue triage" reaches={BLUEPRINT_REACHES} onOpen={() => {}} />
        </div>
      ), entries: ["/"],
    }],
    // `&panel=providers|mcp|cli` picks the modal's body.
    ["setupmodal", { node: <SetupModalFrame />, entries: ["/"] }],
    // `&step=0..3` picks the wizard panel.
    ["welcome", { node: <WelcomeFrame />, entries: [WELCOME_ROUTE] }],
    // Where every connect ends, as a server's callback sends its tab there.
    ["connected", { node: <ConnectedPage />, entries: [CONNECTED_AT] }],
    // `&view=list` seeds the workspaces page's stored choice.
    ["workspaces", { node: <WorkspacesFrame />, entries: ["/workspaces"] }],
    ["chatcode", { node: <ChatCodeFrame />, entries: ["/"] }],
    ["plugins", { node: <PluginsFrame />, entries: ["/plugins"] }],
    ["devices", { node: <DevicesFrame />, entries: ["/user/settings#devices"] }],
    ["usermcp", { node: <UserMcpFrame />, entries: ["/user/settings/mcp"] }],
    ["characters", { node: <CharactersFrame />, entries: ["/"] }],
    ["devices-empty", { node: <DevicesFrame />, entries: ["/user/settings#devices"] }],
    // A workspace's Activity alone, as it ships or (`&activity=log`) as the single log under review.
    ["activity-review", { node: <ActivityView workspace={WORKSPACE_PAGE_NAME} title="API Worker" rpc={galleryRpc()} now={null} />, entries: ["/"] }],
  ]);

  const fixture = fixtureFrames.get(frame);

  // Frames whose module or fixture is runtime-loaded.
  const dynamicFrames = new Map<string, () => Promise<{ node: React.ReactNode; entries: string[] }>>([
    ["deploy", deployFrame],
    ["updates", updatesFrame],
    ["app", appShellFrame],
    ["forkfull", () => mctsExplorerFrame("n000")],
    ["forkbig", () => mctsExplorerFrame("n000")],
    ["forkswarmfull", () => mctsExplorerFrame("sw000")],
    // `&run=` is the permalink's run, as any id the reader typed; none opens the newest.
    ["forkexplorer", () => mctsExplorerFrame(new URLSearchParams(location.search).get("run"))],
    ["settings", settingsFrame],
    ["control", controlFrame],
    ["home", homeFrame],
    ["diff-design", async () => {
      const { default: diffDesignFrame } = await import("@/gallery-diff-design");

      return diffDesignFrame();
    }],
    ["mail", async () => {
      const { default: mailFrame } = await import("@/gallery-mail");

      return mailFrame();
    }],
    ["mailpage", async () => {
      const { default: mailPageFrame } = await import("@/gallery-mailpage");

      return mailPageFrame();
    }],
    // The free tier's screens (core limits/): `&state=` the account's stage, `&dialog=` a refusal (gallery-limits.tsx).
    ["limits", async () => {
      const { default: limitsFrame } = await import("@/gallery-limits");

      return limitsFrame();
    }],
    ["snapshotrace", () => Promise.resolve(snapshotRaceFrame())],
    ["qualitylive", () => {
      serveGalleryRpc(workspacePageWire);

      return Promise.resolve({ entries: ["/"], node: <QualityLiveFrame /> });
    }],
    ["workspaceshell", () => Promise.resolve(workspaceShellFrame())],
    // The whole app, every page through its own sidebar, with the design bar's live switches (gallery-app.tsx).
    ["whole", async () => {
      const { appFrame } = await import("@/gallery-app");

      return appFrame(workspacePageWire, seedFrameTranscript);
    }],
    ["agenttab", () => Promise.resolve({ entries: ["/"], node: <AgentTabFrame /> })],
    ["assistant-home", () => Promise.resolve(assistantHomeFrame(workspacePageWire))],
    ["explore", () => Promise.resolve(exploreFrame("explore"))],
    ["explore-workspace", () => Promise.resolve(exploreFrame("explore-workspace"))],
    ["focus-workspace", () => {
      seedFrameTranscript(new URLSearchParams(location.search).get("transcript"));

      return Promise.resolve(focusWorkspaceFrame(workspacePageWire, WORKSPACE_PAGE_NAME));
    }],
  ]);

  const dynamicFixture = dynamicFrames.get(frame);

  if (frame === "shell") node = <Shell />;
  else if (frame === "forks") node = <Shell surface="Swarms" mctsTrees={MCTS_TREES} rpc={forkRpc} />;
  // Config disclosure open; the card ships shut, so there is no product prop for it.
  else if (frame === "forkconfig") {
    node = <OpenConfigDisclosures><Shell surface="Swarms" mctsTrees={MCTS_TREES} rpc={forkRpc} /></OpenConfigDisclosures>;
  }
  else if (frame === "forkmerge") node = <Shell surface="Swarms" mctsTrees={MCTS_TREES} rpc={mergeFirstRpc} />;
  else if (frame === "forkpreset") node = <Shell surface="Swarms" mctsTrees={MCTS_TREES} rpc={provePresetRpc} />;
  else if (frame === "forkfanin") node = <Shell surface="Swarms" mctsTrees={MCTS_TREES} rpc={swarmFanInRpc} />;
  else if (frame === "forkrefused") node = <Shell surface="Swarms" mctsTrees={MCTS_TREES} rpc={refusedRunRpc} />;
  else if (frame === "forkstopped") node = <Shell surface="Swarms" rpc={stoppedRunRpc} />;
  else if (frame === "forkrunning") {
    node = <Shell surface="Swarms" rpc={runningSwarmRpc} headActivity={RUNNING_ACTIVITY} />;
  }
  else if (frame === "forklive") node = <ForkLiveFrame pinned={pinnedLiveStage(location.search)} />;
  else if (frame === "modal") node = <GalleryModal />;
  else if (frame === "feedback") {
    node = <FeedbackFrame noise={new URLSearchParams(location.search).get("noise") === "1"} />;
  }
  else if (frame === "feedbacksecrets") {
    node = <FeedbackSecretsFrame modal={new URLSearchParams(location.search).get("modal") === "1"} />;
  }
  else if (frame === "feedbackrouted") ({ node, entries } = feedbackRoutedFrame());
  else if (frame === "errorboundary") ({ node, entries } = errorBoundaryFrame());
  else if (frame === "lazyroute") ({ node, entries } = lazyRouteFrame());
  else if (DESIGN_FRAMES.has(frame)) node = DESIGN_FRAMES.get(frame);
  else if (frame === "chat") node = <ChatFrame />;
  else if (frame === "chatsteer") node = <ChatSteerFrame />;
  else if (frame === "chatempty") node = <ChatEmptyFrame />;
  else if (frame === "chatloading") node = <ChatLoadingFrame />;
  else if (frame === "composer") node = <ComposerFrame />;
  else if (frame === "chathistory") node = <ChatHistoryFrame />;
  else if (frame === "historyauthority") node = <HistoryAuthorityFrame />;
  else if (frame === "rosterauthority") node = <RosterAuthorityFrame />;
  else if (frame === "clientcontinuity") node = <ClientContinuityFrame />;
  else if (frame === "qualityretry") node = <QualityRetryFrame />;
  else if (frame === "toolcalls") node = <ToolCallsFrame />;
  else if (frame === "toolrun") node = <ToolRunScaleFrame secrets={new URLSearchParams(location.search).get("secrets") === "1"} />;
  else if (frame === "provenance") node = <ProvenanceFrame />;
  else if (frame === "streaming") node = <StreamingFrame />;
  else if (frame === "agent") node = <AgentFrame />;
  else if (frame === "transcript") node = <TranscriptFrame />;
  else if (frame === "slate") node = <SlatePreviewFrame />;
  else if (frame === "workslatefallback") node = <SlateFallbackFrame answers={{ ...GALLERY_ANSWERS, ...WORK_ANSWERS }} />;
  else if (frame === "previewtabs") ({ node, entries } = previewTabsFrame());
  else if (frame === "compactpreview") node = <CompactPreviewGallery />;
  else if (frame === "work") node = <WorkFrame />;
  else if (frame === "planreview") node = <PlanReviewFrame />;
  else if (frame === "workempty") node = <WorkEmptyFrame />;
  else if (frame === "approvals") node = <ApprovalsFrame />;
  else if (frame === "environment" || frame === "files") ({ node, entries } = driveFrame(frame));
  else if (fixture !== undefined) { node = fixture.node; entries = fixture.entries; }
  else if (frame === "activitylog") node = <div className="p-6 max-w-2xl"><LogBlock log={ACTIVITY_LOG} /></div>;
  else if (frame === "workspacepage") ({ node, entries } = await workspacePageFrame());
  else if (frame === "usersettingsstate") ({ node, entries } = userSettingsStateFrame());
  else if (frame === "devicesandbox") node = <DeviceSandboxFrame />;
  else if (dynamicFixture !== undefined) ({ node, entries } = await dynamicFixture());
  else node = <All />;

  ({ node, entries } = explore(node, entries, frame));

  const root = document.getElementById("root");

  if (root === null) throw new Error("gallery root is missing");
  startTheme();
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary label="gallery">
        <MemoryRouter initialEntries={entries}>
          <FrameStores>{node}</FrameStores>
        </MemoryRouter>
      </ErrorBoundary>
    </StrictMode>,
  );
}

/**
 * Every frame mounts under the shell's three stores; a frame mounting `Layout` gets its nearer store, as the app does. A
 * visitor's frame (`&signed=out`) mounts none: the app's visitor routes have no account to read.
 */
function FrameStores({ children }: { children: ReactNode }) {
  if (new URLSearchParams(location.search).get("signed") === "out") return children;

  return <AccountProvider><WorkspaceRosterProvider><AgentsNavProvider>{children}</AgentsNavProvider></WorkspaceRosterProvider></AccountProvider>;
}

try {
  await mount();
} catch (cause) {
  const failure = toKinuError({ doing: "mount the design-system gallery", cause, otherwise: "unavailable" });

  diagnostics.failure("gallery.mount_failed", failure);
  document.getElementById("root")?.replaceChildren(Object.assign(document.createElement("pre"), {
    textContent: renderThrownChain({ cause: failure }),
  }));
}
