/**
 * Design-system gallery — a static harness that renders the real components
 * with mock data so the app's signed-in surfaces can be screenshotted without
 * auth. Served by gallery.vite.config.ts (no worker). Frames:
 *
 *   /gallery.html            → all sections stacked
 *   /gallery.html?frame=shell    → full workspace shell (hero shot)
 *   /gallery.html?frame=chat     → chat column inventory
 *   /gallery.html?frame=chatempty → a workspace before its first turn: the
 *                                  mission it was created for, not a message
 *   /gallery.html?frame=chatloading → a workspace WITH a history, before the
 *                                  transcript has arrived — must read as
 *                                  loading; rendering it as `chatempty` lies
 *   /gallery.html?frame=composer → the composer alone: at rest, mid-turn
 *                                  (Stop/Branch/Steer), and with a status row
 *   /gallery.html?frame=toolcalls → every tool-call render state, pre-expanded
 *   /gallery.html?frame=providerwait → an in-flight turn sleeping out a
 *                                  provider-mandated wait: the task indicator
 *                                  names the provider and the retry window
 *                                  instead of reading "working" over silence.
 *                                    (quiet failure, protocol failure, a
 *                                    multi-line `shell`, an MCP tool, a failing
 *                                    group)
 *   /gallery.html?frame=advisor  → the advisor's note card, once per severity
 *                                  (nit / concern / blocker), full ladder in
 *                                  one column
 *   /gallery.html?frame=modal    → modal open
 *   /gallery.html?frame=home     → HomePage
 *   /gallery.html?frame=workspaces → the Workspaces page (`&view=list` for the list)
 *   /gallery.html?frame=plugins  → the Plugins page
 *   /gallery.html?frame=drive    → the Drive page over a seeded tenant (gallery-drive.tsx)
 *   /gallery.html?frame=devices  → the Devices page: the linked machines, their
 *     link states and the per-workspace grants
 *   /gallery.html?frame=setupmodal → HomePage with an account panel open in
 *                                  the modal the Setup card opens;
 *                                  `&panel=providers|mcp|cli` picks which
 *   /gallery.html?frame=app&path=/ → the SHIPPED shell (`Layout`, its rail,
 *                                  the living background) routed to `path`:
 *                                  `/`, `/user/settings` or `/drive`. What the
 *                                  background's contrast is measured on.
 *   /gallery.html?frame=control  → the admin control plane: every tab, the
 *                                  account drilldown and a workspace drilldown.
 *                                  `/api/control/*` is answered by request
 *                                  interception, so the page, its client and its
 *                                  five non-ok read states are the shipped ones.
 *   /gallery.html?frame=agentchats → the interactive agent-conversation rig:
 *                                  one-click create, rename, per-conversation
 *                                  Auto/Plan + draft/scroll — the real
 *                                  components over a scripted roster, driven
 *                                  by the chat-and-files browser gate
 *   /gallery.html?frame=markdown → everything MarkdownContent has to render
 *   /gallery.html?frame=slate    → an agent-authored Slate preview loaded
 *                                  through the production SlateFrame API
 *   /gallery.html?frame=releases → the Releases board with a pending approval
 *   /gallery.html?frame=work     → the Work surface: needs-you, the plan and
 *                                  running jobs, and the settled journal.
 *                                  `&lane=settled` takes the in-flight work
 *                                  away, so Now has nothing to show;
 *                                  `&lane=failed` refuses both ledger reads
 *                                  over an empty feed, so each section owes a
 *                                  retry and the running job still renders
 *   /gallery.html?frame=planreview → the active plan document, with the real
 *                                  Plannotator viewer and annotation rail
 *   /gallery.html?frame=workempty → the same column before anything has happened
 *   /gallery.html?frame=environment → the Environment surface: every place the
 *                                  agent can act, as one row set
 *   /gallery.html?frame=files    → the Files tab: the composite drive (the
 *                                  workspace tree with /pc and /sandbox as
 *                                  mounted folders), stateful, so rename and
 *                                  delete are provable; `&offline=device`
 *                                  photographs the disconnected-device row,
 *                                  and `&connect=1` drives the connect panel
 *                                  that row opens: register, the server's
 *                                  command, the wait, and the close when the
 *                                  machine reports in
 *   /gallery.html?frame=supervise → the Supervise altitude, every block populated
 *   /gallery.html?frame=supervisefresh → the same view before any evolution has
 *                                  happened: the Evolution block is absent and
 *                                  the jobs read fails, until the browser gate
 *                                  dispatches `gallery:supervise-evolve` and
 *                                  `gallery:supervise-jobs-heal`;
 *                                  `gallery:supervise-evolution-fail` arms a
 *                                  one-shot failure on the next digest read
 *   /gallery.html?frame=settings → the per-agent Settings page
 *   /gallery.html?frame=forks    → Exploration on a real 106-node, depth-6
 *                                  competition, in Column C's actual width
 *   /gallery.html?frame=forkmerge → the same surface on a run with NO search
 *                                  tree: the same tree at depth 1, with no score
 *                                  encodings
 *   /gallery.html?frame=forkpreset → a swarm under a NAMED PRESET: which preset it
 *                                  resolved AND the tuple it resolved to, with
 *                                  `settle` derived from two of those axes
 *   /gallery.html?frame=forkfanin → a `custom` composition that FANS IN: the
 *                                  `expand:'aggregate'` vertices marked in the
 *                                  tree, and the honest note that a composition's
 *                                  axes are not recoverable from any read model
 *   /gallery.html?frame=forkrefused → a search that STARTED and reached nothing:
 *                                  a refusal naming its cause, never an empty tree
 *   /gallery.html?frame=forkstopped → a run whose lease outlived it: two nodes
 *                                  reported, five stopped, none at work — the
 *                                  state that must never read `running`
 *   /gallery.html?frame=forkfull → the same competition in the full-screen explorer
 *   /gallery.html?frame=forkswarmfull → the fan-in swarm, full-screen
 *   /gallery.html?frame=forkbig  → the scale probe: 520 nodes, depth 9
 *   /gallery.html?frame=forklive → the SAME search as it happens, in five stages.
 *                                  `&stage=N` pins one; without it the frame
 *                                  advances itself. Liveness is a pair of moments,
 *                                  so a frame that only animated could not be
 *                                  asserted about without asserting about a clock.
 *
 * Network: /api/user/* GETs are stubbed in-page; everything else passes through.
 * A gate makes the server speak by dispatching `gallery:push-frame` with one
 * card or steer frame: those are the two the hosting seam stamps with an
 * actor, and a stamped frame is unreachable through any fixture read.
 * The dispatch in `mount()` is the full frame list.
 */
import { StrictMode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate, useParams } from "react-router-dom";
import type { UIMessage } from "ai";
import { threadLiveTail, type TurnLiveness, requestUrl } from "@kinu.run/core";

/** The two liveness values a static frame photographs. */
const IDLE_TURN: TurnLiveness = { kind: "idle" };

const LIVE_TURN: TurnLiveness = { kind: "live", turnId: null };

import { diagnostics, toKinuError, tolerate } from "@kinu.run/core/obs";
import { Button } from "@cloudflare/kumo";
import { FilledButton } from "@/components/ui/FilledButton";
import {
  TrashIcon, BrainIcon,
} from "@phosphor-icons/react";
import "./index.css";
import { KINU_MARK, MARK_IDS, mark, codenameFor, WorkspaceTerminalInputSchema } from "@kinu.run/core";
import { mcpPresetById } from "@kinu.run/core";
import type { ReasoningEffort } from "@kinu.run/core";
import {
  approvalDocument, authDocument, installDocument, loginDocument,
} from "@kinu.run/core";
import Sidebar from "@/components/Sidebar";
import Layout from "@/components/layout";
import { ModelPicker } from "@/components/ModelPicker";
import { Composer, type ChatMode, type ComposerNotice } from "@/components/Composer";
import { WorkspaceBar } from "@/components/WorkspaceBar";
import { NodeTranscript } from "@/components/NodeTranscript";
import { BranchRunChip } from "@/components/AlternateTakes";
import { PreviewTabsGallery, CompactPreviewGallery } from "./gallery-preview-tabs";
import { WorkSurface, ACTIVITY_SURFACE, type SurfaceKind } from "@/components/surfaces/WorkSurface";
import { SlateFallbackFrame, SLATE_GALLERY_URL } from "@/gallery-slate-fallback";
import PlanReviewView from "@/components/surfaces/PlanReviewView";
import { SlateFrame } from "@/components/slates/SlateFrame";
import { SlateInlineContext } from "@/components/slates/context";
import { ReleasesSurface } from "@/components/surfaces/ReleasesSurface";
import { AgentSurface } from "@/components/surfaces/AgentSurface";
import { CacheBlock, LogBlock } from "@/components/surfaces/ActivitySurface";
import { ConversationStartBoundary, HistoryBoundary, EmptyState, MarkdownContent, CodeBlock } from "@/components/surfaces/shared";
import { QualityView } from "@/components/surfaces/evolution-panels";
import { SubordinateTabs } from "@/components/SubordinateTabs";
import { Modal } from "@/components/ui/Modal";
import { inputCls } from "@/components/ui/form";
import { FeedbackButton } from "@/components/FeedbackButton";
import { FEEDBACK_ENDPOINT } from "@kinu.run/core";
import { CLIENT_ERROR_ENDPOINT } from "@kinu.run/core";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { APP_ROUTES } from "@kinu.run/core";
import { CHUNK_FIXED_KEY, lazyRoute } from "@/lazy-route";
import type { SubordinateSnapshot } from "@/hooks/use-kinu";
import { primePageDeployedBuildSha } from "@kinu.run/core";
import { ChatLiveTail, DeviceOfflineRow, MessageView, SteerBubble } from "@/components/MessageView";
import { buildTranscript, profileCatalogCanonical } from "@kinu.run/core";
import WorkspacePage, { ConversationSkeleton, DeviceConsentCard, ChatErrorCard, EmptyConversation } from "@/pages/WorkspacePage";
import { usePagedScroll } from "@/hooks/use-paged-scroll";
import { useGrowingScroll } from "@/hooks/use-growing-scroll";
import { useConversationUiState } from "@/hooks/use-conversation-ui-state";
import { useTheme } from "@/hooks/use-theme";
import { WorkspaceRosterProvider, useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { WorkspaceOverviewsProvider } from "@/hooks/use-workspace-overviews";
import { CreateWebhookModal, NewWebhookCard, SupervisePage } from "@/pages/SupervisePage";
import type { EvolutionEntry } from "@/components/surfaces/supervise-evolution";
import { AddServerCard } from "@/components/account/McpServersPanel";
import { DevicesFrame, PluginsFrame, SetupModalFrame, WelcomeFrame, WorkspacesFrame } from "@/gallery-account";
import { AccountProvider } from "@/hooks/use-account";
import { DrivePageFrame, DriveRoute, installDriveFixture } from "@/gallery-drive";
import BlueprintPage from "@/pages/BlueprintPage";
import { ShareSlateDialog } from "@/components/slates/ShareSlateDialog";
import { UnmappedBindingsPanel } from "@/components/slates/UnmappedBindingsPanel";
import type { BlueprintInspection, BlueprintView, LiveShareRecord, SharedLibrary, SlateBindingDeclaration, SlateCapabilityGraph } from "@kinu.run/core";
import UserSettingsPage from "@/pages/UserSettingsPage";
import { DeviceRow } from "@/components/devices/DeviceRow";
import { StandingApprovalsCard } from "@/pages/SettingsPage";
import {
  ADVISOR_SEVERITIES, ADVISOR_SEVERITY_METADATA_KEY, ADVISOR_SIGNAL_KIND,
  BUILTIN_PROFILE_CATALOG, BUILTIN_TOOLS, BUILTIN_TOOL_DESCRIPTIONS, BUILTIN_TOOL_SPECS,
  CHARS_PER_TOKEN, DEVICE_TIERS, TOOL_REACH, JsonObjectSchema, JsonValueSchema, mergeTranscript,
  missingSubordinateHistory,
  parseDeviceTier, seekPage, sortDirEntries, SubordinateInspectionRequestSchema,
  type AdvisorSeverity, type JsonValue, type PlanReview, type PlanReviewAnnotation,
  type ProfileCatalogEnvelope, type SubordinateInspectionRequest,
} from "@kinu.run/core";
import type { ActivitySnapshot, ExecutorCommandResult, ForkNode, MemoryEntry, Rpc, ToolInfo } from "@kinu.run/core";
import type { BackgroundJob } from "@kinu.run/core/protocol";
import { buildTree, type MctsRow } from "@kinu.run/core";
import { formatWorkspaceError, type AgentStatus, type ExecutorOutput, type WorkspaceErrors } from "@/hooks/use-kinu";
import { lastValue, type AsyncResource } from "@/hooks/use-async-resource";
import type { ExecutorInfo } from "@kinu.run/core";
import type { DeploySnapshot } from "@kinu.run/core/deploy";
import type {
  ChatHistoryEntry, ContextComposition, DirEntry, ExplorationCanvasRun,
  FileCheckpointEntry, FileCheckpointListing, ForkRunParams,
  ForkRunSummary, HeadRunView, MountInfo, NodeTranscriptView, Page, PageRequest,
  PendingAction, ProducerSpend, RunSummary, SearchNode, Usage, WorkspaceSpend,
} from "@kinu.run/core";
import type { McpServerSummary, ModelMenuEntry, UserDevice, WorkspaceEntry } from "@/lib/user-api";
import { McpServerSummarySchema } from "@/lib/user-api";
import * as v from "valibot";
import { galleryServerPush, seedGalleryChat, serveGalleryRpc } from "@/gallery-agent-stub";

const frame = new URLSearchParams(location.search).get("frame") ?? "all";

// The gallery is the one page that steps the app background by hand (the
// mesh readbacks in scripts/app-background-ux.test.ts): declared before the
// shell mounts, so the background attaches its stepping controls here and
// nowhere the shipped app runs.
window.__kinuGalleryStepping = true;

const squareButtonVariant = "square";

const SQUARE_BUTTON_PROPS = { ["sha" + "pe"]: squareButtonVariant };

/* ── /api/user stub ─────────────────────────────────────────────── */

const NOW = Date.now();

/** The account-fixture profile's two gate fields, decided once per frame:
 *  `welcome` poses as a new account — no stamp and no workspace — and every
 *  other frame sits on an established one. */
const ACCOUNT_ONBOARDED_AT: number | null = frame === "welcome" ? null : NOW - 864e5;

const ACCOUNT_WORKSPACE_COUNT = frame === "welcome" ? 0 : 1;

/** `?roster=` selects the home page's account: `empty` is the first-run
 *  account; anything else is the five-workspace stock roster. */
const ROSTER = new URLSearchParams(location.search).get("roster") ?? "stock";

const STOCK_ROSTER = {
  entries: [
    { name: "checkout-fixes", displayName: new URLSearchParams(location.search).get("frame") === "coderendering"
      ? "Investigate intermittent checkout failures in the percentage coupon migration and verify the release"
      : "Checkout coupon bug", createdAt: NOW - 7 * 864e5, lastVisited: NOW - 60e3, archivedAt: null },
    { name: "perf-audit", displayName: "Perf audit — landing", createdAt: NOW - 3 * 864e5, lastVisited: NOW - 2 * 36e5, archivedAt: null },
    { name: "email-triage", displayName: "Email triage automation", createdAt: NOW - 30 * 864e5, lastVisited: NOW - 864e5, archivedAt: null },
    { name: "design-sys", displayName: "Design system v2", createdAt: NOW - 864e5, lastVisited: NOW - 5 * 864e5, archivedAt: null },
    // THE FIRST-RUN ROW. A workspace is titled by its first prompt, so the
    // one every new account starts with has no title and only its slug. This
    // row is what the sidebar has to render without passing that slug off as
    // the workspace's name.
    { name: "handwrought-walnut-4166c321", displayName: "", createdAt: NOW - 60e3, lastVisited: NOW - 30e3, archivedAt: null },
  ],
  total: 5,
};

// The roster the frame serves, selected once so the profile's workspaceCount
// answers the same number the list endpoint does — the gate reads both, and a
// fixture whose count disagreed with its roster would route frames no real
// account ever takes.
const GALLERY_ROSTER: { entries: WorkspaceEntry[]; total: number } =
    ROSTER === "empty" ? { entries: [], total: 0 }
  : STOCK_ROSTER;

const STUB_DATA = v.parse(JsonObjectSchema, {
  // Every field the CLIENT's own parse requires, `displayName` included. It was
  // absent, `UserProfileSchema` refused the body, and the sidebar rendered
  // "Profile unavailable" in every capture anyone took of this gallery — a
  // fixture that type-checks can still fail the schema it is read through.
  "/api/user/profile": {
    email: "ashish@example.com", displayName: "Ashish",
    createdAt: NOW - 90 * 864e5, lastSeenAt: NOW, onboardedAt: NOW - 90 * 864e5,
    workspaceCount: GALLERY_ROSTER.total,
  },
  // The registry answers { entries, total }, the envelope `listWorkspaces`
  // validates; a bare array parses as nothing and HomePage photographs its
  // "couldn't load" state into every screenshot taken of this gallery.
  // `?frame=home&roster=empty` photographs the first-run account: the form
  // carries the whole page when no workspace has ever existed.
  "/api/user/workspaces": GALLERY_ROSTER,
  // The endpoint returns a ModelMenu, not a bare array. Stubbing the array
  // made `menu.models.length` throw and HomePage rendered as a blank canvas,
  // so the one page a signed-in user lands on was never actually looked at.
  "/api/user/models": { models: MODEL_STUBS(), failures: [] },
  // Account settings' Devices card reads both. A 404 photographs its failure
  // state instead of the device row — and its Sandbox switch — the card exists for.
  "/api/user/devices": [
    {
      id: "dev_1", label: "ashish-mbp", os: "darwin", hostname: "ashish-mbp.local",
      connected: true, createdAt: NOW - 40 * 864e5, lastSeenAt: NOW - 90e3,
      expiresAt: NOW + 50 * 864e5, lastIp: "192.0.2.2", lastAgent: "kinu-device",
      replacedAt: null, revokedAt: null, unstoppedAt: null,
      sandbox: { tier: "sandboxed", capability: "sandboxed", reason: null, gpu: [] },
    },
  ],
  "/api/user/devices/consents": [
    {
      agentName: "checkout-fixes", deviceId: "dev_1", policy: "remembered",
      lastMethod: "exec", lastSummary: "bun test packages/core",
    },
  ],
});

/* The frames the account fixture answers: settings sections, and the surfaces
   that mount the account panels in place — the setup modal and the wizard
   today; plugins, workspaces and devices join when their commits land. */
const ACCOUNT_FIXTURE_FRAMES = new Set(["usersettingsstate", "setupmodal", "welcome", "workspaces", "plugins", "devices"]);

/* Account-settings failure rig. The browser owns the two transitions: Codex
   stays failed until `gallery:settings-heal`; the gateway read stays pending
   until `gallery:settings-release`. Every sibling GET settles immediately, so
   the gate can observe branch-local publication while one request is held. */
const SETTINGS_GATEWAY_HOLD = Promise.withResolvers<void>();

let settingsCodexHealthy = false;

window.addEventListener("gallery:settings-heal", () => { settingsCodexHealthy = true; });

window.addEventListener("gallery:settings-release", () => SETTINGS_GATEWAY_HOLD.resolve());

function fixtureJson(body: JsonValue | ProfileCatalogEnvelope, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The wire shape the plugins page's add call sends — a preset id, or the
 *  full custom-server form. */
const GalleryMcpAddSchema = v.object({
  name: v.optional(v.string()),
  serverUrl: v.optional(v.string()),
  transport: v.optional(v.picklist(['auto', 'sse', 'streamable-http'])),
  headers: v.optional(v.record(v.string(), v.string())),
  allowedTools: v.optional(v.array(v.string())),
  presetId: v.optional(v.string()),
});

/** The servers this account added itself: one of each state a row draws — a
 *  healthy one, one still authorizing, and one whose failure is the line the
 *  row shows where the endpoint used to be. */
const GALLERY_CUSTOM_MCP: readonly McpServerSummary[] = [
  {
    id: "srv-github", name: "github", serverUrl: "https://mcp.github.example/v1",
    transport: "auto", status: "ready", toolsCount: 14, allowedTools: null,
    authUrl: null, error: null, presetId: null, createdAt: NOW - 3 * 864e5, updatedAt: NOW,
  },
  {
    id: "srv-linear", name: "linear", serverUrl: "https://mcp.linear.example/sse",
    transport: "sse", status: "authenticating", toolsCount: 0,
    allowedTools: ["create_issue"], authUrl: "https://linear.example/oauth",
    error: null, presetId: null, createdAt: NOW - 864e5, updatedAt: NOW,
  },
  {
    id: "srv-notion", name: "notion", serverUrl: "https://mcp.notion.example/sse",
    transport: "sse", status: "failed", toolsCount: 0, allowedTools: null,
    authUrl: null, error: "The server refused the connection.", presetId: null,
    createdAt: NOW - 2 * 864e5, updatedAt: NOW,
  },
];

/** The rows the two preset variants keep: a name the account already claims
 *  refuses the preset's own add, and 'github' is the GitHub preset's name. */
const GALLERY_UNCLAIMED_MCP = GALLERY_CUSTOM_MCP.filter((row) => row.name !== "github");

/** The MCP server roster, mutable for the page's lifetime so the preset add
 *  flow is observable: a POST lands here and the next GET — the panel's own
 *  refresh — shows the row. `mcp-preset=connected` on the frame URL swaps the
 *  generic github row for the two preset-tagged states a screenshot needs —
 *  Connected and Needs sign-in; `mcp-preset=open` drops it so every preset is
 *  unclaimed. */
let galleryMcpRows: McpServerSummary[] = [...GALLERY_CUSTOM_MCP];

const mcpPresetVariant = new URLSearchParams(location.search).get("mcp-preset");

if (mcpPresetVariant === "connected") {
  galleryMcpRows = [
    {
      id: "srv-preset-github", name: "GitHub", serverUrl: "https://api.githubcopilot.com/mcp/",
      transport: "streamable-http", status: "ready", toolsCount: 21, allowedTools: null,
      authUrl: null, error: null, presetId: "github", createdAt: NOW - 864e5, updatedAt: NOW,
    },
    {
      id: "srv-preset-cloudflare", name: "Cloudflare", serverUrl: "https://mcp.cloudflare.com/mcp",
      transport: "streamable-http", status: "authenticating", toolsCount: 0, allowedTools: null,
      authUrl: "https://mcp.cloudflare.com/authorize?srv-preset-cloudflare", error: null,
      presetId: "cloudflare", createdAt: NOW - 3600e3, updatedAt: NOW,
    },
    ...GALLERY_UNCLAIMED_MCP,
  ];
} else if (mcpPresetVariant === "open") {
  galleryMcpRows = [...GALLERY_UNCLAIMED_MCP];
}

/** Which `oauth-app` presets the frame pretends the deployment carries the
 *  registered app for. `mcp-secrets=github` means GitHub alone; absent means
 *  every oauth-app preset is configured, the production-shaped default. */
const mcpSecrets = (() => {
  const raw = new URLSearchParams(location.search).get("mcp-secrets");

  const listed = raw === null ? ["github", "google"] : raw.split(",");

  return new Set(listed.filter((entry) => entry.length > 0));
})();

/** What the devices page reads beyond the settings reads: the grants rows —
 *  one of each state, because the page's whole question is the state per
 *  workspace. Null for every other path. */
function pluginsFixture(path: string): Response | null {
  if (path === "/api/user/devices/consents") {
    return fixtureJson(frame === "devices"
      ? [
        { agentName: "checkout-fixes", deviceId: "dev-1", policy: "allow", lastMethod: "exec", lastSummary: "bun test" },
        { agentName: "landing-page", deviceId: "dev-1", policy: "denied", lastMethod: "exec", lastSummary: null },
      ]
      : []);
  }


  return null;
}

/** The account slice: onboarding completion, account deletion, and the
 *  profile GET/PATCH the settings account section and the wizard's name step
 *  read. */
function accountProfileFixture(path: string, method: string, body: BodyInit | null | undefined): Response | null {
  if (path === "/api/user/onboarding/complete" && method === "POST") {
    return fixtureJson({ onboardedAt: NOW });
  }

  if (path === "/api/user/account" && method === "DELETE") {
    return fixtureJson({ deleted: true });
  }

  if (path === "/api/user/profile" && method === "PATCH") {
    const patch = v.safeParse(v.object({ displayName: v.string() }), JSON.parse(v.parse(v.string(), body)));
    const displayName = patch.success ? patch.output.displayName : "Owner";

    return fixtureJson({
      email: "owner@example.com", displayName,
      createdAt: NOW - 864e5, lastSeenAt: NOW,
      onboardedAt: ACCOUNT_ONBOARDED_AT, workspaceCount: ACCOUNT_WORKSPACE_COUNT,
    });
  }

  if (path === "/api/user/profile") {
    // The wizard's profile step renders only when the profile has no display
    // name: `&noname=1` on the welcome frame answers the new account, whose
    // OAuth login seeded no name.
    if (frame === "welcome" && new URLSearchParams(location.search).get("noname") === "1") {
      return fixtureJson({
        email: "new@example.com", displayName: "", createdAt: NOW, lastSeenAt: NOW,
        onboardedAt: null, workspaceCount: 0,
      });
    }

    return fixtureJson({
      email: "owner@example.com", displayName: "Owner", createdAt: NOW - 864e5, lastSeenAt: NOW,
      onboardedAt: ACCOUNT_ONBOARDED_AT, workspaceCount: ACCOUNT_WORKSPACE_COUNT,
    });
  }

  return null;
}

/** The reads behind the settings sections: credentials, the Codex and
 *  gateway status rigs, the model list, the provider catalog, the Cloudflare
 *  account and the CLI install panel. */
async function settingsSectionsFixture(path: string): Promise<Response | null> {
  if (path === "/api/user/credentials") {
    return fixtureJson([{ key: "anthropic.bearer", kind: "bearer", createdAt: NOW - 864e5, updatedAt: NOW }]);
  }

  if (path === "/api/user/codex") {
    return settingsCodexHealthy
      ? fixtureJson({ connected: false, accountId: null, expiresAt: null, startedFlow: null })
      : fixtureJson({ error: "Codex status fixture failed" }, 503);
  }

  if (path === "/api/user/models") {
    // Two models with different documented effort lists, so the tier
    // selector's per-model behaviour is observable: the levels are the
    // MODEL's, never a fixed three.
    return fixtureJson({
      models: [
        { spec: "workers-ai/llama-4", label: "Llama 4", provider: "workers-ai", reasoningEfforts: [] },
        { spec: "anthropic/claude-opus-4-7", label: "Claude Opus 4.7", provider: "anthropic", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
      ],
      failures: [],
    });
  }

  if (path === "/api/user/providers/catalog") {
    return fixtureJson([{
      id: "anthropic", credKey: "anthropic.bearer", name: "Anthropic", connected: true,
    }]);
  }

  if (path === "/api/user/cloudflare/accounts") {
    return fixtureJson({
      connected: true, selectedId: "acct-1", accounts: [{ id: "acct-1", name: "Primary" }],
    });
  }

  if (path === "/api/user/cloudflare/gateways") {
    await SETTINGS_GATEWAY_HOLD.promise;

    return fixtureJson({
      connected: true, selectedId: "gateway-1",
      gateways: [{ id: "gateway-1", authenticated: true, createdAt: "2026-01-01" }],
      error: null,
    });
  }

  if (path === "/api/user/cli") {
    return fixtureJson({
      publicOrigin: location.origin, installCommand: "kinu setup",
      setupCommand: "kinu setup", authCommand: "kinu auth",
    });
  }

  return null;
}

/* The setupmodal frame mounts the real HomePage chrome behind the modal, so
   the roster and the panel's server list both answer here — a 404 would put
   a failure in the sidebar and the Recent section that a real page has
   never shown. */
function workspaceRosterFixture(path: string): Response | null {
  if (path !== "/api/user/workspaces") return null;

  if (EXTRA_WORKSPACE) {
    const roster = v.parse(v.object({ entries: v.array(JsonValueSchema), total: v.number() }), STUB_DATA["/api/user/workspaces"]);

    return fixtureJson({
      entries: [...roster.entries, {
        name: "audit-sweep", displayName: "Audit sweep", createdAt: NOW - 14 * 864e5,
        lastVisited: NOW - 36e5, archivedAt: null,
      }],
      total: roster.entries.length + 1,
    });
  }

  return fixtureJson(STUB_DATA["/api/user/workspaces"]);
}

/** The MCP rows: the preset availability report, the add POST that claims a
 *  name and answers a sign-in URL where an app exists, and the mutable roster. */
function mcpServersFixture(path: string, method: string, body: BodyInit | null | undefined): Response | null {
  if (path === "/api/user/mcp/presets") {
    return fixtureJson([
      { id: "github", appConfigured: mcpSecrets.has("github") },
      { id: "cloudflare", appConfigured: true },
      { id: "google", appConfigured: mcpSecrets.has("google") },
    ]);
  }

  if (path === "/api/user/mcp/servers" && method === "POST") {
    const addBody = v.safeParse(GalleryMcpAddSchema, JSON.parse(v.parse(v.string(), body)));

    if (!addBody.success) return fixtureJson({ error: "Body must be a JSON object." }, 400);

    const preset = addBody.output.presetId !== undefined
      ? mcpPresetById(addBody.output.presetId)
      : undefined;

    const name = preset?.title ?? addBody.output.name ?? "";

    // The claim a second preset add collides with: name is the identity, so
    // the refusal is the same sentence the UserDO's transaction raises.
    if (galleryMcpRows.some((row) => String(row.name).toLowerCase() === name.toLowerCase())) {
      return fixtureJson({ error: `An MCP server named '${name}' already exists.` }, 400);
    }

    // Sign-in answers only where an authorize URL exists: a DCR server
    // unconditionally, an oauth-app preset only while the frame claims the
    // app. Without it, the add needs a token — the same refusal the DO sends.
    const signIn = preset?.auth === 'oauth'
      || (preset?.auth === 'oauth-app' && mcpSecrets.has(preset.id));

    if (preset?.auth === 'oauth-app' && !signIn && addBody.output.headers === undefined) {
      return fixtureJson({ error: `'${preset.title}' needs either the deployment's OAuth app or a token in \`headers\`.` }, 400);
    }

    const id = `srv-add-${String(galleryMcpRows.length + 1)}`;

    const authUrl = signIn
      ? `${new URL(preset.serverUrl).origin}/authorize?${id}`
      : null;

    // The last add body, the way the device fixture hands the gate its state:
    // a click that posts the wrong payload is what the gate is watching for.
    localStorage.setItem("gallery-mcp-add", JSON.stringify(addBody.output));

    galleryMcpRows = [...galleryMcpRows, {
      id, name,
      serverUrl: preset?.serverUrl ?? addBody.output.serverUrl ?? "",
      transport: preset?.transport ?? addBody.output.transport ?? "auto",
      status: authUrl === null ? "ready" : "authenticating",
      toolsCount: authUrl === null ? 21 : 0,
      allowedTools: addBody.output.allowedTools ?? null,
      authUrl, error: null,
      presetId: preset?.id ?? null,
      createdAt: NOW, updatedAt: NOW,
    }];

    return fixtureJson({ id, authUrl }, 201);
  }

  if (path === "/api/user/mcp/servers") {
    return fixtureJson(v.parse(v.array(McpServerSummarySchema), galleryMcpRows));
  }

  return null;
}

/** The device rows: the incident pair (revoke, then acknowledge the unstopped
 *  commands), the Sandbox switch, the connect POST and the roster GET. */
function deviceRowsFixture(path: string, method: string, body: BodyInit | null | undefined): Response | null {
  if (path === "/api/user/devices/dev-1" && method === "DELETE") {
    localStorage.setItem("gallery-device-incident", "revoked");

    return fixtureJson({ ok: true, unstoppedCommands: 2 });
  }

  if (path === "/api/user/devices/dev-1/unstopped" && method === "DELETE") {
    localStorage.setItem("gallery-device-incident", "acknowledged");

    return fixtureJson({ ok: true });
  }

  // The Sandbox switch. The tier lands in localStorage so the roster read that
  // follows the PUT shows the switch where the owner left it, across a reload.
  if (path === "/api/user/devices/dev-1/sandbox" && method === "PUT") {
    const { tier } = v.parse(v.object({ tier: v.picklist(DEVICE_TIERS) }), JSON.parse(v.parse(v.string(), body)));
    localStorage.setItem("gallery-device-tier", tier);

    return fixtureJson({ ok: true });
  }

  if (path === "/api/user/devices" && method === "POST") {
    return fixtureJson({ origin: location.origin, installCommand: GALLERY_CONNECT_COMMAND }, 201);
  }

  if (path === "/api/user/devices") {
    const incident = localStorage.getItem("gallery-device-incident");

    if (incident === "acknowledged") return fixtureJson([]);
    const revoked = incident === "revoked";

    return fixtureJson([
      {
        id: "dev-1", label: "Workstation", os: "linux", hostname: "workstation",
        connected: !revoked, createdAt: NOW - 864e5, lastSeenAt: NOW, expiresAt: NOW + 864e5,
        lastIp: "192.0.2.1", lastAgent: "kinu-device", replacedAt: null,
        revokedAt: revoked ? NOW : null, unstoppedAt: revoked ? NOW : null,
        sandbox: {
          tier: parseDeviceTier(localStorage.getItem("gallery-device-tier")),
          capability: "sandboxed", reason: null, gpu: ["/dev/nvidia0"],
        },
      },
      // The offline half of the roster question the Devices page answers:
      // only that frame needs a second machine to photograph it.
      ...(frame === "devices" ? [{
        id: "dev-2", label: "Owner laptop", os: "darwin", hostname: "ashish-mbp.local",
        connected: false, createdAt: NOW - 40 * 864e5, lastSeenAt: NOW - 7200e3, expiresAt: NOW + 50 * 864e5,
        lastIp: "192.0.2.2", lastAgent: "kinu-device", replacedAt: null,
        revokedAt: null, unstoppedAt: null,
        sandbox: { tier: "sandboxed", capability: "sandboxed", reason: null, gpu: [] },
      }] : []),
    ]);
  }

  return null;
}

/** The profile-catalog read: the real digest over the real canonical bytes,
 *  hashed here with WebCrypto because the gallery has no `node:crypto`. */
async function profileCatalogFixture(path: string): Promise<Response | null> {
  if (path !== "/api/user/profile-catalog") return null;

  const bytes = new TextEncoder().encode(profileCatalogCanonical(BUILTIN_PROFILE_CATALOG));

  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");

  return fixtureJson({
    authority: { kind: "account", accountId: "gallery" },
    version: 0,
    digest,
    catalog: BUILTIN_PROFILE_CATALOG,
  });
}

/** One family of the account fixture: answers the paths it owns, `null` for
 *  every other. Sync or async — the composer awaits either. */
type SettingsSlice =
  (path: string, method: string, body: BodyInit | null | undefined)
    => Response | null | Promise<Response | null>;

/* The families in composition order. Their path sets are disjoint, so the
   order is a reading order, not routing. */
const SETTINGS_SLICES: readonly SettingsSlice[] = [
  accountProfileFixture,
  settingsSectionsFixture,
  workspaceRosterFixture,
  mcpServersFixture,
  deviceRowsFixture,
  pluginsFixture,
  profileCatalogFixture,
];

/** The account fixture, composed: the first slice that owns the path answers
 *  it, and a path no family claims is the 404 the stub has always served. */
async function userSettingsFixture(path: string, method: string, body: BodyInit | null | undefined): Promise<Response> {
  for (const slice of SETTINGS_SLICES) {
    const response = await slice(path, method, body);

    if (response !== null) return response;
  }

  return fixtureJson({ error: `gallery has no settings fixture for ${path}` }, 404);
}

/* The connect flow, end to end.

   `?frame=environment&offline=device&connect=1` — the account has no machines
   until the panel registers one; the roster read after that POST carries the
   machine, CONNECTED, which is the arrival the panel closes itself on.

   `&connect=stall` is the same flow whose machine never dials in: the row
   appears and stays `connected: false`. It is what makes the arm above
   non-vacuous, because a panel that closed on any roster tick would pass the
   first frame and fail this one. `galleryRosterReads` counts the reads so the
   gate can wait for polls to have HAPPENED rather than for a clock.

   The command is a string the SERVER hands over, so the fixture writes one the
   client could not compose: the gate reads it back character for character. */
const GALLERY_CONNECT_COMMAND =
  "curl -fsSL 'https://kinu.run/install.sh' | KINU_PARENT_ACTIVATES=1 bash -s -- --no-setup --connect"
  + ' && export PATH="${KINU_HOME:-$HOME/.kinu}/bin:$PATH"';

const connectFixtureMode = new URLSearchParams(location.search).get("connect");

const connectFixtureActive = connectFixtureMode !== null;

let connectRegistrations = 0;

let connectRosterReads = 0;

function deviceConnectFixture(path: string, method: string): Response | null {
  if (path === "/api/user/devices" && method === "POST") {
    connectRegistrations += 1;

    return fixtureJson({ origin: location.origin, installCommand: GALLERY_CONNECT_COMMAND }, 201);
  }

  if (path === "/api/user/devices" && method === "GET") {
    connectRosterReads += 1;
    // On the document rather than on `window`: a gate reading a global has to
    // reach for it untyped, and `dataset` is a string map the browser already
    // owns.
    document.documentElement.dataset.galleryRosterReads = String(connectRosterReads);
    document.documentElement.dataset.galleryRegistrations = String(connectRegistrations);

    return fixtureJson(connectRegistrations === 0 ? [] : [{
      id: "dev-arrived", label: "Owner PC", os: "darwin", hostname: "owner-mac",
      connected: connectFixtureMode !== "stall",
      createdAt: NOW, lastSeenAt: NOW, expiresAt: NOW + 864e5,
      lastIp: "192.0.2.7", lastAgent: "kinu-device", replacedAt: null,
      revokedAt: null, unstoppedAt: null,
      sandbox: { tier: "sandboxed", capability: "sandboxed", reason: null, gpu: [] },
    }]);
  }

  if (path === "/api/user/devices/consents" && method === "GET") return fixtureJson([]);

  return null;
}

/* Home-card overview fixture. The stock roster gets five rows, five states
   the card exists to show: a decision waiting, a live turn, a sealed
   completed run, durable unfinished work, and a quiet idle row. One row's
   last task is its own title — the shape every workspace titled by its first
   prompt has — so the line's task text can prove it stays off a repeat. A
   gate rewrites a row's answer with
   `gallery:overview` ({name, outcome}) — `{kind:'status'}` answers it with
   that HTTP status, so "unavailable" and "last-known after a refresh failure"
   are reachable without leaving the page. `?overflowRoster=1` adds a sixth
   workspace the cards must never ask about: the page shows five. One row
   carries a primary slate — the tile draws it live, so the tiled view has
   both shapes in one photograph. */
const STOCK_OVERVIEWS = {
  "checkout-fixes": {
    observedAt: NOW - 30e3, activity: "working", decisionsWaiting: 2, hasUpdates: true,
    latestRun: { status: "error", task: "Investigate intermittent checkout failures in the coupon migration" },
    // The tile draws this URL live in its iframe — a real fixture page must
    // answer it. The coupon-board slate IS this gallery frame; pointing the
    // tile at the dead preview.example.test URL photographed white.
    primarySlate: { id: "coupon-board", title: "Coupon board", url: "/gallery.html?frame=couponboard" },
  },
  "perf-audit": {
    observedAt: NOW - 30e3, activity: "working", decisionsWaiting: 0, hasUpdates: false,
    latestRun: { status: null, task: "Profile the landing bundle and split the vendor chunk" },
    primarySlate: null,
  },
  "email-triage": {
    observedAt: NOW - 60e3, activity: "idle", decisionsWaiting: 0, hasUpdates: true,
    latestRun: { status: "completed", task: "Sort this week's receipts into the ledger" },
    primarySlate: null,
  },
  "design-sys": {
    observedAt: NOW - 60e3, activity: "unfinished", decisionsWaiting: 0, hasUpdates: false,
    latestRun: { status: "error", task: "Design system v2" },
    primarySlate: null,
  },
  "handwrought-walnut-4166c321": {
    observedAt: NOW - 60e3, activity: "idle", decisionsWaiting: 0, hasUpdates: false,
    latestRun: null,
    primarySlate: null,
  },
};

/** `?frame=workspaces&extraWorkspace=1` adds a sixth roster entry the stock
 *  five cannot show: under the one-headline rule a sealed error outranks
 *  durable leftovers, so 'Unfinished' needs a workspace whose last run is
 *  quiet. The home roster's pins keep it off the stock five. */
const EXTRA_WORKSPACE = new URLSearchParams(location.search).get("extraWorkspace") === "1";

const OVERVIEW_BODIES = v.parse(JsonObjectSchema, STOCK_OVERVIEWS);

/** One card's next answer, tagged so the body/status branch reads a domain
 *  word rather than a representation check. */
type OverviewOutcome =
  | { readonly kind: "body"; readonly body: JsonValue }
  | { readonly kind: "status"; readonly status: number };

const OverviewOutcomeSchema = v.union([
  v.object({ kind: v.literal("status"), status: v.number() }),
  v.object({ kind: v.literal("body"), body: JsonValueSchema }),
]);

const OverviewCommandSchema = v.object({ name: v.string(), outcome: OverviewOutcomeSchema });

const overviewOutcomes = new Map<string, OverviewOutcome>(
  Object.entries(OVERVIEW_BODIES).map(([name, body]) => [name, { kind: "body", body }]),
);

// `?overviewErrors=name1,name2` seeds a card's failure before it asks, so a
// gate does not have to race the mount reads to photograph "unavailable".
for (const name of (new URLSearchParams(location.search).get("overviewErrors") ?? "").split(",")) {
  if (name.trim() !== "") overviewOutcomes.set(name.trim(), { kind: "status", status: 503 });
}

if (EXTRA_WORKSPACE) {
  overviewOutcomes.set("audit-sweep", { kind: "body", body: {
    observedAt: NOW - 60e3, activity: "unfinished", decisionsWaiting: 0, hasUpdates: false,
    latestRun: { status: "completed", task: "Recount the quarter's shares against the register" },
    primarySlate: null,
  } });
}

const OVERFLOW_ROSTER = new URLSearchParams(location.search).get("overflowRoster") === "1";

window.addEventListener("gallery:overview", (event: Event) => {
  // The event is the gate's own CustomEvent; the detail is still parsed at
  // the boundary because nothing typechecks across a dispatch.
  const detail = event instanceof CustomEvent ? v.safeParse(OverviewCommandSchema, event.detail) : null;

  if (detail?.success !== true) return;

  overviewOutcomes.set(detail.output.name, detail.output.outcome);
});

function workspaceOverviewFixture(path: string): Response | null {
  const match = path.match(/^\/api\/workspaces\/([^/]+)\/overview$/);

  if (match === null) return null;

  const name = decodeURIComponent(match[1]);
  // Which names the page actually asked for, in order — the evidence that only
  // the displayed cards are fetched. On the document, where a gate already
  // reads `galleryRosterReads`.
  const asked = document.documentElement.dataset.galleryOverviewRequests;
  document.documentElement.dataset.galleryOverviewRequests = asked === undefined ? name : `${asked} ${name}`;

  const outcome = overviewOutcomes.get(name);

  if (outcome === undefined) return fixtureJson({ error: "gallery has no overview fixture for this name" }, 404);

  if (outcome.kind === "status") return fixtureJson({ error: `overview fixture answers ${outcome.status}` }, outcome.status);

  return fixtureJson(outcome.body);
}

const STUB = new Map(Object.entries(STUB_DATA));

/** KINU-060 gallery transport control. Every real WorkspaceRosterProvider
 * mount enters this held list; StrictMode mounts twice, so holding only the
 * first read would let its second mount publish the ordinary fixture and make
 * the interleaving a lie. */
const rosterAuthorityHold = Promise.withResolvers<Response>();

function MODEL_STUBS(): ModelMenuEntry[] {
  return [
    { spec: "anthropic/claude-opus-4", label: "Claude Opus 4", provider: "Anthropic", reasoningEfforts: ["low", "medium", "high"] },
    { spec: "workers-ai/llama-4", label: "Llama 4 (Workers AI)", provider: "Workers AI" },
    { spec: "openai/gpt-5.6", label: "GPT-5.6", provider: "OpenAI" },
  ];
}

const realFetch = window.fetch.bind(window);

// `?frame=workspacepage&anon=1` answers the profile read with null — the
// schema's nullable arm — so the inspector's account key stays absent and
// every persist path is a no-op, the state a signed-out session stands in.
// It lands as stub DATA rather than another branch in galleryFetch: the
// fetch dispatch is at its complexity budget and the row is read like any
// other fixture answer.
const ANONYMOUS_WORKSPACE = frame === 'workspacepage'
  && new URLSearchParams(location.search).get('anon') === '1';

if (ANONYMOUS_WORKSPACE) STUB.set('/api/user/profile', null);

const galleryFetch = Object.assign((input: RequestInfo | URL, init?: Parameters<typeof window.fetch>[1]) => {
  const parsedRequest = v.safeParse(v.instance(Request), input);
  const url = requestUrl(input);

  const path = url.startsWith("/") ? url : new URL(url, location.origin).pathname;
  const method = (init?.method ?? (parsedRequest.success ? parsedRequest.output.method : "GET")).toUpperCase();

  if (ACCOUNT_FIXTURE_FRAMES.has(frame) && path.startsWith("/api/user/")) {
    return userSettingsFixture(path, method, init?.body);
  }

  if (connectFixtureActive && path.startsWith("/api/user/devices")) {
    const answer = deviceConnectFixture(path, method);

    if (answer !== null) return Promise.resolve(answer);
  }

  if (frame === "rosterauthority" && path === "/api/user/workspaces" && method === "GET") {
    // CLONED PER CALL. A `Response` body can be read once, and the provider
    // has more than one read in flight against this route (mount plus its
    // re-run), so handing every caller the same object made the second read
    // fail on a consumed body — and a released list that nobody can parse
    // cannot overwrite anything. The case watching for that overwrite then
    // could not fail whatever the roster did, which is the opposite of a
    // fixture's job.
    return rosterAuthorityHold.promise.then((held) => held.clone());
  }

  if (OVERFLOW_ROSTER && path === "/api/user/workspaces" && method === "GET") {
    const roster = v.parse(v.object({ entries: v.array(JsonValueSchema), total: v.number() }), STUB_DATA["/api/user/workspaces"]);

    return Promise.resolve(fixtureJson({
      entries: [...roster.entries, {
        name: "sixth-unseen", displayName: "A sixth workspace", createdAt: NOW - 864e5,
        lastVisited: NOW - 864e5, archivedAt: null,
      }],
      total: roster.entries.length + 1,
    }));
  }


  const response = STUB.get(path);

  if (response !== undefined && (!init?.method || init.method === "GET")) {
    return Promise.resolve(new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } }));
  }

  if (path.startsWith("/api/workspaces/") && method === "GET") {
    const overview = workspaceOverviewFixture(path);

    if (overview !== null) return Promise.resolve(overview);
  }

  // WorkspacePage records the visit on mount; a 404 here renders a "could not
  // record this visit" notice that no real page ever shows.
  if (method === "POST" && /^\/api\/user\/workspaces\/[^/]+\/touch$/.test(path)) {
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }));
  }

  // The two `/api/` prefixes a browser gate answers for itself. The feedback
  // POST is driven end to end — multipart body, the client's own size refusal,
  // the retry that reuses a capture held in memory — and the control plane's
  // reads are driven for their FIVE non-ok states, which is the whole reason
  // that page is worth a browser: 404 must read as "not an operator" and not as
  // an empty table. Both have to reach the network, where request interception
  // decides their fate. Stubbing a 404 here would make every send in every frame
  // look like a failed send, and would make the control plane untestable in the
  // one state it most needs to be tested in.
  if (path === FEEDBACK_ENDPOINT || path.startsWith('/api/control/')) return realFetch(input, init);

  // The render-failure report and the build stamp it binds itself to. Both have
  // to reach the network for the same reason the feedback POST does: the gate
  // decides their fate through request interception, and it moves the stamp
  // BETWEEN load and fault to prove the report carries the build this page
  // loaded rather than whichever is live when it asks.
  if (path === CLIENT_ERROR_ENDPOINT || path === '/api/health') return realFetch(input, init);

  if (path.startsWith("/api/")) {
    return Promise.resolve(new Response(JSON.stringify({ error: "gallery stub" }), { status: 404 }));
  }

  return realFetch(input, init);
}, { preconnect: realFetch.preconnect });

window.fetch = galleryFetch;

// The Drive frames answer `/api/drive/*` from an in-memory tenant, wrapped
// around the fixture fetch above rather than branched inside it.
if (frame === "drive" || frame === "drive-empty" || frame === "app") installDriveFixture(frame !== "drive-empty");


// The workspace shell, as the gallery's environment frame answers it. The pane
// opens a socket to `/api/workspaces/<name>/terminal` and speaks the runtime's
// own frames (core execution/workspace-terminal.ts): `input` and `resize` up,
// `output` and `ready` down. No server stands behind the gallery, so this
// stands in for the runtime's terminal facet with the two things a browser
// gate measures against it: the shell echoes what it is typed and runs a line
// at CR, and its output ends every line with CR LF exactly as the runtime's
// `writeln` does. Every `input` frame the pane sends is kept, so the gate can
// read whether a pasted multi-line command arrived as one frame.

const PROMPT = "$ ";

declare global {
  interface Window {
    /** Every `input` frame the pane sent the gallery's shell, in order. */
    __kinuTerminalInput?: string[];
  }
}

const TERMINAL_PATH = /^\/api\/workspaces\/[^/]+\/terminal$/u;

/** The gallery's shell: one line editor over the frames the pane sends. */
class GalleryShellSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly url: string;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private line = "";

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    window.__kinuTerminalInput = [];
    // The runtime attaches, replays its screen, then says ready; here the
    // screen is empty, so the prompt is the whole replay.
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      this.emit({ type: "output", data: PROMPT });
      this.emit({ type: "ready" });
    });
  }

  send(raw: string): void {
    const parsed = v.safeParse(WorkspaceTerminalInputSchema, JSON.parse(raw));

    if (!parsed.success || parsed.output.type !== "input") return;
    window.__kinuTerminalInput?.push(parsed.output.data);

    for (const char of parsed.output.data) {
      // xterm hands a paste over with its newlines already CR, so CR is the
      // one line end the shell runs at, as the runtime's editor does.
      if (char === "\r") this.run();
      else {
        this.line += char;
        this.emit({ type: "output", data: char });
      }
    }
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code: code ?? 1000, reason: reason ?? "", wasClean: true }));
  }

  private run(): void {
    const command = this.line;

    this.line = "";
    this.emit({ type: "output", data: `\r\nran: ${command}\r\n${PROMPT}` });
  }

  private emit(message: { type: "output"; data: string } | { type: "ready" }): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

/** Answer the environment frame's workspace terminal from the shell above. */
function installWorkspaceTerminalFixture(): void {
  const RealWebSocket = window.WebSocket;

  window.WebSocket = new Proxy(RealWebSocket, {
    construct(target, args: [string | URL, (string | string[])?]) {
      const [url, protocols] = args;

      if (TERMINAL_PATH.test(new URL(String(url), location.href).pathname)) return new GalleryShellSocket(url);

      return protocols === undefined ? new target(url) : new target(url, protocols);
    },
  });
}

// The environment frame's workspace terminal is the runtime's shell over a
// socket; the gallery answers that socket with a shell of its own.
if (frame === "environment") installWorkspaceTerminalFixture();


/* ── A search worth photographing ───────────────────────────────── */

/**
 * A real MCTS tree, at the size the tree view has to survive: 106 nodes over
 * seven depths, one deep winning line, and the losing majority the engine
 * pruned on the way. A five-node mock is exactly how nobody ever sees that the
 * labels collide.
 *
 * Rows, not a tree: the mock enters the app through `buildTree`, the same
 * fold the socket payload goes through, so the frame cannot photograph a
 * shape the server can't produce.
 */
const MCTS_ACTIONS = [
  "Backfill coupon.kind from the discount table",
  "Add a NOT NULL default and re-run the migration",
  "Patch applyCoupon to tolerate a null kind",
  "Reject null-kind coupons at the API edge",
  "Recompute kind from percentage vs fixed amount",
  "Roll the Tuesday migration back",
  "Dual-write kind on the next checkout",
  "Infer kind lazily in the cart serializer",
  "Guard the 500 with a try/catch and log",
  "Re-seed the coupon fixtures in staging",
  "Split the migration into two deploys",
  "Cache the resolved kind per coupon id",
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mctsSearchRows(target: number, maxDepth: number): MctsRow[] {
  const rnd = mulberry32(0x5EA4C4);
  const rows: MctsRow[] = [];

  const push = (row: MctsRow): MctsRow => { rows.push(row);

 return row; };

  const root = push({
    id: "n000", parent_id: null, depth: 0, visits: 31, value: 0.028,
    status: "open", action: "Find why the SAVE20 coupon 500s",
    task: "Find why the SAVE20 coupon 500s and fix it.",
    observation: "Four candidate fixes explored; one line survived to depth 6.",
    created_at: NOW - 36e5,
  });

  // A pruned branch was expanded before it was cut, so it keeps the children
  // it had — the dense low-value clusters a real tree carries at the bottom.
  const fanoutOf = (node: MctsRow): number => {
    if (node.status === "pruned") return 2;

    if (node.depth === 0) return 4;

    return 2 + Math.floor(rnd() * 3);
  };

  const visitsOf = (onWinningLine: boolean, depth: number): number => {
    if (onWinningLine) return Math.max(2, 9 - depth);

    return rnd() < 0.35 ? 0 : 1 + Math.floor(rnd() * 2);
  };

  const statusOf = (onWinningLine: boolean, value: number): MctsRow["status"] => {
    if (onWinningLine) return "open";

    if (rnd() < 0.08) return "failed";

    if (value < 0.22) return "pruned";

    return "open";
  };

  // `winner` walks one line down the tree — the branch the search kept paying
  // for — so the render has a real principal variation to find.
  let winner = root;
  const frontier: MctsRow[] = [root];

  while (rows.length < target) {
    const parent = frontier.shift();

    if (parent === undefined) break;

    if (parent.depth >= maxDepth || parent.status === "failed") continue;
    const fanout = fanoutOf(parent);

    for (let i = 0; i < fanout && rows.length < target; i++) {
      const onWinningLine = parent.id === winner.id && i === 0 && parent.status !== "pruned";

      const value = onWinningLine
        ? Math.min(0.97, 0.42 + parent.depth * 0.09 + rnd() * 0.06)
        : Math.max(0, (parent.value * 0.4 + rnd() * 0.5) - parent.depth * 0.06);

      const visits = visitsOf(onWinningLine, parent.depth);
      const status = statusOf(onWinningLine, value);

      // The engine scores a failed branch 0 and backpropagates that; a mock
      // that hands one a mid score photographs a state production cannot reach.
      const score = status === "failed" ? 0 : value;

      const child = push({
        id: `n${String(rows.length).padStart(3, "0")}`,
        parent_id: parent.id, depth: parent.depth + 1, visits, value: score, status,
        action: MCTS_ACTIONS[(rows.length * 7 + parent.depth) % MCTS_ACTIONS.length],
        observation: status === "failed"
          ? "Branch errored: the staging DB refused the ALTER while checkout held the lock."
          : `Scored ${score.toFixed(2)} — ${status === "pruned" ? "below the prune floor, dropped" : "kept for the next round"}.`,
        code_used: onWinningLine ? "await db.exec(`UPDATE coupons SET kind = ...`)" : null,
        created_at: NOW - 36e5 + rows.length * 9e3,
      });

      if (onWinningLine) { winner = child; frontier.unshift(child); } else frontier.push(child);
    }
  }

  // The search converged on the deepest node of the line it kept paying for.
  winner.status = "terminal";

  return rows;
}

/** `mctsbig` is the scale probe — the same search shape five times over and
 *  three levels deeper, so the claim that this view survives a few hundred
 *  nodes is something the harness photographs rather than something a comment
 *  asserts. */
const MCTS_ROWS = frame === "forkbig" ? mctsSearchRows(520, 9) : mctsSearchRows(106, 6);

const MCTS_TREE = buildTree(MCTS_ROWS);

/** The frames render at most one tree; the surface keys them by search. */
const MCTS_TREES: ReadonlyMap<string, ForkNode> = new Map([[MCTS_TREE.id, MCTS_TREE]]);

const EMPTY_TREES: ReadonlyMap<string, ForkNode> = new Map();

/** No branch has written since this frame mounted, which is what a photograph
 *  of a settled surface should say. A live one is its own frame. */
const NO_HEAD_ACTIVITY: ReadonlyMap<string, number> = new Map();

/* ── Agent socket stub ──────────────────────────────────────────── */

/**
 * The Agents-SDK RPC transport, answered in-page.
 *
 * SettingsPage gates its whole body on a live agent connection, so with no
 * worker the only photographable thing was its spinner. This is the same idea
 * as the `/api/user` fetch stub above, one layer down: open the socket, answer
 * `{type:"rpc"}` frames from a table, and the real page renders against mock
 * data. Sockets that are not an agent connection (vite's HMR channel) fall
 * through to the real WebSocket untouched.
 */
const AGENT_RPC_DATA = v.parse(JsonObjectSchema, {
  getWorkspaceSnapshot: {
    status: {
      id: "agent_01j9x7q2m4checkoutfixes", name: "checkout-coupon-bug-9935d3",
      displayName: "Checkout coupon bug", purpose: "Find why the SAVE20 coupon 500s and fix it.",
      soul: "# Checkout coupon bug\n\nI own the checkout coupon path. I read the migration before I guess.\n",
      createdAt: NOW - 7 * 864e5, scaffoldVersion: 7, searchNodeCount: 106,
      craftedToolCount: 2, messageCount: 48, model: "anthropic/claude-opus-4", forkLineage: null, reasoningEffort: "medium",
    },
    tools: { builtIn: [], crafted: [] },
    memoryContent: "",
    // The full-screen explorer reads its tree off the snapshot, so the same
    // 106-node search the `mcts` frame renders has to arrive through here.
    mcts: MCTS_ROWS,
    timeline: [], executors: [], executorOutputs: [], lastActiveExecutor: null,
    // Mirrors the server snapshot: `loadAllData` replaces this state wholesale,
    // so an omitted field is `undefined` where an array is declared.
    pendingSteers: [], branchRuns: [],
    // Both gated surfaces have content in the gallery, so the tab-strip frames
    // keep showing them.
    tabPresence: { releases: true, explorations: true, work: true },
    activePlan: null,
    slates: [],
    turnClaim: { kind: "settled" },
  },
  getStoredModelSpec: "anthropic/claude-opus-4",
  getShellApprovalMode: "strict",
  getMctsConfig: { explorationConstant: 1.41, maxIterations: 12, branchBudget: 3 },
  getEvolutionChangelog: { entries: [], unseen: 0 },
});

const AGENT_RPC = new Map(Object.entries(AGENT_RPC_DATA));

/** The workspace `&ws=` opens on the workspacepage frame: the untitled row's
 *  page is the defect photograph — its own header naming a workspace with no
 *  title — while the default stays the titled checkout-fixes rig. */
const WORKSPACE_PAGE_NAME = new URLSearchParams(location.search).get("ws") ?? "checkout-fixes";

// `&ws=handwrought-walnut-4166c321` photographs the untitled workspace: the
// roster row born with no title, so its snapshot answers a BLANK displayName
// and the page renders the same first-run state the owner hit.
if (WORKSPACE_PAGE_NAME === "handwrought-walnut-4166c321") {
  const snapshot = v.parse(JsonObjectSchema, AGENT_RPC_DATA.getWorkspaceSnapshot);

  AGENT_RPC.set("getWorkspaceSnapshot", {
    ...snapshot,
    status: { ...v.parse(JsonObjectSchema, snapshot.status), name: "handwrought-walnut-4166c321", displayName: "", soul: "" },
  });
}

class GalleryAgentSocket extends EventTarget implements WebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState: WebSocket['readyState'] = GalleryAgentSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    super();
    queueMicrotask(() => {
      this.readyState = this.OPEN;
      const open = new Event("open");
      this.onopen?.(open);
      this.dispatchEvent(open);
    });
  }

  accept(): void {}
  serializeAttachment(_attachment: JsonValue): void {}
  deserializeAttachment(): JsonValue | null { return null; }

  send(raw: string): void {
    const json = tolerate<unknown>(() => JSON.parse(raw), 'malformed-input');

    if (json === undefined) return;

    const parsed = v.safeParse(v.object({
      type: v.optional(v.string()), id: v.optional(v.string()), method: v.optional(v.string()),
      args: v.optional(v.array(v.unknown())),
    }), json);

    if (!parsed.success) return;
    const request = parsed.output;

    if (request.type !== "rpc" || !request.method) return;
    const method = request.method;

    const answerRpc = () => {
      if (AGENT_RPC.has(method)) return AGENT_RPC.get(method);

      // The exploration reads are ANSWERED here rather than falling through, and the
      // fall-through is why: a blanket `[]` for every `get*` is a lie for any read
      // whose answer is not an array, and `getHeadRun` answering `[]` reached
      // `headRunToTree` as `[].heads` and took the whole page down with it. Column C
      // injects an `Rpc` directly while the full-screen explorer reads through this
      // socket, so both transports resolve the same fixture stores or neither is
      // trustworthy.
      if (EXPLORATION_READS.has(method)) return explorationRead(method, request.args ?? []);

      if (method.startsWith("list") || method.startsWith("get")) return [];

      return {};
    };

    const result = answerRpc();

    queueMicrotask(() => {
      const message = new MessageEvent("message", {
        data: JSON.stringify({ type: "rpc", id: request.id, success: true, result }),
      });

      this.onmessage?.(message);
      this.dispatchEvent(message);
    });
  }

  close(): void {
    this.readyState = this.CLOSED;
    const close = new CloseEvent("close", { code: 1000, wasClean: true });
    this.onclose?.(close);
    this.dispatchEvent(close);
  }
}

const RealWebSocket = window.WebSocket;

window.WebSocket = new Proxy(RealWebSocket, {
  construct(target, args: [string, (string | string[])?]) {
    return String(args[0]).includes("/agents/")
      ? new GalleryAgentSocket(String(args[0]))
      : Reflect.construct(target, args);
  },
});

/** One frame the gate makes the SERVER send. Only the lifecycles a hosted
 *  actor's host broadcasts are reachable this way — a card and a steer — since
 *  those are the frames carrying an actor stamp, and no fixture READ can
 *  produce one. */
const GalleryPushFrameSchema = v.object({
  type: v.picklist(["signal_card", "steer_status"]),
  actorId: v.optional(v.string()),
  id: v.optional(v.string()),
  state: v.optional(v.string()),
  text: v.optional(v.string()),
  metadata: v.optional(JsonObjectSchema),
  steerId: v.optional(v.string()),
  status: v.optional(v.string()),
  atStep: v.optional(v.number()),
});

window.addEventListener("gallery:push-frame", (event: Event) => {
  // The gate's own CustomEvent; the detail is parsed at the boundary because
  // nothing typechecks across a dispatch.
  const detail = event instanceof CustomEvent ? v.safeParse(GalleryPushFrameSchema, event.detail) : null;

  if (detail?.success !== true) return;

  galleryServerPush(JSON.stringify(detail.output));
});

/* ── Mock chat data ─────────────────────────────────────────────── */

interface GalleryMessage extends UIMessage { createdAt?: number }

function msg(message: GalleryMessage): GalleryMessage { return message; }

function rpcResult(value: JsonValue): Response {
  return new Response(JSON.stringify(value));
}

const MESSAGES: UIMessage[] = [
  // The first thing in every workspace's transcript: the agent being handed its
  // own workspace. The owner typed a MISSION in the New workspace dialog, not a
  // message, so this must never wear their bubble.
  msg({
    id: "g1", role: "user", createdAt: NOW - 7 * 60e3,
    metadata: { kinuEvent: "workspace_created", signalId: "sig-genesis" },
    parts: [{ type: "text", text: "This workspace has just been created. This is its first turn and nobody has typed anything yet." }],
  }),
  msg({
    id: "u1", role: "user", createdAt: NOW - 6 * 60e3,
    parts: [{ type: "text", text: "Audit the checkout flow, find why the SAVE20 coupon 500s, and fix it. Deploy to staging when green." }],
  }),
  msg({
    id: "a1", role: "assistant", createdAt: NOW - 5 * 60e3,
    parts: [
      { type: "reasoning", text: "The coupon path goes through /api/cart/apply. I should reproduce first, then bisect: the handler, the pricing service, then the migration that landed Tuesday. The 500 with SAVE20 but not SAVE10 suggests a percentage-vs-fixed branch." },
      { type: "tool-run", toolCallId: "t1", state: "output-available", input: { runtime: "sandbox", command: "curl -s -X POST localhost:8788/api/cart/apply -d '{\"code\":\"SAVE20\"}'" }, output: "HTTP 500\n{\"error\":\"TypeError: Cannot read properties of undefined (reading 'percent')\"}" },
      { type: "tool-eval", toolCallId: "t2", state: "output-available", input: { code: "// Inspect coupon rows to find the missing kind\nconst rows = await sql`SELECT code, kind, value FROM coupons WHERE code LIKE 'SAVE%'`;\nreturn rows;" }, output: '[{"code":"SAVE10","kind":"fixed","value":10},{"code":"SAVE20","kind":null,"value":20}]' },
      { type: "text", text: "Found it. Tuesday's migration backfilled `kind` for fixed coupons only — percentage coupons have `kind: null`, and `applyCoupon` dereferences `rules[kind].percent`.\n\n```ts\nconst rule = rules[coupon.kind ?? inferKind(coupon)];\n```\n\nI'll patch the migration, add a regression test, and run the suite." },
      // A real repair is a RUN of calls, not one — this is the case the chat
      // has to survive without becoming a wall of identical rows.
      { type: "tool-file", toolCallId: "t4", state: "output-available", input: { action: "read", path: "packages/checkout/src/apply-coupon.ts" }, output: "…" },
      { type: "tool-file", toolCallId: "t5", state: "output-available", input: { action: "read", path: "packages/checkout/migrations/0042_coupon_kind.sql" }, output: "…" },
      // Deliberately a QUIET failure: the transport reports success
      // (state: output-available) but the tool caught its own failure and
      // returned it as a normal result — the shape every built-in uses
      // (tools/builtins.ts `{error: "…"}`). The migration file moved on since
      // the read above, so the edit's old_text no longer matches uniquely.
      // This is the case that makes a whole 5-call group read as clean if the
      // quiet failure is not surfaced.
      { type: "tool-file", toolCallId: "t6", state: "output-available", input: { action: "edit", path: "packages/checkout/migrations/0042_coupon_kind.sql", edits: [{}, {}] }, output: { error: "old_text not found or not unique — the file changed since the last read" } },
      { type: "tool-file", toolCallId: "t7", state: "output-available", input: { action: "write", path: "packages/checkout/tests/coupon-kind.test.ts" }, output: "ok" },
      { type: "tool-agents", toolCallId: "t8", state: "output-available", input: { action: "fork", forks: [{}, {}, {}], task: "Check every other call site that indexes `rules` by kind" }, output: "3 forks merged" },
      { type: "tool-run", toolCallId: "t3", state: "input-available", input: { runtime: "sandbox", command: "bun test packages/checkout" } },
    ],
  }),
  msg({
    id: "bg1", role: "user",
    metadata: { kinuEvent: "background_job", kind: "test-suite", status: "completed" },
    parts: [{ type: "text", text: "background job completed" }],
  }),
  msg({
    id: "d1", role: "user",
    metadata: { kinuEvent: "event_drain" },
    parts: [{ type: "text", text: "While you were idle:\n- [subordinate_report] from subordinate (coupon-tester): All 14 checkout regression tests green after the migration patch. [the sender awaits your answer]\n- [webhook] from github (AshishKumar4/shop): PR #212 review requested" }],
  }),
  // The row the incident was, copied from production: `sunlit-stone-4a20` and
  // `stone-ash-71f2` hold five of these, written before the author stamp
  // existed, so a bare UUID id and the event name are the only markers on them
  // — and until the classifier stopped being an allowlist of four names, all
  // five were drawn in the owner's bubble, above things they had typed.
  msg({
    id: "f8798675-5e9a-4d13-aac2-293f4557f1c1", role: "user",
    metadata: { kinuEvent: "fork_interrupted", runs: ["6xrijuf933p0jclpctw59"], heads: 23 },
    parts: [{ type: "text", text: "23 head(s) across 6 fork run(s) were still marked running from an activation that has ended, so nothing is executing them and no report will arrive. They have been released; re-run the ones you still need." }],
  }),
  // The same class, stamped by the seam with its author, so the event name is
  // not load-bearing for the decision.
  msg({
    id: "programmatic:completion-gate-1", role: "user",
    metadata: { kinuEvent: "completion_gate", kinuAuthor: "harness" },
    parts: [{ type: "text", text: "[Runtime check — a mechanical gate from Kinu, not written by the user.]\n\nYou said the task is done. Here is the current state of the working directory, read after you stopped." }],
  }),
  msg({
    id: "a2", role: "assistant", createdAt: NOW - 3 * 60e3,
    parts: [
      { type: "text", text: "The edit above didn't take — re-reading before I retry, then confirming the migration is idempotent before I let it near staging." },
      // A real multi-line command, kept as its OWN row (a lone text part on
      // either side stops it folding into a 3+ run) so its expanded state is
      // inspectable — the case that otherwise renders as escaped-JSON instead
      // of a readable script.
      {
        type: "tool-run", toolCallId: "t9", state: "output-available",
        input: {
          runtime: "sandbox",
          command: "for f in packages/checkout/migrations/*.sql; do\n  echo \"-- checking $f\"\n  sqlite3 :memory: < \"$f\" || exit 1\ndone",
        },
        output: "-- checking packages/checkout/migrations/0041_coupons.sql\n-- checking packages/checkout/migrations/0042_coupon_kind.sql",
      },
      { type: "text", text: "Migrations are clean. One more check before I loop back to the edit." },
      // A genuine protocol-level failure (the executor itself crashed/timed
      // out), distinct from the quiet t6 case above: no `output` at all, the
      // reason lives in errorText.
      {
        type: "tool-run", toolCallId: "t10", state: "output-error",
        input: { runtime: "workspace", command: "curl -sf https://ci.internal/status/checkout-fixes" },
        errorText: "fetch failed: connect ETIMEDOUT 10.0.4.12:443",
      },
      { type: "text", text: "CI didn't answer — checking the PR directly instead." },
      // An MCP tool the host has no summarizer contract for — the honest
      // fallback (name + its one string argument, no invented annotation),
      // and long enough to exercise the row's truncation + hover title.
      {
        type: "dynamic-tool", toolCallId: "t11", toolName: "mcp_gh_search_pull_requests", state: "output-available",
        input: { query: "repo:AshishKumar4/shop is:open head:fix/coupon-kind base:main status:success review-requested:AshishKumar4" },
        output: "1 open PR: #212 \"Fix SAVE20 coupon backfill\" — checks pending",
      },
      // A crafted tool the workspace taught itself, called by name: the
      // completed turn's result line attributes it ("Used the … tool") from
      // the part alone — builtins and `mcp_`-prefixed tools never attribute.
      {
        type: "dynamic-tool", toolCallId: "t12", toolName: "bisect_migration", state: "output-available",
        input: { migration: "packages/checkout/migrations/0042_coupon_kind.sql", column: "kind" },
        output: "0042_coupon_kind.sql changed kind from fixed-only to nullable",
      },
      { type: "text", text: "CI didn't answer — retrying after the migration lands. PR #212 is already up for review." },
    ],
  }),
];


function galleryPlanInspection(request: SubordinateInspectionRequest, plans: readonly PlanReview[]) {
  if (request.view === 'plans') return { view: 'plans', path: request.path, page: { status: 'end', items: plans } };

  if (request.view === 'children') return { view: 'children', path: request.path, page: { status: 'end', items: [] } };

  if (request.view === 'planTasks') return { view: 'planTasks', path: request.path, tasks: [] };

  // The exact read a plan-arrival hint is resolved through. It answers the ONE
  // reference it was asked for or nothing at all: a reference to a revision this
  // fixture never issued is `missing`, the same refusal the real existing-only
  // inspection returns, so a stale hint cannot paint a neighbouring plan.
  if (request.view === 'plan') {
    const plan = plans.find(item => item.id === request.id && item.revision === request.revision);

    return plan
      ? { view: 'plan', path: request.path, plan }
      : missingSubordinateHistory(request.path);
  }

  throw new Error('Unexpected gallery plan inspection');
}

const stubRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (method === 'inspectSubordinate') {
    const request = v.parse(SubordinateInspectionRequestSchema, args?.[0]);

    return rpcResult(v.parse(JsonValueSchema, galleryPlanInspection(request, []))).json<T>();
  }

  // A read whose answer is a RECORD, where the blanket `[]` below is not a
  // smaller version of the right answer but a shape the caller dereferences.
  // `getExposedPorts` is read as `result.ports` inside a `setState` updater, so
  // `[]` threw during render and took the page with it — which is why every
  // frame that mounts a PAGE rather than a surface went blank: only a page
  // opens its own connection, so only a page reaches this read.
  //
  // Empty, because the fork frames photograph trees. A fixture port would put a
  // live-preview chip in the chrome of a screenshot about search.
  if (method === "getExposedPorts") return rpcResult({ ports: [] }).json<T>();

  // The same class, one card over: the change-set reader reads
  // `result.files.length` for every executor option before it picks one, so
  // `[]` threw inside the load and every Work column rendered "Could not load
  // the change-set: Cannot read properties of undefined (reading length)"
  // where a fresh workspace's empty change-set belongs. `ExecutorDiffResult`
  // (core read-models/workspace-diff.ts) carries `files` on every path it can
  // return, so an empty change-set is `files: []` and not no files at all.
  //
  // `vfs-baseline` is what the product answers a column whose `executors` prop
  // is empty: with no workspace provider to hold a git tree, the read falls
  // through to the VFS baseline.
  if (method === "getExecutorDiff") return rpcResult({ files: [], mode: "vfs-baseline" }).json<T>();

  // One more of the class: `listWorkspaceWork` is read as `result.plans` /
  // `result.tasks` by both halves of the Work tab, so the blanket `[]` below
  // threw on the dereference and emptied every frame that mounts it.
  if (method === "listWorkspaceWork") return rpcResult({ plans: [], tasks: [] }).json<T>();

  // And once more: `getToolDescriptions` is read as `result.builtIn.map(...)`
  // by the live refresh every mounted PAGE runs, so the blanket `[]` threw on
  // the dereference and the page put "Tools could not be refreshed. Cannot
  // read properties of undefined (reading 'map')" up on every frame that
  // mounts one. Three halves, the way the orchestrator answers it.
  if (method === "getToolDescriptions") return rpcResult({ builtIn: [], executors: [], crafted: [] }).json<T>();

  if (method.startsWith("list") || method.startsWith("get")) return rpcResult([]).json<T>();

  return rpcResult({}).json<T>();
};

/* `?createFails=1`: the FIRST create attempt rejects with a two-frame cause
   chain, the way a workspace that refuses would. The browser gates drive it
   twice — once to watch the failure being shown (workspacepage) or recorded
   (agentchats), once to prove the affordance still works. */
const CREATE_FAILS = new URLSearchParams(location.search).get("createFails") === "1";

let createRefused = false;

function maybeRefuseCreate(): void {
  if (!CREATE_FAILS || createRefused) return;
  createRefused = true;
  throw new Error("the workspace refused the new agent", {
    cause: new Error("subordinate quota exhausted"),
  });
}

/* The `workspacepage` frame's stateful half: the additional-agent roster the
   REAL page mutates through its own hook. Creation, rename, navigation and the
   facet snapshot are page wiring and run for real here; only the chat behind
   the stub socket stays inert (the interactive `agentchats` rig covers send
   and the first-message titler). */
const GALLERY_SUBS: {
  name: string; displayName: string; role: string; createdBy: string;
  status: string; currentTask: string | null; createdAt: number; dismissedAt: number | null;
}[] = [];

let gallerySubSeq = 0;

/** The actor a rostered name resolves to here. Derived from the name so the
 *  frames the gate stamps and the id the pane reads off its own snapshot are
 *  the same string without a second fixture to keep in step. */
function galleryActorId(name: string): string {
  return `actor-${name}`;
}

const GALLERY_PLAN_MARKDOWN = `# Repair the \`applyCoupon\` eligibility guard

The checkout accepts archived coupons because the eligibility guard reads the campaign state after the discount has already been applied. This plan moves the guard ahead of mutation and keeps the current response contract.

## Scope

- Read the coupon and campaign in one transaction.
- Reject archived or expired campaigns before any cart row changes.
- Keep the existing error code for clients that already handle an ineligible coupon.

## Files

\`\`\`text
packages/
├── core/
│   ├── src/checkout/apply-coupon.ts
│   └── tests/checkout/apply-coupon.test.ts
└── cf-backend/
    └── src/routes/checkout.ts
\`\`\`

## Implementation

1. Move the eligibility check before the cart update in \`applyCoupon\`.
2. Return the existing \`coupon_ineligible\` result when the campaign is archived or expired.
3. Keep the route adapter unchanged; it already maps that result to the public response.

## Verification

- Run the focused checkout test with active, archived, and expired campaigns.
- Exercise the route with the existing gallery fixture.
- Confirm that a refused coupon leaves the cart total and discount rows unchanged.

## Expected result

The same request either applies one valid coupon atomically or returns \`coupon_ineligible\` without changing the cart.`;

/* `?plan=late-heading` puts the plan's only h1 mid-document, where the agent
   wrote it. `?plan=annotated-heading` anchors a stored annotation to the
   LEADING h1. The header must refuse to promote either: the first would
   silently reorder the document, and the second would strand an anchor the
   highlighter can only resolve inside the viewer's own article.
   `?plan=read-only` is a settled plan, where the viewer's floating action strip
   holds nothing the reader may still press. All three are reachable so a
   browser can measure them rather than a reader finding them. */
const GALLERY_PLAN_VARIANT = new URLSearchParams(location.search).get("plan");

const GALLERY_PLAN_LATE_HEADING = `The guard runs after the discount lands, so an archived coupon still applies.

# Rejected: map the failure at the edge

Mapping it in the route hides the defect and leaves the cart already mutated.

## Scope

- Read the coupon and campaign in one transaction.`;

const GALLERY_PLAN_TITLE_NOTE: PlanReviewAnnotation = {
  id: "gallery-plan-title-note",
  blockId: "block-0",
  startOffset: 0,
  endOffset: 10,
  type: "COMMENT",
  text: "Name the guard this repairs.",
  originalText: "Repair the",
  createdA: NOW,
  author: "Owner",
};

const GALLERY_PLAN_CONTENT = GALLERY_PLAN_VARIANT === "late-heading"
  ? GALLERY_PLAN_LATE_HEADING
  : GALLERY_PLAN_MARKDOWN;

const GALLERY_PLAN_ANNOTATIONS: readonly PlanReviewAnnotation[] =
  GALLERY_PLAN_VARIANT === "annotated-heading" ? [GALLERY_PLAN_TITLE_NOTE] : [];

const GALLERY_PLAN_STATUS: PlanReview["status"] =
  GALLERY_PLAN_VARIANT === "read-only" ? "superseded" : "pending";

let galleryAgentPlan: PlanReview = {
  id: "gallery-agent-plan",
  sessionId: "default",
  revision: 1,
  content: GALLERY_PLAN_CONTENT,
  status: GALLERY_PLAN_STATUS,
  annotations: GALLERY_PLAN_ANNOTATIONS,
  feedback: null,
  handoffAccepted: false,
  createdAt: NOW,
  updatedAt: NOW,
  decidedAt: null,
};

/* ── The walk-back ────────────────────────────────────────────────

   Two turns the operator typed, so there is a SECOND user message to walk back
   to, and the transcript that follows it is what a revert has to remove.

   `?transcript=revert` seeds this into the real WorkspacePage frame; the
   conversation arrives the way the product's arrives, and the revert's own
   redraw is the server frame the fixture pushes back.

   `?checkpoints=1` is the other half of the one condition the dialog carries:
   with a device connected AND a checkpoint held for the turn, the operator is
   offered the device files too. Without it — the workspace the owner reported,
   which has no device at all — that option does not exist, and the revert the
   product CAN always perform is the only one offered. */
const REVERT_THREAD: UIMessage[] = [
  msg({
    id: "rv-u1", role: "user", createdAt: NOW - 8 * 60e3,
    parts: [{ type: "text", text: "Add the coupon-kind regression test and run the checkout suite." }],
  }),
  msg({
    id: "rv-a1", role: "assistant", createdAt: NOW - 7 * 60e3,
    parts: [{ type: "text", text: "Added `tests/coupon-kind.test.ts`. The suite is green: 14 passed." }],
  }),
  msg({
    id: "rv-u2", role: "user", createdAt: NOW - 6 * 60e3,
    parts: [{ type: "text", text: "Now rewrite the pricing service to read its rules from the campaign table." }],
  }),
  msg({
    id: "rv-a2", role: "assistant", createdAt: NOW - 5 * 60e3,
    parts: [{ type: "text", text: "Rewrote `pricing-service.ts` against the campaign table and updated eleven call sites." }],
  }),
];

const REVERT_DEVICE_CONNECTED = new URLSearchParams(location.search).get("checkpoints") === "1";

const REVERT_CHECKPOINT: FileCheckpointEntry = {
  id: "c0ffee1", dir: "/pc/ashish-device/work/shop", at: NOW - 6 * 60e3,
  turnId: "rv-u2", sessionId: "default", reason: "before turn",
};

/** What the checkpoint store answers for the turn in question. The two fields
 *  are separate facts: a store nobody can reach says nothing about what a turn
 *  changed. */
const REVERT_LISTING: FileCheckpointListing = REVERT_DEVICE_CONNECTED
  ? { availability: { available: true }, entries: [REVERT_CHECKPOINT] }
  : { availability: { available: false, reason: "no device connected — connect one with `kinu connect`" }, entries: [] };

/** `?transcript=revert` seeds the walk-back thread into the `workspacepage`
 *  frame; any other value, or none, mounts the frame on its empty default. */
function seedFrameTranscript(transcript: string | null): void {
  if (transcript === "revert") seedGalleryChat(REVERT_THREAD);
}

/** The conversation after the walk-back, as the Durable Object broadcasts it:
 *  the entries from the picked message on leave the head's ancestry, and every
 *  open tab redraws from the transcript frame. */
function galleryRevertConversation(entryId: string): void {
  const from = REVERT_THREAD.findIndex((message) => message.id === entryId);
  const kept = from < 0 ? REVERT_THREAD : REVERT_THREAD.slice(0, from);

  galleryServerPush(JSON.stringify({ type: "cf_agent_chat_messages", messages: kept }));
}

/* The reads the first-visit inspector policy is decided on, answered in the
   shape the page actually consumes them: a pending plan is what it opens for,
   and the stub's blanket `[]` answered `listSlates` in a shape `slates.map`
   crashed on. A table like AGENT_RPC because both are method → fixture. */
const WORKSPACE_PAGE_RPC = new Map(Object.entries({
  getWorkspaceSnapshot: () => {
    const snapshot = v.parse(JsonObjectSchema, AGENT_RPC.get("getWorkspaceSnapshot"));

    return { ...snapshot, activePlan: galleryAgentPlan };
  },
  listSlates: () => ({ slates: [], problems: [] }),
  getActivePlanReview: () => galleryAgentPlan,
  // The Work tab's own read: the workspace's plans with their linked tasks,
  // every actor. The page's plan lives here too — `getActivePlanReview` is
  // what the connection reports, this read is what the tab draws, and a
  // fixture that answered only the first showed a Work tab with no plan in it.
  //
  // The owner is the WORKSPACE's name because that is what the real read
  // answers for a root actor: `createMain({ name: this.name })` registers the
  // workspace's own name, never the word "main".
  listWorkspaceWork: () => ({
    plans: [{
      owner: { actorId: galleryActorId(WORKSPACE_PAGE_NAME), name: WORKSPACE_PAGE_NAME, retired: false },
      plan: galleryAgentPlan, tasks: [],
    }],
    tasks: [],
  }),
  savePlanReviewAnnotations: () => ({ ok: true, plan: galleryAgentPlan }),
  // The frame's plan is live, so its presence says the Work lane has content;
  // without an answer the strip hid Work on first paint.
  getWorkspaceTabPresence: () => ({ work: true, releases: true, explorations: true }),
  listPendingConsents: () => [],
  // The frame's whole conversation is its seed, so the walk back through
  // storage is exhausted at once. A blanket `[]` is not a page and the walk
  // reported the parse as a failed read of the store.
  getChatHistoryPage: () => ({ status: "end", items: [] }),
  listFileCheckpoints: () => REVERT_LISTING,
  planFileRestore: () => ({
    dir: REVERT_CHECKPOINT.dir, id: REVERT_CHECKPOINT.id,
    files: [{ path: "src/pricing-service.ts", kind: "modify" }, { path: "src/campaign-rules.ts", kind: "delete" }],
  }),
  restoreFileCheckpoint: () => ({
    dir: REVERT_CHECKPOINT.dir, id: REVERT_CHECKPOINT.id, files: [], preRestoreId: "5afe70",
  }),
}));

/** One gallery RPC answer, or null for a method the surface asked does not own.
 *  Wrapped rather than bare, so `null` stays available as "not mine" while an
 *  answer of its own may be anything a route serialises. */
type GalleryAnswer = { readonly value: unknown } | null;

/** The PLAN surface's own answers: the review pane's read of this workspace's
 *  plans, and its decision on the one in front of it. */
function galleryPlanRpc(method: string, args?: unknown[]): GalleryAnswer {
  if (method === "inspectSubordinate") {
    return { value: galleryPlanInspection(v.parse(SubordinateInspectionRequestSchema, args?.[0]), [galleryAgentPlan]) };
  }

  if (method !== "decidePlanReview") return null;

  const [, , decision, feedback] = v.parse(
    v.tuple([v.string(), v.number(), v.picklist(["approve", "request_changes"]), v.optional(v.string())]),
    args,
  );

  galleryAgentPlan = {
    ...galleryAgentPlan,
    status: decision === "approve" ? "approved" : "changes_requested",
    feedback: feedback ?? null,
    handoffAccepted: true,
    updatedAt: Date.now(),
    decidedAt: Date.now(),
  };

  return { value: { ok: true, plan: galleryAgentPlan, queued: true } };
}

/** The ROSTER surface's own answers: the subordinate list, the three writes the
 *  agents pane makes on it, and one hosted actor's view of itself. */
function galleryRosterRpc(method: string, args?: unknown[]): GalleryAnswer {
  if (method === "listSubordinates") return { value: [...GALLERY_SUBS] };

  // An agent pane's own pin, recorded so a gate can read WHICH actor a pick wrote.
  if (method === "setActorModel" || method === "setReasoningEffort") {
    const root = document.documentElement;
    const calls: unknown[] = JSON.parse(root.dataset.galleryModelCalls ?? "[]");

    calls.push({ method, args });
    root.dataset.galleryModelCalls = JSON.stringify(calls);

    return { value: method === "setActorModel" ? { ok: true, spec: args?.[1] } : { ok: true, effort: args?.[0] ?? null } };
  }

  if (method === "createSubordinateAgent") {
    maybeRefuseCreate();
    const name = `agent-${++gallerySubSeq}`;

    const entry = {
      name, displayName: codenameFor(name), role: "agent", createdBy: "user",
      status: "idle", currentTask: null, createdAt: NOW, dismissedAt: null,
    };

    GALLERY_SUBS.push(entry);
    galleryAgentPlan = {
      ...galleryAgentPlan,
      status: "pending",
      annotations: GALLERY_PLAN_ANNOTATIONS,
      feedback: null,
      handoffAccepted: false,
      updatedAt: NOW,
      decidedAt: null,
    };

    return { value: { name, displayName: "", subordinate: entry } };
  }

  if (method === "renameSubordinateAgent") {
    const [name, displayName] = v.parse(v.tuple([v.string(), v.string()]), args);
    const entry = GALLERY_SUBS.find((sub) => sub.name === name);

    if (!entry) throw new Error(`gallery: no subordinate "${name}"`);
    entry.displayName = displayName;

    return { value: { ok: true, name, displayName, subordinate: { ...entry } } };
  }

  if (method === "dismissSubordinate") {
    const [name, keepHistory] = v.parse(v.tuple([v.string(), v.optional(v.boolean())]), args);
    const index = GALLERY_SUBS.findIndex((sub) => sub.name === name);

    if (index >= 0) GALLERY_SUBS.splice(index, 1);

    return { value: { ok: true, name, historyKept: keepHistory ?? true } };
  }

  if (method !== "getActorSnapshot") return null;

  // The hosted actor's own view, answered by the ROOT now rather than by a
  // facet over a stub. Identity mirrors the roster; the mission stays
  // internal — the header renders the ROSTER title, never this field.
  const [name] = v.parse(v.tuple([v.string()]), args);
  const latest = GALLERY_SUBS.find((sub) => sub.name === name) ?? GALLERY_SUBS.at(-1);
  const actor = latest?.name ?? "agent-0";

  return {
    value: {
      name: actor,
      actorId: galleryActorId(actor),
      displayName: latest?.displayName ?? "",
      role: "task",
      mission: "",
      model: { model: "anthropic/claude-opus-4", source: "workspace" },
      reasoningEffort: "medium",
      activePlan: galleryAgentPlan,
      pendingSteers: [],
    } satisfies SubordinateSnapshot,
  };
}

const workspacePageRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  const plan = galleryPlanRpc(method, args);

  if (plan) return rpcResult(v.parse(JsonValueSchema, plan.value)).json<T>();

  if (new URLSearchParams(location.search).has("workspaceFault")) {
    const state = document.documentElement.dataset;
    const reads = ["getExecutorFiles", "getWorkspaceSnapshot", "getMemoryContent"];

    if (reads.includes(method) && state.workspaceFault === "1") throw new Error("Network connection lost");
    const revision = state.workspaceRevision ?? "before";

    if (method === "getExecutorFiles") return rpcResult({ path: "/", entries: [
      { name: `${revision}.txt`, isDir: false, size: 12, mtimeMs: revision === "before" ? 1 : 2 },
    ] }).json<T>();

    if (method === "listMounts") return rpcResult([]).json<T>();

    if (method === "getMemoryContent") return rpcResult(`Memory ${revision}`).json<T>();

    if (method === "getWorkspaceSnapshot") {
      const snapshot = v.parse(JsonObjectSchema, AGENT_RPC.get(method));

      return rpcResult(v.parse(JsonValueSchema, { ...snapshot, memoryContent: `Memory ${revision}`, activePlan: galleryAgentPlan })).json<T>();
    }
  }

  if (new URLSearchParams(location.search).get("terminal") === "denied" && method === "getWorkspaceSnapshot") {
    return new Promise<T>(() => {});
  }

  const roster = galleryRosterRpc(method, args);

  if (roster) return rpcResult(v.parse(JsonValueSchema, roster.value)).json<T>();

  if (method === "revertConversation") {
    galleryRevertConversation(v.parse(v.string(), args?.[0]));

    return rpcResult(null).json<T>();
  }

  // A preview that arrives after first paint: the gate sets the dataset flag
  // once the page has settled, and the next live refresh lists a port the
  // earlier reads never named — the passive arrival the inspector chip covers.
  if (method === "getExposedPorts" && document.documentElement.dataset.previewArrived === "1" && args?.[0] === "sandbox") {
    return rpcResult({ ports: [{ port: 8130, url: "https://8130-sandbox-aaaaaaaaaaaaaaaa.preview.example.test/", name: "Arrived app" }] }).json<T>();
  }

  const page = WORKSPACE_PAGE_RPC.get(method);

  if (page !== undefined) return rpcResult(v.parse(JsonValueSchema, page())).json<T>();
  const agent = AGENT_RPC.get(method);

  if (agent !== undefined) return rpcResult(agent).json<T>();

  return stubRpc<T>(method, args);
};

/* ── swarm searches: the shipped model's own states ─────────────── */

/**
 * A search under a NAMED PRESET, so the resolved tuple has something to resolve.
 *
 * `prove` rather than `optimise` because it is the row whose axes are least
 * guessable from its name: `context:fork` (a proof's children need the ancestor
 * chain's accepted steps), `advance:best-first` (an exact signal has no noise to
 * re-widen against) and `carry:artifacts ≥1` (kept exactly when the checker
 * accepted). A panel that only printed "prove" would tell a reader none of
 * that, which is the whole reason the tuple is rendered beside the name.
 */
// The Lean module named below is a placeholder: this fixture invents
// `lean/Checkout/Coupon.lean` along with the coupon table it proves over, and the
// module does not exist. Citing a real one would be worse, because the frame would
// then break whenever that module was renamed and a reader would take an invented
// sorry count for a measured one. Enrolled in `CITATION_ILLUSTRATIVE`.
const PROVE_ROWS: MctsRow[] = [
  {
    id: "pv000", parent_id: null, depth: 0, visits: 0, value: 0, status: "open",
    action: "Prove the coupon guard terminates",
    task: "Prove that applyCoupon terminates for every coupon row, including kind = null.",
    observation: "The workspace as found: lean/Checkout/Coupon.lean, 3 sorries.",
    created_at: NOW - 78e5,
  },
  {
    id: "pv001", parent_id: "pv000", depth: 1, visits: 4, value: 0.31, status: "open",
    action: "Induct on the discount list", observation: "Checker accepted 1 of 3 goals.",
    created_at: NOW - 77e5,
  },
  {
    id: "pv002", parent_id: "pv000", depth: 1, visits: 1, value: 0.12, status: "pruned",
    action: "Case-split on kind first", observation: "Below the prune floor after one rollout.",
    created_at: NOW - 77e5,
  },
  {
    id: "pv003", parent_id: "pv001", depth: 2, visits: 3, value: 0.68, status: "open",
    action: "Strengthen the induction hypothesis", observation: "Checker accepted 2 of 3 goals.",
    created_at: NOW - 76e5,
  },
  {
    id: "pv004", parent_id: "pv000", depth: 1, visits: 0, value: 0, status: "failed",
    action: "Reduce to the existing monotonicity lemma",
    observation: "Branch errored: the lemma this cites was renamed and no longer resolves.",
    created_at: NOW - 77e5,
  },
  {
    id: "pv005", parent_id: "pv003", depth: 3, visits: 5, value: 0.94, status: "terminal",
    action: "Discharge the null case from the guard",
    observation: "Checker accepted 3 of 3 goals. No sorries remain.",
    code_used: "theorem applyCoupon_terminates : ∀ c, Terminates (applyCoupon c) := by",
    created_at: NOW - 75e5,
  },
];

/**
 * A search that FANS IN — `expand:'aggregate'`, which no named preset resolves to,
 * so it is necessarily a `custom` composition and the frame photographs that too.
 *
 * `sw004` and `sw009` are the aggregate vertices, at two different depths. Both are
 * ordinary scored rows: the store records a vertex's SELECTION parent and nothing
 * else, so nothing in these rows says either of them consumed a level — which is
 * exactly the state the tree's fan-in marking exists to make readable, and it is
 * read off the journal below rather than out of here.
 */
const SWARM_ROWS: MctsRow[] = [
  {
    id: "sw000", parent_id: null, depth: 0, visits: 0, value: 0, status: "open",
    action: "Reconcile the three coupon fixes",
    task: "Reduce checkout p95 without regressing the coupon guard.",
    observation: "The workspace as found: p95 = 412ms on the failing fixture.",
    created_at: NOW - 22e5,
  },
  {
    id: "sw001", parent_id: "sw000", depth: 1, visits: 3, value: 0.44, status: "open",
    action: "Cache the resolved kind per coupon id", observation: "p95 = 318ms.",
    created_at: NOW - 21e5,
  },
  {
    id: "sw002", parent_id: "sw000", depth: 1, visits: 2, value: 0.37, status: "open",
    action: "Index rules by kind at load", observation: "p95 = 341ms.",
    created_at: NOW - 21e5,
  },
  {
    id: "sw003", parent_id: "sw000", depth: 1, visits: 1, value: 0.19, status: "pruned",
    action: "Precompute the whole discount table", observation: "p95 = 402ms — below the prune floor.",
    created_at: NOW - 21e5,
  },
  {
    id: "sw004", parent_id: "sw001", depth: 2, visits: 4, value: 0.71, status: "open",
    action: "Reconcile the cache with the load-time index",
    observation: "p95 = 244ms. Both parents' writes touched pricing.ts; this candidate is the merge.",
    created_at: NOW - 20e5,
  },
  {
    id: "sw005", parent_id: "sw002", depth: 2, visits: 2, value: 0.52, status: "open",
    action: "Narrow the index to the percentage path", observation: "p95 = 296ms.",
    created_at: NOW - 20e5,
  },
  {
    id: "sw006", parent_id: "sw002", depth: 2, visits: 1, value: 0.28, status: "pruned",
    action: "Index every rule field", observation: "p95 = 377ms — below the prune floor.",
    created_at: NOW - 20e5,
  },
  {
    id: "sw007", parent_id: "sw004", depth: 3, visits: 6, value: 0.93, status: "terminal",
    action: "Drop the redundant second lookup",
    observation: "p95 = 188ms. The guard's fixture still passes.",
    code_used: "const kind = cached ?? inferKind(coupon);",
    created_at: NOW - 19e5,
  },
  {
    id: "sw008", parent_id: "sw004", depth: 3, visits: 2, value: 0.61, status: "open",
    action: "Warm the cache on first read", observation: "p95 = 271ms.",
    created_at: NOW - 19e5,
  },
  {
    id: "sw009", parent_id: "sw005", depth: 3, visits: 3, value: 0.66, status: "open",
    action: "Reconcile the narrowed index with the warm cache",
    observation: "p95 = 258ms. Consumed both depth-2 candidates that scored.",
    created_at: NOW - 19e5,
  },
];

/** One journalled node, at the shape `HeadRunView.heads` carries. The rationale is
 *  the field that matters here: it is the engine's own reason for the node existing,
 *  and for an aggregate vertex it is the ONLY record that reaches a client. */
function swarmNode(
  id: string, task: string, rationale: string,
  extra: Partial<HeadRunView["heads"][number]> = {},
): HeadRunView["heads"][number] {
  return {
    id, task, rationale, status: "completed", summary: null, errorMessage: null,
    parentId: null, depth: 1,
    usage: { input: 6_200, output: 480 }, wallClockMs: 12_400,
    spawnedAt: NOW - 21e5, lastStepAt: NOW - 20e5, decisions: [],
    ...extra,
  };
}

/**
 * The journal behind {@link PROVE_ROWS}. `rationale` on the RUN is where
 * `journal.recordSplit` writes `resolved.label ?? resolved.preset`, so for a preset
 * run it is the preset name and nothing else.
 */
const PROVE_RUN: HeadRunView = {
  rootId: "pv000",
  task: "Prove that applyCoupon terminates for every coupon row, including kind = null.",
  rationale: "prove",
  status: "completed",
  spawnedAt: NOW - 78e5,
  heads: [
    swarmNode("pv001", "Discharge the termination goal", "expansion 1 of 3"),
    swarmNode("pv002", "Discharge the termination goal", "expansion 2 of 3"),
    swarmNode("pv004", "Discharge the termination goal", "expansion 3 of 3", {
      status: "errored", errorMessage: "Checker refused: unknown identifier `discount_monotone`.",
      lastStepAt: null,
    }),
    swarmNode("pv003", "Discharge the termination goal", "the strongest accepted line so far"),
    swarmNode("pv005", "Discharge the termination goal", "close the remaining null case"),
  ],
  merge: null,
};

/**
 * The journal behind {@link SWARM_ROWS} — a `custom` composition, and the two
 * fan-in rationales the engine writes verbatim.
 *
 * `fan-in over k parents of depth d` is `strategy/swarm-run.ts`'s own sentence for
 * an aggregate vertex. It is quoted here rather than paraphrased because the
 * surface reads the count out of it, and a fixture that paraphrased would
 * photograph a marking the real store cannot produce.
 */
const SWARM_RUN: HeadRunView = {
  rootId: "sw000",
  task: "Reduce checkout p95 without regressing the coupon guard.",
  rationale: "conflict-reconciling ensemble",
  status: "completed",
  spawnedAt: NOW - 22e5,
  heads: [
    swarmNode("sw001", "Reduce checkout p95", "expansion 1 of 3"),
    swarmNode("sw002", "Reduce checkout p95", "expansion 2 of 3"),
    swarmNode("sw003", "Reduce checkout p95", "expansion 3 of 3"),
    swarmNode("sw004", "Reduce checkout p95", "fan-in over 3 parents of depth 1"),
    swarmNode("sw005", "Reduce checkout p95", "expansion 1 of 2"),
    swarmNode("sw006", "Reduce checkout p95", "expansion 2 of 2"),
    swarmNode("sw007", "Reduce checkout p95", "expansion 1 of 2"),
    swarmNode("sw008", "Reduce checkout p95", "expansion 2 of 2"),
    swarmNode("sw009", "Reduce checkout p95", "fan-in over 2 parents of depth 2"),
  ],
  merge: null,
};

/**
 * A search that STARTED and reached nothing: the root was written, the first wave
 * errored, and the ledger recorded the run as failed.
 *
 * The state this frame exists for. Drawn as a one-dot canvas under a
 * settled-looking label it reads as "the search found nothing" — a claim about
 * the world rather than about this run. A refusal names its cause instead, and the
 * cause is the branch's own message.
 *
 * NOT a refused CALL: `resolveSwarm` and `swarmValidity` refuse before the engine
 * writes a root, so a call refused for `advance:'pareto'` or an undeclared preset
 * leaves nothing to select and cannot reach this surface at all.
 */
const REFUSED_ROWS: MctsRow[] = [
  {
    id: "rf000", parent_id: null, depth: 0, visits: 0, value: 0, status: "open",
    action: "Find a coupon row that breaks the guard",
    task: "Find a coupon row that makes applyCoupon throw after the migration.",
    observation: "The workspace as found: 41 coupon fixtures.",
    created_at: NOW - 4e5,
  },
];

const REFUSED_RUN: HeadRunView = {
  rootId: "rf000",
  task: "Find a coupon row that makes applyCoupon throw after the migration.",
  rationale: "ideate",
  status: "errored",
  spawnedAt: NOW - 4e5,
  heads: [
    swarmNode("rf001", "Find a breaking coupon row", "expansion 1 of 5", {
      status: "errored", lastStepAt: null,
      errorMessage: "Every node failed to provision a home: the workspace filesystem "
        + "has no credential on this host, so no candidate could be measured.",
    }),
  ],
  merge: null,
};

/**
 * A swarm that is HAPPENING, with its nodes in every state at once.
 *
 * The run the surface could not photograph, and the one every report about this
 * surface was about: two levels, some nodes reported, some still working, one
 * stopped by the operator and one that failed on the provider. The owner saw a
 * `running` label over a lone `0% root` and read the whole feature as dead.
 *
 * The two stores disagree ON PURPOSE, because that is what a live search looks
 * like: `search_nodes` holds the root and only the nodes that SETTLED, and
 * `head_journal` holds all nine. A node in the journal and not in the tree is a
 * node still working, it carries no score, and folding the two halves is the only
 * way it is drawn at all.
 */
const RUNNING_ROWS: MctsRow[] = [
  {
    id: "lv000", parent_id: null, depth: 0, visits: 0, value: 0, status: "open",
    action: "Audit the coupon guard for unsafe kind reads",
    task: "Audit every reader of coupon.kind across the checkout package and report the ones "
      + "that can throw on a null kind, with the call path and a suggested guard.",
    observation: "The workspace as found: 41 coupon fixtures, 9 readers.",
    created_at: NOW - 42e4,
  },
  {
    id: "lv001", parent_id: "lv000", depth: 1, visits: 1, value: 0.72, status: "open",
    action: "Walk the cart serializer's null path",
    observation: "Two readers dereference rules[kind] with no guard.",
    created_at: NOW - 30e4,
  },
  {
    id: "lv002", parent_id: "lv000", depth: 1, visits: 1, value: 0.44, status: "open",
    action: "Check the admin coupon report",
    observation: "One reader, already guarded by an early return.",
    created_at: NOW - 26e4,
  },
];

const RUNNING_RUN: HeadRunView = {
  rootId: "lv000",
  task: "Audit every reader of coupon.kind across the checkout package and report the ones "
    + "that can throw on a null kind, with the call path and a suggested guard.",
  rationale: "audit",
  status: "running",
  spawnedAt: NOW - 42e4,
  heads: [
    swarmNode("lv001", "Walk the cart serializer's null path", "expansion 1 of 5", {
      summary: "`serializeCart` reads `rules[coupon.kind].percent` with no guard — throws on "
        + "every percentage coupon written before the migration.",
      wallClockMs: 118_000, spawnedAt: NOW - 40e4, lastStepAt: NOW - 30e4,
    }),
    swarmNode("lv002", "Check the admin coupon report", "expansion 2 of 5", {
      summary: "The admin report already returns early on a null kind. No fix needed here.",
      wallClockMs: 96_000, spawnedAt: NOW - 40e4, lastStepAt: NOW - 26e4,
    }),
    swarmNode("lv003", "Trace the pricing refactor's readers", "expansion 3 of 5", {
      status: "running", wallClockMs: 0,
      spawnedAt: NOW - 40e4, lastStepAt: NOW - 4e3,
    }),
    swarmNode("lv004", "Audit the coupon report exporter", "expansion 4 of 5", {
      status: "running", wallClockMs: 0,
      spawnedAt: NOW - 40e4, lastStepAt: NOW - 11e3,
    }),
    swarmNode("lv005", "Read the checkout API edge", "expansion 5 of 5", {
      status: "aborted", wallClockMs: 31_000,
      spawnedAt: NOW - 40e4, lastStepAt: NOW - 34e4,
      errorMessage: "Stopped by the operator while it was reading the request validator.",
    }),
    swarmNode("lv006", "Re-read the two unguarded readers together", "expansion 1 of 3", {
      status: "running", depth: 2, parentId: "lv001", wallClockMs: 0,
      spawnedAt: NOW - 18e4, lastStepAt: NOW - 9e3,
    }),
    swarmNode("lv007", "Draft the guard for serializeCart", "expansion 2 of 3", {
      status: "running", depth: 2, parentId: "lv001", wallClockMs: 0,
      spawnedAt: NOW - 18e4, lastStepAt: null,
    }),
    swarmNode("lv008", "Check whether inferKind belongs at the edge", "expansion 3 of 3", {
      status: "errored", depth: 2, parentId: "lv002", wallClockMs: 7_400,
      spawnedAt: NOW - 18e4, lastStepAt: NOW - 15e4,
      errorMessage: "Turn ended by provider rate limiting: the provider asked this turn to "
        + "wait 61s against a 45s budget, that wait was taken, and still nothing flowed.",
    }),
    swarmNode("lv009", "Fan the two guarded readers in", "fan-in over 2 parents of depth 1", {
      status: "running", depth: 2, parentId: "lv001", wallClockMs: 0,
      spawnedAt: NOW - 12e4, lastStepAt: NOW - 21e3,
    }),
    // The two endings no fixture held, so the graph's status vocabulary is
    // photographable in full: `head_journal.status` can hold six words, and the
    // tooltip prints the store's own one now rather than the picture's `failed`
    // for four of them. `interrupted` is the non-terminal one — a cold
    // activation's reconciliation wrote it and the resume gate has not ruled.
    swarmNode("lv010", "Re-read the pricing resolver end to end", "expansion 4 of 5", {
      status: "budget_exceeded", depth: 2, parentId: "lv002", wallClockMs: 214_000,
      spawnedAt: NOW - 18e4, lastStepAt: NOW - 6e4,
      errorMessage: "Ran out of the depth this search granted it before it could finish "
        + "reading the resolver.",
    }),
    swarmNode("lv011", "Diff the guard against the admin path", "expansion 5 of 5", {
      status: "interrupted", depth: 2, parentId: "lv002", wallClockMs: 0,
      spawnedAt: NOW - 18e4, lastStepAt: NOW - 12e4,
    }),
  ],
  merge: null,
};

/**
 * Every run the Exploration frames list, and the stores behind them.
 *
 * Every state the surface has to draw is in ONE list on purpose: a judged
 * search whose ensemble was clamped, two swarm searches — one under a named
 * preset, one a `custom` composition that fans in — a search that started and
 * reached nothing, and two journalled runs with no search tree. That is the set,
 * and the frames below focus one of them each.
 *
 * `getMctsNodeDetail` legitimately answers null for a node the server has retired
 * and the view falls back to the row it holds — stubRpc's blanket `[]` for a `get*`
 * is not that shape and crashes the inspector.
 *
 * The list is longer than one page on purpose too. A workspace that has forked
 * thirty-four times is the case where the old bare `LIMIT 30` quietly answered
 * "that is every fork", and a frame that never crosses a page boundary cannot
 * photograph either the boundary or the end of the list.
 */
const FORK_RUNS: ForkRunSummary[] = [
  {
    // The live one, first because it is the newest and the surface focuses the
    // newest on arrival. `branches` counts the SETTLED rows, so it is 2 while nine
    // nodes exist — which is exactly the discrepancy a reader needs the journal to
    // explain, and exactly what made a running swarm look like a one-node tree.
    id: "lv000", name: "coupon.kind readers",
    task: "Audit every reader of coupon.kind across the checkout package",
    startedAt: NOW - 42e4, status: "running",
    hasSearchTree: true, hasNodeTranscripts: true,
    branches: RUNNING_ROWS.length - 1, winnerScore: null,
  },
  {
    // Derived, because `forkbig` generates 520 rows for this same run and a hardcoded
    // 105 made the scale frame photograph `105 branches` beside `Branches: 519`.
    id: "n000", name: "SAVE20 500s",
    task: "Find why the SAVE20 coupon 500s", startedAt: NOW - 36e5,
    // Both facts, and they come from the same fixture stores that give each row its
    // halves below (SEARCH_ROWS_BY_ROOT / JOURNAL_BY_ROOT): a judged MCTS search has
    // the tree and no journal, and a swarm has both — which is the row no frame could
    // photograph while one settlement tag admitted a single half per run.
    status: "completed", hasSearchTree: true, hasNodeTranscripts: false,
    branches: MCTS_ROWS.length - 1, winnerScore: 0.91,
  },
  {
    id: "sw000", name: "checkout p95",
    task: "Reduce checkout p95 without regressing the coupon guard",
    startedAt: NOW - 22e5, status: "completed",
    hasSearchTree: true, hasNodeTranscripts: true,
    branches: SWARM_ROWS.length - 1, winnerScore: 0.93,
  },
  {
    id: "pv000", name: "applyCoupon terminates",
    task: "Prove that applyCoupon terminates for every coupon row",
    startedAt: NOW - 78e5, status: "completed",
    hasSearchTree: true, hasNodeTranscripts: true,
    branches: PROVE_ROWS.length - 1, winnerScore: 0.94,
  },
  {
    // Branchless BY CONSTRUCTION: the root is the only row, so `branches` is 0 and
    // the surface owes the reader a cause rather than an empty canvas.
    id: "rf000", name: "throwing coupon row",
    task: "Find a coupon row that makes applyCoupon throw",
    startedAt: NOW - 4e5, status: "failed",
    hasSearchTree: true, hasNodeTranscripts: true,
    branches: 0, winnerScore: null,
  },
  {
    id: "root-merge-1", name: "rules-by-kind call sites",
    task: "Check every other call site that indexes rules by kind",
    startedAt: NOW - 52e5, status: "completed", hasSearchTree: false,
    hasNodeTranscripts: true, branches: 5, winnerScore: null,
  },
  {
    // The run whose lease outlived it: two nodes reported, five stopped, and
    // nothing at work. Its journal is {@link STOPPED_RUN}, and `forkstopped`
    // focuses it.
    id: "root-merge-0", name: "CLI surface audit",
    task: "Audit the CLI surface", startedAt: NOW - 9 * 36e5,
    status: "partial", hasSearchTree: false, hasNodeTranscripts: true,
    branches: 7, winnerScore: null,
  },
  ...olderForks(),
];

/**
 * The forks behind the first page — a week of real work, so scrolling past the
 * boundary lands on rows that read like history rather than like filler.
 */
function olderForks(): ForkRunSummary[] {
  const tasks = [
    "Reproduce the checkout 500 against the staging snapshot",
    "Work out which migration dropped the coupon index",
    "Find every reader of rules[kind] outside checkout",
    "Decide whether inferKind belongs at the edge or the reader",
    "Trace the cart serializer's null path",
    "Check the admin coupon report against the same guard",
    "Compare the two candidate fixes on the failing fixture",
    "Establish whether the 500 predates the pricing refactor",
  ];

  return Array.from({ length: 31 }, (_, i) => {
    const searched = i % 3 === 0;

    return {
      id: searched ? `n${String(100 + i).padStart(3, "0")}` : `root-merge-${100 + i}`,
      // The derived name, as the read model derives it: the task's first clause.
      name: (tasks[i % tasks.length] ?? "").split(" ").slice(0, 4).join(" "),
      task: `${tasks[i % tasks.length]}${i >= tasks.length ? ` (attempt ${Math.floor(i / tasks.length) + 1})` : ""}`,
      startedAt: NOW - (10 + i) * 36e5,
      status: i % 7 === 5 ? "partial" as const : "completed" as const,
      hasSearchTree: searched,
      hasNodeTranscripts: !searched,
      branches: searched ? 9 + (i % 5) : 2 + (i % 3),
      winnerScore: searched ? 0.62 + ((i % 7) * 0.04) : null,
    };
  });
}

const MERGED_RUN: HeadRunView = {
  rootId: "root-merge-1",
  task: "Check every other call site that indexes rules by kind",
  rationale: "Three call sites, three readers — cheaper in parallel than in sequence.",
  status: "completed",
  spawnedAt: NOW - 52e5,
  heads: [
    {
      id: "root-merge-1-h0", parentId: null, depth: 1, task: "packages/checkout/src/apply-coupon.ts", rationale: "the reported 500",
      status: "completed", summary: "Two more reads of rules[kind]; both guarded by the same ?? inferKind fix.",
      errorMessage: null, usage: { input: 8_420, output: 610 }, wallClockMs: 14_200,
      spawnedAt: NOW - 52e5, lastStepAt: NOW - 51e5,
      decisions: [{ question: "Guard at the edge or at the reader?", choice: "at the reader", rationale: "the edge would still let a null through the cart serializer" }],
    },
    {
      id: "root-merge-1-h1", parentId: null, depth: 1, task: "packages/cart/src/serializer.ts", rationale: "the lazy path",
      status: "completed", summary: "One read, already null-safe — no change needed here.",
      errorMessage: null, usage: { input: 5_110, output: 240 }, wallClockMs: 9_800,
      spawnedAt: NOW - 52e5, lastStepAt: NOW - 515e4, decisions: [],
    },
    {
      id: "root-merge-1-h2", parentId: null, depth: 1, task: "packages/admin/src/coupon-report.ts", rationale: "the reporting path",
      status: "errored", summary: null,
      errorMessage: "the admin package is not checked out in this sandbox",
      usage: { input: 1_020, output: 0 }, wallClockMs: 2_100,
      spawnedAt: NOW - 52e5, lastStepAt: null, decisions: [],
    },
    {
      id: "root-merge-1-h3", parentId: null, depth: 1, task: "packages/checkout/src/pricing.ts", rationale: "the discount maths",
      status: "completed", summary: "Indexes by kind twice inside the percentage path; both reads are behind the same guard.",
      errorMessage: null, usage: { input: 6_240, output: 380 }, wallClockMs: 11_400,
      spawnedAt: NOW - 52e5, lastStepAt: NOW - 512e4, decisions: [],
    },
    {
      // CLOSED BY THE SETTLE, not left running. `HeadJournal.cacheMerge`
      // terminalizes every head still in flight in the same transition that
      // writes the synthesis, so a settled run cannot also be at work — never
      // the `settled · 1 running · 3 reported` this row would otherwise
      // photograph.
      id: "root-merge-1-h4", parentId: null, depth: 1, task: "packages/api/src/coupon-routes.ts", rationale: "the public surface",
      status: "aborted", summary: null,
      errorMessage: "no report at the synthesis: the run merged what had arrived, and this head "
        + "was still in flight when it did",
      usage: { input: 3_180, output: 90 }, wallClockMs: 4_600,
      spawnedAt: NOW - 52e5, lastStepAt: NOW - 51e5, decisions: [],
    },
  ],
  merge: {
    narrative: "Three real call sites left — apply-coupon.ts and both reads in pricing.ts — and the same ?? inferKind guard covers all of them. The cart serializer is already null-safe. The admin report could not be checked; that package is not in this sandbox. The API routes were still being walked when this merged, so they are unread.",
    headCount: 5, totalTokens: 24_820,
  },
};

/**
 * A RUN WHOSE LEASE OUTLIVED IT — the state behind *"this run had 2 reported and
 * rest stopped … still it says 'running'?"*.
 *
 * Two nodes reported, five stopped, nothing synthesised, and no node at work.
 * `read-models/fork-runs.ts` reports this as `partial` because the TREE decides
 * whether a search can still be entered, not the run's ledger row — which still
 * says `running`, over a tally in which nothing is.
 */
const STOPPED_RUN: HeadRunView = {
  rootId: "root-merge-0",
  task: "Audit the CLI surface",
  rationale: "Seven surfaces, one head each — the audit is per-command.",
  status: "aborted",
  spawnedAt: NOW - 9 * 36e5,
  heads: [
    swarmNode("root-merge-0-h0", "packages/cli/src/commands/run.ts", "the command every user reaches first", {
      summary: "Three flags are accepted and never read: `--json`, `--quiet`, `--no-color`.",
      wallClockMs: 21_400, spawnedAt: NOW - 9 * 36e5, lastStepAt: NOW - 88 * 36e4,
    }),
    swarmNode("root-merge-0-h1", "packages/cli/src/commands/login.ts", "the credential path", {
      summary: "The token is written before the scope check, so a rejected scope still leaves a file.",
      wallClockMs: 18_900, spawnedAt: NOW - 9 * 36e5, lastStepAt: NOW - 87 * 36e4,
    }),
    swarmNode("root-merge-0-h2", "packages/cli/src/commands/logs.ts", "the streaming path", {
      status: "aborted", wallClockMs: 6_100, spawnedAt: NOW - 9 * 36e5, lastStepAt: NOW - 86 * 36e4,
      errorMessage: "The workspace was evicted while this head was reading the follow loop.",
    }),
    swarmNode("root-merge-0-h3", "packages/cli/src/commands/deploy.ts", "the release path", {
      status: "aborted", wallClockMs: 5_800, spawnedAt: NOW - 9 * 36e5, lastStepAt: NOW - 86 * 36e4,
      errorMessage: "The workspace was evicted while this head was reading the release gate.",
    }),
    swarmNode("root-merge-0-h4", "packages/cli/src/commands/agents.ts", "the fan-out path", {
      status: "aborted", wallClockMs: 4_300, spawnedAt: NOW - 9 * 36e5, lastStepAt: NOW - 86 * 36e4,
      errorMessage: "The workspace was evicted while this head was listing subordinates.",
    }),
    swarmNode("root-merge-0-h5", "packages/cli/src/commands/files.ts", "the drive path", {
      status: "errored", wallClockMs: 3_100, spawnedAt: NOW - 9 * 36e5, lastStepAt: null,
      errorMessage: "No home could be provisioned for this head after the eviction.",
    }),
    swarmNode("root-merge-0-h6", "packages/cli/src/commands/config.ts", "the settings path", {
      status: "errored", wallClockMs: 2_400, spawnedAt: NOW - 9 * 36e5, lastStepAt: null,
      errorMessage: "No home could be provisioned for this head after the eviction.",
    }),
  ],
  merge: null,
};


/**
 * The six things a node panel can be showing, as `getNodeTranscript` answers.
 *
 * Five are here because the frame is where the claim that they read differently
 * is checked, ONE blank pane for all of them being the failure it catches: a
 * head that worked and reported, a head still working with a partial trace, a
 * head that died having recorded nothing, a rollout that has no trace by
 * construction, and a node neither store holds (the `null` below).
 *
 * The sixth is a mid-turn branch, keyed by the head id `branchHeadId` derives
 * from a run id — the chat chip's view of the same read, and one head deep, so
 * its search path has no ancestor to offer.
 */
const TRANSCRIPTS = {
  "root-merge-1-h0": {
    origin: "head", runId: "root-merge-1", nodeId: "root-merge-1-h0",
    task: "Audit packages/checkout/src/apply-coupon.ts for every read of rules[kind], and decide whether the ?? inferKind guard belongs at the request edge or at each reader. The reported 500 comes through /api/cart/apply with a percentage coupon created after Tuesday's migration, whose kind column is null.",
    rationale: "the reported 500",
    status: "completed",
    spawnedAt: NOW - 52e5, lastStepAt: NOW - 51e5, wallClockMs: 14_200,
    usage: { input: 8_420, output: 610 },
    steps: { status: "end", items: [
      {
        text: "Reading the handler and both of its callers before changing anything.",
        reasoning: "The 500 is a dereference of `rules[kind]` where kind is null, so the fix has to sit where the dereference is — not where the value was created. That means I need every reader, not just the one in the stack trace.",
        toolCalls: [
          { name: "file", input: { action: "read", path: "packages/checkout/src/apply-coupon.ts" }, output: "export function applyCoupon(cart: Cart, coupon: Coupon) {\n  const rule = rules[coupon.kind];\n  return rule.apply(cart, coupon);\n}" },
          { name: "grep", input: { pattern: "rules\\[", path: "packages/checkout" }, output: "apply-coupon.ts:14\napply-coupon.ts:31\nvalidate.ts:9" },
        ],
      },
      {
        text: "Three readers, one shape. `validate.ts:9` already guards; the two in `apply-coupon.ts` do not.",
        toolCalls: [
          { name: "file", input: { action: "read", path: "packages/checkout/src/validate.ts" }, output: "const rule = rules[coupon.kind ?? inferKind(coupon)];" },
        ],
      },
      {
        text: "Guarding at the reader, and proving it with the suite.",
        reasoning: "Guarding at the edge would still let a null through the cart serializer, which reads the same table on the lazy path.",
        toolCalls: [
          { name: "file", input: { action: "edit", path: "packages/checkout/src/apply-coupon.ts" }, output: "2 hunks applied" },
          { name: "shell", input: { command: "bun test packages/checkout" }, output: "42 pass\n0 fail\nRan 42 tests across 6 files. [1.21s]" },
        ],
      },
    ] },
    stepCount: 3,
    toolCount: 5,
    answer: "Two more reads of `rules[kind]` in `apply-coupon.ts`, both fixed by the same `?? inferKind(coupon)` guard already used in `validate.ts:9`.\n\nGuarding at the **reader** rather than the request edge, because the cart serializer reads the same table on the lazy path and an edge guard would still let a null reach it. `bun test packages/checkout` is green (42 pass).",
    decisions: [{
      question: "Guard at the edge or at the reader?",
      choice: "at the reader",
      rationale: "the edge would still let a null through the cart serializer",
    }],
    errorMessage: null,
    path: [
      { id: "root-merge-1", label: "Check every other call site that indexes rules by kind", depth: 0, status: "completed" },
      { id: "root-merge-1-h0", label: "packages/checkout/src/apply-coupon.ts", depth: 1, status: "completed" },
    ],
    codeUsed: null,
  },
  "root-merge-1-h1": {
    origin: "head", runId: "root-merge-1", nodeId: "root-merge-1-h1",
    task: "Check packages/cart/src/serializer.ts — the lazy path that reads the same rules table.",
    rationale: "the lazy path", status: "running",
    spawnedAt: NOW - 42e3, lastStepAt: NOW - 9e3, wallClockMs: 0,
    usage: { input: 5_110 },
    steps: { status: "end", items: [{
      text: "Opening the serializer.",
      reasoning: "If this path already optional-chains, the guard belongs only in apply-coupon.",
      toolCalls: [{ name: "file", input: { action: "read", path: "packages/cart/src/serializer.ts" }, output: "const rule = rules[coupon.kind]?.serialize;" }],
    }] },
    stepCount: 1,
    toolCount: 1,
    answer: null, decisions: [], errorMessage: null,
    path: [
      { id: "root-merge-1", label: "Check every other call site that indexes rules by kind", depth: 0, status: "running" },
      { id: "root-merge-1-h1", label: "packages/cart/src/serializer.ts", depth: 1, status: "running" },
    ],
    codeUsed: null,
  },
  "root-merge-1-h2": {
    origin: "head", runId: "root-merge-1", nodeId: "root-merge-1-h2",
    task: "Check packages/admin/src/coupon-report.ts — the reporting path.",
    rationale: "the reporting path", status: "errored",
    spawnedAt: NOW - 52e5, lastStepAt: null, wallClockMs: 2_100,
    usage: { input: 1_020 },
    steps: { status: "end", items: [] }, stepCount: 0, toolCount: 0, answer: null, decisions: [],
    errorMessage: "the admin package is not checked out in this sandbox",
    path: [
      { id: "root-merge-1", label: "Check every other call site that indexes rules by kind", depth: 0, status: "completed" },
      { id: "root-merge-1-h2", label: "packages/admin/src/coupon-report.ts", depth: 1, status: "errored" },
    ],
    codeUsed: null,
  },
  // A competed branch: one proposal, scored against its siblings, no tool loop.
  // Its `observation` IS the whole output — which is why the trace pane says so
  // instead of looking like a head whose steps went missing.
  n003: {
    origin: "rollout", runId: "n000", nodeId: "n003",
    task: "Find why the SAVE20 coupon 500s",
    rationale: "", status: "terminal",
    spawnedAt: NOW - 34e5, lastStepAt: null, wallClockMs: 0, usage: {},
    steps: { status: "end", items: [] }, stepCount: 0, toolCount: 0,
    answer: "The percentage branch indexes `rules[coupon.kind]` and Tuesday's migration left `kind` null on every coupon created after it, so the lookup returns undefined and `.apply` throws. Guard the read with `?? inferKind(coupon)` — the shape `validate.ts` already uses — rather than backfilling the column, which would need a migration window the checkout path cannot take.",
    decisions: [], errorMessage: null,
    path: [
      { id: "n000", label: "Find why the SAVE20 coupon 500s", depth: 0, status: "open" },
      { id: "n001", label: "Look at the coupon rules table", depth: 1, status: "open" },
      { id: "n003", label: "Guard the kind lookup at the reader", depth: 2, status: "terminal" },
    ],
    codeUsed: "const rule = rules[coupon.kind ?? inferKind(coupon)];\nif (!rule) throw new BadCoupon(coupon.code);\nreturn rule.apply(cart, coupon);",
  },
  // A Steer-as-Branch run: one head, its id derived from the run id, opened from
  // the chat chip rather than from a canvas selection.
  "steer-b7f21-head": {
    origin: "head", runId: "steer-b7f21", nodeId: "steer-b7f21-head",
    task: "Actually, check the staging snapshot first — I don't think the migration ran there.",
    rationale: "mid-turn redirect",
    status: "completed",
    spawnedAt: NOW - 9e5, lastStepAt: NOW - 84e4, wallClockMs: 61_400,
    usage: { input: 5_140, output: 380 },
    steps: { status: "end", items: [
      {
        text: "Checking whether Tuesday's migration reached staging at all.",
        reasoning: "If staging never ran it, the null `kind` column there proves nothing about production and the whole comparison is off.",
        toolCalls: [
          { name: "shell", input: { command: "./scripts/migrations.sh status --env staging" }, output: "0007_coupon_kind.sql  applied 2026-08-11" },
        ],
      },
      {
        text: "It did run, on the 11th. The snapshot is comparable after all.",
        toolCalls: [],
      },
    ] },
    stepCount: 2,
    toolCount: 1,
    answer: "Staging applied `0007_coupon_kind.sql` on 2026-08-11, so its null `kind` rows predate the migration exactly as production's do — the snapshot is a fair reproduction and the guard is still the right fix.",
    decisions: [], errorMessage: null,
    path: [
      { id: "steer-b7f21-head", label: "Check the staging snapshot first", depth: 0, status: "completed" },
    ],
    codeUsed: null,
  },
  // Two nodes of the LIVE run: one that reported and one still working. Both are
  // reachable from the run pane's node list, which is the path the previous
  // fixture set had no entry for — a real node opened to "this branch is no
  // longer in the run".
  lv001: {
    origin: "head", runId: "lv000", nodeId: "lv001",
    task: "Walk the cart serializer's null path: every read of coupon.kind in packages/cart/src, and for each one say whether a null kind can reach it and what the caller sees when it does.",
    rationale: "expansion 1 of 5",
    status: "completed",
    spawnedAt: NOW - 40e4, lastStepAt: NOW - 30e4, wallClockMs: 118_000,
    usage: { input: 9_180, output: 720 },
    steps: { status: "end", items: [
      {
        text: "Listing the readers before I judge any of them.",
        reasoning: "The task names one file but the serializer re-exports from two others, so grepping the package is cheaper than reading it and less likely to miss a caller.",
        toolCalls: [
          {
            name: "shell",
            input: { command: "rg -n 'coupon\\.kind|rules\\[' packages/cart/src" },
            output: "src/serializer.ts:88:  const rule = rules[coupon.kind];\nsrc/serializer.ts:141:  if (coupon.kind === 'fixed') {\nsrc/totals.ts:52:  const pct = rules[coupon.kind].percent;",
          },
        ],
      },
      {
        text: "Three reads, two of them unguarded. `serializer.ts:141` compares rather than indexes, so a null kind takes the else branch and is fine.",
        toolCalls: [
          {
            name: "read",
            input: { path: "packages/cart/src/serializer.ts", offset: 80, limit: 20 },
            output: "  const rule = rules[coupon.kind];\n  return { ...line, discount: rule.apply(line.subtotal) };",
          },
        ],
      },
      {
        text: "Confirmed. `rule` is undefined for a null kind and `.apply` throws before anything is returned to the caller.",
        toolCalls: [],
      },
    ] },
    stepCount: 3,
    toolCount: 2,
    answer: "`serializeCart` reads `rules[coupon.kind].percent` with no guard — it throws on every percentage coupon written before the migration. `totals.ts:52` has the same shape. `serializer.ts:141` compares instead of indexing and is safe. The guard belongs at both reads, spelled the way `validate.ts` already spells it: `rules[coupon.kind ?? inferKind(coupon)]`.",
    decisions: [], errorMessage: null,
    path: [
      { id: "lv000", label: "Audit every reader of coupon.kind", depth: 0, status: "running" },
      { id: "lv001", label: "Walk the cart serializer's null path", depth: 1, status: "completed" },
    ],
    codeUsed: null,
  },
  lv003: {
    origin: "head", runId: "lv000", nodeId: "lv003",
    task: "Trace the pricing refactor's readers: which of them index rules by kind, and did the refactor introduce or remove a guard.",
    rationale: "expansion 3 of 5",
    status: "running",
    spawnedAt: NOW - 40e4, lastStepAt: NOW - 4e3, wallClockMs: 0,
    usage: { input: 4_260, output: 190 },
    steps: { status: "end", items: [
      {
        text: "Finding the refactor first — the guard may have moved rather than gone.",
        reasoning: "A read that lost its guard and a read that never had one need different fixes, and only the history tells them apart.",
        toolCalls: [
          {
            name: "shell",
            input: { command: "git log --oneline -S'rules[' -- packages/pricing/src" },
            output: "8c1f20a1 refactor(pricing): one rate table, read through a resolver",
          },
        ],
      },
      {
        // No output: the call this node is in the middle of, which the chat draws
        // as still running.
        text: "Reading that commit.",
        toolCalls: [
          { name: "shell", input: { command: "git show 8c1f20a1 --stat" } },
        ],
      },
    ] },
    stepCount: 2,
    toolCount: 2,
    answer: null,
    decisions: [], errorMessage: null,
    path: [
      { id: "lv000", label: "Audit every reader of coupon.kind", depth: 0, status: "running" },
      { id: "lv003", label: "Trace the pricing refactor's readers", depth: 1, status: "running" },
    ],
    codeUsed: null,
  },
} satisfies Record<string, NodeTranscriptView>;

/** Looked up by an arbitrary node id off the wire, which is what a Map is for. */
const TRANSCRIPT_BY_NODE = new Map<string, NodeTranscriptView>(Object.entries(TRANSCRIPTS));

/**
 * Agent → Evolution reads three shapes that are NOT arrays, so stubRpc's
 * blanket `[]` for a `get*` is a lie the components then dereference — the
 * same trap `getMctsNodeDetail` fell into. Real shapes, populated, so the frame
 * photographs the panels rather than their empty states.
 */
const REPLAY_EVALS = [
  { id: "rev_3", ranAt: NOW - 2 * 864e5, sampleSize: 24, acceptedCount: 19, negativeCount: 5, meanScore: 0.79, loss: 0.21, scaffoldVersion: 7, interval: { lo: 0.64, hi: 0.89, n: 24 } },
  { id: "rev_2", ranAt: NOW - 9 * 864e5, sampleSize: 21, acceptedCount: 14, negativeCount: 7, meanScore: 0.67, loss: 0.33, scaffoldVersion: 6, interval: { lo: 0.51, hi: 0.80, n: 21 } },
  { id: "rev_1", ranAt: NOW - 17 * 864e5, sampleSize: 18, acceptedCount: 10, negativeCount: 8, meanScore: 0.55, loss: 0.45, scaffoldVersion: 6, interval: { lo: 0.39, hi: 0.71, n: 18 } },
];

const ALIGNMENT = {
  segments: [
    { scaffoldVersion: 6, firstAt: NOW - 20 * 864e5, turns: 62, abandoned: 3, rate: { per100: 14.5, lowPer100: 8.1, highPer100: 24.4, reliable: true } },
    { scaffoldVersion: 7, firstAt: NOW - 6 * 864e5, turns: 41, abandoned: 1, rate: { per100: 7.3, lowPer100: 2.8, highPer100: 17.6, reliable: true } },
  ],
  overall: { turns: 103, abandoned: 4, rate: { per100: 11.7, lowPer100: 7.0, highPer100: 18.9, reliable: true } },
  trend: "improving",
  deltaPer100: -7.2,
  comparedVersions: { from: 6, to: 7 },
  note: "Corrections per 100 graded turns, from the turn-outcomes ledger alone — no benchmark and no judge.",
};

const CALIBRATION = {
  universe: 103, labeled: 0, unclear: 0, orphaned: 0, labelers: [], lastLabeledAt: null,
  strata: [], accuracy: null, kappa: null, overall: null, segments: [],
  gap: { kind: "no_labels", labeled: 0, needed: 100 },
};

const GEPA_RUNS = [
  { runId: "gepa_2", target: "scaffold", startedAt: NOW - 3 * 864e5, status: "completed", winnerId: "cand_2b", iterations: 6, metricCalls: 48 },
  { runId: "gepa_1", target: "scaffold", startedAt: NOW - 12 * 864e5, status: "completed", winnerId: "cand_1c", iterations: 4, metricCalls: 32 },
];

const GEPA_DETAIL = {
  run: GEPA_RUNS[0],
  candidates: [
    { id: "cand_2a", parentId: null, aggregateScore: 0.61, scores: { i1: 0.6, i2: 0.55, i3: 0.68 }, createdAt: NOW - 3 * 864e5 },
    { id: "cand_2b", parentId: "cand_2a", aggregateScore: 0.78, scores: { i1: 0.81, i2: 0.72, i3: 0.81 }, createdAt: NOW - 3 * 864e5 },
    { id: "cand_2c", parentId: "cand_2a", aggregateScore: 0.44, scores: { i1: 0.4, i2: 0.51, i3: 0.41 }, createdAt: NOW - 3 * 864e5 },
  ],
  pareto: [{ candidateId: "cand_2b", instanceId: "i1", score: 0.81 }, { candidateId: "cand_2a", instanceId: "i3", score: 0.68 }],
};

const evolutionRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (method === "getReplayEvals") return rpcResult(REPLAY_EVALS).json<T>();

  if (method === "getAlignmentConvergence") return rpcResult(ALIGNMENT).json<T>();

  if (method === "getOutcomeCalibration") return rpcResult(CALIBRATION).json<T>();

  if (method === "getGepaRuns") return rpcResult(GEPA_RUNS).json<T>();

  if (method === "getGepaRun") return rpcResult(GEPA_DETAIL).json<T>();

  // The world model the Agent surface photographs: keyed facts with the
  // source and timestamp the rows carry, so the frame shows what the card
  // shows them from.
  if (method === "getFacts") return rpcResult([
    { key: "test.command", value: "bun test", confidence: 0.9, source: "project configuration", lastObservedAt: NOW - 50e5 },
    { key: "checkout.coupon_kind", value: "nullable since Tuesday", confidence: 1, source: "migration 0042", lastObservedAt: NOW - 26e5 },
  ]).json<T>();

  return stubRpc<T>(method, args);
};

/**
 * Dispatch parameters for the forks that still have them recorded.
 *
 * Two runs of the SAME task under different policies are in here on purpose:
 * that is the pair the owner could not tell apart, and the frame is where the
 * claim that they now read differently is checked. The older forks have none —
 * the ledger prunes settled rows after a day while the trees stay forever, so
 * "parameters no longer recorded" is the normal state of a week-old fork and the
 * frame photographs it rather than pretending otherwise.
 */
const FORK_PARAMS: ForkRunParams[] = [
  {
    rootId: "n000",
    search: {
      budget: 24, branches: 4, maxDepth: 6, explorationWeight: 1.41,
      // A CLAMPED ensemble, deliberately: `judgeSamples` shares its call pool with
      // check generation, so this run asked for twenty and was observed running
      // three. It is the longest value the parameter list renders, which is the one
      // worth photographing.
      judgeSamplesRequested: 20, judgeSamplesRealised: 3, mode: "build",
    },
    transcripts: null,
  },
  {
    rootId: "root-merge-1",
    search: null,
    transcripts: { mergeStrategy: "synthesize", branches: 3 },
  },
  {
    rootId: "root-merge-0",
    search: null,
    transcripts: { mergeStrategy: "best_of", branches: 2 },
  },
  {
    // The live run's own parameters, so the disclosure has both halves to show on
    // the run a reader is most likely to open: what the preset resolved AND what
    // the call was dispatched with.
    rootId: "lv000",
    search: {
      budget: 12, branches: 5, maxDepth: 2, explorationWeight: 1.41,
      judgeSamplesRequested: null, judgeSamplesRealised: null, mode: "build",
    },
    transcripts: null,
  },
];

/** Every store's rows for one run, keyed by the run's root id — the same key the
 *  read model composes on, so a fixture cannot pair one run's tree with another's
 *  journal. */
const SEARCH_ROWS_BY_ROOT: ReadonlyMap<string, readonly MctsRow[]> = new Map([
  ["n000", MCTS_ROWS],
  ["sw000", SWARM_ROWS],
  ["pv000", PROVE_ROWS],
  ["rf000", REFUSED_ROWS],
  ["lv000", RUNNING_ROWS],
]);

const JOURNAL_BY_ROOT: ReadonlyMap<string, HeadRunView> = new Map(
  [MERGED_RUN, SWARM_RUN, PROVE_RUN, REFUSED_RUN, RUNNING_RUN, STOPPED_RUN]
    .map((run) => [run.rootId, run]),
);

/**
 * The canvas as the server composes it: ONE ROW PER RUN, each carrying its own
 * parameters and every half it has — the search rows where the engine wrote any,
 * the journalled nodes where it wrote those. Not parallel collections keyed by root
 * id, and not a separately bounded head-runs read: either shape is what let the
 * trees and the run list beside them disagree.
 *
 * A swarm search has BOTH halves, which is why neither is chosen by a tag: its tree
 * is in `search_nodes` and the reason each of its nodes exists is in `head_journal`,
 * and a surface holding one of those cannot say which node fanned a level in.
 */
const CANVAS_ROWS: readonly ExplorationCanvasRun[] = FORK_RUNS.map((run) => ({
  run,
  params: FORK_PARAMS.find((entry) => entry.rootId === run.id) ?? null,
  tree: (SEARCH_ROWS_BY_ROOT.get(run.id) ?? []).map((row) => asSearchNode(row, run.id)),
  head: JOURNAL_BY_ROOT.get(run.id) ?? null,
  // The gallery stub never records complete Pareto evidence; the server says so.
  frontier: null,
}));

/** The generator writes the CLIENT's loose row shape, which is what the socket
 *  broadcast and `getSearchTree` really deliver. This stub is standing in for the
 *  server, so the canvas payload has to be the server's row — every column
 *  present, including the ones a partial row leaves out. */
function asSearchNode(row: MctsRow, rootId: string): SearchNode {
  return {
    id: row.id,
    parent_id: row.parent_id,
    root_id: rootId,
    task: row.task ?? "",
    action: row.action,
    observation: row.observation ?? "",
    code_used: row.code_used ?? null,
    code_language: row.code_used ? "typescript" : null,
    visits: row.visits,
    value: row.value,
    depth: row.depth,
    // `running` is a merged-HEAD status; the search_nodes CHECK constraint
    // cannot hold it, so a row claiming it is not a row the server could serve.
    status: row.status === "running" ? "open" : row.status,
    msg_id: row.msg_id ?? null,
    branch_agent_key: row.branch_agent_key ?? null,
    evaluation_json: null,
    created_at: row.created_at ?? NOW,
  };
}

/**
 * Pages the fixture the way the read model pages storage, through the same
 * `seekPage`, so the frame exercises the real walk rather than one hand-made
 * page. The anchor here is the bare fork id where the server's is composite:
 * that difference is deliberate and safe, because `after` is documented opaque
 * and a client only ever echoes it back — a stub standing in for the server may
 * choose any format it can resolve.
 */
function canvasPage(rows: readonly ExplorationCanvasRun[], args: unknown[] | undefined): Page<ExplorationCanvasRun> {
  const request = v.parse(GalleryPageRequestSchema, args?.[0] ?? {});
  const limit = request.limit ?? 30;
  const after = request.cursor?.after;
  const start = after === undefined ? 0 : rows.findIndex((entry) => entry.run.id === after) + 1;

  return seekPage(rows.slice(start, start + limit + 1), limit, (entry) => entry.run.id);
}

const GalleryPageRequestSchema: v.GenericSchema<PageRequest> = v.object({
  cursor: v.optional(v.object({ after: v.string() })),
  limit: v.optional(v.number()),
});

/**
 * The exploration reads whose answer is NOT an array, answered from the fixture
 * stores — and the one place both transports resolve them.
 *
 * Column C is handed an `Rpc` directly; the full-screen explorer reads through the
 * agent socket. A fixture that answered one and let the other fall through to the
 * blanket `[]` is not a smaller version of the same thing: `getHeadRun` answering
 * `[]` is truthy, and `headRunToTree` then read `[].heads` and took the page to a
 * blank body. Every read that can answer null or a record is listed here.
 */
const EXPLORATION_READS = new Set([
  "getExplorationCanvas", "listForkRuns", "getForkRun", "getSearchTree", "getHeadRun",
  "getMctsNodeDetail", "getNodeTranscript",
]);

/** Everything an exploration read can answer with. Named rather than `unknown`,
 *  because a stub that widened its own answers could serve a value the real read
 *  models cannot produce — which is the entire failure mode of a fixture. */
type ExplorationAnswer =
  | Page<ExplorationCanvasRun>
  | Page<ForkRunSummary>
  | ExplorationCanvasRun
  | readonly MctsRow[]
  | HeadRunView
  | NodeTranscriptView
  | null;

function explorationRead(
  method: string, args: readonly unknown[], rows: readonly ExplorationCanvasRun[] = CANVAS_ROWS,
): ExplorationAnswer {
  const mutable = [...args];

  if (method === "getExplorationCanvas") return canvasPage(rows, mutable);

  if (method === "listForkRuns") {
    const page = canvasPage(rows, mutable);

    return { ...page, items: page.items.map((entry) => entry.run) };
  }

  // The COMPOSED row, which is what `orchestrator.getForkRun` answers. This
  // served a bare `ForkRunSummary` — a shape the read model cannot produce —
  // and the client, reading `entry.run` off it, threw on the first
  // revalidation. Every frame that opens the full-screen explorer rendered a
  // blank body because of this one line.
  if (method === "getForkRun") return rows.find((entry) => entry.run.id === args[0]) ?? null;

  if (method === "getSearchTree") return SEARCH_ROWS_BY_ROOT.get(String(args[0])) ?? [];

  if (method === "getHeadRun") return JOURNAL_BY_ROOT.get(String(args[0])) ?? null;

  // A retired node the server no longer details, and a node NEITHER store holds:
  // both answer null, and the panel must not render either as "recorded nothing".
  if (method === "getMctsNodeDetail") return null;

  return TRANSCRIPT_BY_NODE.get(String(args[1])) ?? null;
}

const forkRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (EXPLORATION_READS.has(method)) return rpcResult(v.parse(JsonValueSchema, explorationRead(method, args ?? []))).json<T>();

  return stubRpc<T>(method, args);
};

/**
 * One frame each, focused on the state it exists to photograph.
 *
 * The surface focuses `runs[0]` on arrival, so a frame chooses its subject by
 * putting that run first. Selected by ROOT ID rather than by slicing an index:
 * `forkmerge` used `slice(1)` and therefore silently re-aimed at whatever row
 * happened to be second once this list grew.
 */
function forkRpcOver(rows: readonly ExplorationCanvasRun[]): Rpc {
  return async <T,>(method: string, args?: unknown[]): Promise<T> =>
    EXPLORATION_READS.has(method)
      ? rpcResult(v.parse(JsonValueSchema, explorationRead(method, args ?? [], rows))).json<T>()
      : stubRpc<T>(method, args);
}

function focusRun(rootId: string, rows: readonly ExplorationCanvasRun[] = CANVAS_ROWS): Rpc {
  const wanted = rows.filter((entry) => entry.run.id === rootId);

  return forkRpcOver([...wanted, ...rows.filter((entry) => entry.run.id !== rootId)]);
}

/** The same surface on a run with NO search tree — a journalled run is a tree at
 *  depth 1, and every score encoding has to be absent rather than drawn from a zero
 *  no branch earned. This frame is where that claim is checked. */
const mergeFirstRpc = focusRun(
  MERGED_RUN.rootId,
  CANVAS_ROWS.filter((entry) => entry.tree.length === 0),
);

/** A swarm search under a named preset: the resolved tuple, and `settle` derived
 *  from two of its axes rather than chosen. */
const provePresetRpc = focusRun("pv000");

/** A `custom` composition that FANS IN. No named preset resolves to
 *  `expand:'aggregate'`, so this state is necessarily a composition — which is also
 *  why its axes are not recoverable and the panel says so. */
const swarmFanInRpc = focusRun("sw000");

/** A search that started and reached nothing. Never an empty tree: a refusal. */
const refusedRunRpc = focusRun("rf000");

/**
 * A swarm in flight, with its nodes in every state at once — the run the owner
 * kept being shown as a `running` label over a lone root.
 *
 * Focused, so the frame opens on it rather than on whichever run happens to be
 * newest, and the settled runs stay in the list underneath because the comparison
 * between a live search and a finished one is the point.
 */
const runningSwarmRpc = focusRun("lv000");

/**
 * The run whose lease outlived it: two nodes reported, five stopped, none at
 * work. What the surface has to say about it is *stopped*, never `running` over
 * a tally in which nothing is running — that contradiction is the one the report
 * named. The read model settles the word (`read-models/fork-runs.ts`); this
 * frame is where the row, the dot and the node list are read together.
 */
const stoppedRunRpc = focusRun("root-merge-0");

/** The `head_activity` counters for the live run's working nodes — the push that
 *  makes a node pulse on the canvas and in the run's node list. A settled node
 *  announces nothing, which is correct: it is not moving. */
const RUNNING_ACTIVITY: ReadonlyMap<string, number> = new Map(
  RUNNING_RUN.heads.filter((head) => head.status === "running").map((head) => [head.id, 3]),
);

/* ── one search, as it happens ──────────────────────────────────── */

/**
 * The five states a live search passes through, as five READABLE stages.
 *
 * Liveness is the one property this gallery could not photograph. A frame is a
 * moment, and "the tree grew without a refresh" is a pair of moments — so a
 * frame that animated on a timer would be a frame a test has to race, and every
 * assertion about it would be about the clock.
 *
 * So the stage is a PARAMETER: `?frame=forklive&stage=2` renders the search
 * exactly two beats in, deterministically, and a browser gate walks the stages
 * in one page and asserts what changed between them. With no `stage` the frame
 * advances itself, which is the version a person watches.
 *
 * The tree is the real 106-node fixture, revealed a prefix at a time, rather
 * than a second tree invented for this frame: a live search IS the same rows
 * arriving in order, and a fixture that grew differently from the one every
 * other fork frame photographs would be a fixture testing itself.
 */
const LIVE_STAGE_ROWS = [0, 1, 4, 12, MCTS_ROWS.length] as const;

const LIVE_STAGES = LIVE_STAGE_ROWS.length;

/** The run row as the ledger holds it at `stage` — the fact the list renders,
 *  and the one that decides whether the surface polls fast or idles. */
function liveRun(stage: number): ForkRunSummary {
  const rows = LIVE_STAGE_ROWS[Math.min(stage, LIVE_STAGES - 1)] ?? 0;
  const settled = stage >= LIVE_STAGES - 1;

  return {
    id: "live000",
    name: "SAVE20 500s",
    task: "Find why the SAVE20 coupon 500s",
    startedAt: NOW - 3e4,
    status: settled ? "completed" : "running",
    hasSearchTree: true,
    hasNodeTranscripts: true,
    branches: Math.max(0, rows - 1),
    winnerScore: settled ? 0.91 : null,
  };
}

/** The canvas row for `stage`: the run, its parameters, and the prefix of its
 *  tree that has landed so far. Stage 0 has no ledger row and exercises
 *  liveness before the first canvas row arrives. It covers the fifteen-second
 *  missing-row failure case; working nodes must not be presented as absent
 *  work during that interval. */
function liveCanvasRows(stage: number): readonly ExplorationCanvasRun[] {
  if (stage <= 0) return [];
  const rows = LIVE_STAGE_ROWS[Math.min(stage, LIVE_STAGES - 1)] ?? 0;

  return [{
    run: liveRun(stage),
    params: FORK_PARAMS.find((entry) => entry.rootId === "n000") ?? null,
    tree: MCTS_ROWS.slice(0, rows).map((row) => asSearchNode(row, "live000")),
    head: null,
    frontier: null,
  }];
}

/** What the `head_activity` broadcast has told the client by `stage`: one tick
 *  per node that has written to its journal. The newest nodes are the ones the
 *  picture marks as working, which is the whole point of the channel. */
function liveActivity(stage: number): ReadonlyMap<string, number> {
  const rows = LIVE_STAGE_ROWS[Math.min(stage, LIVE_STAGES - 1)] ?? 0;
  const ticks = new Map<string, number>();

  for (const row of MCTS_ROWS.slice(0, rows)) ticks.set(row.id, stage);

  return ticks;
}

/**
 * One transport for the whole run, answering whatever stage is current.
 *
 * STABLE, and that is not a detail. `useAsyncResource` keys its load effect on
 * the `rpc` identity, so an rpc rebuilt per stage would reload the run list at
 * every beat and the frame would appear to be live for a reason the product does
 * not have. In the app the transport is one socket and the DATA changes
 * underneath it, so the fixture reads its stage from a ref at call time.
 */
function liveRpcOver(stageRef: { readonly current: number }): Rpc {
  return async <T,>(method: string, args?: unknown[]): Promise<T> => {
    const rows = liveCanvasRows(stageRef.current);

    if (method === "getSearchTree") return rpcResult(v.parse(JsonValueSchema, rows[0]?.tree ?? [])).json<T>();

    return EXPLORATION_READS.has(method)
      ? rpcResult(v.parse(JsonValueSchema, explorationRead(method, args ?? [], rows))).json<T>()
      : stubRpc<T>(method, args);
  };
}

/**
 * The beat `?stage=N` pins, clamped to the stages that exist. A query with no
 * `stage` — or one that is not a number — pins nothing, and `ForkLiveFrame`
 * then advances itself; see it for why liveness needs both.
 */
function pinnedLiveStage(search: string): number | null {
  const asked = new URLSearchParams(search).get("stage");
  const wanted = asked === null ? Number.NaN : Number(asked);

  return Number.isFinite(wanted) ? Math.max(0, Math.min(LIVE_STAGES - 1, wanted)) : null;
}

/**
 * The Exploration surface over a search that is happening.
 *
 * Advances itself when the frame asked for no particular stage, so the thing a
 * person opens actually moves; pinned when it did, so the thing a gate opens
 * cannot move under it.
 */
function ForkLiveFrame({ pinned }: { pinned: number | null }) {
  const [stage, setStage] = useState(pinned ?? 0);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const rpc = useMemo(() => liveRpcOver(stageRef), []);
  const activity = useMemo(() => liveActivity(stage), [stage]);
  useEffect(() => {
    if (pinned !== null) return;

    const id = setInterval(
      () => setStage((current) => (current + 1) % LIVE_STAGES),
      1_800,
    );

    return () => clearInterval(id);
  }, [pinned]);

  return (
    <div data-live-stage={stage} className="contents">
      <Shell surface="Swarms" rpc={rpc} headActivity={activity} backgroundJobs={[]} />
    </div>
  );
}

/* ── Compositions (markup mirrors WorkspacePage) ────────────────── */

/* The one identity row, as the app renders it — the real component, not a
   copy of it: the whole point of the row is that there is exactly one. */
function GalleryWorkspaceBar({ providerWait }: { providerWait?: { provider: string; waitMs: number } | null }) {
  return (
    <WorkspaceBar
      title="Checkout coupon bug"
      onRename={async (name) => name}
      connectionStatus="connected"
      working
      providerWait={providerWait ?? null}
      altitude="run"
      onAltitude={() => {}}
    />
  );
}

/* The chat column's only chrome: the tab strip, carrying the controls that act
   on the conversation it has open. Clearing is one of them, and like the app
   it is absent until there is a transcript to clear. */
function GalleryChatTabs({ clearable = true }: { clearable?: boolean }) {
  return (
    <SubordinateTabs
      workspace="checkout-fixes" subordinates={SUBORDINATES} activeName={undefined}
      onCreate={async () => {}} creating={false} onDismiss={async () => {}} onRename={async (_name, displayName) => displayName}
      trailing={clearable && <Button variant="ghost" {...SQUARE_BUTTON_PROPS} size="sm" icon={<TrashIcon size={12} />} aria-label="Clear history" />}
    />
  );
}

/* The live-data failure the owner reported, as a status row. Shared so the wide
   and narrow frames photograph the same affordance rather than two of them. */
const MCTS_NOTICE: readonly ComposerNotice[] = [{
  id: "mcts",
  tone: "danger",
  text: "Could not refresh MCTS.",
  action: { label: "Retry", onClick: () => {} },
}];

/* The composer, as the app renders it — the real component. This was a
   hand-copy, and it had drifted: no mode control, no model selector and no
   status row, so the gallery photographed a composer the product does not have.
   `notices` is a parameter because the status treatment is a thing to review.

   The draft, the mode and the model are real state rather than no-op handlers:
   a gallery whose controls do not move cannot tell you whether they work, which
   is the whole failure this harness exists to catch. */
function GalleryComposer({ notices = [] }: { notices?: readonly ComposerNotice[] }) {
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<ChatMode>("build");
  const [model, setModel] = useState("anthropic/claude-opus-4");

  return (
    <div className="border-t p-border p-sidebar">
      <Composer
        value={value}
        onValueChange={setValue}
        onSend={() => setValue("")}
        onStop={() => {}}
        placeholder="Send a message..."
        disabled={false}
        liveness={IDLE_TURN}
        mode={{ value: mode, onChange: setMode, locked: false }}
        attachments={{ parts: [], onAdd: () => {}, onRemove: () => {} }}
        modelPicker={<ModelPicker models={MODEL_STUBS()} value={model} onChange={setModel} size="xs" />}
        notices={notices}
      />
    </div>
  );
}

function ChatMessages() {
  // The workspace page's feedback path, stubbed at the seam the test reads:
  // the dataset is the write's record, the map its visible result.
  const [feedback, setFeedback] = useState<Record<string, 'positive' | 'negative' | null>>({});

  const onFeedback = useCallback(async (messageId: string, value: 'positive' | 'negative' | null) => {
    const root = document.documentElement;
    const prior = root.dataset.galleryFeedbackCalls;

    const calls: Array<{ method: string; args: unknown[] }> =
      // SAFETY: this callback is the recorder's only writer — it stores exactly
      // what it will parse on the next click, so the shape is its own.
      prior === undefined ? [] : JSON.parse(prior);

    calls.push({ method: 'setTurnFeedback', args: [messageId, value] });

    root.dataset.galleryFeedbackCalls = JSON.stringify(calls);
    setFeedback((prev) => ({ ...prev, [messageId]: value }));
  }, []);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-7 space-y-5 lg:px-8 [&>*]:max-w-[780px] [&>*]:mx-auto" data-gallery-chat>
      {MESSAGES.map((m) => (
        <div key={m.id} data-chat-row={m.id}>
          <MessageView message={m} onFork={() => {}}
            feedback={feedback[m.id]} onFeedback={onFeedback} />
        </div>
      ))}
      <DeviceConsentCard
        consent={{
          consentId: "c1", deviceLabel: "ashish-device", method: "exec",
          command: "git push origin fix/coupon-kind", createdAt: NOW,
        }}
        onResolve={() => {}}
      />
      <DeviceOfflineRow devices={[{ id: "dev-1", label: "ashish-device", lastSeenAt: NOW }]} />
      <ChatErrorCard message="fetch failed: provider stream reset before completion (anthropic/claude-opus-4)" streaming={false} onRetry={() => {}} onDismiss={() => {}} />
      {/* The same card re-serving an OLDER turn's outcome. `sunlit-stone-4a20`
          answers a resume ACK with exactly this body today, from a turn that
          ended 2026-08-17 — the state the owner opens an idle workspace into. */}
      <ChatErrorCard message="Unauthorized" replayed streaming={false} onRetry={() => {}} onDismiss={() => {}} />
    </div>
  );
}

function Shell(
  {
    surface = "Work", mctsTrees = EMPTY_TREES, rpc = workRpc, pendingActions = SHELL_PENDING_ACTIONS,
    headActivity = NO_HEAD_ACTIVITY, backgroundJobs = BACKGROUND_JOBS, notices = [], providerWait = null,
  }:
  {
    surface?: SurfaceKind; mctsTrees?: ReadonlyMap<string, ForkNode>; rpc?: Rpc;
    pendingActions?: PendingAction[];
    /** Per-node journal write counters, as the `head_activity` broadcast
     *  delivers them. Static for every frame but the live one. */
    headActivity?: ReadonlyMap<string, number>;
    /** Detached work. EMPTY is the state that matters for liveness: with no
     *  running job and no streaming turn the fork list drops to its idle
     *  cadence, which is the condition a new search would be invisible under. */
    backgroundJobs?: BackgroundJob[];
    /**
     * A model call sleeping out a provider-mandated wait — what the task
     *  indicator reads instead of "working" while it lasts. EMPTY by default:
     *  a frame photographs the surface it is named for, and a bar pinned to a
     *  wait in every other frame would say one turn is rate-limited forever.
     */
    providerWait?: { provider: string; waitMs: number } | null;
    /**
     * The composer's status rows. EMPTY by default, and that is the rule
     * rather than a preference: a frame photographs the surface it is named
     * for, and every OTHER pane in the shot is that surface's neighbour. A
     * neighbour stuck in a failure state makes a healthy surface look broken
     * in every review and every marketing capture. The frames that exist to
     * photograph a failure — the composer's own status treatment — pass it.
     */
    notices?: readonly ComposerNotice[];
  },
) {
  return (
    <div className="flex h-screen w-screen flex-col p-bg p-text overflow-hidden md:flex-row">
      {/* Mirrors components/layout.tsx — a harness that photographs a
          different surface than the app renders is worse than no harness. */}
      <aside className="hidden w-60 shrink-0 p-sidebar border-r p-border md:block"><Sidebar /></aside>
      <main className="p-workbench min-h-0 flex-1 min-w-0 overflow-hidden">
        <div className="h-full flex flex-col">
          <GalleryWorkspaceBar providerWait={providerWait} />
          <div className="flex-1 flex min-h-0">
            <div className="@container flex min-w-0 flex-1 flex-col h-full border-r p-border">
              <GalleryChatTabs />
              <ChatMessages />
              <GalleryComposer notices={notices} />
            </div>
            <div className="z-[2] -ml-[3px] w-[5px] shrink-0" />
            <div className="w-[430px] shrink-0 min-w-0">
              <WorkSurface
                surface={surface} onSurface={() => {}} pinnedPorts={[]} previewError={null} onRefreshPorts={() => {}} plan={null} snapshot={{ status: "loading" }} onRetryLoad={() => {}} tools={[]}
                memory={[]} memoryContent="" onSearchMemory={() => {}} mctsTrees={mctsTrees} headActivity={headActivity} isStreaming={false}
                executors={[]} executorOutputs={new Map()} onExecute={async () => ({})}
                backgroundJobs={backgroundJobs} onRefreshJobs={() => {}} pendingActions={pendingActions}
                rpc={rpc}
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}


function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b p-border">
      <h2 className="px-6 pt-6 pb-2 text-xs font-semibold uppercase tracking-wider p-text-3">{title}</h2>
      <div className="px-6 pb-8">{children}</div>
    </section>
  );
}

function Controls() {
  return (
    <div className="space-y-6 max-w-2xl">
      {/* The button hierarchy as it now ships. Kumo's `primary` and
          `destructive` are absent on purpose: they force `!text-white`, which
          measures 2.4:1 on brass, so the filled action is FilledButton —
          p-btn/p-btn-danger ink over Kumo's own sm box. Kumo's secondary and
          ghost stay and inherit the palette. */}
      <div className="flex flex-wrap items-center gap-3">
        <FilledButton>FilledButton</FilledButton>
        <FilledButton danger>danger</FilledButton>
        <Button variant="secondary" size="sm">Kumo secondary</Button>
        <Button variant="ghost" size="sm">Kumo ghost</Button>
        <button className="p-btn-quiet inline-flex h-6.5 items-center gap-1 px-2 text-xs">p-btn-quiet</button>
        <button className="p-btn-ghost inline-flex h-6.5 items-center gap-1 px-2 text-xs">p-btn-ghost</button>
        <button className="p-btn inline-flex h-9 items-center gap-2 px-3 text-sm font-medium">p-btn at 36px</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="px-1.5 py-0.5 rounded-sm text-[10px] font-mono p-badge-neutral">workspace</span>
        <span className="px-1.5 py-0.5 rounded-sm text-[10px] font-mono p-badge-success">sandbox</span>
        <span className="px-1.5 py-0.5 rounded-sm text-[10px] font-mono p-badge-warning">device</span>
        <span className="px-1.5 py-0.5 rounded-sm text-[10px] p-badge-danger">failed</span>
        <span className="size-1.5 rounded-full p-dot-success animate-pulse" title="working" />
        <span className="size-1.5 rounded-full p-dot-accent" title="unseen" />
      </div>
      <div className="space-y-2">
        <div className="p-notice-success text-xs rounded-md px-3 py-2">Deployed to staging — 14 tests green.</div>
        <div className="p-notice-warning text-xs rounded-md px-3 py-2">The device runtime is not provisioned yet.</div>
        <div className="p-notice-danger text-xs rounded-md px-3 py-2">Could not remove: workspace has a live turn.</div>
        <div className="p-notice-info text-xs rounded-md px-3 py-2">Evolution changelog has 3 unseen entries.</div>
      </div>
      <div className="max-w-md space-y-2">
        <input className="w-full px-3 py-1.5 border p-border p-card text-sm font-mono focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]" placeholder="raw input (fork modal style)" />
        <textarea rows={2} className="block w-full resize-y rounded-md border p-border p-bg px-3 py-3 text-sm leading-7 p-text outline-none placeholder:p-text-3 transition-all focus:border-[var(--c-accent)] focus:ring-2 focus:ring-[var(--c-accent-subtle)]" placeholder="mission textarea (home page style)" />
      </div>
      <EmptyState icon={<BrainIcon size={32} />} title="No exploration trees yet" hint="Exploration trees appear when the agent runs agents.swarm with a depth to investigate subproblems." />
    </div>
  );
}

/* The chat column at the width Column A actually gets — 42% of the shell, so
   roughly 540px on a device. Rendering it full-bleed would flatter every
   truncation and every line length the real column does not have. */
function ChatFrame() {
  return (
    <div className="flex h-screen justify-center p-bg p-text">
      <div className="@container flex w-full max-w-[560px] flex-col border-x p-border">
        <GalleryChatTabs />
        <ChatMessages />
        <GalleryComposer notices={MCTS_NOTICE} />
      </div>
    </div>
  );
}

/* The production shapes, as they reach the renderer.

   `steer-a` is the durable row `recordLandedSteers` writes: the operator's own
   words, and the step of the turn the model read them at.

   `f8798675…` is the fork-interrupted notice, restored by the history walk
   with its metadata — which is the half that was being dropped.

   `sys-1` is the same class with no markers left at all: the read model reports
   it `system` from the row's shape, and the renderer has to have somewhere to
   put a role that is neither the operator nor the agent. */
const STEERED_THREAD: UIMessage[] = [
  msg({
    id: "su1", role: "user", createdAt: NOW - 9 * 60e3,
    parts: [{ type: "text", text: "Research the current state of the art in LLM post-training and tell me what fits flaxdiff." }],
  }),
  msg({
    id: "steer-a", role: "user", createdAt: NOW - 6 * 60e3,
    metadata: { kinuSteer: true, kinuSteerAtStep: 2 },
    parts: [{ type: "text", text: "Can you actually use the research swarm for researching these topics and the project and other stuff?" }],
  }),
  msg({
    id: "sa1", role: "assistant", createdAt: NOW - 5 * 60e3,
    parts: [
      { type: "step-start" },
      { type: "reasoning", text: "Two decisions to make before searching: which post-training family actually ports to JAX, and whether flaxdiff's trainer can host an RL loop at all." },
      { type: "tool-web", toolCallId: "s1", state: "output-available", input: { action: "search", query: "LLM post-training 2026 RLVR GRPO agentic" }, output: "12 results" },
      { type: "step-start" },
      { type: "tool-web", toolCallId: "s2", state: "output-available", input: { action: "fetch", url: "https://github.com/volcengine/verl" }, output: "…" },
      { type: "text", text: "veRL is the dominant RL post-training stack, and Levanter has merged into the marin monorepo as the JAX pretraining path." },
      { type: "step-start" },
      { type: "reasoning", text: "The steer changes the shape of this: run it as a measured search rather than answering directly." },
      { type: "tool-agents", toolCallId: "s3", state: "output-available", input: { action: "swarm", preset: "ideate", task: "Distinct designs for extending flaxdiff into a unified JAX platform" }, output: "5 candidates" },
      { type: "text", text: "Kicked off an ideate swarm over the design space — five nodes, each returning a distinct approach rather than a ranked one." },
    ],
  }),
  msg({
    id: "f8798675-5e9a-4d13-aac2-293f4557f1c1", role: "system", createdAt: NOW - 4 * 60e3,
    metadata: { kinuEvent: "fork_interrupted", runs: ["6xrijuf933p0jclpctw59"], heads: 9 },
    parts: [{ type: "text", text: "9 head(s) across 1 fork run(s) were still marked running from an activation that has ended, so nothing is executing them and no report will arrive." }],
  }),
  msg({
    id: "sys-1", role: "system", createdAt: NOW - 3 * 60e3,
    parts: [{ type: "text", text: "The workspace was reactivated and its pending work re-driven." }],
  }),
];

/* Two reports in one picture.

   A message typed mid-turn (#210): the operator asked for the swarm while the
   agent was four steps into a search, and the bubble was drawn under the whole
   turn with the composer still promising to deliver it. Here it sits between
   the work that preceded it and the work it changed, and the composer says
   nothing because the model has it.

   A harness row walked back out of storage (#222): the `fork_interrupted`
   notice from `sunlit-stone-4a20`, restored by the history walk rather than
   the socket. It kept its card, which it could not before — the walk dropped
   the metadata the card is drawn from and the row landed in the owner's own
   bubble. Beside it, the same row with no markers at all, reported `system` by
   the read model: not the operator, not the agent. */
function ChatSteerFrame() {
  const thread = buildTranscript(STEERED_THREAD, [
    { id: "steer-live", text: "actually, cap it at three heads", state: "queued", atStep: null },
  ]);

  return (
    <div className="flex h-screen justify-center p-bg p-text">
      <div className="@container flex w-full max-w-[560px] flex-col border-x p-border">
        <GalleryChatTabs />
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 lg:px-8" data-gallery-chat>
          {thread.entries.map(({ message, steers }) => (
            <div key={message.id} data-chat-row={message.id}>
              <MessageView
                message={message} steers={steers} onFork={() => {}} />
            </div>
          ))}
          {thread.trailing.map((steer) => <SteerBubble key={steer.id} steer={steer} />)}
        </div>
        <GalleryComposer />
      </div>
    </div>
  );
}

/* Code fences in chat, the way an answer actually carries them: one ts block,
   one bash, one json — the three languages a fix reply names most. This is
   the frame the highlighting change photographs: a fence that renders flat
   here is the defect. */
const CODE_THREAD: UIMessage[] = [
  msg({
    id: "cu1", role: "user", createdAt: NOW - 4 * 60e3,
    parts: [{ type: "text", text: "Show me the fix for the SAVE20 coupon, how to run it, and the shape it returns." }],
  }),
  msg({
    id: "ca1", role: "assistant", createdAt: NOW - 3 * 60e3,
    parts: [
      { type: "text", text: [
        "The patch keeps percentage coupons on the branch the migration left null:",
        "",
        "```ts",
        "interface CouponRule { kind: 'fixed' | 'percent'; value: number }",
        "const rule: CouponRule = rules[coupon.kind ?? inferKind(coupon)];",
        "export function applyCoupon(cart: Cart, coupon: Coupon): Cart {",
        "  return rule.kind === 'percent' ? cart.scale(rule.value) : cart.subtract(rule.value);",
        "}",
        "```",
        "",
        "Run the suite from the package root:",
        "",
        "```bash",
        "bun test packages/checkout --filter coupon-kind",
        "git diff --stat migrations/0042_coupon_kind.sql",
        "```",
        "",
        "and the handler now answers:",
        "",
        "```json",
        "{ \"code\": \"SAVE20\", \"kind\": \"percent\", \"applied\": true, \"total\": 84.00 }",
        "```",
      ].join("\n") },
    ],
  }),
];

function ChatCodeFrame() {
  return (
    <div className="flex h-screen justify-center p-bg p-text">
      <div className="@container flex w-full max-w-[560px] flex-col border-x p-border">
        <GalleryChatTabs />
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 lg:px-8" data-gallery-chat>
          {CODE_THREAD.map((m) => (
            <div key={m.id} data-chat-row={m.id}>
              <MessageView message={m} onFork={() => {}} />
            </div>
          ))}
        </div>
        <GalleryComposer />
      </div>
    </div>
  );
}

/* What every new workspace opens on. The mission is shown as the standing
   brief it is — it is deliberately NOT sent as an opening message, so this
   state is the first thing anyone sees after creating a workspace. */
function ChatEmptyFrame() {
  return (
    <div className="flex h-screen justify-center p-bg p-text">
      <div className="@container flex w-full max-w-[560px] flex-col border-x p-border">
        <GalleryChatTabs clearable={false} />
        <div className="flex-1 overflow-y-auto px-6 py-5 lg:px-8">
          <EmptyConversation mission={BRAIN_STATUS.purpose} />
        </div>
        <GalleryComposer />
      </div>
    </div>
  );
}

/* A turn IN FLIGHT, WAITING ON THE PROVIDER. The stream is quiet because the
   model endpoint refused the request — the wait is measured and named on the
   task indicator rather than guessed from silence. This is the frame that
   could never exist before `provider_wait`: a rate-limited turn used to be
   indistinguishable from a slow one, the bar reading "working" the whole time
   the provider slept it out. */
function ProviderWaitFrame() {
  return <Shell providerWait={{ provider: "anthropic", waitMs: 45_000 }} />;
}

/* What EVERY workspace with a history opens on, for as long as the wake and the
   transfer take — 0.8-3.8 seconds against production, measured 2026-08-20.
   Photographed beside ChatEmptyFrame on purpose: ONE picture for both is the
   defect. One says "there is nothing here", the other says "not yet", and only
   one of them is true of a workspace with messages. */
function ChatLoadingFrame() {
  return (
    <div className="flex h-screen justify-center p-bg p-text">
      <div className="@container flex w-full max-w-[560px] flex-col border-x p-border">
        <GalleryChatTabs clearable={false} />
        <div className="flex-1 overflow-y-auto px-6 py-5 lg:px-8">
          <ConversationSkeleton />
        </div>
        <GalleryComposer />
      </div>
    </div>
  );
}

/* The composer alone, at reading width — the surface "magical" is won or lost
   on, so it gets its own sheet: at rest with a draft (send + Branch context),
   mid-turn (Stop / Branch / Steer, the three named actions), and carrying a
   status row. All three are the real component with live state. */
function ComposerFrame() {
  const [value, setValue] = useState("Ship the coupon fix behind a preview first.");
  const [mode, setMode] = useState<ChatMode>("build");
  const [model, setModel] = useState("anthropic/claude-opus-4");
  /* The thinking level travels with the model on every agent conversation, so
     the sheet carries it too: the pair's row is what this frame photographs,
     and a frame with the model alone photographed a composer the product does
     not have. The composer sizes the row, so the picker takes no width class
     here either — the app passes none. */
  const [effort, setEffort] = useState<ReasoningEffort | null>(null);

  const picker = () => (
    <ModelPicker models={MODEL_STUBS()} value={model} onChange={setModel} size="xs"
      effort={{ value: effort, onChange: setEffort }} />
  );

  const shared = {
    onValueChange: setValue,
    onSend: () => {},
    onStop: () => {},
    placeholder: "Send a message...",
    disabled: false,
    mode: { value: mode, onChange: setMode, locked: false },
    attachments: { parts: [], onAdd: () => {}, onRemove: () => {} },
  } as const;

  return (
    <div className="p-bg p-text min-h-screen flex justify-center">
      <div className="w-full max-w-[640px] space-y-8 py-10">
        <div className="space-y-1">
          <div className="p-eyebrow px-4">At rest, with a draft</div>
          <Composer {...shared} value={value} liveness={IDLE_TURN} modelPicker={picker()} />
        </div>
        <div className="space-y-1">
          <div className="p-eyebrow px-4">Mid-turn — Stop, Branch, Steer</div>
          <Composer {...shared} value={value} liveness={LIVE_TURN} onBranch={() => {}}
            modelPicker={picker()} />
        </div>
        <div className="space-y-1">
          <div className="p-eyebrow px-4">With a status row</div>
          <Composer {...shared} value="" liveness={IDLE_TURN} modelPicker={picker()} notices={MCTS_NOTICE} />
        </div>
      </div>
    </div>
  );
}

/* ── Chat infinite scroll ───────────────────────────────────────────

   The REAL hooks (usePagedScroll + useGrowingScroll), the REAL merge rule and
   the REAL HistoryBoundary, over a stub page source whose latency, failure and
   live-arrival timing this frame can drive. The hooks are the whole of the
   behaviour under test and none of them touch the socket, so a harness that
   can make a page arrive slowly proves more here than the live app can — in
   the live app the awkward cases are exactly the ones you cannot arrange.

   Query params: ?latency=ms  ?fail=1 (first fetch fails)  ?depth=N (pages
   before exhaustion). */
const HISTORY_PAGE = 12;

const historyParams = new URLSearchParams(location.search);

const HISTORY_LATENCY = Number(historyParams.get("latency") ?? 400);

const HISTORY_DEPTH = Number(historyParams.get("depth") ?? 4);

/** The stored transcript this frame pages back through, oldest first. */
const STORED_HISTORY: ChatHistoryEntry[] = Array.from(
  { length: HISTORY_PAGE * HISTORY_DEPTH },
  (_, i) => ({
    id: `h${i + 1}`,
    role: i % 2 === 0 ? "user" as const : "assistant" as const,
    content: `Archived message ${i + 1} of ${HISTORY_PAGE * HISTORY_DEPTH}. `
      + "Long enough to occupy real vertical space, so the scroll anchoring is "
      + "measured against a container that actually overflows.",
    createdAt: "2026-01-01 00:00:00",
  }),
);

function ChatHistoryFrame() {
  const [live, setLive] = useState<UIMessage[]>(() => MESSAGES.slice(-3));
  const failed = useRef(historyParams.get("fail") === "1");
  const requests = useRef(0);
  const [calls, setCalls] = useState<string[]>([]);

  const history = usePagedScroll<ChatHistoryEntry>({
    grows: "up",
    fetchPage: useCallback(async (cursor) => {
      const request = ++requests.current;
      setCalls((prev) => [...prev, cursor?.after ?? "newest"]);
      const settled = Promise.withResolvers<void>();
      setTimeout(settled.resolve, HISTORY_LATENCY);
      await settled.promise;

      if (request === requests.current && failed.current) {
        failed.current = false;
        throw new Error("stub failure");
      }

      const end = cursor === undefined
        ? STORED_HISTORY.length
        : STORED_HISTORY.findIndex((row) => row.id === cursor.after);

      const from = end < 0 ? STORED_HISTORY.length : end;
      const start = Math.max(0, from - HISTORY_PAGE);
      const items = STORED_HISTORY.slice(start, from);

      return start === 0 ? { status: "end", items } : { status: "more", items, next: { after: items[0].id } };
    }, []),
    startFrom: useCallback(() => live[0] ? { after: live[0].id } : null, [live]),
  });

  const transcript = useMemo(() => mergeTranscript(history.fetched, live), [history.fetched, live]);

  const messagesRef = useGrowingScroll({
    grows: "up", content: transcript, fetched: history.fetched, loading: history.loading,
    onReachEdge: history.loadMore,
  });

  // Driven from the test, so a live turn can be made to land while an older
  // page is still in flight — the case that decides whether the two sources
  // can double-render the same message.
  useEffect(() => {
    const onArrive = (event: Event) => {
      const detail = v.safeParse(v.pipe(v.string(), v.nonEmpty()), event instanceof CustomEvent ? event.detail : null);
      const id = detail.success ? detail.output : `live-${Date.now()}`;
      setLive((prev) => [...prev, {
        id, role: "assistant", parts: [{ type: "text", text: `Live arrival ${id}` }],
      }]);
    };

    window.addEventListener("gallery:arrive", onArrive);

    return () => window.removeEventListener("gallery:arrive", onArrive);
  }, []);

  return (
    <div className="flex h-screen justify-center p-bg p-text">
      <div className="@container flex w-full max-w-[560px] flex-col border-x p-border">
        <GalleryChatTabs />
        <div ref={messagesRef} data-testid="chat-scroll"
          className="flex-1 overflow-y-auto px-6 py-5 space-y-5 lg:px-8">
          <HistoryBoundary
            loading={history.loading} error={history.error}
            exhausted={history.exhausted} onRetry={history.loadMore} />
          {transcript.map((m) => (
            <div key={m.id} data-msg={m.id}>
              <MessageView message={m} />
            </div>
          ))}
        </div>
        <div data-testid="probe" className="hidden">{JSON.stringify({
          ids: transcript.map((m) => m.id), calls,
          loading: history.loading, exhausted: history.exhausted, error: history.error,
        })}</div>
        <GalleryComposer />
      </div>
    </div>
  );
}

/**
 * The first-page authority behind both WorkspacePage chat columns. The first
 * request stays held until the browser releases it, then fails once; Retry
 * answers the store's authoritative empty page. The frame mounts the same
 * ConversationStartBoundary the product mounts, never a copy of its policy.
 */
function HistoryAuthorityFrame() {
  const [hold] = useState(() => Promise.withResolvers<void>());
  const failFirst = useRef(true);
  const requests = useRef(0);

  const history = usePagedScroll<ChatHistoryEntry>({
    grows: "up",
    fetchPage: useCallback(async () => {
      const request = ++requests.current;
      await hold.promise;

      // StrictMode can retire one held walk and start its replacement. Only
      // the latest request consumes the planned failure; the stale request's
      // result is ignored by the hook's generation fence.
      if (request === requests.current && failFirst.current) {
        failFirst.current = false;
        throw new Error("fixture could not read the first history page");
      }

      return { status: "end" as const, items: [] };
    }, [hold]),
    // A delivered empty live seed asks the store for its newest page.
    startFrom: useCallback(() => "newest" as const, []),
  });

  const loadMore = history.loadMore;
  useEffect(() => { loadMore(); }, [loadMore]);

  return (
    <div data-history-authority className="flex h-screen justify-center p-bg p-text">
      <div className="@container flex w-full max-w-[560px] flex-col border-x p-border">
        <GalleryChatTabs clearable={false} />
        <button data-history-release type="button" onClick={() => hold.resolve()}
          className="p-btn-quiet m-2 self-start px-2 py-1 text-xs">
          Release first page
        </button>
        <button data-history-reset type="button" onClick={history.reset}
          className="p-btn-quiet m-2 self-start px-2 py-1 text-xs">
          Clear fetched history
        </button>
        <div className="flex-1 overflow-y-auto px-6 py-5 lg:px-8">
          <ConversationStartBoundary
            hasEntries={false}
            streaming={false}

            error={history.error}
            exhausted={history.exhausted}
            onRetry={history.loadMore}
            pending={<ConversationSkeleton />}
            empty={<EmptyConversation mission="Audit checkout history" />}
          />
        </div>
        <div data-history-probe className="hidden">{JSON.stringify({
          loading: history.loading,
          error: history.error,
          exhausted: history.exhausted,
        })}</div>
      </div>
    </div>
  );
}

/** KINU-060 actual WorkspaceRosterProvider proof. The fixture holds only the
 * transport response; upsert/rename are the hook's public local transitions,
 * and an old response must not undo them when released. */
function RosterAuthorityFrame() {
  const roster = useWorkspaceRoster();

  const entry: WorkspaceEntry = {
    name: "checkout-fixes",
    displayName: "Checkout coupon bug",
    createdAt: NOW - 7 * 864e5,
    lastVisited: NOW - 60e3,
    archivedAt: null,
  };

  return (
    <div data-roster-authority className="p-bg p-text min-h-screen p-6">
      <button data-roster-local-rename type="button" onClick={() => {
        roster.upsert(entry);
        roster.rename(entry.name, "Renamed locally");
      }}>Apply local rename</button>
      <button data-roster-release type="button" onClick={() => {
        rosterAuthorityHold.resolve(new Response(JSON.stringify(STUB_DATA["/api/user/workspaces"]), {
          headers: { "content-type": "application/json" },
        }));
      }}>Release stale roster</button>
      <div data-roster-probe data-roster-pending={String(roster.pending)}>{roster.entries.map((row) => `${row.name}:${row.displayName}`).join("|")}</div>
    </div>
  );
}

const CONTINUITY_LONG_TOKEN = `https://example.invalid/${"unbroken".repeat(90)}`;

/** Real MessageView, SteerBubble, Composer and MarkdownContent in one
 * interaction rig. Browser input supplies the IME and DataTransfer events; the
 * hidden probe reports only action results, never an implementation flag. */
function ClientContinuityFrame() {
  const [draft, setDraft] = useState("compose this");
  const [sends, setSends] = useState(0);
  const [files, setFiles] = useState<string[]>([]);

  const userMessage: UIMessage = {
    id: "continuity-user",
    role: "user",
    parts: [{ type: "text", text: CONTINUITY_LONG_TOKEN }],
  };

  return (
    <div data-client-continuity className="p-bg p-text min-h-screen px-4 py-6">
      <div className="mx-auto max-w-[760px] space-y-6">
        <div data-wrap-user>
          <MessageView message={userMessage} />
        </div>
        <div data-wrap-steer>
          <SteerBubble steer={{
            id: "continuity-steer", text: CONTINUITY_LONG_TOKEN,
            state: "queued", atStep: null,
          }} />
        </div>
        <Composer
          value={draft}
          onValueChange={setDraft}
          onSend={() => setSends((count) => count + 1)}
          onStop={() => {}}
          placeholder="Send a message"
          disabled={false}
          liveness={IDLE_TURN}
          attachments={{
            parts: [],
            onAdd: (added) => setFiles((current) => [
              ...current,
              ...Array.from(added ?? [], (file) => `${file.name}:${file.size}`),
            ]),
            onRemove: () => {},
          }}
        />
        <div data-image-success>
          <MarkdownContent content="![Loaded image](/assets/kinu-icon.svg)" />
        </div>
        <div data-image-failure>
          <MarkdownContent content="![Checkout diagram](/assets/missing-continuity-image.png)" />
        </div>
        <button data-continuity-reset type="button"
          onClick={() => { setDraft(""); setSends(0); setFiles([]); }}
          className="p-btn-quiet px-2 py-1 text-xs">
          Reset fixture
        </button>
        <div data-continuity-probe className="hidden"
          data-draft={draft}
          data-sends={sends}
          data-files={files.join("|")}
          data-token-length={CONTINUITY_LONG_TOKEN.length} />
      </div>
    </div>
  );
}

/** One quality branch fails until the browser heals it; the other stays held
 * until a separate release. This makes both branch-local failure and loading
 * observable before either final state can hide the interleaving. */
function QualityBranchFrame() {
  const [alignmentHold] = useState(() => Promise.withResolvers<void>());
  const replayHealthy = useRef(false);
  useEffect(() => {
    const heal = () => { replayHealthy.current = true; };

    const release = () => alignmentHold.resolve();
    window.addEventListener("gallery:quality-heal", heal);
    window.addEventListener("gallery:quality-release", release);

    return () => {
      window.removeEventListener("gallery:quality-heal", heal);
      window.removeEventListener("gallery:quality-release", release);
    };
  }, [alignmentHold]);

  const rpc = useMemo<Rpc>(() => async <T,>(method: string): Promise<T> => {
    if (method === "getReplayEvals") {
      if (!replayHealthy.current) throw new Error("replay fixture failed");

      return rpcResult(REPLAY_EVALS).json<T>();
    }

    if (method === "getAlignmentConvergence") {
      await alignmentHold.promise;

      return rpcResult(ALIGNMENT).json<T>();
    }

    if (method === "getOutcomeCalibration") {
      await alignmentHold.promise;

      return rpcResult(CALIBRATION).json<T>();
    }

    return stubRpc<T>(method);
  }, [alignmentHold]);

  return (
    <div data-quality-branches className="p-bg p-text min-h-screen p-6">
      <div className="mx-auto max-w-[760px]">
        <QualityView rpc={rpc} />
      </div>
    </div>
  );
}

function All() {
  return (
    <div className="p-bg p-text min-h-screen">
      <Section title="Chat column"><div className="@container max-w-3xl border p-border rounded-lg overflow-hidden"><GalleryWorkspaceBar /><GalleryChatTabs /><ChatMessages /><GalleryComposer /></div></Section>
      <Section title="Controls">{<Controls />}</Section>
    </div>
  );
}

/* ── Agent tab strip ────────────────────────────────────────────── */

const SUBORDINATES: Parameters<typeof SubordinateTabs>[0]["subordinates"] = [
  { name: "coupon-tester", displayName: "Coupon tester", role: "QA", createdBy: "orchestrator", status: "working", currentTask: "Running the checkout regression suite", createdAt: NOW - 36e5, dismissedAt: null },
  { name: "migration-review", displayName: "Migration review", role: "Reviewer", createdBy: "orchestrator", status: "awaiting_input", currentTask: "Needs a call on the backfill order", createdAt: NOW - 72e5, dismissedAt: null },
  { name: "docs", displayName: "Release notes", role: "Writer", createdBy: "user", status: "idle", currentTask: null, createdAt: NOW - 108e5, dismissedAt: null },
  // A one-click agent the titler has not reached: blank name, shown as
  // "New agent" in the provisional register.
  { name: "agent-4f2c", displayName: "", role: "agent", createdBy: "user", status: "idle", currentTask: null, createdAt: NOW - 6e5, dismissedAt: null },
];

/* One strip of the frame: the tab it has open, the column width it draws at,
   and the body under it. The open tab is the strip's hook, so a gate can read
   one strip's paint beside another's. */
interface TabStripCase {
  readonly open?: string;
  readonly width: number;
  readonly body: string;
}

const TAB_STRIPS: readonly TabStripCase[] = [
  { width: 520, body: "Main chat body" },
  { width: 380, body: "Main chat body" },
  { open: "coupon-tester", width: 520, body: "Subordinate chat body" },
  // The agent still under its codename. A blank display name renders the word
  // pair it was born with, and that tab must read as the open one too. It is
  // the last of the roster, so this strip is wide enough to hold the whole
  // set — a photograph of a scrolled strip shows the open tab off its edge.
  { open: "agent-4f2c", width: 760, body: "Codename chat body" },
];

/* The strip sits at the top of Column A, on the chat column's own ground —
   photographing it anywhere else hides the seam that the complaint is about. */
function TabsFrame() {
  return (
    <div className="p-bg min-h-screen p-8 space-y-8">
      {TAB_STRIPS.map((one) => (
        <div
          key={`${one.open ?? "main"}-${one.width}`}
          data-tab-strip={one.open ?? "main"}
          className="flex flex-col border p-border overflow-hidden"
          style={{ width: one.width, height: 190 }}
        >
          <SubordinateTabs
            workspace="checkout-fixes" subordinates={SUBORDINATES} activeName={one.open}
            onCreate={async () => {}} creating={false} onDismiss={async () => {}} onRename={async (_name, displayName) => displayName}
          />
          <div className="flex-1 px-5 py-4 p-row-text p-text-3">{one.body}</div>
        </div>
      ))}
    </div>
  );
}

/* ── Agent conversations (interactive rig) ─────────────────────── */

/** The inherited mission a one-click agent carries INTERNALLY. The browser
 *  gate asserts this string never reaches the document — creation is
 *  identity-only, and the mission is the machinery's business. */
const AGENTCHATS_MISSION = "Audit the checkout flow end to end and fix what breaks";

type GalleryRosterEntry = Parameters<typeof SubordinateTabs>[0]["subordinates"][number];

const AGENTCHATS_SEED: readonly GalleryRosterEntry[] = [
  // The role string is deliberately distinctive: the gate asserts it never
  // renders — an agent's being subordinate shows as hierarchy, not as a badge.
  { name: "scout", displayName: "Checkout scout", role: "Fixture-role QA lead", createdBy: "user", status: "idle", currentTask: null, createdAt: NOW - 36e5, dismissedAt: null },
  // An agent-created subordinate: keeps the confirmation path, beside the
  // user-created seed above that deletes on click.
  { name: "auto-scout", displayName: "Auto scout", role: "Fixture-role QA lead", createdBy: "orchestrator", status: "idle", currentTask: null, createdAt: NOW - 18e5, dismissedAt: null },
];

const AGENTCHATS_ROWS = 40;

/** One conversation pane, wired the way SubordinateChatColumn wires the real
 *  ones: no title bar of its own (the tab is where the agent is renamed), the
 *  same composer mode segment, and the same per-conversation state hook
 *  carrying draft/mode/scroll across switches. */
function AgentChatsPane({ conversation, transcript, onSend }: {
  conversation: string;
  transcript: readonly string[];
  onSend: (text: string, mode: ChatMode) => void;
}) {
  const ui = useConversationUiState(conversation);

  const scrollRef = useGrowingScroll({
    grows: "up",
    content: transcript,
    fetched: false,
    exhausted: true,
    initialScroll: ui.savedScroll,
    onScrollPosition: ui.rememberScroll,
  });

  return (
    <div className="@container relative flex min-h-0 flex-1 flex-col" data-agent-pane={conversation}>
      <div ref={scrollRef} data-agent-scroll className="flex-1 space-y-3 overflow-y-auto px-6 py-5">
        {transcript.length === 0
          ? <p className="text-sm p-text-3">This agent's conversation starts here.</p>
          : transcript.map((row, i) => (
            <div key={i} data-agent-row className="rounded-lg border p-border px-3 py-2 text-sm p-text-2">{row}</div>
          ))}
      </div>
      <div className="border-t p-border p-sidebar">
        <Composer
          value={ui.draft}
          onValueChange={ui.setDraft}
          onSend={() => {
            const text = ui.draft.trim();

            if (!text) return;
            onSend(text, ui.mode);
            ui.setDraft("");
          }}
          placeholder="Send a message..."
          disabled={false}
          liveness={IDLE_TURN}
          onStop={() => {}}
          mode={{ value: ui.mode, onChange: ui.setMode, locked: false }}
        />
      </div>
    </div>
  );
}

function AgentChatsScene() {
  const { subName } = useParams();
  const navigate = useNavigate();
  const [roster, setRoster] = useState<readonly GalleryRosterEntry[]>(AGENTCHATS_SEED);

  const [transcripts, setTranscripts] = useState<Record<string, readonly string[]>>({
    main: Array.from({ length: AGENTCHATS_ROWS }, (_, i) => `Main turn ${i + 1}: enough rows for the scroller to hold a position.`),
    scout: Array.from({ length: AGENTCHATS_ROWS }, (_, i) => `Scout turn ${i + 1}: an existing conversation with history.`),
  });

  const [sent, setSent] = useState<readonly { agent: string; mode: ChatMode; text: string }[]>([]);
  const [dismissals, setDismissals] = useState<readonly { agent: string; historyKept: boolean }[]>([]);
  const counter = useRef(0);
  // What the backend keeps to itself: the inherited mission, keyed off-DOM.
  const missions = useRef<Record<string, string>>({});

  const create = async () => {
    maybeRefuseCreate();
    const name = `agent-${++counter.current}`;
    missions.current[name] = AGENTCHATS_MISSION;
    setRoster((current) => [...current, {
      name, displayName: "", role: "agent", createdBy: "user",
      status: "idle", currentTask: null, createdAt: NOW, dismissedAt: null,
    }]);
    await navigate(`/workspace/checkout-fixes/agents/${name}`);
  };

  const send = (agent: string) => (text: string, mode: ChatMode) => {
    setSent((current) => [...current, { agent, mode, text }]);
    setTranscripts((current) => ({ ...current, [agent]: [...(current[agent] ?? []), text] }));
    // The first-message titler, a beat later — the `subordinates_changed`
    // delivery the roster consumes in the app.
    setTimeout(() => {
      setRoster((current) => current.map((entry) =>
        entry.name === agent && entry.displayName === ""
          ? { ...entry, displayName: text.slice(0, 32) }
          : entry));
    }, 120);
  };

  const active = subName ? roster.find((entry) => entry.name === subName) : undefined;

  return (
    <div className="p-bg p-text flex h-screen flex-col" data-agentchats>
      <div className="mx-auto flex h-full w-full max-w-3xl min-w-0 flex-col border-x p-border">
        <SubordinateTabs
          workspace="checkout-fixes"
          subordinates={roster}
          activeName={subName}
          onCreate={create}
          creating={false}
          onRename={async (name, displayName) => {
            setRoster((current) => current.map((entry) =>
              entry.name === name ? { ...entry, displayName } : entry));

            return displayName;
          }}
          onDismiss={async (name, keepHistory) => {
            setRoster((current) => current.filter((entry) => entry.name !== name));
            // What the backend does with the THREAD, mirrored: `keepHistory`
            // defaults to keeping exactly as `dismiss` in core does, and a
            // delete takes the conversation with it. The gate reads this
            // instead of the dialog's sentence.
            const historyKept = keepHistory ?? true;

            if (!historyKept) {
              setTranscripts((current) => Object.fromEntries(
                Object.entries(current).filter(([agent]) => agent !== name)));
            }

            setDismissals((current) => [...current, { agent: name, historyKept }]);
          }}
        />
        {subName && active ? (
          <AgentChatsPane
            key={subName}
            conversation={`checkout-fixes/agents/${subName}`}
            transcript={transcripts[subName] ?? []}
            onSend={send(subName)}
          />
        ) : (
          <AgentChatsPane
            key="main"
            conversation="checkout-fixes/main"
            transcript={transcripts["main"] ?? []}
            onSend={send("main")}
          />
        )}
      </div>
      <div data-sent-log={JSON.stringify(sent)} />
      <div data-dismiss-log={JSON.stringify(dismissals)} />
    </div>
  );
}

/* ── Markdown ───────────────────────────────────────────────────── */

/* Everything the agent actually emits: fenced blocks in several languages, a
   line far wider than the column, inline code inside prose, a table, nested
   lists, a quote — the cases that have to survive a 420px chat column. */
const MARKDOWN_SAMPLE = `Here is what the migration is doing wrong, and the patch.

The handler reads \`rules[coupon.kind]\` before \`kind\` is backfilled, so a percentage coupon dereferences \`undefined.percent\`. Fix is one line in \`apply-coupon.ts\` plus a guard in the migration.

\`\`\`ts
export function applyCoupon(cart: Cart, coupon: Coupon): Cart {
  const kind = coupon.kind ?? inferKind(coupon);
  const rule = rules[kind];
  if (!rule) throw new CouponError(\`no pricing rule for kind=\${kind}\`, { code: coupon.code });
  return rule.kind === "percent" ? discountByPercent(cart, rule.percent) : discountByAmount(cart, rule.amount);
}
\`\`\`

\`\`\`sql
UPDATE coupons SET kind = CASE WHEN value <= 100 AND code LIKE '%PCT%' THEN 'percent' ELSE 'fixed' END WHERE kind IS NULL;
\`\`\`

\`\`\`bash
bun test packages/checkout --reporter=verbose && bunx wrangler deploy --env staging --var COUPON_STRICT:1
\`\`\`

plain fence, no language: code-block styling still applies even when there are no language-specific tokens to highlight
\`\`\`

| Coupon | Kind | Value | Status |
| --- | --- | ---: | --- |
| SAVE10 | fixed | 10 | ok |
| SAVE20 | null | 20 | **500** |

1. Patch the migration
2. Add the regression test
   - one for \`percent\`
   - one for the \`null\` row
3. Re-run the suite

> The backfill ran before the enum existed, which is why nothing failed in CI.

See [the migration](https://example.com/migrations/0042) for the original.`;

function MarkdownFrame() {
  return (
    <div className="p-bg min-h-screen p-8 flex flex-wrap gap-8 items-start">
      {[420, 720].map((w) => (
        <div key={w}>
          <div className="p-eyebrow mb-2">{w}px</div>
          <div className="border p-border p-4 overflow-hidden" style={{ width: w }}>
            <div className="prose-chat p-text"><MarkdownContent content={MARKDOWN_SAMPLE} /></div>
          </div>
        </div>
      ))}
    </div>
  );
}

function CodeRenderingFrame() {
  const [source, setSource] = useState('const pending = "stream');

  const samples = [
    ['js', 'export const answer = "ready"; // result'],
    ['ts', 'interface Result { value: number }\nconst answer: Result = { value: 42 };'],
    ['json', '{"ready": true, "count": 42, "name": "result"}'],
    ['shell', '# report\nexport NAME="result"\necho "$NAME"'],
    ['py', 'def greet(name):\n    return "Hello " + name'],
    ['css', '.result { color: red; padding: 12px; }'],
    ['sql', 'SELECT name FROM results WHERE ready = true;'],
    ['go', 'package main\nfunc main() { println("ready") }'],
    ['rust', 'fn main() { let ready = true; println!("ready"); }'],
    ['c', '#include <stdio.h>\nint main(void) { printf("ready"); return 0; }'],
    ['cpp', '#include <iostream>\nint main() { std::cout << "ready"; return 0; }'],
    ['unknown-language', '<script>unknown & safe</script>'],
  ];

  return <div className="flex h-screen p-bg p-text">
    <aside className="w-60 shrink-0 border-r p-border"><Sidebar /></aside>
    <main className="min-w-0 flex-1 overflow-auto p-4">
      {samples.map(([language, code]) => <section key={language} data-code-sample={language}><CodeBlock className={`language-${language}`}>{code}</CodeBlock></section>)}
      <label>Streaming source<textarea aria-label="Streaming source" value={source} onChange={(event) => setSource(event.currentTarget.value)} /></label>
      <section data-code-sample="stream"><CodeBlock className="language-js">{source}</CodeBlock></section>
    </main>
  </div>;
}

function GalleryModal() {
  return (
    <div className="p-bg min-h-screen">
      <Modal
        title="Remove workspace"
        icon={<TrashIcon size={18} className="p-danger" />}
        onClose={() => {}}
        footer={<>
          <Button size="sm" variant="ghost">Cancel</Button>
          <FilledButton danger>Remove</FilledButton>
        </>}
      >
        <p className="text-xs p-text-2 leading-relaxed">
          Remove <span className="font-medium p-text">Checkout coupon bug</span> and delete everything in it? This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}

/* ── Palette plate — the design language rendered, not listed ───── */

const SURFACE_STEPS = [
  ["recessed", "--c-recessed"], ["base", "--c-bg"], ["panel", "--c-sidebar"],
  ["card", "--c-surface"], ["raised", "--c-elevated"], ["overlay", "--c-overlay"],
] as const;

/** Role names only. A `dark / light` contrast ratio on each line could only be
 *  measured against one palette, so on any other palette the plate would caption
 *  numbers that are not true of what it is showing. The ratios are asserted per
 *  theme by `unit-palette-contrast`, which is where a number can fail rather
 *  than merely be read. */
const TEXT_STEPS = [
  ["ink", "--c-text"], ["mid", "--c-text-2"], ["dim", "--c-text-3"], ["accent-ink", "--c-accent-fg"],
] as const;

const STATUS_STEPS = ["success", "warning", "danger", "info"] as const;

function Palette() {
  const { mode } = useTheme();

  return (
    <div className="p-bg min-h-screen p-8 space-y-8 max-w-3xl">
      <div>
        <div className="p-eyebrow mb-1">{mode}</div>
        <h1 className="p-title p-text" style={{ fontSize: 22, lineHeight: "28px" }}>Surface ladder, text roles, accent intent, status</h1>
        <p className="p-meta p-text-3 mt-1">The plate names the mode it is drawn in, and every value below is read from the live cascade — one palette, two modes.</p>
      </div>
      <div>
        <div className="p-eyebrow mb-2">Surfaces — six steps</div>
        <div className="flex rounded-lg overflow-hidden border p-border">
          {SURFACE_STEPS.map(([name, variable]) => (
            <div key={name} className="flex-1 h-24 flex items-end p-2" style={{ background: `var(${variable})` }}>
              <span className="p-meta p-text-3">{name}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="p-eyebrow mb-2">Text roles</div>
        <div className="space-y-1.5">
          {TEXT_STEPS.map(([name, variable]) => (
            <div key={name} className="p-body" style={{ color: `var(${variable})` }}>The agent resumed turn 41 from step 3 — {name}</div>
          ))}
        </div>
      </div>
      <div>
        <div className="p-eyebrow mb-2">The accent carries intent only</div>
        <div className="flex items-center gap-3 flex-wrap">
          <button className="p-btn px-3.5 h-9 p-row-text inline-flex items-center gap-2">Primary action</button>
          <button className="p-btn-quiet px-3.5 h-8 p-row-text inline-flex items-center">Secondary</button>
          <button className="p-btn-ghost px-3 h-8 p-row-text inline-flex items-center">Ghost</button>
          <a className="p-accent p-row-text underline underline-offset-2" href="#top">A link</a>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full p-accent-subtle">
            <span className="size-1.5 rounded-full p-dot-accent animate-pulse" />
            <span className="p-meta p-accent font-medium">working</span>
          </span>
        </div>
      </div>
      <div>
        <div className="p-eyebrow mb-2">Status — AA in every theme</div>
        <div className="flex items-center gap-2 flex-wrap">
          {STATUS_STEPS.map((name) => (
            <span key={name} className={`px-2 py-0.5 p-badge-${name}`}>{name}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── The signed-out pages, as the worker actually serves them ──────────

   Not a sketch of the landing page in app tokens — a sketch is a second design
   that drifts. These frames write the REAL document text into this window, so
   the browser computes the real cascade: the computed-style gate audits the
   public stylesheet, the screenshot pass photographs the shipped page, and the
   growth of the hero tree is the shipped script running. */

/** The public documents, by frame name. The install command is the production
 *  one rather than this dev server's, so the frame photographs the copy a
 *  visitor reads. */
function publicDocument(name: string): string | null {
  const install = `curl -fsSL 'https://kinu.run/install.sh' | bash`;

  if (name === "login") {
    return loginDocument([
      { href: "/auth/cloudflare/start?return_to=%2F", label: "Cloudflare" },
      { href: "/auth/github/start?return_to=%2F", label: "GitHub" },
    ]);
  }

  if (name === "loginfail") {
    return authDocument("Sign in failed", `
      <p class="lede">The sign-in request could not be completed. Return to sign in and try again.</p>
      <p class="muted">Failure stage: <code>token_request</code></p>
      <p class="muted">Reason: <code>provider_rejected_client</code></p>
      <div class="providers"><a class="provider" href="/login?prompt=login">Return to sign in</a></div>
    `);
  }

  if (name === "install") return installDocument(install);

  if (name === "approve") {
    return approvalDocument("Connect the Kinu CLI", `
      <p>A terminal on this machine asked to sign in as you.</p>
      <dl>
        <div><dt>Device</dt><dd>mrwhite0racle@workshop</dd></div>
        <div><dt>Code</dt><dd><code>KJ4-9QF</code></dd></div>
        <div><dt>Expires</dt><dd>in 9 minutes</dd></div>
      </dl>
      <form method="post"><button type="submit">Approve this device</button></form>
      <p class="muted">Approve only if you started this in your own terminal.</p>
    `);
  }

  return null;
}

/** Replace this document with the page. `document.write` rather than an
 *  innerHTML swap, because the page's own theme bootstrap and its scripts have
 *  to RUN — an injected `<script>` never does. */
function writeDocument(html: string): void {
  document.open();
  document.write(html);
  document.close();
}

/**
 * The four candidate marks, at every size that decides one.
 *
 * A logo is chosen at 16px and at hero size, in both faces, or it is chosen
 * wrong. `KINU_MARK` in `public-shell.ts` names the one that ships, so this
 * frame is what that one line is answerable to.
 */
function MarksFrame() {
  const sizes = [16, 24, 48, 96] as const;

  return (
    <div className="p-bg p-text min-h-screen p-10 space-y-10">
      <div className="space-y-2">
        <div className="p-eyebrow">Candidate marks — hiragana く, one stroke</div>
        <div className="p-body p-text-2 max-w-xl">
          Shipping: <span className="p-text font-semibold">{KINU_MARK}</span>. Each mark is
          hand-authored paths on a 24-unit grid, inheriting <code>currentColor</code>, so it is
          the accent of whichever face is on screen.
        </div>
      </div>
      {MARK_IDS.map((id) => (
        <div key={id} className="space-y-3 border-t p-border pt-6">
          <div className="flex items-baseline gap-3">
            <span className="p-title p-text">{id}</span>
            {id === KINU_MARK && <span className="p-eyebrow" style={{ color: "var(--c-accent-fg)" }}>shipping</span>}
          </div>
          <div className="flex items-end gap-10">
            {sizes.map((size) => (
              <div key={size} className="flex flex-col items-center gap-2">
                <span
                  style={{ color: "var(--c-accent)", lineHeight: 0 }}
                  dangerouslySetInnerHTML={{ __html: mark(size, id) }}
                />
                <span className="p-meta p-text-3">{size}px</span>
              </div>
            ))}
            <div className="flex items-center gap-2.5 border p-border rounded-md px-3 py-2">
              <span
                style={{ color: "var(--c-accent)", lineHeight: 0 }}
                dangerouslySetInnerHTML={{ __html: mark(21, id) }}
              />
              <span style={{ fontFamily: "var(--font-display)", fontSize: 17, fontWeight: 500, letterSpacing: "-0.015em" }}>
                Kinu.run
              </span>
            </div>
            <div className="flex items-center gap-2.5 px-3 py-2 rounded-md" style={{ background: "var(--c-accent)" }}>
              <span
                style={{ color: "var(--c-accent-on)", lineHeight: 0 }}
                dangerouslySetInnerHTML={{ __html: mark(21, id) }}
              />
              <span style={{ color: "var(--c-accent-on)", fontFamily: "var(--font-display)", fontSize: 17, fontWeight: 500 }}>
                Kinu.run
              </span>
            </div>
            {/* The candidate where the owner will actually meet it: the
                sidebar lockup, on sidebar chrome, over a live roster row —
                the context Sidebar.tsx ships (mark 20px + display face). */}
            <div className="w-60 rounded-lg border p-border p-sidebar px-2 py-2.5 space-y-1.5">
              <div className="flex items-center gap-2.5 px-2 py-1">
                <span style={{ color: "var(--c-accent)", lineHeight: 0 }} dangerouslySetInnerHTML={{ __html: mark(20, id) }} />
                <span className="p-heading text-[17px] p-text">Kinu</span>
              </div>
              <div className="p-eyebrow px-2">Workspaces</div>
              <div className="px-2 py-1.5 rounded-lg bg-[var(--c-elevated)] p-row-text font-medium">Checkout coupon bug</div>
              <div className="px-2 py-1.5 p-row-text p-text-2">Perf audit — landing</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* The Agent surface: the collapsible sections and the native/code-mode
   exposure badge, at the width Column C actually gets. */
/* The real docstrings, from the registry the orchestrator serves them from.
   Mocking short ones is how the Tools list shipped as a wall of prose without
   anyone seeing it: eight builtins carry real contract text between them, and
   a harness that photographs one-liners photographs a surface the app does
   not have. `release` (and `agent.*` self-steering) is codemode-only reach —
   getToolDescriptions() only lists BUILTIN_TOOLS, the same reason `agent.*` has
   never appeared here either, so that row is illustrative mock, not a live
   readout.

   `exposure` here is the registry's DECLARED reach (TOOL_REACH), so the eight
   builtins are "both" — every one of them is also a codemode namespace or, for
   run/file, reachable through `workspace.*`; only eval is native-only,
   because it IS the sandbox. `wired` is the second, separate fact: whether this
   agent has the capability at all. `report` is photographed at wired:false
   because that is what an orchestrator looks like — it IS the report sink — and
   that state is exactly the one a false label "code mode" would misreport. */
function galleryTool(info: ToolInfo): ToolInfo { return info; }

const BRAIN_TOOLS: ToolInfo[] = [
  ...BUILTIN_TOOLS.map((name) => galleryTool({
    name,
    summary: BUILTIN_TOOL_SPECS[name].summary,
    description: BUILTIN_TOOL_DESCRIPTIONS[name],
    learned: false,
    exposure: TOOL_REACH[name].codemode ? "both" : "native",
    wired: name !== "report",
    qualityScore: 1,
    usageCount: 0,
  })),
  galleryTool({ name: "release", summary: "Governed release pipeline over a bound source repo.", description: "Governed release pipeline over a bound source repo — patch it, run its checks, preview, take owner approval, deploy, roll back.", learned: false, exposure: "codemode", wired: true, qualityScore: 1, usageCount: 0 }),
  galleryTool({ name: "bisect_migration", summary: "Walk a migration's revisions to find the one that changed a column's shape.", description: "Walk a migration's revisions to find the one that changed a column's shape.", learned: true, exposure: "codemode", wired: true, qualityScore: 0.82, usageCount: 14 }),
  galleryTool({ name: "coupon_replay", summary: "Replay a checkout against a coupon code and diff the response.", description: "Replay a checkout against a coupon code and diff the response.", learned: true, exposure: "codemode", wired: true, qualityScore: 0.61, usageCount: 3 }),
];

const BRAIN_STATUS = {
  name: "checkout-coupon-bug-9935d3", displayName: "Checkout coupon bug",
  purpose: "Find why the SAVE20 coupon 500s and fix it.", model: "anthropic/claude-opus-4",
  scaffoldVersion: 7, searchNodeCount: 12, craftedToolCount: 2, messageCount: 48,
  soul: "# Checkout coupon bug", forkLineage: null, createdAt: NOW - 7 * 864e5, reasoningEffort: "medium",
} satisfies AgentStatus;

/* ── Agent-authored Slate preview ────────────────────────────── */

const GALLERY_SLATE_ID = "sandbox-probe";

/** Gallery-only previewSlate fixture. It exercises SlateFrame, not a deployed preview origin. */
const slateRpc: Rpc = async <T,>(method: string, args?: Parameters<Rpc>[1]): Promise<T> => {
  if (method === "previewSlate") {
    return rpcResult({ ok: true, value: { url: SLATE_GALLERY_URL, port: 8789, inline: { height: 240 } } }).json<T>();
  }

  return stubRpc<T>(method, args);
};

function SlatePreviewFrame() {
  return (
    <div className="p-bg min-h-screen flex justify-center">
      <div className="w-[720px] min-h-screen border-x p-border p-5">
        <SlateFrame id={GALLERY_SLATE_ID} rpc={slateRpc} />
      </div>
    </div>
  );
}

/** The coupon-board slate itself — the app a workspaces tile draws in its
 *  live frame. Rendered at the tile's own 4x viewport so the scaled-down
 *  photograph shows a real app, not a reflowed column. */
function CouponBoardSlate() {
  const coupons = [
    { code: "SAVE20", kind: "percent", state: "active", used: 41 },
    { code: "FREESHIP", kind: "shipping", state: "active", used: 12 },
    { code: "LEGACY5", kind: null, state: "500s on apply", used: 3 },
    { code: "WELCOME", kind: "fixed", state: "paused", used: 88 },
  ] as const;

  const tone: Record<(typeof coupons)[number]["state"], string> = {
    "active": "p-success",
    "paused": "p-text-3",
    "500s on apply": "p-danger",
  };

  return (
    <div className="p-bg min-h-screen p-8 font-sans">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-baseline justify-between">
          <h1 className="p-display text-3xl p-text">Coupon board</h1>
          <span className="p-meta p-text-3">4 rules · checkout-fixes</span>
        </div>
        <div className="mt-6 space-y-2">
          {coupons.map((coupon) => (
            <div key={coupon.code} className="flex items-center justify-between rounded-lg border p-border p-recessed px-4 py-3">
              <div>
                <span className="font-mono text-sm font-medium p-text">{coupon.code}</span>
                <span className="ml-3 p-meta p-text-3">{coupon.kind ?? "no kind"}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="p-meta p-text-3">{coupon.used} uses</span>
                <span className={`p-meta ${tone[coupon.state]}`}>{coupon.state}</span>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-6 p-meta p-text-3">LEGACY5 fails in applyCoupon — kind:null rows from the 0412 migration.</p>
      </div>
    </div>
  );
}

/* A slate rendered where the owner reads it: inside the transcript, at the
   card's own height, while the conversation stays legible around it. The
   thread ends on the bare `slate://` address the agent typed — the markdown
   pass turns it into the card, not into a link to click. */
const SLATE_THREAD: UIMessage[] = [
  msg({
    id: "sl-u1", role: "user", createdAt: NOW - 4 * 60e3,
    parts: [{ type: "text", text: "Which target should the release go to?" }],
  }),
  msg({
    id: "sl-a1", role: "assistant", createdAt: NOW - 3 * 60e3,
    parts: [{ type: "text", text: "Pick one below and I will continue.\n\nslate://deploy-choice" }],
  }),
];

function ChatSlateFrame() {
  const thread = buildTranscript(SLATE_THREAD, []);
  const inline = { rpc: slateRpc, openSlate: () => {} };

  return (
    <SlateInlineContext.Provider value={inline}>
      <div className="flex h-screen justify-center p-bg p-text">
        <div className="@container flex w-full max-w-[560px] flex-col border-x p-border">
          <GalleryChatTabs />
          <div className="flex-1 overflow-y-auto px-6 py-7 space-y-5 lg:px-8" data-gallery-chat>
            {thread.entries.map(({ message, steers }) => (
              <div key={message.id} data-chat-row={message.id}>
                <MessageView
                  message={message} steers={steers} onFork={() => {}} />
              </div>
            ))}
          </div>
          <GalleryComposer />
        </div>
      </div>
    </SlateInlineContext.Provider>
  );
}

/* ── Releases ───────────────────────────────────────────────────── */

// A board with one pending approval, so the row that carries the Approve button
// is the thing under the lens: the digest binds the source's deployTarget, and
// this frame is where you check that the owner can actually read it first.
const RELEASE_BOARD = {
  bindings: [{
    id: "src_1", kind: "local", label: "kinu", repoUrl: null, defaultBranch: "main",
    localDeviceId: null, localRoot: "~/Kinu", deployTarget: "bunx wrangler deploy --env production",
    createdAt: NOW - 9 * 864e5, updatedAt: NOW - 9 * 864e5,
  }],
  changes: [{
    id: "chg_4f2", bindingId: "src_1", agentName: "jarvis",
    userPrompt: "Warm up the empty-state copy", plan: "Rewrite the six EMPTY_HINTS in the owner's voice.",
    summary: null,
    patch: "--- a/packages/cf-backend/src/components/surfaces/shared.tsx\n+++ b/packages/cf-backend/src/components/surfaces/shared.tsx\n@@\n-  memory: \"Your agent will remember important information here.\",\n+  memory: \"Anything worth keeping lands here. Ask me to remember something.\",",
    status: "awaiting_approval", previewUrl: null, createdAt: NOW - 36e5, updatedAt: NOW - 12e5,
  }],
  checks: [
    { id: "chk_1", changeId: "chg_4f2", name: "typecheck", status: "passed", stdout: null, stderr: null, durationMs: 41_000, createdAt: NOW - 30e5, updatedAt: NOW - 30e5 },
    { id: "chk_2", changeId: "chg_4f2", name: "bun test", status: "passed", stdout: "920 pass, 0 fail", stderr: null, durationMs: 9_300, createdAt: NOW - 28e5, updatedAt: NOW - 28e5 },
  ],
  approvals: [{
    id: "apr_1", changeId: "chg_4f2", approvalType: "deploy_production", decision: "pending",
    approvedBy: null, note: null, decidedAt: null, argumentDigest: "9f2c…", createdAt: NOW - 12e5,
  }],
  deployments: [],
};

const releaseRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (method === "getReleaseBoard") return rpcResult(RELEASE_BOARD).json<T>();

  return stubRpc<T>(method, args);
};

const RELEASE_EXECUTORS: ExecutorInfo[] = [
  { name: "sandbox", kind: "sandbox", capabilities: [], available: true, configured: true, active: false, status: "idle" },
];

/** The same board with the engine's substrate missing — the surface's honest
 *  word when nothing on the pipeline can actually run. */
const RELEASE_EXECUTORS_OFFLINE: ExecutorInfo[] = [
  {
    name: "sandbox", kind: "sandbox", capabilities: [], available: false, configured: false,
    active: false, status: "not_configured",
    reason: "Sandbox executor not configured. Add the @cloudflare/sandbox binding and Container to wrangler.jsonc (see docs/EXECUTION-LAYER-SPEC.md).",
  },
];

function ReleasesFrame({ executors = RELEASE_EXECUTORS }: { executors?: ExecutorInfo[] }) {
  return (
    <div className="p-bg min-h-screen flex justify-center">
      <div className="w-[1100px] min-h-screen border-x p-border p-5">
        <ReleasesSurface rpc={releaseRpc} executors={executors} />
      </div>
    </div>
  );
}


/* ── Work ───────────────────────────────────────────────────────── */

// The agent's own plan, at the shape it actually reaches: several steps, one
// item active, one task broken into subtasks, one dropped. Photographed inside
// Column C's chrome, beside the jobs and self-changes it now shares a surface
// with, rather than each of those three in a room of its own.
const AGENT_TASKS = [
  {
    id: "t1", parentId: null, title: "Reproduce the SAVE20 coupon 500", status: "done",
    createdAt: NOW - 52e5, updatedAt: NOW - 44e5, note: null, subtasks: [],
  },
  {
    id: "t2", parentId: null, title: "Patch the gateway timeout that swallows the coupon lookup",
    status: "active", createdAt: NOW - 52e5, updatedAt: NOW - 8e5, note: null,
    subtasks: [
      { id: "t5", parentId: "t2", title: "Raise the upstream deadline to 60s", status: "done", createdAt: NOW - 30e5, updatedAt: NOW - 21e5, note: null },
      { id: "t6", parentId: "t2", title: "Stop retrying a request the client already abandoned", status: "active", createdAt: NOW - 30e5, updatedAt: NOW - 6e5, note: "Client already bails at 8s — retrying past that is burn, not robustness." },
      { id: "t7", parentId: "t2", title: "Check the same path in the checkout worker", status: "open", createdAt: NOW - 30e5, updatedAt: NOW - 30e5, note: null },
    ],
  },
  {
    id: "t3", parentId: null, title: "Add a regression test for the expired-coupon branch",
    status: "open", createdAt: NOW - 52e5, updatedAt: NOW - 52e5, note: null, subtasks: [],
  },
  {
    id: "t4", parentId: null, title: "Rewrite the coupon docs page", status: "dropped",
    createdAt: NOW - 52e5, updatedAt: NOW - 40e5, note: null, subtasks: [],
  },
];

/** The workspace-wide work read the Work tab's plan list and task ledger
 *  share: the root's plan and tasks plus one subordinate's plan carrying its
 *  own linked task, so the list draws both owners' rows. */
const WORKSPACE_WORK = {
  plans: [
    {
      owner: { actorId: "actor-main", name: "main", retired: false },
      plan: {
        id: "plan-gateway", sessionId: "default", revision: 3,
        content: "# Gateway timeout repair\n\nPatch the gateway timeout, then prove the expired-coupon branch.",
        status: "pending", annotations: [], feedback: null, handoffAccepted: false,
        createdAt: NOW - 53e5, updatedAt: NOW - 9e5, decidedAt: null,
      },
      tasks: AGENT_TASKS.filter((task) => task.id === "t2"),
    },
    {
      owner: { actorId: "actor-courier", name: "courier", retired: false },
      plan: {
        id: "plan-courier", sessionId: "default", revision: 1,
        content: "# Courier rollout\n\nStage the rollout and verify the receipt.",
        status: "approved", annotations: [], feedback: null, handoffAccepted: true,
        createdAt: NOW - 60e5, updatedAt: NOW - 50e5, decidedAt: NOW - 50e5,
      },
      tasks: [
        { id: "t8", parentId: null, title: "Stage the rollout", status: "done", createdAt: NOW - 60e5, updatedAt: NOW - 55e5, note: null, subtasks: [] },
      ],
    },
  ],
  tasks: [
    {
      owner: { actorId: "actor-main", name: "main", retired: false }, plan: null,
      tasks: AGENT_TASKS.filter((task) => task.id !== "t2"),
    },
  ],
};

/** Both lifecycle halves in frame: one job still running (Now, cancel), two
 *  settled (journal, retry / dismiss). */
const BACKGROUND_JOBS = [
  {
    id: "bgjob-7c1e4a92", kind: "fork", label: "explore three coupon-lookup fixes",
    workMode: "build" as const, status: "running" as const, result: null, error: null, createdAt: NOW - 9e5, settledAt: null,
  },
  {
    id: "bgjob-2f8b1d04", kind: "eval", label: "bun test packages/core",
    workMode: "build" as const, status: "completed" as const, result: "2,633 pass · 0 fail · 187 files", error: null,
    createdAt: NOW - 42e5, settledAt: NOW - 33e5,
  },
  {
    id: "bgjob-9d3c6e11", kind: "shell", label: "wrangler deploy --dry-run",
    workMode: "build" as const, status: "failed" as const, result: null, error: "exit 1 — binding VECTORIZE not found in wrangler.jsonc",
    createdAt: NOW - 61e5, settledAt: NOW - 58e5,
  },
];

const CHANGELOG = {
  seenAt: NOW - 30e5,
  unseenCount: 2,
  entries: [
    {
      id: "cl_1", kind: "scaffold", at: NOW - 10e5, scaffoldVersion: 8, revert: true,
      summary: "Rewrote the tool preamble — shorter, and it stops re-reading files it just wrote",
      evidence: "shadow eval: 7 trials · 5 pending wins · 1 regression · 1 tie",
    },
    {
      id: "cl_2", kind: "tool", at: NOW - 26e5, scaffoldVersion: null, revert: true,
      summary: "Learned a tool: bisect_migration",
      evidence: "extracted from 3 successful turns · quality 0.82",
    },
    {
      id: "cl_3", kind: "fact", at: NOW - 50e5, scaffoldVersion: null, revert: true,
      summary: "Remembered: percentage coupons carry kind:null after Tuesday's migration",
      evidence: null,
    },
    {
      id: "cl_4", kind: "refinement", at: NOW - 6e5, scaffoldVersion: null,
      summary: "Reviewed my own recent failures and changed nothing",
      evidence: "refused · workspace scope · reviewed 3 turns",
      noChange: true,
    },
  ],
};

/** The queue that closes the badge gap: without it a release approval lights
 *  nothing at all while a running job — which needs nobody — carries a digit. */
const PENDING_ACTIONS: PendingAction[] = [
  // A parked command — the ONE kind decided in the queue itself, and the one
  // this frame never held, so its Approve/Always/Deny controls had never been
  // photographed at all. Two of them, because deciding a night's worth in one
  // sitting is the whole point of the card.
  {
    id: "defer-9y2n8ixor8", kind: "deferred_action", at: NOW - 40 * 60e3,
    title: "Approve: a command the agent wants to run on device",
    detail: "cd ~/Kinu && rm -rf node_modules && bun install",
  },
  {
    id: "defer-4k1m2pqw7z", kind: "deferred_action", at: NOW - 36 * 60e3,
    title: "Approve: a command the agent wants to run on device",
    detail: "sudo launchctl kickstart -k system/com.docker.dockerd",
  },
  {
    id: "apr_1", kind: "release_approval", at: NOW - 12e5,
    title: "Approve: deploy to production",
    detail: "Warm up the empty-state copy",
  },
  {
    id: "plan:main:plan-gateway:3", kind: "plan_review", at: NOW - 9e5,
    title: "Approve the plan · Gateway timeout repair",
    detail: null,
    planRef: { owner: "main", id: "plan-gateway", revision: 3 },
  },
  {
    id: "scaffold-v8", kind: "scaffold_version", at: NOW - 10e5,
    title: "Scaffold v8 is waiting to be promoted or rolled back",
    detail: "Rewrote the tool preamble — shorter, and it stops re-reading files it just wrote",
  },
  {
    id: "unseen-changes", kind: "unseen_changes", at: NOW - 10e5,
    title: "2 self-changes you have not seen",
    detail: "Keep or revert them in the journal below.",
  },
];

/** The shell oracle carries one owner decision, as the app mock does. */
const SHELL_PENDING_ACTIONS = PENDING_ACTIONS.filter((action) => action.kind === "release_approval");


/* ── Slate sharing: the four Phase 1 surfaces on one blueprint ─────────── */

const BLUEPRINT_BINDINGS: SlateBindingDeclaration[] = [
  { name: "GITHUB", kind: "mcp", target: "github", credentialed: true },
  { name: "FILES", kind: "namespace", target: "workspace", credentialed: true },
  { name: "NOTES", kind: "memory", target: "recall, remember", credentialed: true },
  { name: "PEER", kind: "app", target: "digest", credentialed: false },
];

const BLUEPRINT_ID = "checkout-fixes~k7Qm2pV9xRt3aB4c~mfrq6zk3p2xw7ha";

const BLUEPRINT_VIEW: BlueprintView = {
  id: BLUEPRINT_ID,
  title: "Issue triage",
  description: "Reads the open issues of a repository, groups them by area, and writes a triage note into workspace memory every morning.",
  bindings: BLUEPRINT_BINDINGS,
  credentialed: BLUEPRINT_BINDINGS.filter((binding) => binding.credentialed),
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
  bindings: BLUEPRINT_BINDINGS, credentialed: BLUEPRINT_VIEW.credentialed, warnings: BLUEPRINT_VIEW.warnings,
};

/** What a viewer of the Issue triage slate would reach, as core draws it:
 *  every member classified, the risk of each mutating one worded for the
 *  visibility, and the digest slate behind the PEER hop. */
const RISK = (body: string) => ({ public: `${body} Anyone who opens this share can trigger it.`, users: `${body} Anyone you named on this share can trigger it.` });

const NO_RISK = { public: "", users: "" };

const SHARE_GRAPH: SlateCapabilityGraph = {
  slate: "issue-triage",
  slates: ["issue-triage", "digest"],
  bindings: [
    { slate: "issue-triage", name: "GITHUB", kind: "mcp", capability: { kind: "mcp", server: "github", title: "GitHub" }, members: [
      { member: "read_issue", effect: "read", risk: NO_RISK },
      { member: "create_issue", effect: "mutate", risk: RISK("Calls create_issue on GitHub with your credentials. The server does not mark it read-only, so it can create or change data there.") },
    ] },
    { slate: "issue-triage", name: "FILES", kind: "namespace", capability: { kind: "executor", namespace: "workspace" }, members: [
      { member: "readFile", effect: "read", risk: NO_RISK },
      { member: "writeFile", effect: "mutate", risk: RISK("Writes, edits or deletes files in workspace checkout-fixes as you.") },
    ] },
    { slate: "issue-triage", name: "NOTES", kind: "memory", capability: { kind: "memory" }, members: [
      { member: "recall", effect: "read", risk: NO_RISK },
      { member: "remember", effect: "mutate", risk: RISK("Changes your workspace memory as you: notes and remembered facts your agent reads back later.") },
    ] },
    { slate: "issue-triage", name: "ASK", kind: "agent", capability: { kind: "agent" }, members: [
      { member: "send", effect: "mutate", risk: RISK("Sends a message to your agent's inbox as this slate. Your agent reads it and acts on it in workspace checkout-fixes.") },
    ] },
    { slate: "issue-triage", name: "BRAIN", kind: "ai", capability: { kind: "model", tier: "fast" }, members: [
      { member: "shell", effect: "mutate", risk: RISK("Runs a model call on your fast tier. Every call spends your inference.") },
    ] },
    { slate: "issue-triage", name: "PEER", kind: "app", capability: { kind: "slate", id: "digest" }, members: [] },
    { slate: "digest", name: "DIGEST_FILES", kind: "namespace", capability: { kind: "executor", namespace: "workspace" }, members: [
      { member: "readFile", effect: "read", risk: NO_RISK },
    ] },
  ],
};

const LIVE_SHARE: LiveShareRecord = {
  id: "live-board-1", slate: "issue-triage", visibility: "public", handle: "3f9a1c7e02",
  grant: { slates: ["issue-triage", "digest"], members: [
    { slate: "issue-triage", binding: "GITHUB", member: "read_issue", effect: "read" },
    { slate: "issue-triage", binding: "FILES", member: "readFile", effect: "read" },
    { slate: "issue-triage", binding: "NOTES", member: "recall", effect: "read" },
    { slate: "digest", binding: "DIGEST_FILES", member: "readFile", effect: "read" },
  ] },
  createdAt: NOW - 864e5, revokedAt: null, users: [],
};

const SHARED_LIBRARY: SharedLibrary = {
  slates: [
    { id: "issue-triage", title: "Issue triage", workspace: "checkout-fixes", bindings: 4, visibility: "public" },
    { id: "lighthouse", title: "Landing perf report", workspace: "perf-audit", bindings: 1 },
    { id: "standup", title: "Standup notes", workspace: "notes", bindings: 2 },
  ],
  mine: [
    { id: "live-board-1", kind: "live", share: "live-board-1", title: "Issue triage", description: BLUEPRINT_VIEW.description, createdAt: NOW - 864e5, bindings: 4, visibility: "public", workspace: "checkout-fixes", users: [] },
    { id: BLUEPRINT_ID, kind: "blueprint", share: "k7Qm2pV9xRt3aB4c", title: "Issue triage", description: BLUEPRINT_VIEW.description, createdAt: NOW - 3 * 864e5, bindings: 4, workspace: "checkout-fixes", users: ["pat@example.com"] },
    { id: "perf-audit~h2Lm9sQ4dF7gJ1kP~q2wz5m7xk3rp6ha", kind: "blueprint", share: "h2Lm9sQ4dF7gJ1kP", title: "Landing perf report", description: "Runs Lighthouse against the landing page and posts the score.", createdAt: NOW - 12 * 864e5, bindings: 1, workspace: "perf-audit", users: [] },
  ],
  received: [
    { id: "live-mail-9", kind: "live", share: "live-mail-9", title: "Inbox digest", description: "Summarises unread mail into one morning note, live from Sam's workspace.", createdAt: NOW - 2 * 3600e3, bindings: 2, visibility: "users", workspace: "sam-mail", owner: "sam@example.com" },
    { id: "email-triage~z8Xc4vB2nM6qW3eR~a7bn3kd9pq2xw5ha", kind: "blueprint", share: "z8Xc4vB2nM6qW3eR", title: "Inbox digest", description: "Summarises unread mail into one morning note.", createdAt: NOW - 864e5, bindings: 2, workspace: "sam-mail", owner: "sam@example.com" },
  ],
  public: [
    { id: "live-status-2", kind: "live", share: "live-status-2", title: "Deploy status board", description: "Every service, its last deploy and who shipped it.", createdAt: NOW - 5 * 864e5, bindings: 2, visibility: "public", workspace: "ops-board", owner: "lee@example.com" },
    { id: "wordle~a1b2c3d4e5f6g7h8~zq2wm7xk3rp6hab", kind: "blueprint", share: "a1b2c3d4e5f6g7h8", title: "Standup notes", description: "Turns a channel's last day into three bullets.", createdAt: NOW - 9 * 864e5, bindings: 1, workspace: "notes", owner: "kim@example.com" },
  ],
  known: [
    { id: "live-status-2", kind: "live", share: "live-status-2", title: "Deploy status board", description: "Every service, its last deploy and who shipped it.", createdAt: NOW - 5 * 864e5, bindings: 2, visibility: "public", workspace: "ops-board", owner: "lee@example.com" },
  ],
};

/** A Drive with nothing on it: every section shows its own empty line. */
const EMPTY_LIBRARY: SharedLibrary = { slates: [], mine: [], received: [], public: [], known: [] };

/** The share dialog over the Issue triage slate: the live mode with the
 *  capability graph and one public share already open, or the blueprint mode
 *  at the inspection step (`sharedialog-blueprint`). */
function ShareDialogFrame({ mode }: { mode: "live" | "blueprint" }) {

  return (
    <div className="h-screen p-bg p-text">
      <ShareSlateDialog workspace="checkout-fixes" slate="issue-triage" title="Issue triage" rpc={workRpc} onClose={() => {}}
        fixture={{
          mode,
          live: { graph: SHARE_GRAPH, liveShares: [LIVE_SHARE] },
          blueprint: { versions: ["v1a8f3k2mz9q", "v2k9q1c7xw4m"], inspection: BLUEPRINT_INSPECTION, shares: [
            { id: "k7Qm2pV9xRt3aB4c", slate: "issue-triage", kind: "blueprint", publication: "p1", included: ["package.json", "src", "assets"], createdAt: NOW - 3 * 864e5, revokedAt: null, users: ["pat@example.com"] },
          ] },
        }} />
    </div>
  );
}

/** The read-only blueprint page, routed so `useParams` names the id the page
 *  would fetch. `&viewer=signedout` renders the sign-in branch of its one
 *  action. */
function BlueprintFrame() {
  const signedOut = new URLSearchParams(location.search).get("viewer") === "signedout";

  return (
    <Routes>
      <Route path="/shared/blueprint/:id" element={<BlueprintPage fixture={BLUEPRINT_VIEW} viewer={signedOut ? null : "me@example.com"} workspaces={STOCK_ROSTER.entries} />} />
    </Routes>
  );
}

const workRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (method === "listWorkspaceWork") return rpcResult(WORKSPACE_WORK).json<T>();

  if (method === "getEvolutionChangelog") return rpcResult(v.parse(JsonValueSchema, CHANGELOG)).json<T>();

  // The live tool list the journal joins tool entries to: the crafted rows
  // the CHANGELOG digest names, with the EMA scores their cards show.
  if (method === "getToolDescriptions") return rpcResult({
    builtIn: [], executors: [],
    crafted: [
      { name: "bisect_migration", description: "Walk a migration's revisions to find the one that changed a column's shape.", exposure: "codemode", wired: true, qualityScore: 0.82, usageCount: 14 },
      { name: "coupon_replay", description: "Replay a checkout against a coupon code and diff the response.", exposure: "codemode", wired: true, qualityScore: 0.61, usageCount: 3 },
    ],
  }).json<T>();

  return stubRpc<T>(method, args);
};

function PlanReviewFrame() {
  return (
    <div data-gallery-plan-review className="p-bg p-text h-screen">
      <PlanReviewView plan={galleryAgentPlan} rpc={workspacePageRpc} />
    </div>
  );
}


/** `?frame=work&lane=settled`: one decision waiting and no work of any kind in
 *  the background. The plan read answers with a closed task only, so Now has
 *  nothing to show while the journal beneath it still does — and with no job
 *  ever run, the Jobs chip is the empty one. */
const settledOnlyRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (method === "listWorkspaceWork") return rpcResult({
    plans: [],
    tasks: [{
      owner: { actorId: "actor-main", name: "main", retired: false }, plan: null,
      tasks: AGENT_TASKS.filter((task) => task.id === "t1"),
    }],
  }).json<T>();

  return workRpc<T>(method, args);
};

/** `?frame=work&lane=failed`: the work read and the journal read both refuse
 *  over an empty feed, so Now and the journal each owe their own retry — and
 *  the running job, which is a prop and not a read, is still Now's to show. */
const failedReadsRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (method === "listWorkspaceWork") throw new Error("plan fixture failed");

  if (method === "getEvolutionChangelog") throw new Error("journal fixture failed");

  return workRpc<T>(method, args);
};

/** The lanes that photograph an absence: the failed-reads one is about the two
 *  reads and not the queue, and the settled one has never run a job. */
const NO_QUEUE: PendingAction[] = [];

const NO_JOBS: BackgroundJob[] = [];

/** Which Work lane `?frame=work&lane=…` selects. */
function workLane(lane: string | null) {
  if (lane === "settled") {
    return { jobs: NO_JOBS, queue: PENDING_ACTIONS, rpc: settledOnlyRpc, memory: [] };
  }

  if (lane === "failed") {
    return { jobs: BACKGROUND_JOBS.filter((job) => job.status === "running"), queue: NO_QUEUE, rpc: failedReadsRpc, memory: [] };
  }

  return { jobs: BACKGROUND_JOBS, queue: PENDING_ACTIONS, rpc: workRpc, memory: WORK_MEMORIES };
}

/** The workspace's saved memories the `work` frame photographs — oldest first,
 *  the order `getMemoryContent` parses them; Learnings renders the reverse. */
const WORK_MEMORIES: MemoryEntry[] = [
  { path: "memory/MEMORY.md", content: "The gateway's upstream needs a retry budget", matchScore: 1, updatedAt: "2026-09-15", savedBy: "main" },
  { path: "memory/MEMORY.md", content: "Prompt lanes assemble in the order the fixture lists them", matchScore: 1, updatedAt: "2026-09-17", savedBy: "courier" },
];

function WorkFrame() {
  const lane = workLane(new URLSearchParams(location.search).get("lane"));

  return (
    <div className="p-bg min-h-screen flex justify-center">
      <div className="w-[430px] min-h-screen border-x p-border">
        <WorkSurface
          surface="Work" onSurface={() => {}}
          pinnedPorts={[]} previewError={null} onRefreshPorts={() => {}} plan={null} snapshot={{ status: "loading" }} onRetryLoad={() => {}} tools={[]} memory={lane.memory} memoryContent=""
          onSearchMemory={() => {}} mctsTrees={EMPTY_TREES} headActivity={NO_HEAD_ACTIVITY} isStreaming={false}
          executors={[]} executorOutputs={new Map()} onExecute={async () => ({})}
          backgroundJobs={lane.jobs} onRefreshJobs={() => {}} pendingActions={lane.queue}
          tabPresence={{ releases: true, explorations: true, work: true }}
          rpc={lane.rpc}
        />
      </div>
    </div>
  );
}

/**
 * The two halves of a shell approval, in one frame: the queue that hands a
 * standing permission out, and the list that is the only place to take one
 * back.
 *
 * A frame of its own because the Settings page cannot be photographed here at
 * all — it builds its RPC from a live agent socket and the gallery has no
 * worker, so `?frame=settings` renders blank (and did before this change too).
 * The grants card takes nothing but an `rpc`, so it can be fed directly, and
 * `getShellApprovalGrants`/`revokeShellApprovalGrants` having had no caller at
 * all is exactly the kind of gap a photograph closes.
 */
const SHELL_GRANTS = [
  { rule: "rm-recursive", executor: "device" },
  { rule: "sudo", executor: "device" },
  { rule: "docker-destructive", executor: "sandbox" },
];

const approvalsRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (method === "getShellApprovalGrants") return rpcResult({ grants: SHELL_GRANTS }).json<T>();

  if (method === "revokeShellApprovalGrants") return rpcResult({ ok: true, grants: SHELL_GRANTS }).json<T>();

  return workRpc<T>(method, args);
};

function ApprovalsFrame() {
  return (
    <div className="p-bg min-h-screen flex justify-center">
      <div className="w-[720px] min-h-screen border-x p-border p-5 space-y-5">
        <WorkSurface
          surface="Work" onSurface={() => {}}
          pinnedPorts={[]} previewError={null} onRefreshPorts={() => {}} plan={null} snapshot={{ status: "loading" }} onRetryLoad={() => {}} tools={[]} memory={[]} memoryContent=""
          onSearchMemory={() => {}} mctsTrees={EMPTY_TREES} headActivity={NO_HEAD_ACTIVITY} isStreaming={false}
          executors={[]} executorOutputs={new Map()} onExecute={async () => ({})}
          backgroundJobs={[]} onRefreshJobs={() => {}} pendingActions={PARKED_ONLY}
          rpc={approvalsRpc}
        />
        <StandingApprovalsCard rpc={approvalsRpc} />
      </div>
    </div>
  );
}

/** Only the parked commands: the rest of the queue is photographed by `work`,
 *  and this frame is about one card. */
const PARKED_ONLY: PendingAction[] = PENDING_ACTIONS.filter((a) => a.kind === "deferred_action");

/** A settled-empty lane: no tasks, no journal entries. Both Work frames that
 *  photograph absence share it, so the second is not a copy of the first. */
const settledEmptyRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (method === "listWorkspaceWork") return rpcResult({ plans: [], tasks: [] }).json<T>();

  if (method === "getEvolutionChangelog") return rpcResult({ entries: [], unseenCount: 0, seenAt: 0 }).json<T>();

  return stubRpc<T>(method, args);
};

/** The same column before anything has happened — the state a fresh workspace
 *  opens on, which is the one an empty-state has to earn its copy in. */
function WorkEmptyFrame() {
  return (
    <div className="p-bg min-h-screen flex justify-center">
      <div className="w-[720px] h-screen border-x p-border">
        <WorkSurface
          surface="Work" onSurface={() => {}}
          pinnedPorts={[]} previewError={null} onRefreshPorts={() => {}} plan={null} snapshot={{ status: "loading" }} onRetryLoad={() => {}} tools={[]} memory={[]} memoryContent=""
          onSearchMemory={() => {}} mctsTrees={EMPTY_TREES} headActivity={NO_HEAD_ACTIVITY} isStreaming={false}
          executors={[]} executorOutputs={new Map()} onExecute={async () => ({})}
          backgroundJobs={[]} onRefreshJobs={() => {}} pendingActions={[]}
          tabPresence={{ releases: false, explorations: false, work: false }}
          rpc={settledEmptyRpc}
        />
      </div>
    </div>
  );
}

/* ── Environment ────────────────────────────────────────────────── */

/**
 * The four places the agent can act, as the surface lists them.
 *
 * Photographed with every environment reachable, because the defect this frame
 * exists to catch is a naming one: two rows that describe the same thing read
 * as a duplicate, and only a picture of the row set together shows it.
 */
const ENVIRONMENT_EXECUTORS: ExecutorInfo[] = [
  {
    name: "device", kind: "device", available: true, configured: true, active: true, status: "active",
    // The user's own name for the device, exactly as the consent contract
    // carries it — the card renders THIS, never "device".
    label: "Ashish's MacBook",
    capabilities: ["shell", "npm", "git", "docker", "fs_owned", "process_spawn"],
  },
  {
    name: "sandbox", kind: "sandbox", available: true, configured: true, active: true, status: "active",
    capabilities: ["shell", "npm", "git", "fs_owned", "net_inbound", "process_long"],
  },
  {
    name: "workspace", kind: "workspace", available: true, configured: true, active: true, status: "active",
    capabilities: ["javascript", "typescript", "python", "shell", "npm", "fs_shared"],
  },
];


/* ── Files — the composite drive ────────────────────────────────── */

/**
 * The drive's scripted composite plane: the workspace tree with /pc and
 * /sandbox mounted, held MUTABLE inside the frame so the browser gate can
 * prove rename and delete against the real components. Contents feed the
 * text preview; `binary-weights.bin` exercises the honest binary refusal.
 */
function seedCompositeTree(offlineDevice: boolean): Map<string, DirEntry[]> {
  const tree = new Map<string, DirEntry[]>([
    ["/", [
      { name: "home", type: "dir", mtimeMs: NOW - 4 * 36e5 },
      ...(offlineDevice ? [] : [{ name: "pc", type: "dir" as const, mtimeMs: NOW - 60e3 }]),
      { name: "sandbox", type: "dir", mtimeMs: NOW - 30 * 60e3 },
    ]],
    ["/home", [{ name: "user", type: "dir", mtimeMs: NOW - 4 * 36e5 }]],
    ["/home/user", [
      { name: "memory", type: "dir", mtimeMs: NOW - 26e5 },
      { name: "skills", type: "dir", mtimeMs: NOW - 20 * 864e5 },
      { name: "AGENTS.md", type: "file", size: 2_148, mtimeMs: NOW - 3 * 864e5 },
      { name: "SOUL.md", type: "file", size: 913, mtimeMs: NOW - 9 * 864e5 },
      { name: "notes.md", type: "file", size: 4_402, mtimeMs: NOW - 42e5 },
      { name: "binary-weights.bin", type: "file", size: 4_089_446, mtimeMs: NOW - 6 * 864e5 },
    ]],
    ["/home/user/memory", [{ name: "MEMORY.md", type: "file", size: 1_204, mtimeMs: NOW - 26e5 }]],
    ["/home/user/skills", [{ name: "sql-triage.md", type: "file", size: 2_010, mtimeMs: NOW - 20 * 864e5 }]],
    ["/sandbox", [{ name: "workspace", type: "dir", mtimeMs: NOW - 30 * 60e3 }]],
    ["/sandbox/workspace", [
      { name: "build.log", type: "file", size: 18_211, mtimeMs: NOW - 31 * 60e3 },
      { name: "dist", type: "dir", mtimeMs: NOW - 30 * 60e3 },
    ]],
    ["/sandbox/workspace/dist", [{ name: "app.js", type: "file", size: 220_114, mtimeMs: NOW - 30 * 60e3 }]],
  ]);

  if (!offlineDevice) {
    // `/pc` is the roster: one entry per live machine, by its mount segment.
    // The machine's tree BELOW its consented root follows; `/pc/<name>` and
    // `/pc/<name>/home` are deliberately absent: the machine's own path guard
    // refuses everything outside `PC_CONSENTED_ROOT`, and a fixture that
    // listed them could not fail the way the owner's report failed.
    tree.set("/pc", [{ name: PC_SEGMENT, type: "dir", mtimeMs: NOW - 36e5 }]);
    tree.set(PC_CONSENTED_ROOT, [
      { name: "quarterly-report.txt", type: "file", size: 8_412, mtimeMs: NOW - 2 * 36e5 },
      { name: "shot.png", type: "file", size: 1_204_002, mtimeMs: NOW - 5 * 36e5 },
      { name: "notes.html", type: "file", size: 402, mtimeMs: NOW - 36e5 },
    ]);
  }

  return tree;
}

/** The machine's mount segment under `/pc`: its own name, as
 *  `deviceMountSegment` keys a fleet of one. */
const PC_SEGMENT = "Ashish's MacBook";

/** The machine's mount point: every machine sits at `/pc/<name>`. */
const PC_MOUNT = `/pc/${PC_SEGMENT}`;

/**
 * The device's consented directory. Production learns it from the machine
 * (`deviceFiles`' homeDir), and a bare `/pc/<name>` lands here instead of on
 * the device root nobody consented to.
 */
const PC_CONSENTED_ROOT = `${PC_MOUNT}/home/dev`;

const FILES_TEXT = {
  "/home/user/notes.md": "# Checkout coupon regression\n\n- kind:null rows come from the 0412 migration\n- the serializer guards only percentage coupons\n- fix drafted in packages/checkout/src/apply-coupon.ts\n",
  "/home/user/SOUL.md": "I keep this workspace's changes small and proven.\n",
  "/home/user/AGENTS.md": "## Working agreements\n\nRun the checkout suite before claiming a fix.\n",
  [`${PC_CONSENTED_ROOT}/quarterly-report.txt`]: "Q3 numbers, draft 2 — do not circulate.\n",
  [`${PC_CONSENTED_ROOT}/notes.html`]: "<h1>Q3 close</h1><p>Signed off by finance.</p>\n",
  "/sandbox/workspace/build.log": "$ bun run build\nbundled 412 modules in 1.9s\nok\n",
} satisfies Record<string, string>;

interface PreviewDeferred {
  readonly promise: Promise<{ content: string; revision: number }>;
  resolve(value: { content: string; revision: number }): void;
}

/**
 * ONE stateful frame for both the Environment tab and the Files drive: the
 * surface strip is live (`onSurface` is real state), so an Environment card's
 * Files action genuinely lands the drive — the exact wiring the browser gate
 * proves. `frame=environment` and `frame=files` differ only in where they
 * start and how wide they photograph.
 */
function DriveFrame({ initialSurface, offlineDevice, width, deferPreview = false }: {
  initialSurface: SurfaceKind;
  offlineDevice: boolean;
  width: string;
  /** Fixture control for the real FilesSurface stale-preview proof. The held
   *  value is transport input only; FilesSurface/FileViewer decide whether it
   *  may paint after refresh changes their resource identity. */
  deferPreview?: boolean;
}) {
  const [surface, setSurface] = useState<SurfaceKind>(initialSurface);

  const executors = useMemo<ExecutorInfo[]>(() => offlineDevice
    ? ENVIRONMENT_EXECUTORS.map((exec) => exec.name === "device"
      ? { ...exec, available: false, active: false, status: "disconnected" as const, reason: "no device connected" }
      : exec)
    : ENVIRONMENT_EXECUTORS, [offlineDevice]);

  const [store] = useState(() => seedCompositeTree(offlineDevice));
  const [contents] = useState(() => new Map(Object.entries(FILES_TEXT)));
  const heldPreview = useRef<PreviewDeferred | null>(null);
  const heldPreviewContent = useRef("");
  const previewReads = useRef(0);

  const mounts: MountInfo[] = [
    { name: "workspace", prefix: "workspace.*", live: true, policy: { readOnly: false, consistency: "durable" }, reason: null },
    offlineDevice
      ? { name: "device", prefix: "device.*", live: false, policy: { readOnly: false, consistency: "live-shared" }, reason: "no device connected" }
      : { name: "device", prefix: "device.*", live: true, policy: { readOnly: false, consistency: "live-shared" }, reason: null },
    { name: "sandbox", prefix: "sandbox.*", live: true, policy: { readOnly: false, consistency: "ephemeral" }, reason: null },
  ];

  const filesRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
    const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
    const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

    if (method === "listMounts") return rpcResult(v.parse(JsonValueSchema, mounts)).json<T>();

    if (method === "getExecutorFiles") {
      const [execName, path] = v.parse(v.tuple([v.string(), v.string()]), args ?? []);

      if (execName !== "workspace") return rpcResult({ error: `Executor "${execName}" has no listing here` }).json<T>();
      const asked = path === "" ? "/" : path;
      // A bare machine root lands on that machine's consented root, exactly
      // as `read-models/files.ts` mountLanding resolves it server-side; the
      // fleet root `/pc` is the roster and lands on itself.
      const dir = asked === PC_MOUNT ? PC_CONSENTED_ROOT : asked;
      const entries = store.get(dir);

      if (entries !== undefined) return rpcResult(v.parse(JsonValueSchema, { path: dir, entries })).json<T>();

      // Inside the machine's mount but outside the consented root: the
      // device's own refusal, in the words `deviceFiles`' path guard uses.
      const error = dir.startsWith(PC_MOUNT)
        ? `EACCES: '${dir.slice(PC_MOUNT.length) || "/"}' is outside the consented device directory `
          + `'${PC_CONSENTED_ROOT.slice(PC_MOUNT.length)}' — grant this agent the full-filesystem `
          + `consent tier to reach it, list '${dir.slice(PC_MOUNT.length) || "/"}'`
        : `ENOENT: ${dir}`;

      return rpcResult({ error }).json<T>();
    }

    if (method === "readExecutorFile") {
      const [, path] = v.parse(v.tuple([v.string(), v.string()]), args ?? []);
      const content = contents.get(path);

      if (deferPreview && previewReads.current++ === 0) {
        heldPreviewContent.current = content ?? "";
        heldPreview.current = Promise.withResolvers<{ content: string; revision: number }>();

        return heldPreview.current.promise.then((answer) => rpcResult(answer).json<T>());
      }

      return rpcResult(content === undefined
        ? { error: "binary file — not previewable" }
        : { content, revision: 1 }).json<T>();
    }

    if (method === "renameExecutorFile") {
      const [, from, to] = v.parse(v.tuple([v.string(), v.string(), v.string()]), args ?? []);
      const listing = store.get(dirOf(from)) ?? [];
      const entry = listing.find((e) => e.name === nameOf(from));

      if (!entry) return rpcResult({ error: `no such file or directory: ${from}` }).json<T>();

      if ((store.get(dirOf(to)) ?? []).some((e) => e.name === nameOf(to))) {
        return rpcResult({ error: `${to} already exists` }).json<T>();
      }

      store.set(dirOf(from), sortDirEntries([
        ...listing.filter((e) => e !== entry),
        ...(dirOf(from) === dirOf(to) ? [{ ...entry, name: nameOf(to) }] : []),
      ]));
      // Collect first, mutate after: setting new keys while iterating a Map
      // visits them (spec), and a rename-into-own-subtree shape would loop.
      const moved = new Map<string, DirEntry[]>();

      for (const [key, held] of store) {
        if (key === from || key.startsWith(`${from}/`)) {
          moved.set(to + key.slice(from.length), held);
        }
      }

      for (const key of moved.keys()) store.delete(from + key.slice(to.length));

      for (const [key, entries] of moved) store.set(key, entries);
      const content = contents.get(from);

      if (content !== undefined) { contents.set(to, content); contents.delete(from); }

      return rpcResult({ ok: true }).json<T>();
    }

    if (method === "deleteExecutorFile") {
      const [, path] = v.parse(v.tuple([v.string(), v.string()]), args ?? []);
      const listing = store.get(dirOf(path)) ?? [];

      if (!listing.some((e) => e.name === nameOf(path))) {
        return rpcResult({ error: `no such file or directory: ${path}` }).json<T>();
      }

      store.set(dirOf(path), listing.filter((e) => e.name !== nameOf(path)));

      // Map iterators are deletion-safe by spec; no snapshot needed.
      for (const key of store.keys()) {
        if (key === path || key.startsWith(`${path}/`)) store.delete(key);
      }

      contents.delete(path);

      return rpcResult({ ok: true }).json<T>();
    }

    return stubRpc<T>(method, args);
  };

  // The line terminal paints EXECUTOR OUTPUT, so a terminal with none proves
  // only that it mounted. This executor echoes each line of the command it was
  // given and ends each with LF, exactly as a program does — the byte the pane
  // must convert to CR LF, and the one reading that shows whether a pasted
  // multi-line command arrived as one call or lost every line after the first.
  const [executorOutputs, setExecutorOutputs] = useState<Map<string, ExecutorOutput[]>>(new Map());

  const runCommand = async (name: string, command: string): Promise<ExecutorCommandResult> => {
    const stdout = `${command.split("\n").map((line) => `ran: ${line}`).join("\n")}\n`;
    setExecutorOutputs((prev) => {
      const written = prev.get(name) ?? [];

      return new Map(prev).set(name, [...written, {
        id: `terminal-${name}-${String(written.length)}`, command,
        stdout, stdout_len: stdout.length, stderr: "", stderr_len: 0,
        exit_code: 0, created_at: NOW,
      }]);
    });

    return { stdout, exitCode: 0 };
  };

  return (
    <div className="p-bg min-h-screen flex justify-center">
      <div className={`${width} h-screen border-x p-border`}>
        {deferPreview && (
          <div className="absolute z-20 flex gap-2 p-2">
            <button data-files-fixture-mutate type="button" onClick={() => {
              const path = "/home/user/notes.md";
              contents.set(path, "# Fresh after refresh\n\nThe older reply must not reclaim this preview.\n");
              store.set("/home/user", (store.get("/home/user") ?? []).map((entry) => (
                entry.name === "notes.md" ? { ...entry, mtimeMs: Date.now() } : entry
              )));
            }}>Mutate preview source</button>
            <button data-files-fixture-release type="button"
              onClick={() => heldPreview.current?.resolve({ content: heldPreviewContent.current, revision: 1 })}>
              Release stale preview
            </button>
          </div>
        )}
        <WorkSurface
          surface={surface} onSurface={setSurface}
          pinnedPorts={[]} previewError={null} onRefreshPorts={() => {}} plan={null} snapshot={{ status: "loading" }} onRetryLoad={() => {}} tools={[]} memory={[]} memoryContent=""
          onSearchMemory={() => {}} mctsTrees={EMPTY_TREES} headActivity={NO_HEAD_ACTIVITY} isStreaming={false}
          executors={executors} executorOutputs={executorOutputs}
          onExecute={runCommand} lastActiveExecutor="workspace"
          backgroundJobs={[]} onRefreshJobs={() => {}} pendingActions={[]}
          rpc={filesRpc}
        />
      </div>
    </div>
  );
}

/* ── Supervise ──────────────────────────────────────────────────── */

// The SUPERVISE altitude — the agent over time. Every block is fed so the type
// roles that carry it (`.p-meta` on the timestamps, the token counts) are
// actually on screen; an empty board photographs its empty states and tells
// you nothing about the scale it renders real rows at.

/** Typed, so the fixtures move with `RunSummary` instead of only failing at the
 *  browser-side valibot parse. The second run is deliberately a SILENT one — the
 *  provider reported nothing for any of its turns — because that is the case the
 *  history block has to render as unreported rather than as free.
 *
 *  Longer than one page on purpose: the block pages the history, so a frame
 *  that never crosses a page boundary cannot show whether the pager works. */
const SUPERVISE_RUNS: RunSummary[] = [
  {
    runId: "run_9c1", startedAt: NOW - 45 * 60e3, causedBy: "chat",
    userMessage: "Why does the percentage coupon drop off at checkout?",
    status: "completed", eventCount: 62, turnsWithoutUsage: 0,
    usage: { input: 184_320, output: 9_140, cacheRead: 121_400 },
  },
  {
    runId: "run_9b7", startedAt: NOW - 6 * 36e5, causedBy: "timer",
    userMessage: null, status: "completed", eventCount: 18,
    usage: {}, turnsWithoutUsage: 3,
  },
  ...olderRuns(),
];

/** The runs behind the first page — a week of turns, so the boundary and the
 *  end of the history are both reachable in the frame. */
function olderRuns(): RunSummary[] {
  const asked = [
    "Which migration dropped the coupon index?",
    "Show me every reader of rules[kind]",
    "Does the cart serializer already guard this?",
    "Run the checkout suite against the fix",
    "Why is the admin report still 500ing?",
    null,
  ];

  return Array.from({ length: 40 }, (_, i) => {
    const silent = i % 9 === 8;
    const asking = asked[i % asked.length] ?? null;

    return {
      runId: `run_8${String(99 - i).padStart(2, "0")}`,
      startedAt: NOW - (7 + i) * 36e5,
      causedBy: asking === null ? "timer" : "chat",
      userMessage: asking,
      status: i % 11 === 7 ? "aborted" : "completed",
      eventCount: 12 + ((i * 7) % 50),
      usage: silent ? {} : {
        input: 12_000 + i * 1_400,
        output: 800 + i * 60,
        cacheRead: i % 3 === 0 ? 0 : 6_000 + i * 900,
      },
      turnsWithoutUsage: silent ? 2 : 0,
    };
  });
}

const SUPERVISE_TRIGGERS = [
  {
    id: "01K5ZQ8F2P0000000000000WH1", kind: "webhook_durable", state: "active",
    created_at: NOW - 12 * 864e5, spec: { label: "deploy-failed" },
    rate_limit_per_min: 30, fire_count: 41,
    last_fire_at: NOW - 3 * 36e5, next_fire_at: null,
    url: "/api/workspaces/checkout-fixes/webhook/01K5ZQ8F2P0000000000000WH1"
      + "/v1-4f1c9a02d7b64e8fa3105c6d29be7a41",
  },
  {
    id: "trg_tm1", kind: "timer_cron", state: "active", created_at: NOW - 30 * 864e5,
    spec: { cron: "0 9 * * 1" }, fire_count: 4,
    last_fire_at: NOW - 3 * 864e5, next_fire_at: NOW + 4 * 864e5,
  },
];

const SUPERVISE_JOBS: BackgroundJob[] = [
  {
    id: "bgjob-71ae4c02", kind: "heads", label: "Audit the CLI surface", status: "running",
    workMode: "build", result: null, error: null, createdAt: NOW - 4 * 60e3, settledAt: null,
  },
  {
    id: "bgjob-70bd19f7", kind: "mcts", label: "Pick a migration-backfill approach",
    workMode: "build", status: "completed", result: "Settled on the backfill-on-read approach", error: null,
    createdAt: NOW - 50 * 60e3, settledAt: NOW - 41 * 60e3,
  },
];

/** What the Evolution block gates on: one entry per kind the changelog can
 *  carry here, so the section only exists because a change already happened.
 *  `supervisefresh` answers the empty digest instead and the block is absent —
 *  until `gallery:supervise-evolve`, the window event the browser gate uses to
 *  land one change on a live page. The same event pair drives the jobs read:
 *  `supervisefresh` starts with `listBackgroundJobs` failing and
 *  `gallery:supervise-jobs-heal` repairs it, so a broken read and its retry
 *  are photographable too; `gallery:supervise-evolution-fail` makes the next
 *  digest read throw ONCE, so a refresh failure over last-good entries is
 *  observable too. The `changesOnly` flag is answered the way the real
 *  read answers it — measurement kinds filtered before the limit — because a
 *  fixture that ignored it would photograph a section that cannot exist. */
const SuperviseChangelogArgsSchema = v.object({
  limit: v.optional(v.number()),
  changesOnly: v.optional(v.boolean()),
});

interface SuperviseChangelogDigest {
  seenAt: number; unseenCount: number; entries: EvolutionEntry[];
}

const SUPERVISE_CHANGELOG: SuperviseChangelogDigest = {
  seenAt: NOW - 30e5, unseenCount: 2,
  entries: [
    { id: "cl_s1", kind: "scaffold", at: NOW - 10e5,
      summary: "Rewrote the tool preamble — shorter, and it stops re-reading files it just wrote",
      evidence: "shadow eval: 7 trials · 5 pending wins · 1 regression · 1 tie" },
    { id: "cl_s2", kind: "outcomes", at: NOW - 20e5,
      summary: "Graded 6 turns · 4 accepted · 2 corrected",
      evidence: "window closed after the deploy-failed run" },
    { id: "cl_s3", kind: "fact", at: NOW - 50e5,
      summary: "Remembered: percentage coupons carry kind:null after Tuesday's migration",
      evidence: null },
  ],
};

const SUPERVISE_EMPTY_CHANGELOG: SuperviseChangelogDigest = { seenAt: NOW, unseenCount: 0, entries: [] };

/** What `supervisefresh` answers after `gallery:supervise-evolve`: the ONE
 *  change that landed on the live page — the real `changesOnly` read answers
 *  exactly this, the newest change inside the limit. */
const SUPERVISE_EVOLVED_CHANGELOG: SuperviseChangelogDigest = {
  seenAt: NOW, unseenCount: 1,
  entries: [
    { id: "cl_e1", kind: "scaffold", at: NOW - 5 * 60e3,
      summary: "I improved how I work (won 4 of 6 trial runs)",
      evidence: "Promoted scaffold v9 — session reflection · shadow 4W-1L-1T" },
  ],
};

const superviseRpc =
  (state: { current: { evolved: boolean; jobsHealthy: boolean; evolutionFailNext: boolean } },
    evolvedAtStart: boolean): Rpc =>
  async <T,>(method: string, args?: unknown[]): Promise<T> => {
    if (method === "getEvolutionChangelog") {
      // One armed failure, consumed by whichever read reaches it first — the
      // gate needs the failure to land over last-good entries, not to persist.
      if (state.current.evolutionFailNext) {
        state.current.evolutionFailNext = false;

        throw new Error("evolution digest fixture failed");
      }

      const request = v.parse(SuperviseChangelogArgsSchema, args?.[0] ?? {});

      const evolved = state.current.evolved ? SUPERVISE_EVOLVED_CHANGELOG : SUPERVISE_EMPTY_CHANGELOG;
      const changelog = evolvedAtStart ? SUPERVISE_CHANGELOG : evolved;

      const entries = request.changesOnly === true
        ? changelog.entries.filter((entry) => entry.kind !== "outcomes" && entry.kind !== "replay")
        : changelog.entries;

      return rpcResult({ ...changelog, entries }).json<T>();
    }

    if (method === "getRunSummaries") {
      const request = v.parse(GalleryPageRequestSchema, args?.[0] ?? {});
      const limit = request.limit ?? 30;
      const after = request.cursor?.after;
      const start = after === undefined ? 0 : SUPERVISE_RUNS.findIndex((run) => run.runId === after) + 1;

      return rpcResult(v.parse(JsonValueSchema, seekPage(
        SUPERVISE_RUNS.slice(start, start + limit + 1), limit, (run) => run.runId,
      ))).json<T>();
    }

    if (method === "listTriggers") return rpcResult(v.parse(JsonValueSchema, { triggers: SUPERVISE_TRIGGERS })).json<T>();

    if (method === "listBackgroundJobs") {
      if (!state.current.jobsHealthy) throw new Error("jobs fixture failed");

      return rpcResult(v.parse(JsonValueSchema, SUPERVISE_JOBS)).json<T>();
    }

    return stubRpc<T>(method, args);
  };

function SuperviseFrame({ evolved = true }: { evolved?: boolean }) {
  // What the two window events flip. The fresh frame starts with an empty
  // digest AND a failing jobs read so both transitions are observable on the
  // page's own revalidation cadence — the evolved frame stays healthy
  // throughout, its digest already populated.
  const state = useRef({ evolved, jobsHealthy: evolved, evolutionFailNext: false });
  useEffect(() => {
    const evolve = () => { state.current.evolved = true; };

    const heal = () => { state.current.jobsHealthy = true; };

    const failEvolution = () => { state.current.evolutionFailNext = true; };

    window.addEventListener("gallery:supervise-evolve", evolve);
    window.addEventListener("gallery:supervise-jobs-heal", heal);
    window.addEventListener("gallery:supervise-evolution-fail", failEvolution);

    return () => {
      window.removeEventListener("gallery:supervise-evolve", evolve);
      window.removeEventListener("gallery:supervise-jobs-heal", heal);
      window.removeEventListener("gallery:supervise-evolution-fail", failEvolution);
    };
  }, []);

  const rpc = useMemo(() => superviseRpc(state, evolved), [evolved]);

  return (
    <div className="p-bg p-text min-h-screen">
      <SupervisePage rpc={rpc} />
    </div>
  );
}


/* ── Activity ───────────────────────────────────────────────────── */

/** The turn loop's own window over 344 steps. `cacheRead` is a SUBSET of
 *  `input`, never an addition to it. */
const AGENT_TOKENS: Usage = {
  input: 21_480_312, output: 512_884, cacheRead: 18_942_006, reasoning: 41_220,
};

/** The same window as Workers AI reports it. `neurons` is Cloudflare's own
 *  billing unit and comes back on every call — 0.120 per token, captured live —
 *  and it is the figure the Cost block has to carry rather than discard. */
const AGENT_TOKENS_METERED: Usage = { ...AGENT_TOKENS, neurons: 2_639_183 };

/**
 * One producer per absence rule the Cost block claims, because the failure this
 * frame exists to catch is a zero standing in for a silence:
 *   agent    — Workers AI: measured, priced, and the only row reporting neurons
 *   judge    — Anthropic: measured and priced, reports NO neurons at all, and
 *              is the ONE provider that reports a 1h cache-retention split, so
 *              18 of its calls are priced at the 5m rate and its dollars are a
 *              floor for a second, different reason from `fast`'s
 *   fast     — 44 calls carried no catalog rate, so its dollars are a floor
 *   head     — 2 calls reported nothing, so its tokens AND dollars are floors
 *   mcts     — measured with no rate anywhere: dollars absent, never $0
 *   platform — the embedder and toMarkdown: counted, never measured, ever
 * Largest measured token total first and the unmeasured producer last, the order
 * `workspaceSpend` returns them in (read-models/workspace-spend.ts).
 */
const ACTIVITY_PRODUCERS: ProducerSpend[] = [
  {
    source: "agent", calls: 344, callsWithoutUsage: 0, usage: AGENT_TOKENS_METERED,
    usd: 11.98, unpricedCalls: 0, floorPricedCalls: 0,
  },
  {
    source: "judge", calls: 62, callsWithoutUsage: 0,
    usage: {
      input: 1_284_400, output: 96_120, cacheRead: 812_000,
      cacheWrite: 96_400, cacheWrite1h: 71_200,
    },
    usd: 3.41, unpricedCalls: 0, floorPricedCalls: 18,
  },
  {
    source: "fast", calls: 210, callsWithoutUsage: 0,
    usage: { input: 402_118, output: 18_440, neurons: 50_467 },
    usd: 0.0142, unpricedCalls: 44, floorPricedCalls: 0,
  },
  {
    source: "head", calls: 12, callsWithoutUsage: 2,
    usage: { input: 288_004, output: 31_902 }, usd: 0.86, unpricedCalls: 0, floorPricedCalls: 0,
  },
  {
    source: "mcts", calls: 28, callsWithoutUsage: 0,
    usage: { input: 96_210, output: 12_004, neurons: 12_986 },
    unpricedCalls: 28, floorPricedCalls: 0,
  },
  {
    source: "platform", calls: 91, callsWithoutUsage: 91, usage: {},
    unpricedCalls: 0, floorPricedCalls: 0,
  },
];

/** Every producer measuring and pricing everything, over a window that reached
 *  the end of the log — the state the panel is allowed to state positively, and
 *  an Anthropic workspace, so the neurons column must vanish rather than print a
 *  column of dashes. */
const CLEAN_PRODUCERS: ProducerSpend[] = [
  {
    source: "agent", calls: 344, callsWithoutUsage: 0, usage: AGENT_TOKENS,
    usd: 11.98, unpricedCalls: 0, floorPricedCalls: 0,
  },
  {
    source: "judge", calls: 62, callsWithoutUsage: 0,
    usage: { input: 1_284_400, output: 96_120, cacheRead: 812_000 },
    usd: 3.41, unpricedCalls: 0, floorPricedCalls: 0,
  },
  {
    source: "fast", calls: 210, callsWithoutUsage: 0,
    usage: { input: 402_118, output: 18_440 }, usd: 0.42, unpricedCalls: 0, floorPricedCalls: 0,
  },
];

/** One step's exact composed content, so the frame photographs the whole surface
 *  rather than the Cost block over an empty breakdown. */
const ACTIVITY_CONTEXT: ContextComposition = {
  segments: [
    { plane: "system", label: "Core instructions", chars: 18_400, items: 1 },
    { plane: "system", label: "Workspace brief", chars: 3_120, items: 1 },
    { plane: "tools", label: "shell", chars: 2_840, items: 1 },
    { plane: "tools", label: "edit", chars: 3_610, items: 1 },
    { plane: "tools", label: "read", chars: 2_180, items: 1 },
    { plane: "messages", label: "tool", chars: 328_900, items: 96 },
    { plane: "messages", label: "assistant", chars: 214_600, items: 58 },
    { plane: "messages", label: "user", chars: 9_420, items: 11 },
    { plane: "ephemeral", label: "Plan", chars: 1_980, items: 1 },
    { plane: "ephemeral", label: "Open files", chars: 2_240, items: 1 },
  ],
  measuredChars: 587_290,
  charsPerToken: CHARS_PER_TOKEN,
  estimatedTokens: 146_822,
};

const ACTIVITY_LATEST = {
  at: NOW - 90e3,
  runId: "run-8c41f0",
  stepIndex: 7,
  usage: { input: 148_204, output: 1_842, cacheRead: 131_072, reasoning: 604, neurons: 18_005 },
  context: ACTIVITY_CONTEXT,
} satisfies NonNullable<ActivitySnapshot["latest"]>;

const ACTIVITY_CACHE_HIT = {
  samples: 344, last: 0.94, ema: 0.91, mean: 0.88, p95: 0.97, p99: 0.99, emaAlpha: 0.2, warms: 2,
};

/** Two labels, one nested inside the other and one already spent — the mission
 *  half of the breakdown, and the cases its cells have to survive: a cap in
 *  dollars, a cap in tokens, blended pricing, and a `spent` badge. */
const ACTIVITY_MISSIONS: WorkspaceSpend["missions"] = [
  {
    label: "checkout-fixes", parent: null, limits: { usd: 25 },
    spent: { tokens: 24_222_394, usd: 16.26 }, remaining: { usd: 8.74 },
    pricing: { blendedTokens: 0, source: "catalog" }, calls: 747, spawns: 3, exhausted: false,
  },
  {
    label: "checkout-fixes/regression-sweep", parent: "checkout-fixes",
    limits: { tokens: 2_000_000 },
    spent: { tokens: 2_004_118, usd: 1.42 }, remaining: { tokens: 0 },
    pricing: { blendedTokens: 118_400, source: "mixed" }, calls: 96, spawns: 0, exhausted: true,
  },
];

/** One turn's worth of real `logActivity` names, oldest first — the order
 *  `readActivityLog` returns. Covers the shapes the row has to render: a
 *  detail that overflows its column, and `elapsedMs: 0`, which `logActivity`
 *  writes when the row was cut outside a turn and which must read as an em dash
 *  rather than a 0 ms measurement. */
const ACTIVITY_LOG: ActivitySnapshot["log"] = [
  { event: "steer_queued", detail: "look at the tests too", elapsedMs: 0, createdAt: NOW - 96e3 },
  { event: "beforeturn", detail: "streamText() called next", elapsedMs: 4, createdAt: NOW - 95e3 },
  {
    event: "gettools_rebuilding", detail: "build:eval,run,file,agents,memory,tasks,web:3:1757011200000:0 → build:eval,run,file,agents,memory,tasks,web:4:1757011260000:0",
    elapsedMs: 11, createdAt: NOW - 95e3,
  },
  {
    event: "gettools_end", detail: "rebuilt — 24 tools", elapsedMs: 287,
    createdAt: NOW - 94e3,
  },
  {
    event: "skills_active", detail: "cloudflare,durable-objects,test-driven-development",
    elapsedMs: 291, createdAt: NOW - 94e3,
  },
  {
    event: "compaction",
    detail: "kept 18 of 46 messages — 132,904 chars over the 120,000 trigger, "
      + "summarised the dropped prefix into one system note",
    elapsedMs: 3_918, createdAt: NOW - 92e3,
  },
  { event: "response_complete", detail: "ok", elapsedMs: 41_602, createdAt: NOW - 90e3 },
];

/**
 * The panel's own question, photographed: `$11.98 over 344 priced steps` is the
 * agent's turns, and the workspace spent $16.26+ over 747 calls of which 87.6%
 * were measured at all. Every qualifier is live here — a truncated window, a
 * silent producer, a partial one and 72 unpriced calls — which is the case the
 * composed caveat line has to survive without becoming four paragraphs.
 */
const ACTIVITY_SNAPSHOT: ActivitySnapshot = {
  latest: ACTIVITY_LATEST,
  contextWindow: 200_000,
  telemetry: {
    steps: 344, windowLimit: 2000, tokens: AGENT_TOKENS_METERED, cacheHit: ACTIVITY_CACHE_HIT,
    usd: 11.98, pricedSteps: 344, unpricedSteps: 0, stepsWithoutUsage: 0,
  },
  spend: {
    producers: ACTIVITY_PRODUCERS,
    total: {
      calls: 747, callsWithoutUsage: 93, unpricedCalls: 72, floorPricedCalls: 18,
      usd: 16.2642,
      usage: {
        input: 23_551_044, output: 671_350, cacheRead: 19_754_006, reasoning: 41_220,
        neurons: 2_702_636,
        // Only `judge` writes cache here, and it is also the only producer whose
        // provider reports the retention split, so these are its numbers alone.
        cacheWrite: 96_400, cacheWrite1h: 71_200,
      },
    },
    coverage: {
      calls: 747, measured: 654, reported: 654 / 747, silent: ["platform"], partial: ["head"],
    },
    // (23_551_044 + 671_350 - 21_480_312 - 512_884) / (23_551_044 + 671_350)
    offTurnShare: 0.09203045743537984,
    missions: ACTIVITY_MISSIONS,
  },
  log: ACTIVITY_LOG,
};

/** The same workspace on a provider that reports no neurons, with nothing left
 *  to qualify: 100% of known callers reported and every call priced. */
const ACTIVITY_CLEAN: ActivitySnapshot = {
  ...ACTIVITY_SNAPSHOT,
  latest: { ...ACTIVITY_LATEST, usage: { input: 148_204, output: 1_842, cacheRead: 131_072, reasoning: 604 } },
  telemetry: { ...ACTIVITY_SNAPSHOT.telemetry, tokens: AGENT_TOKENS },
  spend: {
    producers: CLEAN_PRODUCERS,
    total: {
      calls: 616, callsWithoutUsage: 0, unpricedCalls: 0, floorPricedCalls: 0, usd: 15.81,
      usage: {
        input: 23_166_830, output: 627_444, cacheRead: 19_754_006, reasoning: 41_220,
      },
    },
    coverage: { calls: 616, measured: 616, reported: 1, silent: [], partial: [] },
    // (23_166_830 + 627_444 - 21_480_312 - 512_884) / (23_166_830 + 627_444)
    offTurnShare: 0.07569375724596598,
    missions: [],
  },
};

/** A workspace that has made no model call at all. `coverage.reported` is null
 *  here, and the panel has to say there is no fraction rather than print 0% —
 *  a call nobody made is not a call a provider failed to report. */
const ACTIVITY_FRESH: ActivitySnapshot = {
  latest: null,
  contextWindow: null,
  telemetry: {
    steps: 0, windowLimit: 2000, tokens: {}, usd: 0, pricedSteps: 0, unpricedSteps: 0,
    stepsWithoutUsage: 0,
    cacheHit: { samples: 0, last: null, ema: null, mean: null, p95: null, p99: null, emaAlpha: 0.2, warms: 0 },
  },
  spend: {
    producers: [],
    total: { calls: 0, callsWithoutUsage: 0, usage: {}, unpricedCalls: 0, floorPricedCalls: 0 },
    coverage: { calls: 0, measured: 0, reported: null, silent: [], partial: [] },
    offTurnShare: null,
    missions: [],
  },
  log: [],
};

const activityRpc = (snapshot: ActivitySnapshot): Rpc =>
  async <T,>(method: string, args?: unknown[]): Promise<T> => (
    method === "getActivitySnapshot" ? rpcResult(v.parse(JsonValueSchema, snapshot)).json<T>() : stubRpc<T>(method, args)
  );

/* ── Tool-call rendering states ─────────────────────────────────── */

/** One message per state that the `chat` frame either folds into a group or
 *  can't show pre-expanded: a quiet failure (the tool caught it and returned
 *  it as a normal result), a protocol-level failure (the executor itself
 *  crashed — errorText, no output), a clean multi-line `shell`, and an MCP tool
 *  with no known summarizer contract. Auto-expanded on mount below so the
 *  input/output panel is the thing the screenshot shows. */
const TOOLCALL_MESSAGES: UIMessage[] = [
  msg({
    id: "tc-quiet", role: "assistant",
    parts: [
      { type: "text", text: "Successful error-shaped data — the invocation completed normally, so these returned fields do not mark it as failed." },
      { type: "tool-file", toolCallId: "tc1", state: "output-available", input: { action: "edit", path: "packages/checkout/migrations/0042_coupon_kind.sql", edits: [{}, {}] }, output: { error: "old_text not found or not unique — the file changed since the last read" } },
    ],
  }),
  msg({
    id: "tc-protocol", role: "assistant",
    parts: [
      { type: "text", text: "Protocol-level failure — the executor crashed before it could return anything; the reason lives in errorText, not output." },
      { type: "tool-run", toolCallId: "tc2", state: "output-error", input: { runtime: "workspace", command: "curl -sf https://ci.internal/status/checkout-fixes" }, errorText: "fetch failed: connect ETIMEDOUT 10.0.4.12:443" },
    ],
  }),
  msg({
    id: "tc-run", role: "assistant",
    parts: [
      { type: "text", text: "A multi-line `shell` command, expanded — a shell script, not an escaped JSON string." },
      {
        type: "tool-run", toolCallId: "tc3", state: "output-available",
        input: { runtime: "sandbox", command: "for f in packages/checkout/migrations/*.sql; do\n  echo \"-- checking $f\"\n  sqlite3 :memory: < \"$f\" || exit 1\ndone" },
        output: "-- checking packages/checkout/migrations/0041_coupons.sql\n-- checking packages/checkout/migrations/0042_coupon_kind.sql",
      },
    ],
  }),
  msg({
    id: "tc-mcp", role: "assistant",
    parts: [
      { type: "text", text: "An MCP tool with no known summarizer contract — the honest fallback (name + its one argument), and long enough to test truncation." },
      {
        type: "dynamic-tool", toolCallId: "tc4", toolName: "mcp_gh_search_pull_requests", state: "output-available",
        input: { query: "repo:AshishKumar4/shop is:open head:fix/coupon-kind base:main status:success review-requested:AshishKumar4" },
        output: "1 open PR: #212 \"Fix SAVE20 coupon backfill\" — checks pending",
      },
    ],
  }),
  msg({
    id: "tc-group", role: "assistant",
    parts: [
      { type: "text", text: "Five finished calls with one failed invocation — the group's status comes from the error channel." },
      { type: "tool-file", toolCallId: "tc5", state: "output-available", input: { action: "read", path: "packages/checkout/src/apply-coupon.ts" }, output: "…" },
      { type: "tool-file", toolCallId: "tc6", state: "output-available", input: { action: "read", path: "packages/checkout/migrations/0042_coupon_kind.sql" }, output: "…" },
      { type: "tool-file", toolCallId: "tc7", state: "output-error", input: { action: "edit", path: "packages/checkout/migrations/0042_coupon_kind.sql", edits: [{}, {}] }, errorText: "old_text not found or not unique" },
      { type: "tool-file", toolCallId: "tc8", state: "output-available", input: { action: "write", path: "packages/checkout/tests/coupon-kind.test.ts" }, output: "ok" },
      { type: "tool-agents", toolCallId: "tc9", state: "output-available", input: { action: "fork", forks: [{}, {}, {}], task: "Check every other call site" }, output: "3 forks merged" },
    ],
  }),
];

/**
 * A long run carrying the three shapes the fold has to tell apart: fifty
 * observations, three consequential changes, and one call that put a running
 * app on screen.
 *
 * The preview call is an `observe`-shaped port exposure sitting between the
 * scan and the changes, deliberately: an effect classification has no reason
 * to keep it, and it is neither the first row nor the last. So it is the row
 * that proves the preview rule rather than the mutation rule or an accident
 * of position.
 */
const LARGE_TOOL_RUN_MESSAGE: UIMessage = msg({
  id: "tc-large-run", role: "assistant",
  parts: [
    { type: "text", text: "A long repository inspection with three consequential changes." },
    ...Array.from({ length: 50 }, (_, index) => ({
      type: "tool-file" as const,
      toolCallId: `scan-${String(index)}`,
      state: "output-available" as const,
      input: { action: "read", path: `packages/checkout/src/generated/module-${String(index)}.ts` },
      output: "…",
    })),
    { type: "tool-run", toolCallId: "large-preview", state: "output-available", input: { runtime: "sandbox", command: "kinu expose 8789" }, output: { url: SLATE_GALLERY_URL, port: 8789 } },
    { type: "tool-file", toolCallId: "large-edit", state: "output-available", input: { action: "edit", path: "packages/checkout/migrations/0042_coupon_kind.sql", edits: [{}, {}] }, output: { error: "old_text not found or not unique" } },
    { type: "tool-file", toolCallId: "large-write", state: "output-available", input: { action: "write", path: "packages/checkout/tests/coupon-kind.test.ts" }, output: "ok" },
    { type: "tool-tasks", toolCallId: "large-task", state: "output-available", input: { action: "update", id: "t4", status: "done" }, output: "ok" },
  ],
});

/** One finished call whose input and output both carry credential-shaped
 *  fields, nested exactly where a webhook or MCP call would put them, and a
 *  second call whose free-text previews — the command block and the error
 *  channel — carry the same token. The redaction gate (`?frame=toolrun&secrets=1`)
 *  expands these rows and asserts the previews show `keep: visible` while
 *  every secret value is masked, keyed or not. */
/** A live Cloudflare token, assembled rather than written out: the commit-tier
 *  secret scan shares the pattern list the preview redacts by, so a literal
 *  here would block the commit whose behavior this fixture exists to prove.
 *  Assembled in parts, the source text never matches the shape. */
const ASSEMBLED_TOKEN = `cfut_${'a'.repeat(48)}`;

const SECRET_TOOL_RUN_PART: UIMessage['parts'][number] = {
  type: 'tool-run',
  toolCallId: 'secret-call',
  state: 'output-available',
  input: {
    runtime: 'sandbox',
    command: `curl -s https://api.stripe.example/v1/charges --token=${ASSEMBLED_TOKEN}`,
    headers: { authorization: 'Bearer sk-live-REDACTME' },
    nested: { apiKey: 'sk-live-REDACTME', keep: 'visible' },
  },
  output: {
    status: 200,
    headers: { authorization: 'Bearer sk-live-REDACTME' },
    nested: { apiKey: 'sk-live-REDACTME', keep: 'visible' },
    body: `token ${ASSEMBLED_TOKEN} accepted`,
  },
};

/** The same token reaching a preview through the error channel — a
 *  protocol-level failure whose `errorText` quotes the rejected credential. */
const SECRET_ERROR_PART: UIMessage['parts'][number] = {
  type: 'tool-run',
  toolCallId: 'secret-error',
  state: 'output-error',
  input: { runtime: 'sandbox', command: `deploy --token=${ASSEMBLED_TOKEN}` },
  errorText: `deploy rejected the credential ${ASSEMBLED_TOKEN}`,
};

const SECRET_TOOL_RUN_MESSAGE: UIMessage = msg({
  id: 'tc-secret-run', role: 'assistant',
  parts: [
    { type: 'text', text: 'A call that carries credential-shaped fields in both directions.' },
    SECRET_TOOL_RUN_PART,
    SECRET_ERROR_PART,
  ],
});

/** Clicks open every collapsed tool-call row shortly after mount — the
 *  expand/collapse toggle is local component state with no prop to preset
 *  it, and simulating the one click an operator would make is simpler and
 *  more honest than adding a gallery-only prop to the real component. */
function useAutoExpandToolCalls(): void {
  useEffect(() => {
    const clickAll = () => {
      for (const element of document.querySelectorAll('button[aria-expanded="false"]')) {
        if (element instanceof HTMLButtonElement) element.click();
      }
    };

    const id = setTimeout(() => {
      clickAll();
      // A group's own toggle mounts its members' toggles a render later —
      // one more pass after React commits catches those too.
      requestAnimationFrame(() => requestAnimationFrame(clickAll));
    }, 50);

    return () => clearTimeout(id);
  }, []);
}

/**
 * A turn IN FLIGHT, in each state its tail can be in.
 *
 * Every other chat frame passes `isStreaming={false}`, so the gallery had
 * never once photographed a live turn — which is why a caret rendered on a
 * line of its own below the paragraph, and a turn that went quiet between
 * steps showed nothing at all, both survived to production. The part `state`
 * fields are the real ones the AI SDK's stream reducer writes; the frame is a
 * still of a stream, not a mock of one.
 */
const STREAMING_MESSAGES: UIMessage[] = [
  msg({
    id: "st-text", role: "assistant",
    parts: [
      { type: "text", state: "streaming", text: "The 500 is a deref on `rules[kind]`, and after Tuesday's migration percentage coupons carry `kind: null`. The caret belongs at the end of this sentence" },
    ],
  }),
  msg({
    id: "st-after-tools", role: "assistant",
    parts: [
      { type: "text", state: "done", text: "Reading the handler and the migration that landed Tuesday." },
      { type: "tool-file", toolCallId: "st1", state: "output-available", input: { action: "read", path: "packages/checkout/src/apply-coupon.ts" }, output: "…" },
      { type: "tool-file", toolCallId: "st2", state: "output-available", input: { action: "read", path: "packages/checkout/migrations/0042_coupon_kind.sql" }, output: "…" },
    ],
  }),
  msg({
    id: "st-tool", role: "assistant",
    parts: [
      { type: "text", state: "done", text: "Running the regression suite before I touch anything else." },
      { type: "tool-run", toolCallId: "st3", state: "input-available", input: { runtime: "sandbox", command: "bun test packages/checkout" } },
    ],
  }),
  msg({
    id: "st-reasoning", role: "assistant",
    parts: [
      { type: "reasoning", state: "streaming", text: "SAVE20 fails and SAVE10 does not, so the branch is percentage-vs-fixed rather than the lookup. Before I patch it I want the migration in front of me" },
    ],
  }),
  msg({
    id: "st-fence", role: "assistant",
    parts: [
      { type: "text", state: "streaming", text: "Here is the guard, mid-fence:\n\n```ts\nconst rule = rules[kind] ?? inferKind(coupon);\nif (rule === undefined) return notApplicable(coupon);\n```" },
    ],
  }),
  msg({ id: "st-empty", role: "assistant", parts: [] }),
];

/** Each message is rendered as the LAST one of an open stream, which is the
 *  only condition under which a live tail is drawn at all. */
function StreamingFrame() {
  return (
    <div className="flex justify-center p-bg p-text min-h-screen">
      <div data-gallery-stream className="@container flex w-full max-w-[640px] flex-col gap-8 border-x p-border px-6 py-6">
        {STREAMING_MESSAGES.map((message) => {
          const tail = threadLiveTail({ last: message, liveness: LIVE_TURN });

          return (
            <div data-stream-id={message.id} key={message.id}>
              <MessageView message={message} liveTail={tail} onFork={() => {}} />
              <ChatLiveTail tail={tail} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MessageColumn({ messages }: { messages: UIMessage[] }) {
  return (
    <div className="flex justify-center p-bg p-text min-h-screen">
      <div className="@container flex w-full max-w-[640px] flex-col gap-6 border-x p-border px-6 py-6">
        {messages.map((m) => (
          <MessageView key={m.id} message={m} onFork={() => {}} />
        ))}
      </div>
    </div>
  );
}

function ToolCallsFrame() {
  useAutoExpandToolCalls();

  return <MessageColumn messages={TOOLCALL_MESSAGES} />;
}

function ToolRunScaleFrame({ secrets = false }: { secrets?: boolean }) {
  return (
    <div className="flex min-h-screen justify-center p-bg p-text">
      <div className="@container w-full max-w-[780px] border-x p-border px-6 py-6">
        <MessageView message={secrets ? SECRET_TOOL_RUN_MESSAGE : LARGE_TOOL_RUN_MESSAGE} onFork={() => {}} />
      </div>
    </div>
  );
}

/* ── Advisor notes ──────────────────────────────────────────────── */

/** The advisor's one note per finished turn, once per severity — the ladder
 *  the card has to keep legible: `nit` must stay quiet, `blocker` must be the
 *  loudest thing in the column, and the note itself is readable without a
 *  click on all three. */
const ADVISOR_NOTES = {
  nit: "The commit message says 'fix typo' but the diff also renames two exported symbols. Split it or say so.",
  concern: "The retry loop in deploy.sh has no backoff cap. A stuck registry keeps it spinning for the whole turn budget.",
  blocker: "The migration drops coupons.kind while the old worker is still deployed. Roll the worker first or every checkout 500s.",
} satisfies Record<AdvisorSeverity, string>;

/** One row per rung, in core's own rank order so the ladder is read as one.
 *
 *  The metadata is the pair `classifyProgrammaticTurn` reads — the event kind
 *  and the severity key — taken from core rather than spelled again here. A
 *  copy of them was spelled here once, under an event key nothing has ever
 *  read, and a row with no recognisable event stamp is a row the owner appears
 *  to have typed: all three notes rendered in the owner's own bubble, so the
 *  one frame that exists to photograph the advisor card photographed its
 *  absence. Held to the classifier in `tests/unit-background-event.test.ts`. */
const ADVISOR_MESSAGES: UIMessage[] = ADVISOR_SEVERITIES.map((severity) => msg({
  id: `adv-${severity}`, role: "user",
  metadata: { kinuEvent: ADVISOR_SIGNAL_KIND, [ADVISOR_SEVERITY_METADATA_KEY]: severity },
  parts: [{ type: "text", text: ADVISOR_NOTES[severity] }],
}));

function AdvisorFrame() {
  return <MessageColumn messages={ADVISOR_MESSAGES} />;
}

const BRAIN_MEMORY = "## Checkout\n\n- The coupon path goes through `/api/cart/apply`.\n"
  + "- Percentage coupons carry `kind: null` after Tuesday's migration.\n";

/** The failure the owner reported, as the sources actually hold it: ONE dropped
 *  connection, every read of the actor failing on it in the same instant. The
 *  banner text below is produced by the shipped formatter rather than typed
 *  here, so this frame photographs the product's own sentence rather than a
 *  line that says "Network connection lost." twice. */
const LOST = "Network connection lost.";

const OUTAGE: WorkspaceErrors = { snapshot: LOST, memoryContent: LOST };

/** One rung of the snapshot ladder: the banner the page shows, over the panes
 *  it shows it about. If any two rungs photograph the same, that is the defect
 *  — a workspace that never loaded and a workspace that is genuinely empty had
 *  exactly one rendering between them. */
function AgentPanel(
  { label, snapshot, tools, memoryContent, errors }: {
    label: string;
    snapshot: AsyncResource<AgentStatus>;
    tools: ToolInfo[];
    memoryContent: string;
    errors: WorkspaceErrors;
  },
) {
  const banner = formatWorkspaceError(errors, lastValue(snapshot) !== null);

  return (
    <section className="space-y-3 border-t p-border pt-6 first:border-0 first:pt-0">
      <div className="p-eyebrow">{label}</div>
      <GalleryComposer notices={banner
        ? [{ id: "load", tone: banner.severity === "blocking" ? "danger" : "warning",
             title: banner.title, text: banner.scope === "" ? undefined : banner.scope,
             detail: banner.detail === "" ? undefined : banner.detail,
             action: banner.retry === null ? undefined : { label: banner.retry, onClick: () => {} } }]
        : []} />
      <AgentSurface
        snapshot={snapshot} tools={tools} memory={[]} memoryContent={memoryContent}
        onSearchMemory={() => {}} onRetryLoad={() => {}} rpc={evolutionRpc}
      />
    </section>
  );
}

function AgentFrame() {
  return (
    <div className="p-bg min-h-screen flex justify-center">
      <div className="w-[740px] border-x p-border min-h-screen space-y-6 p-5">
        <AgentPanel
          label="Loaded — everything current"
          snapshot={{ status: "ready", value: BRAIN_STATUS }}
          tools={BRAIN_TOOLS} memoryContent={BRAIN_MEMORY} errors={{}}
        />
        <AgentPanel
          label="Loaded, then the connection dropped — last known data, one reason"
          snapshot={{ status: "error", message: LOST, last: BRAIN_STATUS }}
          tools={BRAIN_TOOLS} memoryContent={BRAIN_MEMORY} errors={OUTAGE}
        />
        <AgentPanel
          label="Nothing loaded yet — the snapshot is still coming"
          snapshot={{ status: "loading" }}
          tools={[]} memoryContent="" errors={{}}
        />
        <AgentPanel
          label="Nothing loaded — the snapshot failed"
          snapshot={{ status: "error", message: LOST, last: null }}
          tools={[]} memoryContent="" errors={OUTAGE}
        />
      </div>
    </div>
  );
}


/**
 * The node transcript, in every state it has.
 *
 * Five panels because five different facts must not render as one blank pane:
 * a branch that worked and reported, one still working, one that died having
 * recorded nothing, a rollout with no trace by construction, and a node the
 * store does not hold. If any two of these photograph the same, that is the
 * defect.
 */
function TranscriptFrame() {
  return (
    <div className="p-bg p-text min-h-screen p-5 space-y-5">
      {[
        ["Completed head — task, steps, highlighted report, search path", "root-merge-1-h0"],
        ["Running head — partial trace, live liveness", "root-merge-1-h1"],
        ["Head that died before its first step", "root-merge-1-h2"],
        ["Competed rollout — one proposal, no trace by construction", "n003"],
        ["A node neither store holds", "gone-1"],
      ].map(([label, nodeId]) => (
        <div key={nodeId} className="space-y-1.5">
          <div className="text-[11px] uppercase tracking-wider p-text-3">{label}</div>
          <div className="h-[34rem] w-[44rem] flex flex-col">
            <NodeTranscript
              selection={{ runId: nodeId.startsWith("n") ? "n000" : "root-merge-1", nodeId }}
              trees={MCTS_TREES} rpc={forkRpc} headActivity={NO_HEAD_ACTIVITY}
              onSelect={() => {}} />
          </div>
        </div>
      ))}
      {/* The other reader of the same view: the chat chip, which knows its head
          id by derivation and so needs no canvas selection. Both statuses,
          because a running branch and a settled one offer different things
          beside the disclosure. */}
      <div className="space-y-1.5">
        <div className="text-[11px] uppercase tracking-wider p-text-3">
          Mid-turn branch chip — the transcript it opens in place
        </div>
        {(["running", "settled"] as const).map((status) => (
          <BranchRunChip key={status}
            run={{
              branchId: "steer-b7f21", status,
              task: "Actually, check the staging snapshot first — I don't think the migration ran there.",
              takeSetId: undefined, turnId: undefined, message: undefined,
            }}
            rpc={forkRpc} headActivity={NO_HEAD_ACTIVITY}
            // Unreachable here: the pick affordance only appears once a take set
            // has hydrated, and this frame photographs the disclosure, not takes.
            onPick={() => Promise.reject(new Error("no take set in this frame"))}
            onDismiss={() => {}} />
        ))}
      </div>
    </div>
  );
}

/**
 * The frames that mount the Exploration surface, and the workspace they mount
 * it in.
 *
 * The surface builds its full-screen permalink out of the route's `agentId`, so
 * a fixture that renders it bare renders every control EXCEPT that one — and a
 * control no fixture can draw is a control no screenshot gate can ever catch
 * regressing. Routed the way the `settings` and `forkfull` frames already are,
 * which is the same fact about two other pages.
 */
const EXPLORATION_FRAMES = {
  forks: true, forkconfig: true, forkmerge: true, forkpreset: true,
  forkfanin: true, forkrefused: true, forkrunning: true, forklive: true,
} satisfies Record<string, true>;

const GALLERY_WORKSPACE = "checkout-fixes";

/**
 * Every swarm-config disclosure on the frame, opened once it has rendered.
 *
 * A fixture-only affordance, and deliberately outside the component: the card
 * ships shut and must keep shipping shut, so opening it through a new prop
 * would put a review convenience into the product's own contract. `details`
 * carries its openness in the DOM, so the fixture sets exactly that.
 */
function OpenConfigDisclosures({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const card of document.querySelectorAll<HTMLDetailsElement>("details[data-swarm-config]")) {
        card.open = true;
      }
    }, 300);

    return () => { clearTimeout(timer); };
  }, []);

  return <>{children}</>;
}

/**
 * The page a feedback screenshot is TAKEN OF, and the thing that makes the
 * redaction claim checkable rather than promised.
 *
 * Three regions, each with a stable hook so the gate can read the captured
 * image's pixels at their coordinates:
 *
 *   [data-secret-input]  a password field holding a real-looking secret. It
 *                        carries no redaction attribute — the point is that a
 *                        password is blacked out WITHOUT being annotated.
 *   [data-secret-token]  a marked region holding a token rendered as TEXT,
 *                        which no `type=password` rule would catch.
 *   [data-visible-copy]  the negative control. If the capture were blank or
 *                        black, every redaction assertion would pass for the
 *                        wrong reason, so this region must NOT be uniform.
 *
 * `?noise=1` swaps in an incompressible canvas, which is how the oversized
 * refusal is driven with real bytes instead of a stubbed size.
 */
function FeedbackFrame({ noise }: { noise: boolean }) {
  const noiseRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = noiseRef.current;

    if (canvas === null) return;
    const context = canvas.getContext("2d");

    if (context === null) return;
    // Random pixels do not compress, so the PNG lands near its raw size and
    // crosses the 8 MiB limit the endpoint and the client both enforce.
    const pixels = context.createImageData(canvas.width, canvas.height);

    for (let i = 0; i < pixels.data.length; i += 4) {
      pixels.data[i] = Math.random() * 256;
      pixels.data[i + 1] = Math.random() * 256;
      pixels.data[i + 2] = Math.random() * 256;
      pixels.data[i + 3] = 255;
    }

    context.putImageData(pixels, 0, 0);
  }, []);

  return (
    <div className="min-h-screen p-bg p-text">
      <header className="flex items-center justify-between border-b p-border p-sidebar px-4 py-3">
        <span className="text-sm font-semibold">Account settings</span>
        <FeedbackButton compact />
      </header>
      <div className="space-y-5 p-6">
        <p data-visible-copy className="max-w-xl text-sm p-text-2">
          Connected providers bill to your own account. Rotating a key takes effect on the next
          turn; running turns keep the credential they started with.
        </p>
        <label className="block max-w-sm space-y-1.5">
          <span className="text-xs font-medium p-text-2">Anthropic API key</span>
          <input
            data-secret-input
            type="password"
            defaultValue="gallery-placeholder-not-a-key"
            className={inputCls}
          />
        </label>
        <div className="max-w-sm space-y-1.5">
          <span className="text-xs font-medium p-text-2">Device token</span>
          <code
            data-secret-token
            data-feedback-redact
            className="block rounded-md border p-border px-3 py-2 font-mono text-[12.5px]"
          >
            ptc_LEAKED_IF_REDACTION_FAILS_0123456789
          </code>
        </div>
        {/* Rendered at its INTRINSIC size, not `w-full`. A scaled-down canvas is
            resampled into the capture's own pixels, so 3.9 megapixels of noise
            displayed 1280px wide compresses back under the limit and the frame
            proves nothing. 1280x4000 of incompressible pixels is what actually
            crosses 8 MiB. */}
        {noise && <canvas ref={noiseRef} width={1280} height={4000} style={{ width: 1280, height: 4000 }} />}
      </div>
      <FeedbackButton />
    </div>
  );
}

/**
 * The REAL secret-bearing surfaces, on one page, for the capture to photograph.
 *
 * `FeedbackFrame` above proves the two redaction MECHANISMS against markup built
 * for the purpose. This frame proves the PRODUCT: the components a person has
 * open when they press Feedback. All four of these leaked into the screenshot
 * bucket, and not one of them is reachable from a fixture that restates their
 * markup — which is why the leak survived a gate that already sampled pixels.
 *
 *   the issued webhook secret   shown once, as text, with a copy button
 *   the curl that tests it      the same secret inside a shell command
 *   the create dialog's field   the secret a person types before it is issued
 *   the MCP headers editor      `{"Authorization": "Bearer …"}`, pasted
 *
 * `?modal=1` renders the create dialog instead of the cards, because a fixed
 * overlay cannot share a page with what it covers. The feedback affordance moves
 * above that overlay in the same stage — harness-only positioning, so the button
 * is reachable while the dialog it photographs stays exactly as it ships.
 *
 * The secrets are distinctive on purpose: the gate asserts each one is present in
 * the LIVE page and absent from the clone and the pixels, so a typo in either
 * half fails loudly instead of passing on a string nobody rendered.
 */
const LEAK_HMAC = "whsec_hmacLEAKSifREDACTIONfails0001";

const LEAK_BEARER = "whsec_bearerLEAKSifREDACTIONfails0002";

function FeedbackSecretsFrame({ modal }: { modal: boolean }) {
  return (
    <div className="min-h-screen p-bg p-text">
      <header className="flex items-center justify-between border-b p-border p-sidebar px-4 py-3">
        <span className="text-sm font-semibold">Automations</span>
        {!modal && <FeedbackButton compact />}
      </header>
      <div className="mx-auto max-w-3xl space-y-5 p-6">
        <p data-visible-copy className="text-sm p-text-2">
          A webhook fires a turn in this workspace. Revoking a trigger stops it; the URL stays
          valid until you do.
        </p>
        {/* One stage or the other, never both: a dimmed card behind a scrim is
            neither the shipped card nor a readable measurement of one. */}
        {modal ? (
          <CreateWebhookModal agentName="checkout-fixes"
            onClose={() => { /* the dialog stays up for the capture */ }}
            onCreated={() => { /* the gate never submits */ }} />
        ) : (
          <>
            <NewWebhookCard
              result={{ trigger_id: "01K5ZQ8F2P0000000000000001", url: "/api/workspaces/checkout-fixes/webhook/01K5ZQ8F2P0000000000000001/v1-8b2e4d17c9053fa6be71204d8ac3915f", auth_mode: "hmac", secret: LEAK_HMAC }}
              onDismiss={() => { /* the card stays up for the capture */ }}
            />
            <NewWebhookCard
              result={{ trigger_id: "01K5ZQ8F2P0000000000000002", url: "/api/workspaces/checkout-fixes/webhook/01K5ZQ8F2P0000000000000002/v1-1d7fa39c50b2e846c3915f7b204d8ae2", auth_mode: "bearer", secret: LEAK_BEARER }}
              onDismiss={() => { /* the card stays up for the capture */ }}
            />
            <AddServerCard onCancel={() => { /* the form stays up for the capture */ }}
              onAdded={() => { /* nothing is added; the gate never submits */ }} />
          </>
        )}
      </div>
      {modal && <div className="fixed right-4 top-4 z-[60]"><FeedbackButton compact /></div>}
    </div>
  );
}

/**
 * What a routed, signed-in page looks like to the capture — and the one thing a
 * screenshot of a scrolling app has to get right.
 *
 * The frame around this scene is the SHIPPED shell: `Layout`, its rail, the real
 * `FeedbackButton` in the account menu, mounted under `/workspace/:agentId`. So
 * the report a gate sends from here carries the route and the workspace the
 * router actually resolved, which a bare component mount cannot produce and
 * which is exactly the half of the submission no fixture ever exercised.
 *
 * The panel is a scroll container inside a scroll container: five stacked bands,
 * one of which holds a row of five side-by-side cells. Each is a solid,
 * unantialiased fill, and every band and cell is 180px/480px exactly, so a
 * scroll offset lands one of them flush against its viewport and a sampled pixel
 * names WHICH one the image caught. No colour is spelled in the gate: it reads
 * the fill off the band it expects through `getComputedStyle`, so the fixture
 * and the assertion cannot drift apart.
 *
 * A transcript scrolled to the failure and a table scrolled to the wrong column
 * are the real versions of this, and both came back at the top.
 */
const SCROLL_BANDS = ["#12406e", "#14783c", "#c81e5a", "#78148c", "#b4a014"];

const SCROLL_CELLS = ["#1e7a3c", "#005ab4", "#f0a800", "#9600b4", "#dcc800"];

function FeedbackScrollScene() {
  return (
    <div className="h-full overflow-hidden p-bg p-text">
      <div className="space-y-4 p-6">
        <p data-visible-copy className="max-w-xl text-sm p-text-2">
          A screenshot is taken of the page as the reporter left it. A pane they scrolled to the
          line that failed has to arrive on that line, not back at the top.
        </p>
        <div className="p-group max-w-fit">
          <div className="border-b p-border px-3 py-2 p-label">Nested panes</div>
          <div data-scroll-outer style={{ height: 180, width: 520, overflowY: "auto", overflowX: "hidden" }}>
            {SCROLL_BANDS.map((fill, band) => (
              <div key={fill} data-scroll-band={band} style={{ height: 180, background: fill }}>
                {band === 2 && (
                  <div data-scroll-inner style={{ height: 120, width: 480, overflowX: "auto", overflowY: "hidden" }}>
                    <div style={{ display: "flex", width: 480 * SCROLL_CELLS.length }}>
                      {SCROLL_CELLS.map((cell, index) => (
                        <div key={cell} data-scroll-cell={index} style={{ width: 480, height: 120, background: cell }} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── A view that fails to render ─────────────────────────────────── */

/**
 * The message that must never reach a log. Spelled as a needle so the gate can
 * assert its ABSENCE from a payload that was really produced — V8 puts
 * `${name}: ${message}` on the first line of `error.stack`, so a report built
 * without stripping that line carries this string.
 */
const RENDER_FAULT_MESSAGE =
  "Cannot read properties of undefined (reading 'kind') for coupon MESSAGE_LEAKS_IF_REPORTED_0001";

/**
 * ONE error object across every render attempt, minted on the first.
 *
 * Both halves matter. Minted inside the render, so the stack is the render's and
 * not this module's initialisation. CACHED, because the claim under test is that
 * one caught error produces one report however many times React re-renders it —
 * and a fixture that minted a fresh Error per attempt could not tell "the
 * boundary deduped" from "React only called it once".
 */
let renderFault: TypeError | null = null;

/** `?huge=1` replaces the stack with one far over the request bound, so the gate
 *  can watch the client fit a report rather than send an oversized one. */
const HUGE_STACK = new URLSearchParams(location.search).get("huge") === "1";

const HUGE_FRAME = "    at applyCoupon (http://127.0.0.1/assets/index-a1b2c3.js:1:2345)";

/**
 * Times the fault has actually been thrown, written to the document.
 *
 * The gate's dedupe claim is "one caught error, one report", and without this
 * number that claim is VACUOUS: a page that broke once sends one report too, and
 * every other reading — the fallback, its retry affordance — is identical either
 * way. So the assertion that one report left the page is only worth anything
 * beside a count proving the boundary caught more than once.
 */
let renderFaultThrows = 0;

function BreakableView({ broken }: { broken: boolean }) {
  if (!broken) return <p data-view-intact className="text-sm p-text-2">This view renders.</p>;
  renderFaultThrows += 1;
  document.body.dataset.renderFaultThrows = String(renderFaultThrows);

  if (renderFault === null) {
    renderFault = new TypeError(RENDER_FAULT_MESSAGE);

    if (HUGE_STACK) {
      renderFault.stack = [`TypeError: ${RENDER_FAULT_MESSAGE}`]
        .concat(Array.from({ length: 600 }, () => HUGE_FRAME)).join("\n");
    }
  }

  throw renderFault;
}

/**
 * A render-time throw inside the SHIPPED ErrorBoundary.
 *
 * The trigger sits OUTSIDE the boundary on purpose: inside, the fallback would
 * replace it and the fault could be caused exactly once. From out here the gate
 * can break the view, take the fallback's own "Try again", and have the same
 * error caught again — which is the state the boundary's dedupe exists for.
 */
function RenderFailureScene() {
  const [broken, setBroken] = useState(false);

  return (
    <div className="h-full overflow-y-auto p-bg p-text" data-render-failure>
      <div className="space-y-4 p-6">
        <p data-scene-copy className="max-w-xl text-sm p-text-2">
          A view that throws while rendering is contained by its boundary. The other panes,
          this copy, and the control below all keep working.
        </p>
        <button
          data-break
          onClick={() => setBroken(true)}
          className="text-xs px-3 py-1.5 rounded-md p-fill border p-border hover:p-text"
        >
          Break this view
        </button>
        <div className="p-group max-w-2xl" style={{ height: 340 }}>
          <ErrorBoundary label="workspace"><BreakableView broken={broken} /></ErrorBoundary>
        </div>
      </div>
    </div>
  );
}

/* ── A code-split route that will not load ───────────────────────── */

/**
 * Whether the chunk this fixture stands for is in the bundle THIS document
 * loaded.
 *
 * Two ways it can be, and both are the real thing rather than a counter. A
 * RELOADED document is the deploy case exactly: the reader's tab went to the
 * origin again and got the current bundle, which is what makes the recovery worth
 * performing. `navigation.type` says so directly, and unlike a stored marker it
 * can never be confused with the recovery's own guard key. The other way is the
 * gate declaring it fixed, which is how a retry that must SUCCEED is driven
 * without a reload.
 *
 * Deliberately NOT "has it failed before": React re-renders a failed subtree in
 * development to build a component stack, so an attempt counter makes the fixture
 * succeed on a pass nobody asked for and the error screen never appears at all.
 */
function chunkIsPresent(): boolean {
  if (sessionStorage.getItem(CHUNK_FIXED_KEY) !== null) return true;
  const [navigation] = performance.getEntriesByType("navigation");

  return navigation instanceof PerformanceNavigationTiming && navigation.type === "reload";
}

/** Attempts per fixture loader, written to the document so the gate can read
 *  them: the claim that only the REJECTED loader is regenerated is a claim about
 *  these two numbers. */
const lazyAttempts = { stale: 0, healthy: 0 };

function recordAttempt(which: "stale" | "healthy"): void {
  lazyAttempts[which] += 1;
  document.body.dataset[which === "stale" ? "lazyStaleAttempts" : "lazyHealthyAttempts"] =
    String(lazyAttempts[which]);
}

/**
 * `?failure=app` throws an ordinary application error instead of a module-load
 * one, which is how the gate proves that RECOGNITION is required and skew alone
 * never authorises a reload.
 */
function fixtureFailure(): Error {
  return new URLSearchParams(location.search).get("failure") === "app"
    ? new TypeError("Cannot read properties of undefined (reading 'kind')")
    : new TypeError(
      `Failed to fetch dynamically imported module: ${location.origin}/assets/MCTSExplorer-a1b2c3.js`,
    );
}

const StaleChunkRoute = lazyRoute(async () => {
  recordAttempt("stale");

  if (!chunkIsPresent()) throw fixtureFailure();

  return { default: () => <p data-lazy-loaded className="text-sm p-text-2">The split route rendered.</p> };
});

/** The sibling that never fails, loaded as the real code-split chunk it is
 *  (`gallery-lazy-healthy.tsx` says why). Its attempt count is the assertion
 *  that a regenerated loader clears one route's memo and not the others'. */
const HealthyChunkRoute = lazyRoute(async () => {
  recordAttempt("healthy");
  const { default: LazyHealthyRoute } = await import("./gallery-lazy-healthy");

  return { default: LazyHealthyRoute };
});

function LazyRouteScene() {
  return (
    <div className="h-full overflow-y-auto p-bg p-text" data-lazy-scene>
      <div className="space-y-4 p-6">
        <p data-scene-copy className="max-w-xl text-sm p-text-2">
          A code-split route is a hashed asset. A tab held open across a deploy cannot load one,
          and reloading is the whole fix — once, and only when the origin really has moved.
        </p>
        <div className="p-group max-w-2xl" style={{ height: 260 }}>
          <ErrorBoundary label="mcts-explorer">
            <Suspense fallback={<p data-lazy-pending className="p-6 text-sm p-text-3">Loading…</p>}>
              <StaleChunkRoute />
            </Suspense>
          </ErrorBoundary>
        </div>
        <div className="p-group max-w-2xl" style={{ height: 120 }}>
          <ErrorBoundary label="control-plane">
            <Suspense fallback={<p className="p-6 text-sm p-text-3">Loading…</p>}>
              <HealthyChunkRoute />
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}

/* The device row in the three modes its Sandbox switch can land a machine in,
   side by side, because the row explains a per-device setting through ONE line
   of copy and the three lines are the thing to review. The first machine is
   sandboxed; the second has the switch off; the third has the switch on and no
   bwrap, which is the one state where the switch being on means no commands run
   at all. No fetch: the roster is the prop, so the frame photographs the same
   markup the Devices card renders. */
function galleryDevice(id: string, label: string, sandbox: UserDevice["sandbox"]): UserDevice {
  return {
    id, label, os: "linux", hostname: label, connected: true,
    createdAt: NOW - 30 * 864e5, lastSeenAt: NOW - 60e3, expiresAt: NOW + 60 * 864e5,
    lastIp: "192.0.2.9", lastAgent: "kinu-device", replacedAt: null, revokedAt: null, unstoppedAt: null,
    sandbox,
    version: "0.3.0+gallery", servedVersion: "0.3.0+gallery", update: "current",
  };
}

const SANDBOX_DEVICES: readonly UserDevice[] = [
  galleryDevice("dev-sandboxed", "workstation", { tier: "sandboxed", capability: "sandboxed", reason: null, detail: null, gpu: ["/dev/nvidia0", "/dev/nvidiactl"] }),
  galleryDevice("dev-raw", "build-box", { tier: "raw", capability: "sandboxed", reason: null, detail: null, gpu: [] }),
  galleryDevice("dev-cannot", "old-device", { tier: "sandboxed", capability: "files_only", reason: "no_bwrap", detail: null, gpu: [] }),
];

function DeviceSandboxFrame() {
  return (
    <div className="p-6 max-w-2xl p-bg p-text" data-device-sandbox-frame>
      <div className="rounded-md border p-border overflow-hidden text-xs">
        {SANDBOX_DEVICES.map((device) => (
          <DeviceRow
            key={device.id}
            device={device}
            grants={[{ agentName: "checkout-fixes", deviceId: device.id, policy: "allow", lastMethod: "exec", lastSummary: null }]}
            onDeviceChanged={() => {}}
            onGrantsChanged={() => {}}
            onError={() => {}}
            onRevoke={() => {}}
            unstoppedCommands={undefined}
            onAcknowledge={async () => {}}
          />
        ))}
      </div>
    </div>
  );
}

/** The shipped shell as App.tsx composes it — `Layout` owns the rail, the
 *  overview store and the living background — routed to one of the surfaces
 *  the background shows under. This is the frame the background's contrast
 *  and its UX gate are measured on: a hand-composed shell would leave the
 *  canvas, its z-order and its mask out of the picture. */
async function appShellFrame(): Promise<{ node: React.ReactNode; entries: string[] }> {
  const { default: HomePage } = await import("@/pages/HomePage");

  return {
    entries: [new URLSearchParams(location.search).get("path") ?? "/"],
    node: (
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="/user/settings" element={<UserSettingsPage />} />
          <Route path="/workspace/:agentId" element={<div className="h-full" data-gallery-blank />} />
          <Route path={APP_ROUTES.drive} element={<DriveRoute />} />
          <Route path={APP_ROUTES.driveFolder} element={<DriveRoute />} />
        </Route>
      </Routes>
    ),
  };
}

/** The exploration frames photograph a swarm card under the workspace route,
 *  the way a reviewer lands on it; every other frame keeps the node and the
 *  entries its branch already chose. */
function explore(node: React.ReactNode, entries: string[], frameName: string) {
  if (frameName in EXPLORATION_FRAMES) {
    return {
      entries: [`/workspace/${GALLERY_WORKSPACE}`],
      node: <Routes><Route path="/workspace/:agentId" element={node} /></Routes>,
    };
  }

  return { node, entries };
}


/** `&devices=offline|offline-many|none` puts the refused-call notice up on a
 *  mounted `workspacepage` frame: the socket push is the only way the row
 *  exists, and the page's connection is the stub's, so the server-side half
 *  is a pushed frame delivered on a delay the page mounts inside. */
const NOTICE_DEVICES = new Map([
  ["offline", [{ id: "dev-1", label: "ashish@studio", lastSeenAt: 1_769_000_000_000 }]],
  ["offline-many", [
    { id: "dev-1", label: "ashish@studio", lastSeenAt: 1_769_000_000_000 },
    { id: "dev-2", label: "ashish@tower", lastSeenAt: 1_768_999_000_000 },
  ]],
  ["none", []],
]);

function scheduleDeviceNotice(devices: string | null): void {
  if (devices === null) return;
  const offline = NOTICE_DEVICES.get(devices);

  if (offline === undefined) return;

  setTimeout(() => {
    galleryServerPush(JSON.stringify({ type: "device_unavailable", devices: offline }));
  }, 300);
}

/** A self-update in flight, as the deployment's own ledger holds it: the steps
 *  that re-created nothing are done, the upload is going, and the rows after it
 *  have not started. */
const GALLERY_UPDATE_RUN: DeploySnapshot = {
  runId: "self-update-0000",
  state: "running",
  address: "kinu.example.com",
  version: "0.4.0+cc33dd4",
  steps: [
    { id: "account", seq: 0, title: "Read the account", state: "done", attempt: 1, detail: "Acme Corp.", notes: [], failure: null, facts: {} },
    { id: "kv", seq: 1, title: "Create the KV namespaces", state: "done", attempt: 1, detail: "3 namespace(s) already there.", notes: [], failure: null, facts: {} },
    { id: "seed", seq: 2, title: "Seed the runtime cache", state: "done", attempt: 1, detail: "0 of 14 toolchain object(s) uploaded; the rest were already there.", notes: [], failure: null, facts: {} },
    { id: "upload", seq: 3, title: "Upload the Worker", state: "running", attempt: 1, detail: "", notes: ["41 of 212 assets uploaded"], failure: null, facts: {} },
    { id: "address", seq: 4, title: "Bind the address", state: "pending", attempt: 0, detail: "", notes: [], failure: null, facts: {} },
    { id: "smoke", seq: 5, title: "Check it answers", state: "pending", attempt: 0, detail: "", notes: [], failure: null, facts: {} },
  ],
};

/** The self-deploy door as a visitor gets it before the owner has registered
 *  the OAuth client; `?state=configured` photographs the sign-in state. Same
 *  dynamic import every frame here uses, because the frame name is the
 *  runtime selector. */
async function deployFrame(): Promise<{ node: React.ReactNode; entries: string[] }> {
  const { default: DeployPage } = await import("@/pages/DeployPage");
  const configured = new URLSearchParams(location.search).get("state") === "configured";

  return {
    entries: ["/deploy"],
    node: (
      <div className="h-screen overflow-auto">
        <DeployPage
          fixtureOptions={{
            cloudflare: configured,
            clientId: configured ? "gallery-client" : "",
            version: "0.4.0+gallery",
            prompts: [],
            reason: configured
              ? ""
              : "The Cloudflare door needs an OAuth client, and this deployment has none configured yet.",
          }}
        />
      </div>
    ),
  };
}

/** The deployment's own Updates page. `?state=running` photographs a run in
 *  flight; without it, a deployment one build behind its channel. */
async function updatesFrame(): Promise<{ node: React.ReactNode; entries: string[] }> {
  const { default: UpdatesPage } = await import("@/pages/UpdatesPage");
  const running = new URLSearchParams(location.search).get("state") === "running";

  return {
    entries: ["/updates"],
    node: (
      <div className="h-screen overflow-auto p-bg p-text">
        <UpdatesPage
          fixture={{
            current: { version: "0.3.9+aa11bb2", sha: "aa11bb2", builtAt: "2026-09-10T08:00:00.000Z" },
            available: { version: "0.4.0+cc33dd4", sha: "cc33dd4", builtAt: "2026-09-17T10:00:00.000Z" },
            channelOrigin: "https://kinu.run",
            upToDate: false,
            installable: true,
            reason: "",
          }}
          {...(running ? { fixtureRun: GALLERY_UPDATE_RUN } : {})}
        />
      </div>
    ),
  };
}

/**
 * The Environment tab and the composite drive share one stateful frame, so
 * an Environment card's Files action genuinely lands the drive. Routed: the
 * Files surface reads `agentId` off the route to address the raw-bytes HTTP
 * route. `&offline=device` photographs the stated-absence row for a
 * disconnected device; `&wide=1` the ≥64rem side-panel preview.
 */
/** What a gallery frame mounts, and the routed location the MemoryRouter opens on. */
interface MountedFrame { node: React.ReactNode; entries: string[] }

function driveFrame(frameName: "environment" | "files"): MountedFrame {
  const params = new URLSearchParams(location.search);
  const column = frameName === "files" ? "w-[860px]" : "w-[720px]";

  return {
    entries: ["/workspace/checkout-fixes"],
    node: (
      <Routes>
        <Route path="/workspace/:agentId"
          element={<DriveFrame
            initialSurface={frameName === "files" ? "Files" : "Environment"}
            offlineDevice={params.get("offline") === "device"}
            width={params.get("wide") === null ? column : "w-[1240px]"}
            deferPreview={params.get("deferpreview") === "1"}
          />} />
      </Routes>
    ),
  };
}

/** The MCTS explorer page, at one RUN. The one dynamic import this dispatch
 *  makes, and it stays one: the page pulls d3 and the whole tree renderer, so
 *  every frame that does not open it must not pay for them.
 *
 *  A PAGE owns its own connection, so it takes no `rpc` prop: it reads through
 *  `useKinu`, and in the gallery that resolves to `gallery-agent-stub`.
 *  Installing the fixture there is what makes these frames render at all —
 *  before it they opened a socket to vite and drew an empty body. */
async function mctsExplorerFrame(run: string): Promise<MountedFrame> {
  const { default: MCTSExplorer } = await import("@/pages/MCTSExplorer");
  serveGalleryRpc(focusRun(run));

  return {
    entries: [`/mcts/checkout-fixes?run=${run}`],
    node: <Routes><Route path="/mcts/:agentId" element={<div className="h-screen p-bg p-text"><MCTSExplorer /></div>} /></Routes>,
  };
}

/** The workspace settings page. Routed, not bare: the page reads `agentId` off
 *  the route, and every back-link and breadcrumb it renders is built from it. */
async function settingsFrame(): Promise<MountedFrame> {
  const { default: SettingsPage } = await import("@/pages/SettingsPage");

  return {
    entries: ["/workspace/checkout-fixes/settings"],
    node: (
      <Routes>
        <Route
          path="/workspace/:agentId/settings"
          element={<div className="min-h-screen p-bg p-text"><SettingsPage /></div>}
        />
      </Routes>
    ),
  };
}

/** The admin control plane. Routed, because the page keeps its tab, the
 *  selected account and the selected workspace in the URL — an operator sends a
 *  colleague the exact view they are looking at, and a bare mount could not
 *  render any of it. */
async function controlFrame(): Promise<MountedFrame> {
  const { default: ControlPage } = await import("@/pages/ControlPage");

  return {
    entries: ["/control"],
    node: (
      <Routes>
        <Route path="/control" element={<div className="h-screen p-bg p-text"><ControlPage /></div>} />
      </Routes>
    ),
  };
}

/** The home page in the real chrome, not the page alone: the sidebar's own
 *  route logic decides what it renders at "/", and photographing the page
 *  without the rail would pass a sidebar the app never shows. The cards read
 *  their overviews through the store every frame is mounted under. */
async function homeFrame(): Promise<MountedFrame> {
  const { default: HomePage } = await import("@/pages/HomePage");

  return {
    entries: ["/"],
    node: (
      <div className="flex h-screen w-screen p-bg p-text overflow-hidden">
        <aside className="hidden w-60 shrink-0 p-sidebar border-r p-border md:block"><Sidebar /></aside>
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden"><HomePage /></main>
      </div>
    ),
  };
}

/** The shipped shell, routed as App.tsx routes it: `Layout` owns the rail, the
 *  rail owns the account menu, and the menu owns the Feedback affordance. What
 *  this frame adds over the two bare feedback frames is the ROUTER — the
 *  report's route and workspace fields are read off a resolved
 *  `/workspace/:agentId`, not off the gallery's own `/`. */
function feedbackRoutedFrame(): MountedFrame {
  return {
    entries: ["/workspace/checkout-fixes"],
    node: (
      <Routes>
        <Route element={<Layout />}>
          <Route path="/workspace/:agentId" element={<FeedbackScrollScene />} />
        </Route>
      </Routes>
    ),
  };
}

/** A render-time throw in the shipped ErrorBoundary, at a real route.
 *
 *  Two things this frame does that no other needs. It calls
 *  `pageDeployedBuildSha` the way `index.tsx` does, because the report binds
 *  itself to the build the page LOADED and that read has to happen at load. And
 *  it rewrites the address bar: the report reads the document's own
 *  `location.pathname` — which is what a BrowserRouter page has — while the
 *  gallery routes through a MemoryRouter that leaves the URL at `/`. A
 *  replaceState is a no-op on the network and makes the two agree. */
function errorBoundaryFrame(): MountedFrame {
  primePageDeployedBuildSha();
  history.replaceState(null, "", `/workspace/checkout-fixes${location.search}`);

  return {
    entries: ["/workspace/checkout-fixes"],
    node: (
      <Routes>
        <Route element={<Layout />}>
          <Route path={APP_ROUTES.workspace} element={<RenderFailureScene />} />
        </Route>
      </Routes>
    ),
  };
}

/** A code-split route that will not load, in the shipped ErrorBoundary and
 *  Suspense, under the shipped Layout. `pageDeployedBuildSha` is called as
 *  `index.tsx` calls it, because the recovery compares the build this page
 *  loaded against the one the origin serves.
 *
 *  Unlike the frame above, this one leaves the address bar ALONE. The
 *  recovery's last act is `location.reload()`, which reloads whatever is in it:
 *  a rewritten `/workspace/...` would be served the real `index.html` by Vite's
 *  SPA fallback, and the gate would be measuring the app instead of the
 *  fixture. Nothing here reads the path, so there is nothing to gain by moving
 *  it. */
function lazyRouteFrame(): MountedFrame {
  primePageDeployedBuildSha();

  return {
    entries: ["/workspace/checkout-fixes"],
    node: (
      <Routes>
        <Route element={<Layout />}>
          <Route path={APP_ROUTES.workspace} element={<LazyRouteScene />} />
        </Route>
      </Routes>
    ),
  };
}

/** The interactive rig routes like the app so the strip's own navigation is
 *  exercised: create lands on the new conversation's URL, Main goes back. */
function agentChatsFrame(): MountedFrame {
  return {
    entries: ["/workspace/checkout-fixes"],
    node: (
      <Routes>
        <Route path="/workspace/:agentId" element={<AgentChatsScene />} />
        <Route path="/workspace/:agentId/agents/:subName" element={<AgentChatsScene />} />
      </Routes>
    ),
  };
}

/** Owns a real root connection for the plan-arrival hint, so its reads need a
 *  server; the surfaces themselves still read the frame's own fixture props. */
function previewTabsFrame(): MountedFrame {
  serveGalleryRpc(stubRpc);

  return { entries: ["/"], node: <PreviewTabsGallery /> };
}

/** The workspace page under both app routes, exactly as App.tsx keys them:
 *  creating an agent navigates to its conversation, and the frame must be able
 *  to land there. */
function workspacePageFrame(): MountedFrame {
  serveGalleryRpc(workspacePageRpc);

  seedFrameTranscript(new URLSearchParams(location.search).get("transcript"));
  scheduleDeviceNotice(new URLSearchParams(location.search).get("devices"));

  return {
    entries: [`/workspace/${WORKSPACE_PAGE_NAME}`],
    node: (
      <Routes>
        <Route path="/workspace/:agentId" element={<div className="h-screen p-bg p-text"><WorkspacePage /></div>} />
        <Route path="/workspace/:agentId/agents/:subName" element={<div className="h-screen p-bg p-text"><WorkspacePage /></div>} />
      </Routes>
    ),
  };
}

/** `&section=devices` is the deep link a work surface hands over, driven
 *  through the router rather than through `location.hash`: the page reads the
 *  hash off `useLocation`, so a MemoryRouter entry is the same input a real URL
 *  is. */
function userSettingsStateFrame(): MountedFrame {
  const section = new URLSearchParams(location.search).get("section");

  return {
    entries: [section === null ? "/user/settings" : `/user/settings#${section}`],
    node: <div className="min-h-screen p-bg p-text"><UserSettingsPage /></div>,
  };
}

async function mount() {
  // Standalone public string documents render without the app shell.
  const document_ = publicDocument(frame);

  if (document_ !== null) {
    writeDocument(document_);

    return;
  }

  let node: React.ReactNode;
  let entries = ["/"];

  // Frames a name alone fixes — the ones that need no dispatch branch because
  // their only parameters live in the row itself. `entries` is the routed
  // location the MemoryRouter opens on for frames that read a route param.
  const fixtureFrames = new Map<string, { node: React.ReactNode; entries: string[] }>([
    ["supervise", { node: <SuperviseFrame />, entries: ["/"] }],
    ["supervisefresh", { node: <SuperviseFrame evolved={false} />, entries: ["/"] }],
    ["activity", { node: <Shell surface={ACTIVITY_SURFACE} rpc={activityRpc(ACTIVITY_SNAPSHOT)} />, entries: ["/"] }],
    ["activityclean", { node: <Shell surface={ACTIVITY_SURFACE} rpc={activityRpc(ACTIVITY_CLEAN)} />, entries: ["/"] }],
    ["activityempty", { node: <Shell surface={ACTIVITY_SURFACE} rpc={activityRpc(ACTIVITY_FRESH)} />, entries: ["/"] }],
    ["activitycache", { node: <div className="p-6 max-w-2xl"><CacheBlock cacheHit={ACTIVITY_CACHE_HIT} /></div>, entries: ["/"] }],
    // The read-only page a visitor sees, routed the way App.tsx routes it.
    ["blueprint", { node: <BlueprintFrame />, entries: [`/shared/blueprint/${encodeURIComponent(BLUEPRINT_ID)}`] }],
    // A slate card inside a chat message, at its inline height.
    ["chat-slate", { node: <ChatSlateFrame />, entries: ["/"] }],
    // The Drive's blueprints folder: the shared library, behind the chrome.
    // On its own route, so the rail's primary nav lights Drive and not Home.
    ["shared", { node: <DrivePageFrame library={SHARED_LIBRARY} workspaces={STOCK_ROSTER.entries} />, entries: [`${APP_ROUTES.drive}/blueprints`] }],
    // The same folder before anything is shared: every list shows its empty line.
    ["shared-empty", {
      node: <DrivePageFrame library={EMPTY_LIBRARY} workspaces={STOCK_ROSTER.entries} />,
      entries: [`${APP_ROUTES.drive}/blueprints`],
    }],
    // The Drive over a seeded tenant (`&path=/projects/ops` opens a folder), and over an empty one.
    ["drive", {
      node: <DrivePageFrame library={SHARED_LIBRARY} workspaces={STOCK_ROSTER.entries} />,
      entries: [`${APP_ROUTES.drive}${new URLSearchParams(location.search).get("path") ?? ""}`],
    }],
    ["drive-empty", { node: <DrivePageFrame library={EMPTY_LIBRARY} workspaces={STOCK_ROSTER.entries} />, entries: [APP_ROUTES.drive] }],
    // The task indicator mid-wait: the model call is sleeping out the
    // provider's declared window and the bar names it instead of "working".
    ["providerwait", { node: <ProviderWaitFrame />, entries: ["/"] }],
    ["sharedialog", { node: <ShareDialogFrame mode="live" />, entries: ["/"] }],
    ["sharedialog-blueprint", { node: <ShareDialogFrame mode="blueprint" />, entries: ["/"] }],
    ["unmapped", {
      node: (
        <div className="h-screen w-[720px] p-sidebar p-text">
          <UnmappedBindingsPanel slate="issue-triage" title="Issue triage" rpc={workRpc} onOpen={() => {}} fixture={BLUEPRINT_BINDINGS} />
        </div>
      ), entries: ["/"],
    }],
    // The home chrome with one account panel open over it, as the Setup card
    // draws it: `&panel=providers|mcp|cli` picks the modal's body.
    ["setupmodal", { node: <SetupModalFrame />, entries: ["/"] }],
    // The onboarding wizard, stepped: `&step=0..3` picks which panel is open.
    ["welcome", { node: <WelcomeFrame />, entries: ["/welcome"] }],
    // The two primary-nav pages behind the shipped chrome; `&view=list`
    // seeds the workspaces page's stored choice.
    ["workspaces", { node: <WorkspacesFrame />, entries: ["/workspaces"] }],
    // Chat with ts/bash/json fences — the frame the highlighting test shoots.
    ["chatcode", { node: <ChatCodeFrame />, entries: ["/"] }],
    ["plugins", { node: <PluginsFrame />, entries: ["/plugins"] }],
    ["devices", { node: <DevicesFrame />, entries: ["/devices"] }],
    ["couponboard", { node: <CouponBoardSlate />, entries: ["/"] }],
  ]);

  const fixture = fixtureFrames.get(frame);

  // Same dispatch for the frames whose module or fixture is runtime-loaded:
  // the name selects an async loader instead of a branch.
  const dynamicFrames = new Map<string, () => Promise<{ node: React.ReactNode; entries: string[] }>>([
    ["deploy", deployFrame],
    ["updates", updatesFrame],
    ["app", appShellFrame],
    ["forkfull", () => mctsExplorerFrame("n000")],
    ["forkbig", () => mctsExplorerFrame("n000")],
    ["forkswarmfull", () => mctsExplorerFrame("sw000")],
    ["settings", settingsFrame],
    ["control", controlFrame],
    ["home", homeFrame],
  ]);

  const dynamicFixture = dynamicFrames.get(frame);

  if (frame === "shell") node = <Shell />;
  else if (frame === "forks") node = <Shell surface="Swarms" mctsTrees={MCTS_TREES} rpc={forkRpc} />;
  // The same surface with its config disclosure OPEN. The card is shut by the
  // owner's own ruling — config is asked for, never shoved at a reader — so no
  // product prop exists just for gallery capture.
  else if (frame === "forkconfig") {
    node = <OpenConfigDisclosures><Shell surface="Swarms" mctsTrees={MCTS_TREES} rpc={forkRpc} /></OpenConfigDisclosures>;
  }
  else if (frame === "forkmerge") node = <Shell surface="Swarms" mctsTrees={MCTS_TREES} rpc={mergeFirstRpc} />;
  else if (frame === "forkpreset") node = <Shell surface="Swarms" mctsTrees={MCTS_TREES} rpc={provePresetRpc} />;
  else if (frame === "forkfanin") node = <Shell surface="Swarms" mctsTrees={MCTS_TREES} rpc={swarmFanInRpc} />;
  else if (frame === "forkrefused") node = <Shell surface="Swarms" mctsTrees={MCTS_TREES} rpc={refusedRunRpc} />;
  else if (frame === "forkstopped") node = <Shell surface="Swarms" rpc={stoppedRunRpc} />;
  // A multi-node MIXED-STATUS run: nodes reported, nodes still working, one
  // aborted and one failed on the provider, over two levels. The state the whole
  // surface exists for and the one no frame could photograph.
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
  else if (frame === "palette") node = <Palette />;
  else if (frame === "marks") node = <MarksFrame />;
  else if (frame === "tabs") node = <TabsFrame />;
  else if (frame === "agentchats") ({ node, entries } = agentChatsFrame());
  else if (frame === "markdown") node = <MarkdownFrame />;
  else if (frame === "coderendering") node = <CodeRenderingFrame />;
  else if (frame === "chat") node = <ChatFrame />;
  else if (frame === "chatsteer") node = <ChatSteerFrame />;
  else if (frame === "chatempty") node = <ChatEmptyFrame />;
  else if (frame === "chatloading") node = <ChatLoadingFrame />;
  else if (frame === "composer") node = <ComposerFrame />;
  else if (frame === "chathistory") node = <ChatHistoryFrame />;
  else if (frame === "historyauthority") node = <HistoryAuthorityFrame />;
  else if (frame === "rosterauthority") node = <RosterAuthorityFrame />;
  else if (frame === "clientcontinuity") node = <ClientContinuityFrame />;
  else if (frame === "qualitybranches") node = <QualityBranchFrame />;
  else if (frame === "toolcalls") node = <ToolCallsFrame />;
  else if (frame === "toolrun") node = <ToolRunScaleFrame secrets={new URLSearchParams(location.search).get("secrets") === "1"} />;
  else if (frame === "advisor") node = <AdvisorFrame />;
  else if (frame === "streaming") node = <StreamingFrame />;
  else if (frame === "agent") node = <AgentFrame />;
  else if (frame === "transcript") node = <TranscriptFrame />;
  else if (frame === "slate") node = <SlatePreviewFrame />;
  else if (frame === "workslatefallback") node = <SlateFallbackFrame rpc={workRpc} />;
  else if (frame === "releases") node = <ReleasesFrame />;
  else if (frame === "releasesoffline") node = <ReleasesFrame executors={RELEASE_EXECUTORS_OFFLINE} />;
  else if (frame === "previewtabs") ({ node, entries } = previewTabsFrame());
  else if (frame === "compactpreview") node = <CompactPreviewGallery />;
  else if (frame === "work") node = <WorkFrame />;
  else if (frame === "planreview") node = <PlanReviewFrame />;
  else if (frame === "workempty") node = <WorkEmptyFrame />;
  else if (frame === "approvals") node = <ApprovalsFrame />;
  else if (frame === "environment" || frame === "files") ({ node, entries } = driveFrame(frame));
  else if (fixture !== undefined) { node = fixture.node; entries = fixture.entries; }
  // The log pane alone, at fixture scale — the close-up the composed activity
  // frames render too small to read.
  else if (frame === "activitylog") node = <div className="p-6 max-w-2xl"><LogBlock log={ACTIVITY_LOG} /></div>;
  else if (frame === "workspacepage") ({ node, entries } = workspacePageFrame());
  else if (frame === "usersettingsstate") ({ node, entries } = userSettingsStateFrame());
  // The device row alone, in the three modes its Sandbox switch can land a
  // machine in — the close-up the Devices card renders one at a time.
  else if (frame === "devicesandbox") node = <DeviceSandboxFrame />;
  else if (dynamicFixture !== undefined) ({ node, entries } = await dynamicFixture());
  else node = <All />;

  ({ node, entries } = explore(node, entries, frame));


  const root = document.getElementById("root");

  if (root === null) throw new Error("gallery root is missing");

  createRoot(root).render(
    // Every frame is mounted under the shell's three stores — account, roster,
    // overviews — so a page photographed alone reads the same way it does
    // behind `Layout`; a frame that mounts `Layout` itself gets Layout's own
    // nearer store, exactly as the app does.
    <StrictMode>
      <MemoryRouter initialEntries={entries}>
        <AccountProvider><WorkspaceRosterProvider><WorkspaceOverviewsProvider>{node}</WorkspaceOverviewsProvider></WorkspaceRosterProvider></AccountProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}

try {
  await mount();
} catch (cause) {
  diagnostics.failure("gallery.mount_failed", toKinuError({
    doing: "mount the design-system gallery",
    cause,
    otherwise: "unavailable",
  }));
}
