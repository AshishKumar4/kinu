/**
 * Design-system gallery: the real components over mock data, so signed-in surfaces can be screenshotted without auth.
 * Served by gallery.vite.config.ts; `?frame=` selects a frame (full list: the dispatch in `mount()`). /api/user/* GETs are stubbed in-page.
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
import { CHECKPOINTS_NO_DEVICE, CHECKPOINTS_UNAVAILABLE_NO_GIT } from "@kinu.run/core";
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
import { ACTIVITY_SURFACE, type SurfaceKind } from "@kinu.run/core";
import { WorkSurface } from "@/components/surfaces/WorkSurface";
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
import { APP_ROUTES, rosterBucket, rosterMatches, WorkspaceOverviewSchema, type WorkspaceOverview } from "@kinu.run/core";
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
import { CreateWebhookModal, NewWebhookCard, SupervisePage } from "@/pages/SupervisePage";
import type { EvolutionEntry } from "@/components/surfaces/supervise-evolution";
import { AddServerCard } from "@/components/account/McpServersPanel";
import { DevicesFrame, PluginsFrame, SetupModalFrame, WelcomeFrame, WorkspacesFrame } from "@/gallery-account";
import { AccountProvider } from "@/hooks/use-account";
import { DrivePageFrame, DriveRoute, installDriveFixture } from "@/gallery-drive";
import { driveDesignFrame } from "@/gallery-drive-design";
import BlueprintPage from "@/pages/BlueprintPage";
import { ShareSlateDialog } from "@/components/slates/ShareSlateDialog";
import { UnmappedBindingsPanel } from "@/components/slates/UnmappedBindingsPanel";
import type { BlueprintInspection, BlueprintView, LiveShareRecord, SlateBindingDeclaration, SlateCapabilityGraph } from "@kinu.run/core";
import UserSettingsPage from "@/pages/UserSettingsPage";
import { DeviceRow } from "@/components/devices/DeviceRow";
import { StandingApprovalsCard } from "@/pages/SettingsPage";
import {
  ADVISOR_SEVERITIES, ADVISOR_SEVERITY_METADATA_KEY, ADVISOR_SIGNAL_KIND,
  BUILTIN_PROFILE_CATALOG, BUILTIN_TOOLS, BUILTIN_TOOL_DESCRIPTIONS, BUILTIN_TOOL_SPECS,
  CHARS_PER_TOKEN, DEVICE_TIERS, TOOL_REACH, JsonObjectSchema, JsonValueSchema, mergeTranscript,
  missingSubordinateHistory,
  parseDeviceTier, seekPage, sortDirEntries, SubordinateInspectionRequestSchema,
  type AdvisorSeverity, type JsonValue, type PlanReview, type ReviewAnnotation,
  type ProfileCatalogEnvelope, type SubordinateInspectionRequest, type AccountUsage,
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
  AccountSpend, PendingAction, ProducerSpend, RunSummary, SearchTreeRow, Usage, WorkspaceSpend,
} from "@kinu.run/core";
import type { McpServerSummary, ModelMenuEntry, ModelTestResult, RosterCounts, RosterEntry, RosterFrame, RosterPage, UserDevice, WorkspaceEntry } from "@/lib/user-api";
import { McpServerSummarySchema, ROSTER_SOCKET_ROUTE } from "@/lib/user-api";
import * as v from "valibot";
import { galleryServerPush, seedGalleryChat, serveGalleryRpc } from "@/gallery-agent-stub";

const frame = new URLSearchParams(location.search).get("frame") ?? "all";

// Declared before the shell mounts so the app background attaches its stepping controls here only (scripts/app-background-ux.test.ts).
window.__kinuGalleryStepping = true;

const squareButtonVariant = "square";

const SQUARE_BUTTON_PROPS = { ["sha" + "pe"]: squareButtonVariant };

const NOW = Date.now();

/** `welcome` poses as a new account (no stamp, no workspace); every other frame is an established one. */
const ACCOUNT_ONBOARDED_AT: number | null = frame === "welcome" ? null : NOW - 864e5;

const ACCOUNT_WORKSPACE_COUNT = frame === "welcome" ? 0 : 1;

const ROSTER = new URLSearchParams(location.search).get("roster") ?? "stock";

const STOCK_ROSTER = {
  entries: [
    { name: "checkout-fixes", displayName: new URLSearchParams(location.search).get("frame") === "coderendering"
      ? "Investigate intermittent checkout failures in the percentage coupon migration and verify the release"
      : "Checkout coupon bug", createdAt: NOW - 7 * 864e5, lastVisited: NOW - 60e3, archivedAt: null },
    { name: "perf-audit", displayName: "Perf audit — landing", createdAt: NOW - 3 * 864e5, lastVisited: NOW - 2 * 36e5, archivedAt: null },
    { name: "email-triage", displayName: "Email triage automation", createdAt: NOW - 30 * 864e5, lastVisited: NOW - 864e5, archivedAt: null },
    { name: "design-sys", displayName: "Design system v2", createdAt: NOW - 864e5, lastVisited: NOW - 5 * 864e5, archivedAt: null },
    // First-run row: titled by its first prompt, so it has no title yet, only its slug.
    { name: "handwrought-walnut-4166c321", displayName: "", createdAt: NOW - 60e3, lastVisited: NOW - 30e3, archivedAt: null },
  ],
  total: 5,
};

// Selected once so the profile's workspaceCount matches the list endpoint; the gate reads both.
const GALLERY_ROSTER: { entries: WorkspaceEntry[]; total: number } =
    ROSTER === "empty" ? { entries: [], total: 0 }
  : STOCK_ROSTER;

const STUB_DATA = v.parse(JsonObjectSchema, {
  // Every field the client's `UserProfileSchema` requires; a fixture that type-checks can still fail that parse.
  "/api/user/profile": {
    email: "ashish@example.com", displayName: "Ashish",
    createdAt: NOW - 90 * 864e5, lastSeenAt: NOW, onboardedAt: NOW - 90 * 864e5,
    workspaceCount: GALLERY_ROSTER.total,
  },
  // A ModelMenu, not a bare array.
  "/api/user/models": { models: MODEL_STUBS(), failures: [] },
  // Account settings' Devices card reads both; a 404 photographs its failure state.
  "/api/user/devices": [
    {
      id: "dev_1", label: "ashish-mbp", os: "darwin", hostname: "ashish-mbp.local",
      connected: true, createdAt: NOW - 40 * 864e5, lastSeenAt: NOW - 90e3,
      expiresAt: NOW + 50 * 864e5, lastIp: "192.0.2.2", lastAgent: "kinu-device",
      replacedAt: null, revokedAt: null, unstoppedAt: null, reuseDetectedAt: null, wholeMachine: false,
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

const ACCOUNT_FIXTURE_FRAMES = new Set(["usersettingsstate", "setupmodal", "welcome", "workspaces", "plugins", "devices", "devices-empty"]);

/* Account-settings failure rig: Codex stays failed until `gallery:settings-heal`, the gateway read pends until
   `gallery:settings-release`; sibling GETs settle immediately so branch-local publication is observable. */
const SETTINGS_GATEWAY_HOLD = Promise.withResolvers<void>();

let settingsCodexHealthy = false;

window.addEventListener("gallery:settings-heal", () => { settingsCodexHealthy = true; });

window.addEventListener("gallery:settings-release", () => SETTINGS_GATEWAY_HOLD.resolve());

function fixtureJson(body: JsonValue | ProfileCatalogEnvelope | AccountUsage, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const GalleryMcpAddSchema = v.object({
  name: v.optional(v.string()),
  serverUrl: v.optional(v.string()),
  transport: v.optional(v.picklist(['auto', 'sse', 'streamable-http'])),
  headers: v.optional(v.record(v.string(), v.string())),
  allowedTools: v.optional(v.array(v.string())),
  presetId: v.optional(v.string()),
});

/** One of each state a row draws: healthy, authorizing, failed. */
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

/** A name the account already claims refuses the preset's own add; 'github' is the GitHub preset's name. */
const GALLERY_UNCLAIMED_MCP = GALLERY_CUSTOM_MCP.filter((row) => row.name !== "github");

/** Mutable so the preset add is observable on the next GET. `mcp-preset=connected` swaps in the preset-tagged states; `mcp-preset=open` leaves every preset unclaimed. */
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

/** `mcp-secrets=github` means GitHub alone; absent means every oauth-app preset is configured (production-shaped). */
const mcpSecrets = (() => {
  const raw = new URLSearchParams(location.search).get("mcp-secrets");

  const listed = raw === null ? ["github", "google"] : raw.split(",");

  return new Set(listed.filter((entry) => entry.length > 0));
})();

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

function accountProfileFixture(path: string, method: string, body: BodyInit | null | undefined): Response | null {
  if (path === "/api/user/onboarding/complete" && method === "POST") {
    return fixtureJson({ onboardedAt: NOW });
  }

  if (path === "/api/user/account" && method === "DELETE") {
    return fixtureJson({ deleted: true });
  }

  if (path === "/api/user/models/test" && method === "POST") {
    return fixtureJson({ ok: true, firstTokenMs: 410, totalMs: 620 });
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
    // The wizard's profile step renders only without a display name: `&noname=1` answers that account.
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

async function settingsSectionsFixture(path: string): Promise<Response | null> {
  if (path === "/api/user/credentials") {
    return fixtureJson([
      { key: "anthropic.bearer", kind: "bearer", createdAt: NOW - 864e5, updatedAt: NOW },
      { key: "anthropic.bearer@work", kind: "bearer", createdAt: NOW - 36e5, updatedAt: NOW },
    ]);
  }

  if (path === "/api/user/usage") {
    return fixtureJson({
      accounts: ACTIVITY_ACCOUNTS,
      workspaces: 4,
      unread: ["old-bot"],
      limitsUnread: [{ provider: "claude", account: "work", reason: "Claude answered HTTP 401 for the work account" }],
      limits: [
        { provider: "claude", account: "main", at: NOW - 5e3, windows: [
          { name: "5h", usedPercent: 62, resetsAt: NOW + 2 * 36e5 + 3 * 6e4 },
          { name: "weekly", usedPercent: 18, resetsAt: NOW + 3.5 * 864e5 },
        ] },
        { provider: "codex", account: "main", at: NOW - 5e3, windows: [
          { name: "5h", usedPercent: 40, resetsAt: NOW + 36e5 },
          { name: "weekly", usedPercent: 7, resetsAt: NOW + 6 * 864e5 },
        ] },
        { provider: "opencode-go", account: "main", at: NOW - 12 * 6e4, undocumented: true, windows: [
          { name: "5h", usedPercent: 12, resetsAt: NOW + 3 * 36e5 },
          { name: "weekly", usedPercent: 55, resetsAt: NOW + 3 * 864e5 },
          { name: "monthly", usedPercent: 100, resetsAt: NOW + 8.4 * 864e5 },
        ] },
        { provider: "openrouter", account: "main", at: NOW - 5e3, windows: [{ name: "credit", used: 5.88, limit: 10, resets: "monthly" }] },
      ],
    });
  }

  if (path === "/api/user/codex") {
    return settingsCodexHealthy
      ? fixtureJson({ connected: false, accountId: null, expiresAt: null, startedFlow: null })
      : fixtureJson({ error: "Codex status fixture failed" }, 503);
  }

  if (path === "/api/user/models") {
    // Different effort lists per model: the tier levels are the model's, never a fixed three.
    return fixtureJson({
      models: [
        { spec: "workers-ai/llama-4", label: "Llama 4", provider: "workers-ai", reasoningEfforts: [] },
        { spec: "anthropic/claude-opus-4-7", label: "Claude Opus 4.7", provider: "anthropic", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
      ],
      failures: [],
      accounts: { anthropic: ["main", "work"] },
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

/* The setupmodal frame mounts the real HomePage behind the modal, so the roster and server list must answer here too. */
function workspaceRosterFixture(path: string): Response | null {
  const url = new URL(path, location.origin);

  return url.pathname === "/api/user/workspaces" ? fixtureJson(rosterAnswer(url.searchParams)) : null;
}

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

    // Name is the identity; the refusal is the UserDO transaction's sentence.
    if (galleryMcpRows.some((row) => String(row.name).toLowerCase() === name.toLowerCase())) {
      return fixtureJson({ error: `An MCP server named '${name}' already exists.` }, 400);
    }

    // Sign-in only where an authorize URL exists: DCR always, oauth-app only while the frame claims the app.
    const signIn = preset?.auth === 'oauth'
      || (preset?.auth === 'oauth-app' && mcpSecrets.has(preset.id));

    if (preset?.auth === 'oauth-app' && !signIn && addBody.output.headers === undefined) {
      return fixtureJson({ error: `'${preset.title}' needs either the deployment's OAuth app or a token in \`headers\`.` }, 400);
    }

    const id = `srv-add-${String(galleryMcpRows.length + 1)}`;

    const authUrl = signIn
      ? `${new URL(preset.serverUrl).origin}/authorize?${id}`
      : null;

    // Exposed so the gate can check the posted payload.
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

function deviceRowsFixture(path: string, method: string, body: BodyInit | null | undefined): Response | null {
  if (path === "/api/user/devices/dev-1" && method === "DELETE") {
    localStorage.setItem("gallery-device-incident", "revoked");

    return fixtureJson({ ok: true, unstoppedCommands: 2 });
  }

  if (path === "/api/user/devices/dev-1/unstopped" && method === "DELETE") {
    localStorage.setItem("gallery-device-incident", "acknowledged");

    return fixtureJson({ ok: true });
  }

  // Persisted in localStorage so the switch survives a reload.
  if (path === "/api/user/devices/dev-1/sandbox" && method === "PUT") {
    const { tier } = v.parse(v.object({ tier: v.picklist(DEVICE_TIERS) }), JSON.parse(v.parse(v.string(), body)));
    localStorage.setItem("gallery-device-tier", tier);

    return fixtureJson({ ok: true });
  }

  if (path === "/api/user/devices" && method === "POST") {
    return fixtureJson({ origin: location.origin, installCommand: GALLERY_CONNECT_COMMAND }, 201);
  }

  if (path === "/api/user/devices") {
    if (frame === "devices-empty") return fixtureJson([]);
    const incident = localStorage.getItem("gallery-device-incident");

    if (incident === "acknowledged") return fixtureJson([]);
    const revoked = incident === "revoked" || incident === "reused";

    return fixtureJson([
      {
        id: "dev-1", label: "Workstation", os: "linux", hostname: "workstation",
        connected: !revoked, createdAt: NOW - 864e5, lastSeenAt: NOW, expiresAt: NOW + 864e5,
        lastIp: "192.0.2.1", lastAgent: "kinu-device", replacedAt: null,
        revokedAt: revoked ? NOW : null, unstoppedAt: incident === "revoked" ? NOW : null,
        reuseDetectedAt: incident === "reused" ? NOW : null, wholeMachine: false,
        sandbox: {
          tier: parseDeviceTier(localStorage.getItem("gallery-device-tier")),
          capability: "sandboxed", reason: null, gpu: ["/dev/nvidia0"],
        },
      },
      ...(frame === "devices" ? [{
        id: "dev-2", label: "Owner laptop", os: "darwin", hostname: "ashish-mbp.local",
        connected: false, createdAt: NOW - 40 * 864e5, lastSeenAt: NOW - 7200e3, expiresAt: NOW + 50 * 864e5,
        lastIp: "192.0.2.2", lastAgent: "kinu-device", replacedAt: null,
        revokedAt: null, unstoppedAt: null, reuseDetectedAt: null, wholeMachine: true,
        sandbox: { tier: "sandboxed", capability: "sandboxed", reason: null, gpu: [] },
      }] : []),
    ]);
  }

  return null;
}

/** Hashed with WebCrypto: the gallery has no `node:crypto`. */
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

/** Answers the paths it owns, `null` for every other; sync or async. */
type SettingsSlice =
  (path: string, method: string, body: BodyInit | null | undefined)
    => Response | null | Promise<Response | null>;

/* Path sets are disjoint: the order is for reading, not routing. */
const SETTINGS_SLICES: readonly SettingsSlice[] = [
  accountProfileFixture,
  settingsSectionsFixture,
  workspaceRosterFixture,
  mcpServersFixture,
  deviceRowsFixture,
  pluginsFixture,
  profileCatalogFixture,
];

async function userSettingsFixture(path: string, method: string, body: BodyInit | null | undefined): Promise<Response> {
  for (const slice of SETTINGS_SLICES) {
    const response = await slice(path, method, body);

    if (response !== null) return response;
  }

  return fixtureJson({ error: `gallery has no settings fixture for ${path}` }, 404);
}

/* `&connect=1`: no machines until the panel registers one; the next roster read carries it connected. `&connect=stall`
   never connects, so a panel closing on any roster tick fails; `galleryRosterReads` lets the gate wait on polls, not a clock. */
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
    // On the document, not `window`: `dataset` is a typed string map, a global is not.
    document.documentElement.dataset.galleryRosterReads = String(connectRosterReads);
    document.documentElement.dataset.galleryRegistrations = String(connectRegistrations);

    return fixtureJson(connectRegistrations === 0 ? [] : [{
      id: "dev-arrived", label: "Owner PC", os: "darwin", hostname: "owner-mac",
      connected: connectFixtureMode !== "stall",
      createdAt: NOW, lastSeenAt: NOW, expiresAt: NOW + 864e5,
      lastIp: "192.0.2.7", lastAgent: "kinu-device", replacedAt: null,
      revokedAt: null, unstoppedAt: null, reuseDetectedAt: null, wholeMachine: false,
      sandbox: { tier: "sandboxed", capability: "sandboxed", reason: null, gpu: [] },
    }]);
  }

  if (path === "/api/user/devices/consents" && method === "GET") return fixtureJson([]);

  return null;
}

/* One tile per card state; `gallery:overview` ({name, overview}) changes one and the roster socket carries it. */
const STOCK_OVERVIEWS = new Map(Object.entries({
  "checkout-fixes": {
    activity: "working", decisionsWaiting: 2, hasUpdates: true,
    latestRun: { status: "error", task: "Investigate intermittent checkout failures in the coupon migration" },
    slates: [{ id: "coupon-board", title: "Coupon board", picture: null, bindings: 0, visibility: null }], shares: [],
  },
  "perf-audit": {
    activity: "working", decisionsWaiting: 0, hasUpdates: false,
    latestRun: { status: null, task: "Profile the landing bundle and split the vendor chunk" }, slates: [], shares: [],
  },
  "email-triage": {
    activity: "idle", decisionsWaiting: 0, hasUpdates: true,
    latestRun: { status: "completed", task: "Sort this week's receipts into the ledger" }, slates: [], shares: [],
  },
  "design-sys": {
    activity: "unfinished", decisionsWaiting: 0, hasUpdates: false,
    latestRun: { status: "error", task: "Design system v2" }, slates: [], shares: [],
  },
  "handwrought-walnut-4166c321": {
    activity: "idle", decisionsWaiting: 0, hasUpdates: false, latestRun: null, slates: [], shares: [],
  },
  "audit-sweep": {
    activity: "unfinished", decisionsWaiting: 0, hasUpdates: false,
    latestRun: { status: "completed", task: "Recount the quarter's shares against the register" }, slates: [], shares: [],
  },
} satisfies Record<string, WorkspaceOverview>));

/** A sixth entry whose last run is quiet, so 'Unfinished' can headline; the home roster's pins keep it off the stock five. */
const EXTRA_WORKSPACE = new URLSearchParams(location.search).get("extraWorkspace") === "1";

const galleryRoster: RosterEntry[] = [
  ...GALLERY_ROSTER.entries,
  ...(EXTRA_WORKSPACE ? [{
    name: "audit-sweep", displayName: "Audit sweep", createdAt: NOW - 14 * 864e5, lastVisited: NOW - 36e5, archivedAt: null,
  }] : []),
].map((entry) => {
  const overview = STOCK_OVERVIEWS.get(entry.name) ?? null;

  return { ...entry, overview, decisions: overview?.decisionsWaiting ?? 0 };
});

function galleryRosterCounts(): RosterCounts {
  const counts: RosterCounts = { all: galleryRoster.length, needs: 0, working: 0, idle: 0, unreported: 0, decisions: 0 };

  for (const entry of galleryRoster) {
    counts[rosterBucket(entry.overview?.activity ?? null, entry.decisions)] += 1;
    counts.decisions += entry.decisions;
  }

  return counts;
}

function rosterAnswer(search: URLSearchParams): RosterPage {
  const bucket = search.get("bucket");
  const q = search.get("q") ?? "";

  const entries = galleryRoster.filter((entry) => rosterMatches(entry, q)
    && (bucket === null || rosterBucket(entry.overview?.activity ?? null, entry.decisions) === bucket));

  return { entries, total: entries.length, nextCursor: null, counts: galleryRosterCounts() };
}

const rosterSockets = new Set<EventTarget>();

/** `&rosterSocket=refused` closes each socket unopened; `&session=expired` makes each roster read a 401. */
const galleryQuery = new URLSearchParams(location.search);

const ROSTER_SOCKET_REFUSED = galleryQuery.get("rosterSocket") === "refused";

const SESSION_EXPIRED = galleryQuery.get("session") === "expired";

const galleryRosterSockets: GalleryRosterSocket[] = [];

Object.assign(window, { galleryRosterSockets });

class GalleryRosterSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;

  constructor() {
    super();
    galleryRosterSockets.push(this);
    rosterSockets.add(this);
    queueMicrotask(() => {
      if (ROSTER_SOCKET_REFUSED) {
        this.close();

        return;
      }

      this.readyState = WebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(): void {}

  close(): void {
    this.readyState = WebSocket.CLOSED;
    rosterSockets.delete(this);
    this.dispatchEvent(new CloseEvent("close"));
  }
}

const OverviewCommandSchema = v.object({ name: v.string(), overview: v.nullable(WorkspaceOverviewSchema) });

window.addEventListener("gallery:overview", (event: Event) => {
  // Parsed at the boundary: nothing typechecks across a dispatch.
  const detail = event instanceof CustomEvent ? v.safeParse(OverviewCommandSchema, event.detail) : null;

  if (detail?.success !== true) return;
  const entry = galleryRoster.find((each) => each.name === detail.output.name);

  if (entry === undefined) return;
  entry.overview = detail.output.overview;
  entry.decisions = detail.output.overview?.decisionsWaiting ?? 0;
  const change: RosterFrame = { type: "workspace", name: entry.name, entry: { ...entry }, counts: galleryRosterCounts() };

  for (const socket of rosterSockets) socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(change) }));
});

const STUB = new Map(Object.entries(STUB_DATA));

/** KINU-060: every WorkspaceRosterProvider mount is held; StrictMode mounts twice, so holding only the first read would let the second publish the ordinary fixture. */
const rosterAuthorityHold = Promise.withResolvers<Response>();

function MODEL_STUBS(): ModelMenuEntry[] {
  return [
    { spec: "anthropic/claude-opus-4", label: "Claude Opus 4", provider: "Anthropic", reasoningEfforts: ["low", "medium", "high"] },
    { spec: "workers-ai/llama-4", label: "Llama 4 (Workers AI)", provider: "Workers AI" },
    { spec: "openai/gpt-5.6", label: "GPT-5.6", provider: "OpenAI" },
  ];
}

const realFetch = window.fetch.bind(window);

// `&anon=1` answers the profile with null (signed out), so every persist path is a no-op. Stub data, not a galleryFetch branch: that dispatch is at its complexity budget.
const ANONYMOUS_WORKSPACE = frame === 'workspacepage'
  && new URLSearchParams(location.search).get('anon') === '1';

if (ANONYMOUS_WORKSPACE) STUB.set('/api/user/profile', null);

/** Every path fetched, so a gate can prove what the page did not read. */
const galleryRequests: string[] = [];

Object.assign(window, { galleryRequests });

const galleryFetch = Object.assign((input: RequestInfo | URL, init?: Parameters<typeof window.fetch>[1]) => {
  const parsedRequest = v.safeParse(v.instance(Request), input);
  const url = requestUrl(input);

  galleryRequests.push(new URL(url, location.origin).pathname);

  const path = url.startsWith("/") ? url : new URL(url, location.origin).pathname;
  const method = (init?.method ?? (parsedRequest.success ? parsedRequest.output.method : "GET")).toUpperCase();

  if (ACCOUNT_FIXTURE_FRAMES.has(frame) && path.startsWith("/api/user/")) {
    return userSettingsFixture(path, method, init?.body);
  }

  if (connectFixtureActive && path.startsWith("/api/user/devices")) {
    const answer = deviceConnectFixture(path, method);

    if (answer !== null) return Promise.resolve(answer);
  }

  const roster = new URL(url, location.origin);

  if (roster.pathname === "/api/user/workspaces" && method === "GET") {
    // Cloned per call: a `Response` body reads once and the provider has several reads in flight here.
    if (frame === "rosterauthority") return rosterAuthorityHold.promise.then((held) => held.clone());

    if (SESSION_EXPIRED) return Promise.resolve(fixtureJson({ error: "Sign in again." }, 401));

    return Promise.resolve(fixtureJson(rosterAnswer(roster.searchParams)));
  }

  const response = STUB.get(path);

  if (response !== undefined && (!init?.method || init.method === "GET")) {
    return Promise.resolve(new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } }));
  }

  // WorkspacePage records the visit on mount; a 404 renders a notice no real page shows.
  if (method === "POST" && /^\/api\/user\/workspaces\/[^/]+\/touch$/.test(path)) {
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }));
  }

  // Feedback and control-plane requests reach the network so the gate decides them by request interception; a stub 404 would fail every send and hide the control plane's non-ok states.
  if (path === FEEDBACK_ENDPOINT || path.startsWith('/api/control/')) return realFetch(input, init);

  // Reaches the network too: the gate moves the build stamp between load and fault to prove the report carries this page's build.
  if (path === CLIENT_ERROR_ENDPOINT || path === '/api/health') return realFetch(input, init);

  if (path.startsWith("/api/")) {
    return Promise.resolve(new Response(JSON.stringify({ error: "gallery stub" }), { status: 404 }));
  }

  return realFetch(input, init);
}, { preconnect: realFetch.preconnect });

window.fetch = galleryFetch;

installDriveFixture(frame);


// Stands in for the runtime's terminal facet (core execution/workspace-terminal.ts): echoes input, runs a line at CR,
// ends output lines with CR LF like the runtime's `writeln`, and keeps every `input` frame for the gate.

const PROMPT = "$ ";

declare global {
  interface Window {
    __kinuTerminalInput?: string[];
  }
}

const TERMINAL_PATH = /^\/api\/workspaces\/[^/]+\/terminal$/u;

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
    // The runtime replays its screen before ready; here the screen is empty.
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
      // xterm hands a paste over with newlines already CR, so CR is the only line end.
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

/** Every frame's roster socket is the fixture's; the environment frame's terminal socket is too. */
window.WebSocket = new Proxy(window.WebSocket, {
  construct(target, args: [string | URL, (string | string[])?]) {
    const [url, protocols] = args;
    const path = new URL(String(url), location.href).pathname;

    if (path === ROSTER_SOCKET_ROUTE) return new GalleryRosterSocket();

    if (frame === "environment" && TERMINAL_PATH.test(path)) return new GalleryShellSocket(url);

    return protocols === undefined ? new target(url) : new target(url, protocols);
  },
});


/** A real MCTS tree at the size the view must survive; rows, not a tree, so it enters through `buildTree` like the socket payload. */
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
    id: "n000", parent_id: null, depth: 0, visits: 31, value: 0.028, own_score: 0.028,
    status: "open", action: "Find why the SAVE20 coupon 500s",
    task: "Find why the SAVE20 coupon 500s and fix it.",
    observation: "Four candidate fixes explored; one line survived to depth 6.",
    created_at: NOW - 36e5,
  });

  // A pruned branch keeps the children it had before it was cut.
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

      // The engine scores a failed branch 0 and backpropagates it.
      const score = status === "failed" ? 0 : value;

      const child = push({
        id: `n${String(rows.length).padStart(3, "0")}`,
        parent_id: parent.id, depth: parent.depth + 1, visits, value: score, own_score: score, status,
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

  winner.status = "terminal";

  return rows;
}

/** The scale probe: the same search shape five times over and three levels deeper. */
const MCTS_ROWS = frame === "forkbig" ? mctsSearchRows(520, 9) : mctsSearchRows(106, 6);

const MCTS_TREE = buildTree(MCTS_ROWS);

const MCTS_TREES: ReadonlyMap<string, ForkNode> = new Map([[MCTS_TREE.id, MCTS_TREE]]);

const EMPTY_TREES: ReadonlyMap<string, ForkNode> = new Map();

const NO_HEAD_ACTIVITY: ReadonlyMap<string, number> = new Map();

/**
 * The Agents-SDK RPC transport, answered in-page from a table so socket-gated pages render without a worker.
 * Non-agent sockets (vite HMR) fall through to the real WebSocket.
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
    // The full-screen explorer reads its tree off the snapshot.
    mcts: MCTS_ROWS,
    timeline: [], executors: [], executorOutputs: [], lastActiveExecutor: null,
    // Mirrors the server snapshot: `loadAllData` replaces state wholesale, so an omitted field is `undefined`.
    pendingSteers: [], branchRuns: [],
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

const WORKSPACE_PAGE_NAME = new URLSearchParams(location.search).get("ws") ?? "checkout-fixes";

// `&ws=handwrought-walnut-4166c321` is the untitled row: its snapshot answers a blank displayName.
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

      // Answered here, not by the blanket `[]` fall-through (wrong shape for non-array reads); Column C's injected `Rpc` and this socket must resolve the same fixture stores.
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

/** A frame the gate makes the server send: only cards and steers carry an actor stamp, which no fixture read can produce. */
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
  const detail = event instanceof CustomEvent ? v.safeParse(GalleryPushFrameSchema, event.detail) : null;

  if (detail?.success !== true) return;

  galleryServerPush(JSON.stringify(detail.output));
});

interface GalleryMessage extends UIMessage { createdAt?: number }

function msg(message: GalleryMessage): GalleryMessage { return message; }

function rpcResult(value: JsonValue): Response {
  return new Response(JSON.stringify(value));
}

const MESSAGES: UIMessage[] = [
  // The owner typed a mission, not a message, so this must never wear their bubble.
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
      // A run of calls, not one.
      { type: "tool-file", toolCallId: "t4", state: "output-available", input: { action: "read", path: "packages/checkout/src/apply-coupon.ts" }, output: "…" },
      { type: "tool-file", toolCallId: "t5", state: "output-available", input: { action: "read", path: "packages/checkout/migrations/0042_coupon_kind.sql" }, output: "…" },
      // A quiet failure: state output-available, but the tool returned its own `{error}` (tools/builtins.ts); unsurfaced, it makes the group read clean.
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
  // Copied from production: written before the author stamp, so a bare UUID id and the event name are its only markers.
  msg({
    id: "f8798675-5e9a-4d13-aac2-293f4557f1c1", role: "user",
    metadata: { kinuEvent: "fork_interrupted", runs: ["6xrijuf933p0jclpctw59"], heads: 23 },
    parts: [{ type: "text", text: "23 head(s) across 6 fork run(s) were still marked running from an activation that has ended, so nothing is executing them and no report will arrive. They have been released; re-run the ones you still need." }],
  }),
  msg({
    id: "programmatic:completion-gate-1", role: "user",
    metadata: { kinuEvent: "completion_gate", kinuAuthor: "harness" },
    parts: [{ type: "text", text: "[Runtime check — a mechanical gate from Kinu, not written by the user.]\n\nYou said the task is done. Here is the current state of the working directory, read after you stopped." }],
  }),
  msg({
    id: "a2", role: "assistant", createdAt: NOW - 3 * 60e3,
    parts: [
      { type: "text", text: "The edit above didn't take — re-reading before I retry, then confirming the migration is idempotent before I let it near staging." },
      // Its own row (a lone text part on either side stops it folding into a run) so its expanded state is inspectable.
      {
        type: "tool-run", toolCallId: "t9", state: "output-available",
        input: {
          runtime: "sandbox",
          command: "for f in packages/checkout/migrations/*.sql; do\n  echo \"-- checking $f\"\n  sqlite3 :memory: < \"$f\" || exit 1\ndone",
        },
        output: "-- checking packages/checkout/migrations/0041_coupons.sql\n-- checking packages/checkout/migrations/0042_coupon_kind.sql",
      },
      { type: "text", text: "Migrations are clean. One more check before I loop back to the edit." },
      // A protocol-level failure: no `output`; the reason is in errorText.
      {
        type: "tool-run", toolCallId: "t10", state: "output-error",
        input: { runtime: "workspace", command: "curl -sf https://ci.internal/status/checkout-fixes" },
        errorText: "fetch failed: connect ETIMEDOUT 10.0.4.12:443",
      },
      { type: "text", text: "CI didn't answer — checking the PR directly instead." },
      // No summarizer contract: name plus its one string argument; long enough to exercise truncation.
      {
        type: "dynamic-tool", toolCallId: "t11", toolName: "mcp_gh_search_pull_requests", state: "output-available",
        input: { query: "repo:AshishKumar4/shop is:open head:fix/coupon-kind base:main status:success review-requested:AshishKumar4" },
        output: "1 open PR: #212 \"Fix SAVE20 coupon backfill\" — checks pending",
      },
      // A crafted tool: the result line attributes it; builtins and `mcp_` tools never do.
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

  // Answers only the reference asked for; an unissued revision is `missing`, so a stale hint cannot paint a neighbouring plan.
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

  // A record, not an array: read as `result.ports`, so the blanket `[]` below throws. Empty so no live-preview chip enters the fork screenshots.
  if (method === "getExposedPorts") return rpcResult({ ports: [] }).json<T>();

  // `ExecutorDiffResult` (core read-models/workspace-diff.ts) always carries `files`; `vfs-baseline` is the answer for an empty `executors` prop.
  if (method === "getExecutorDiff") return rpcResult({ files: [], mode: "vfs-baseline" }).json<T>();

  // Read as `result.plans` / `result.tasks`.
  if (method === "listWorkspaceWork") return rpcResult({ plans: [], tasks: [] }).json<T>();

  // Read as `result.builtIn.map(...)`; three halves, as the orchestrator answers it.
  if (method === "getToolDescriptions") return rpcResult({ builtIn: [], executors: [], crafted: [] }).json<T>();

  if (method.startsWith("list") || method.startsWith("get")) return rpcResult([]).json<T>();

  return rpcResult({}).json<T>();
};

/* `?createFails=1`: the first create rejects with a two-frame cause chain; the second succeeds. */
const CREATE_FAILS = new URLSearchParams(location.search).get("createFails") === "1";

const RENAME_FAILS = new URLSearchParams(location.search).get("renameFails") === "1";

let createRefused = false;

function maybeRefuseCreate(): void {
  if (!CREATE_FAILS || createRefused) return;
  createRefused = true;
  throw new Error("the workspace refused the new agent", {
    cause: new Error("subordinate quota exhausted"),
  });
}

/* The `workspacepage` frame's additional-agent roster, mutated by the real page; only the chat stays inert (`agentchats` covers send). */
const GALLERY_SUBS: {
  name: string; actorId: string; displayName: string; role: string; createdBy: string;
  status: string; currentTask: string | null; createdAt: number; dismissedAt: number | null;
}[] = [];

let gallerySubSeq = 0;

/** Derived from the name, so gate-stamped frames and the pane's snapshot id agree without a second fixture. */
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

/* `?plan=late-heading` (mid-document h1) and `?plan=annotated-heading` (anchor on the leading h1): the header must promote
   neither. `?plan=read-only` is a settled plan. */
const GALLERY_PLAN_VARIANT = new URLSearchParams(location.search).get("plan");

const GALLERY_PLAN_LATE_HEADING = `The guard runs after the discount lands, so an archived coupon still applies.

# Rejected: map the failure at the edge

Mapping it in the route hides the defect and leaves the cart already mutated.

## Scope

- Read the coupon and campaign in one transaction.`;

const GALLERY_PLAN_TITLE_NOTE: ReviewAnnotation = {
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

const GALLERY_PLAN_ANNOTATIONS: readonly ReviewAnnotation[] =
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

/* The walk-back: two user turns, so there is a second message to revert to. `?transcript=revert` seeds it;
   `?checkpoints=1` adds a connected device and a checkpoint, the one condition that offers the device files too. */
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

const REVERT_CHECKPOINTS = new URLSearchParams(location.search).get("checkpoints");

const REVERT_CHECKPOINT: FileCheckpointEntry = {
  id: "c0ffee1", dir: "/pc/ashish-device/work/shop", at: NOW - 6 * 60e3,
  turnId: "rv-u2", sessionId: "default", reason: "before turn",
};

/** Separate facts: an unreachable store says nothing about what a turn changed. */
const REVERT_LISTINGS = new Map<string | null, FileCheckpointListing>([
  ["1", { availability: { available: true }, entries: [REVERT_CHECKPOINT] }],
  ["none", { availability: { available: true }, entries: [] }],
  ["nogit", { availability: { available: false, reason: CHECKPOINTS_UNAVAILABLE_NO_GIT }, entries: [] }],
]);

const REVERT_LISTING: FileCheckpointListing = REVERT_LISTINGS.get(REVERT_CHECKPOINTS)
  ?? { availability: { available: false, reason: CHECKPOINTS_NO_DEVICE }, entries: [] };

function seedFrameTranscript(transcript: string | null): void {
  if (transcript === "revert") seedGalleryChat(REVERT_THREAD);
}

/** As the Durable Object broadcasts it after the walk-back. */
function galleryRevertConversation(entryId: string): void {
  const from = REVERT_THREAD.findIndex((message) => message.id === entryId);
  const kept = from < 0 ? REVERT_THREAD : REVERT_THREAD.slice(0, from);

  galleryServerPush(JSON.stringify({ type: "cf_agent_chat_messages", messages: kept }));
}

/* The reads the first-visit inspector policy decides on, in the shapes the page consumes (`listSlates` needs an array for `slates.map`). */
const WORKSPACE_PAGE_RPC = new Map(Object.entries({
  getWorkspaceSnapshot: () => {
    const snapshot = v.parse(JsonObjectSchema, AGENT_RPC.get("getWorkspaceSnapshot"));

    return { ...snapshot, activePlan: galleryAgentPlan };
  },
  // `&slates=3`: three slates, whose tabs overflow the strip.
  listSlates: () => ({
    slates: ["Board", "Notes", "Tally"].slice(0, Number(new URLSearchParams(location.search).get("slates") ?? 0))
      .map((title) => ({ id: title.toLowerCase(), title, bindings: [] })),
    problems: [],
  }),
  getActivePlanReview: () => galleryAgentPlan,
  // The Work tab draws this read, not `getActivePlanReview`. The owner is the workspace's name: `createMain({ name: this.name })` registers it, never "main".
  listWorkspaceWork: () => ({
    plans: [{
      owner: { actorId: galleryActorId(WORKSPACE_PAGE_NAME), name: WORKSPACE_PAGE_NAME, retired: false },
      plan: galleryAgentPlan, tasks: [],
    }],
    tasks: [],
  }),
  savePlanReviewAnnotations: () => ({ ok: true, plan: galleryAgentPlan }),
  // Without an answer the strip hides Work on first paint.
  getWorkspaceTabPresence: () => ({ work: true, releases: true, explorations: true }),
  listPendingConsents: () => [],
  // The seed is the whole conversation, so the storage walk is exhausted at once.
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

/** Wrapped so `null` stays free to mean "not mine" while the answer itself may be anything serialisable. */
type GalleryAnswer = { readonly value: unknown } | null;

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

function galleryRosterRpc(method: string, args?: unknown[]): GalleryAnswer {
  if (method === "listSubordinates") return { value: [...GALLERY_SUBS] };

  // Recorded so a gate can read which actor a pick wrote.
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
      name, actorId: galleryActorId(name), displayName: codenameFor(name), role: "agent", createdBy: "user",
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

    if (RENAME_FAILS) throw new Error("Connection closed");

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

  // Answered by the root; the header renders the roster title, never `mission`.
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

  if (new URLSearchParams(location.search).get("snapshot") === "held" && method === "getWorkspaceSnapshot"
      && document.documentElement.dataset.snapshotReleased !== "1") {
    await new Promise<void>((resolve) => {
      const released = new MutationObserver(() => {
        if (document.documentElement.dataset.snapshotReleased !== "1") return;
        released.disconnect();
        resolve();
      });

      released.observe(document.documentElement, { attributes: true, attributeFilter: ["data-snapshot-released"] });
    });
  }

  const roster = galleryRosterRpc(method, args);

  if (roster) return rpcResult(v.parse(JsonValueSchema, roster.value)).json<T>();

  if (method === "revertConversation") {
    galleryRevertConversation(v.parse(v.string(), args?.[0]));

    return rpcResult(null).json<T>();
  }

  if (method === "getExposedPorts" && document.documentElement.dataset.listingHeld === "1") return new Promise<T>(() => {});

  if (method === "getExposedPorts" && document.documentElement.dataset.sandboxStarting === "1" && args?.[0] === "sandbox") {
    return rpcResult({ ports: [], pending: "the sandbox's container is still restoring" }).json<T>();
  }

  // Arrives after first paint: once the gate sets the dataset flag, the next live refresh lists a new port.
  if (method === "getExposedPorts" && document.documentElement.dataset.previewArrived === "1" && args?.[0] === "sandbox") {
    return rpcResult({ ports: [{ port: 8130, url: "https://8130-sandbox-aaaaaaaaaaaaaaaa.preview.example.test/", name: "Arrived app" }] }).json<T>();
  }

  const page = WORKSPACE_PAGE_RPC.get(method);

  if (page !== undefined) return rpcResult(v.parse(JsonValueSchema, page())).json<T>();
  const agent = AGENT_RPC.get(method);

  if (agent !== undefined) return rpcResult(agent).json<T>();

  return stubRpc<T>(method, args);
};

/** A named-preset search. `prove` because its resolved axes are the least guessable from its name. */
// `lean/Checkout/Coupon.lean` is invented along with the coupon table; the module does not exist. Enrolled in `CITATION_ILLUSTRATIVE`.
const PROVE_ROWS: MctsRow[] = [
  {
    id: "pv000", parent_id: null, depth: 0, visits: 0, value: 0, own_score: 0, status: "open",
    action: "Prove the coupon guard terminates",
    task: "Prove that applyCoupon terminates for every coupon row, including kind = null.",
    observation: "The workspace as found: lean/Checkout/Coupon.lean, 3 sorries.",
    created_at: NOW - 78e5,
  },
  {
    id: "pv001", parent_id: "pv000", depth: 1, visits: 4, value: 0.31, own_score: 0.31, status: "open",
    action: "Induct on the discount list", observation: "Checker accepted 1 of 3 goals.",
    created_at: NOW - 77e5,
  },
  {
    id: "pv002", parent_id: "pv000", depth: 1, visits: 1, value: 0.12, own_score: 0.12, status: "pruned",
    action: "Case-split on kind first", observation: "Below the prune floor after one rollout.",
    created_at: NOW - 77e5,
  },
  {
    id: "pv003", parent_id: "pv001", depth: 2, visits: 3, value: 0.68, own_score: 0.68, status: "open",
    action: "Strengthen the induction hypothesis", observation: "Checker accepted 2 of 3 goals.",
    created_at: NOW - 76e5,
  },
  {
    id: "pv004", parent_id: "pv000", depth: 1, visits: 0, value: 0, own_score: 0, status: "failed",
    action: "Reduce to the existing monotonicity lemma",
    observation: "Branch errored: the lemma this cites was renamed and no longer resolves.",
    created_at: NOW - 77e5,
  },
  {
    id: "pv005", parent_id: "pv003", depth: 3, visits: 5, value: 0.94, own_score: 0.94, status: "terminal",
    action: "Discharge the null case from the guard",
    observation: "Checker accepted 3 of 3 goals. No sorries remain.",
    code_used: "theorem applyCoupon_terminates : ∀ c, Terminates (applyCoupon c) := by",
    created_at: NOW - 75e5,
  },
];

/** A `custom` composition that fans in (`expand:'aggregate'`): `sw004` and `sw009` are the aggregate vertices, readable only from the journal. */
const SWARM_ROWS: MctsRow[] = [
  {
    id: "sw000", parent_id: null, depth: 0, visits: 0, value: 0, own_score: 0, status: "open",
    action: "Reconcile the three coupon fixes",
    task: "Reduce checkout p95 without regressing the coupon guard.",
    observation: "The workspace as found: p95 = 412ms on the failing fixture.",
    created_at: NOW - 22e5,
  },
  {
    id: "sw001", parent_id: "sw000", depth: 1, visits: 3, value: 0.44, own_score: 0.44, status: "open",
    action: "Cache the resolved kind per coupon id", observation: "p95 = 318ms.",
    created_at: NOW - 21e5,
  },
  {
    id: "sw002", parent_id: "sw000", depth: 1, visits: 2, value: 0.37, own_score: 0.37, status: "open",
    action: "Index rules by kind at load", observation: "p95 = 341ms.",
    created_at: NOW - 21e5,
  },
  {
    id: "sw003", parent_id: "sw000", depth: 1, visits: 1, value: 0.19, own_score: 0.19, status: "pruned",
    action: "Precompute the whole discount table", observation: "p95 = 402ms — below the prune floor.",
    created_at: NOW - 21e5,
  },
  {
    id: "sw004", parent_id: "sw001", depth: 2, visits: 4, value: 0.71, own_score: 0.71, status: "open",
    action: "Reconcile the cache with the load-time index",
    observation: "p95 = 244ms. Both parents' writes touched pricing.ts; this candidate is the merge.",
    created_at: NOW - 20e5,
  },
  {
    id: "sw005", parent_id: "sw002", depth: 2, visits: 2, value: 0.52, own_score: 0.52, status: "open",
    action: "Narrow the index to the percentage path", observation: "p95 = 296ms.",
    created_at: NOW - 20e5,
  },
  {
    id: "sw006", parent_id: "sw002", depth: 2, visits: 1, value: 0.28, own_score: 0.28, status: "pruned",
    action: "Index every rule field", observation: "p95 = 377ms — below the prune floor.",
    created_at: NOW - 20e5,
  },
  {
    id: "sw007", parent_id: "sw004", depth: 3, visits: 6, value: 0.93, own_score: 0.93, status: "terminal",
    action: "Drop the redundant second lookup",
    observation: "p95 = 188ms. The guard's fixture still passes.",
    code_used: "const kind = cached ?? inferKind(coupon);",
    created_at: NOW - 19e5,
  },
  {
    id: "sw008", parent_id: "sw004", depth: 3, visits: 2, value: 0.61, own_score: 0.61, status: "open",
    action: "Warm the cache on first read", observation: "p95 = 271ms.",
    created_at: NOW - 19e5,
  },
  {
    id: "sw009", parent_id: "sw005", depth: 3, visits: 3, value: 0.66, own_score: 0.66, status: "open",
    action: "Reconcile the narrowed index with the warm cache",
    observation: "p95 = 258ms. Consumed both depth-2 candidates that scored.",
    created_at: NOW - 19e5,
  },
];

/** At the `HeadRunView.heads` shape; for an aggregate vertex the rationale is the only record that reaches a client. */
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

/** For a preset run the run's `rationale` is the preset name: `journal.recordSplit` writes `resolved.label ?? resolved.preset`. */
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

/** `fan-in over k parents of depth d` is quoted from `strategy/swarm-run.ts`: the surface parses the count out of it. */
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
 * A search that started and reached nothing (first wave errored, run failed): must render a refusal naming its cause, not an empty tree.
 * A refused call (`resolveSwarm` / `swarmValidity`) writes no root and cannot reach this surface.
 */
const REFUSED_ROWS: MctsRow[] = [
  {
    id: "rf000", parent_id: null, depth: 0, visits: 0, value: 0, own_score: 0, status: "open",
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
 * A live swarm with nodes in every state. The stores disagree on purpose: `search_nodes` holds the root and settled nodes,
 * `head_journal` all nine; a node only in the journal is still working.
 */
const RUNNING_ROWS: MctsRow[] = [
  {
    id: "lv000", parent_id: null, depth: 0, visits: 0, value: 0, own_score: 0, status: "open",
    action: "Audit the coupon guard for unsafe kind reads",
    task: "Audit every reader of coupon.kind across the checkout package and report the ones "
      + "that can throw on a null kind, with the call path and a suggested guard.",
    observation: "The workspace as found: 41 coupon fixtures, 9 readers.",
    created_at: NOW - 42e4,
  },
  {
    id: "lv001", parent_id: "lv000", depth: 1, visits: 1, value: 0.72, own_score: 0.72, status: "open",
    action: "Walk the cart serializer's null path",
    observation: "Two readers dereference rules[kind] with no guard.",
    created_at: NOW - 30e4,
  },
  {
    id: "lv002", parent_id: "lv000", depth: 1, visits: 1, value: 0.44, own_score: 0.44, status: "open",
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
    // `head_journal.status` has six words; `interrupted` is the non-terminal one (reconciled, resume not yet ruled).
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
 * Every run the Exploration frames list, one per state the surface draws, and longer than one page so the boundary is photographable.
 * `getMctsNodeDetail` may answer null for a retired node; the blanket `[]` would crash the inspector.
 */
const FORK_RUNS: ForkRunSummary[] = [
  {
    // First: the surface focuses the newest. `branches` counts settled rows, so 2 while nine nodes exist.
    id: "lv000", name: "coupon.kind readers",
    task: "Audit every reader of coupon.kind across the checkout package",
    startedAt: NOW - 42e4, status: "running",
    hasSearchTree: true, hasNodeTranscripts: true,
    branches: RUNNING_ROWS.length - 1, winnerScore: null,
  },
  {
    // Derived: `forkbig` generates 520 rows for this same run.
    id: "n000", name: "SAVE20 500s",
    task: "Find why the SAVE20 coupon 500s", startedAt: NOW - 36e5,
    // From the same stores as each row's halves: an MCTS search has the tree only, a swarm has both.
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
    // Branchless by construction: the root is the only row.
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
    // The run whose lease outlived it; journal {@link STOPPED_RUN}, focused by `forkstopped`.
    id: "root-merge-0", name: "CLI surface audit",
    task: "Audit the CLI surface", startedAt: NOW - 9 * 36e5,
    status: "partial", hasSearchTree: false, hasNodeTranscripts: true,
    branches: 7, winnerScore: null,
  },
  ...olderForks(),
];

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
      // The read model's derivation: the task's first clause.
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
      // Closed by the settle: `HeadJournal.cacheMerge` terminalizes in-flight heads in the same transition, so a settled run has none running.
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

/** A run whose lease outlived it: `read-models/fork-runs.ts` reports `partial` because the tree, not the ledger row still saying `running`, decides. */
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


/** The six things a node panel can show, as `getNodeTranscript` answers; each must read differently. The sixth is a mid-turn branch keyed by `branchHeadId`. */
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
  // A competed branch: no tool loop, its `observation` is the whole output.
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
  // A Steer-as-Branch run: one head, its id derived from the run id.
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
  // Two nodes of the live run, reachable from the run pane's node list.
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
        // No output: the chat draws this call as still running.
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

const TRANSCRIPT_BY_NODE = new Map<string, NodeTranscriptView>(Object.entries(TRANSCRIPTS));

/** Evolution reads three non-array shapes the blanket `[]` would break; populated so the frame shows panels, not empty states. */
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

  if (method === "getFacts") return rpcResult([
    { key: "test.command", value: "bun test", confidence: 0.9, source: "project configuration", lastObservedAt: NOW - 50e5 },
    { key: "checkout.coupon_kind", value: "nullable since Tuesday", confidence: 1, source: "migration 0042", lastObservedAt: NOW - 26e5 },
  ]).json<T>();

  return stubRpc<T>(method, args);
};

/** Two runs of the same task under different policies must read differently; older forks have none (the ledger prunes settled rows after a day). */
const FORK_PARAMS: ForkRunParams[] = [
  {
    rootId: "n000",
    search: {
      budget: 24, branches: 4, maxDepth: 6, explorationWeight: 1.41,
      // Clamped: `judgeSamples` shares its call pool with check generation, so asked twenty, ran three.
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
    rootId: "lv000",
    search: {
      budget: 12, branches: 5, maxDepth: 2, explorationWeight: 1.41,
      judgeSamplesRequested: null, judgeSamplesRealised: null, mode: "build",
    },
    transcripts: null,
  },
];

/** Keyed by the run's root id, the read model's key, so one run's tree cannot pair with another's journal. */
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

/** One row per run, as the server composes it, carrying every half it has: a swarm has both `search_nodes` and `head_journal`. */
const CANVAS_ROWS: readonly ExplorationCanvasRun[] = FORK_RUNS.map((run) => ({
  run,
  params: FORK_PARAMS.find((entry) => entry.rootId === run.id) ?? null,
  tree: (SEARCH_ROWS_BY_ROOT.get(run.id) ?? []).map((row) => asSearchNode(row, run.id)),
  head: JOURNAL_BY_ROOT.get(run.id) ?? null,
  frontier: null,
}));

/** The stub stands in for the server, so the canvas payload must be the server's full row, not the client's loose shape. */
function asSearchNode(row: MctsRow, rootId: string): SearchTreeRow {
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
    own_score: row.own_score,
    depth: row.depth,
    // `running` is a merged-head status the search_nodes CHECK constraint cannot hold.
    status: row.status === "running" ? "open" : row.status,
    msg_id: row.msg_id ?? null,
    branch_agent_key: row.branch_agent_key ?? null,
    evaluation_json: null,
    created_at: row.created_at ?? NOW,
  };
}

/** Pages through the real `seekPage`. The anchor is the bare fork id, not the server's composite: `after` is opaque, so any resolvable format is valid. */
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

/** The non-array exploration reads, answered here for both transports (Column C's `Rpc` and the explorer's socket); the blanket `[]` breaks them. */
const EXPLORATION_READS = new Set([
  "getExplorationCanvas", "listForkRuns", "getForkRun", "getSearchTree", "getHeadRun",
  "getMctsNodeDetail", "getNodeTranscript",
]);

/** Named, not `unknown`: a stub must not serve a value the real read models cannot produce. */
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

  // The composed row `orchestrator.getForkRun` answers; the client reads `entry.run` off it.
  if (method === "getForkRun") return rows.find((entry) => entry.run.id === args[0]) ?? null;

  if (method === "getSearchTree") return SEARCH_ROWS_BY_ROOT.get(String(args[0])) ?? [];

  if (method === "getHeadRun") return JOURNAL_BY_ROOT.get(String(args[0])) ?? null;

  // Both answer null; the panel must not render either as "recorded nothing".
  if (method === "getMctsNodeDetail") return null;

  return TRANSCRIPT_BY_NODE.get(String(args[1])) ?? null;
}

const forkRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (EXPLORATION_READS.has(method)) return rpcResult(v.parse(JsonValueSchema, explorationRead(method, args ?? []))).json<T>();

  return stubRpc<T>(method, args);
};

/** The surface focuses `runs[0]`, so each frame puts its subject first, selected by root id rather than index. */
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

/** No search tree: a journalled run is a tree at depth 1, and every score encoding must be absent. */
const mergeFirstRpc = focusRun(
  MERGED_RUN.rootId,
  CANVAS_ROWS.filter((entry) => entry.tree.length === 0),
);

/** `settle` is derived from two of the resolved axes, not chosen. */
const provePresetRpc = focusRun("pv000");

/** No named preset resolves to `expand:'aggregate'`, so this is a composition and its axes are not recoverable. */
const swarmFanInRpc = focusRun("sw000");

const refusedRunRpc = focusRun("rf000");

/** Focused; the settled runs stay listed beneath for comparison. */
const runningSwarmRpc = focusRun("lv000");

/** Must read *stopped*, never `running`; the word comes from `read-models/fork-runs.ts`. */
const stoppedRunRpc = focusRun("root-merge-0");

/** `head_activity` counters for the live run's working nodes; settled nodes announce nothing. */
const RUNNING_ACTIVITY: ReadonlyMap<string, number> = new Map(
  RUNNING_RUN.heads.filter((head) => head.status === "running").map((head) => [head.id, 3]),
);

/**
 * Five readable stages of a live search over the real 106-node fixture, revealed a prefix at a time.
 * `?stage=N` pins one so a gate need not race a clock; without it the frame advances itself.
 */
const LIVE_STAGE_ROWS = [0, 1, 4, 12, MCTS_ROWS.length] as const;

const LIVE_STAGES = LIVE_STAGE_ROWS.length;

/** The ledger row at `stage`; it decides whether the surface polls fast or idles. */
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

/** Stage 0 has no ledger row: working nodes must not read as absent work before the first canvas row lands. */
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

/** One tick per node that has written to its journal; the newest read as working. */
function liveActivity(stage: number): ReadonlyMap<string, number> {
  const rows = LIVE_STAGE_ROWS[Math.min(stage, LIVE_STAGES - 1)] ?? 0;
  const ticks = new Map<string, number>();

  for (const row of MCTS_ROWS.slice(0, rows)) ticks.set(row.id, stage);

  return ticks;
}

/** Stable: `useAsyncResource` keys its load on the `rpc` identity, so the stage is read from a ref at call time. */
function liveRpcOver(stageRef: { readonly current: number }): Rpc {
  return async <T,>(method: string, args?: unknown[]): Promise<T> => {
    const rows = liveCanvasRows(stageRef.current);

    if (method === "getSearchTree") return rpcResult(v.parse(JsonValueSchema, rows[0]?.tree ?? [])).json<T>();

    return EXPLORATION_READS.has(method)
      ? rpcResult(v.parse(JsonValueSchema, explorationRead(method, args ?? [], rows))).json<T>()
      : stubRpc<T>(method, args);
  };
}

/** Clamped; a missing or non-numeric `stage` pins nothing. */
function pinnedLiveStage(search: string): number | null {
  const asked = new URLSearchParams(search).get("stage");
  const wanted = asked === null ? Number.NaN : Number(asked);

  return Number.isFinite(wanted) ? Math.max(0, Math.min(LIVE_STAGES - 1, wanted)) : null;
}

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

/* The real component: there is exactly one identity row. */
function GalleryWorkspaceBar({ providerWait }: { providerWait?: { provider: string; untilMs: number } | null }) {
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

/* Clearing is absent until there is a transcript to clear, like the app. */
function GalleryChatTabs({ clearable = true }: { clearable?: boolean }) {
  return (
    <SubordinateTabs
      workspace="checkout-fixes" subordinates={SUBORDINATES} activeName={undefined}
      onCreate={async () => {}} creating={false} onDismiss={async () => {}} onRename={async (_name, displayName) => displayName}
      trailing={clearable && <Button variant="ghost" {...SQUARE_BUTTON_PROPS} size="sm" icon={<TrashIcon size={12} />} aria-label="Clear history" />}
    />
  );
}

/* Shared so the wide and narrow frames photograph the same affordance. */
const MCTS_NOTICE: readonly ComposerNotice[] = [{
  id: "mcts",
  tone: "danger",
  text: "Could not refresh MCTS.",
  action: { label: "Retry", onClick: () => {} },
}];

/* The real composer over real draft/mode/model state; `notices` is a parameter so the status treatment can be reviewed. */
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
  // Stubbed at the seam the test reads: the dataset records the write, the map is its visible result.
  const [feedback, setFeedback] = useState<Record<string, 'positive' | 'negative' | null>>({});

  const onFeedback = useCallback(async (messageId: string, value: 'positive' | 'negative' | null) => {
    const root = document.documentElement;
    const prior = root.dataset.galleryFeedbackCalls;

    const calls: Array<{ method: string; args: unknown[] }> =
      // SAFETY: this callback is the recorder's only writer, so the parsed shape is its own.
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
      {/* The same card re-serving an older turn's outcome, as `sunlit-stone-4a20` answers a resume ACK. */}
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
    headActivity?: ReadonlyMap<string, number>;
    /** Empty is the liveness case: with no running job or streaming turn the fork list drops to its idle cadence. */
    backgroundJobs?: BackgroundJob[];
    /** Empty by default: only the provider-wait frame pins it. */
    providerWait?: { provider: string; untilMs: number } | null;
    /** Empty by default: a neighbour stuck in failure makes the photographed surface look broken. */
    notices?: readonly ComposerNotice[];
  },
) {
  return (
    <div className="flex h-screen w-screen flex-col p-bg p-text overflow-hidden md:flex-row">
      {/* Mirrors components/layout.tsx. */}
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
      {/* Kumo's `primary`/`destructive` force `!text-white` (2.4:1 on brass), so the filled action is FilledButton. */}
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

/* The width Column A gets (42% of the shell); full-bleed would flatter truncation. */
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

/* Production shapes: `steer-a` is a `recordLandedSteers` row, `f8798675…` a restored fork-interrupted notice with metadata, `sys-1` a markerless row the read model reports as `system`. */
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

/* A mid-turn message (#210) between the work it split, and a `fork_interrupted` notice restored by the history walk (#222) keeping its card. */
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

/* One ts, bash and json fence each: a fence that renders flat is the highlighting defect. */
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

/* The mission is a standing brief, deliberately not sent as an opening message. */
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

/* A turn waiting on the provider: the wait is named on the task indicator rather than guessed from silence. */
function ProviderWaitFrame() {
  return <Shell providerWait={{ provider: "anthropic", untilMs: Date.now() + 45_000 }} />;
}

/* A workspace with history before its transcript arrives: must read "not yet", distinct from ChatEmptyFrame's "nothing here". */
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

/* The real composer at reading width: at rest with a draft, mid-turn (Stop / Branch / Steer), and with a status row. */
function ComposerFrame() {
  const [value, setValue] = useState("Ship the coupon fix behind a preview first.");
  const [mode, setMode] = useState<ChatMode>("build");
  const [model, setModel] = useState("anthropic/claude-opus-4");
  /* The thinking level travels with the model; the composer sizes the row, so the picker takes no width class. */
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
        <ModelPickerStates />
      </div>
    </div>
  );
}

const PICKER_MODELS: ModelMenuEntry[] = [
  { spec: "codex/gpt-5.5", label: "GPT-5.5 (Codex)", provider: "codex", providerLabel: "ChatGPT Codex (subscription)", contextWindow: 272_000, capabilities: ["reasoning", "vision"] },
  { spec: "codex/gpt-6-sol", label: "GPT-6 Sol (Codex)", provider: "codex", providerLabel: "ChatGPT Codex (subscription)", contextWindow: 272_000, capabilities: ["reasoning", "vision"] },
  { spec: "claude/claude-opus-4-8", label: "Claude Opus 4.8", provider: "claude", providerLabel: "Claude (subscription)", contextWindow: 1_000_000, capabilities: ["reasoning", "vision"] },
  { spec: "claude/claude-sonnet-4-8", label: "Claude Sonnet 4.8", provider: "claude", providerLabel: "Claude (subscription)", contextWindow: 1_000_000, capabilities: ["reasoning"] },
  { spec: "workers-ai/@cf/zai-org/glm-5.3", label: "GLM 5.3", provider: "workers-ai", providerLabel: "Workers AI", contextWindow: 1_048_576, capabilities: ["reasoning"] },
  { spec: "openrouter/qwen/qwen3.6-max", label: "Qwen 3.6 Max", provider: "openrouter", providerLabel: "OpenRouter", contextWindow: 262_144 },
  { spec: "opencode-go/glm-5", label: "GLM-5 (OpenCode Go)", provider: "opencode-go", providerLabel: "OpenCode Go", contextWindow: 200_000 },
];

const PICKER_FAILURES = [{ provider: "codex", label: "ChatGPT Codex (subscription)", reason: "Codex models could not be read: chatgpt.com refused this server's network (HTTP 403 block page, before sign-in); showing the built-in list" }];

const PICKER_TEST_RESULTS = new Map<string, ModelTestResult>([
  ["opencode-go", { ok: false, failure: "spent", until: Date.parse("2026-10-03T14:56:00Z"), message: "opencode-go is rate-limited until 2026-10-03 14:56 UTC (in 8d 10h): Monthly usage limit reached. (HTTP 429)" }],
  ["codex", { ok: false, failure: "unreachable", message: "Codex is unreachable from here (HTTP 503, codex_unavailable)" }],
]);

function galleryModelTest(spec: string, signal: AbortSignal): Promise<ModelTestResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ModelTestResult>();
  const result = PICKER_TEST_RESULTS.get(spec.split("/")[0] ?? "") ?? { ok: true, firstTokenMs: 640, totalMs: 910 };
  const timer = setTimeout(() => resolve(result), 700);

  signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); });

  return promise;
}

function ModelPickerStates() {
  const [model, setModel] = useState("codex/gpt-5.5");
  const [tier, setTier] = useState("");
  const models = PICKER_MODELS;
  const failures = PICKER_FAILURES;
  const test = galleryModelTest;

  return (
    <div className="space-y-6 px-4" data-model-picker-states>
      <div className="space-y-1">
        <div className="p-eyebrow">Model picker, a failed Codex list</div>
        <div className="flex items-center gap-1">
          <ModelPicker models={models} failures={failures} value={model} onChange={setModel} size="xs" test={test} label="Picker" />
        </div>
      </div>
      <div className="space-y-1">
        <div className="p-eyebrow">Settings tier, inheriting the default</div>
        <ModelPicker models={models} failures={failures} value={tier} onChange={setTier} clearable size="sm"
          label="deep model" placeholder="Use default: GPT-5.5 (Codex)" test={test} />
      </div>
    </div>
  );
}

/* Chat infinite scroll: the real hooks, merge rule and HistoryBoundary over a stub page source. Params: ?latency=ms ?fail=1 (first fetch fails) ?depth=N (pages before exhaustion). */
const HISTORY_PAGE = 12;

const historyParams = new URLSearchParams(location.search);

const HISTORY_LATENCY = Number(historyParams.get("latency") ?? 400);

const HISTORY_DEPTH = Number(historyParams.get("depth") ?? 4);

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

  // Driven from the test so a live turn can land while an older page is in flight.
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

/** The first request is held until the browser releases it, then fails once; Retry answers the authoritative empty page. */
function HistoryAuthorityFrame() {
  const [hold] = useState(() => Promise.withResolvers<void>());
  const failFirst = useRef(true);
  const requests = useRef(0);

  const history = usePagedScroll<ChatHistoryEntry>({
    grows: "up",
    fetchPage: useCallback(async () => {
      const request = ++requests.current;
      await hold.promise;

      // StrictMode can retire a held walk: only the latest request consumes the planned failure.
      if (request === requests.current && failFirst.current) {
        failFirst.current = false;
        throw new Error("fixture could not read the first history page");
      }

      return { status: "end" as const, items: [] };
    }, [hold]),
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

/** KINU-060: only the transport response is held; a released old response must not undo the hook's upsert/rename. */
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
        rosterAuthorityHold.resolve(new Response(JSON.stringify(rosterAnswer(new URLSearchParams())), {
          headers: { "content-type": "application/json" },
        }));
      }}>Release stale roster</button>
      <div data-roster-probe data-roster-pending={String(roster.pending)}>{roster.entries.map((row) => `${row.name}:${row.displayName}`).join("|")}</div>
    </div>
  );
}

const CONTINUITY_LONG_TOKEN = `https://example.invalid/${"unbroken".repeat(90)}`;

/** The hidden probe reports only action results, never an implementation flag. */
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

/** One quality branch fails until healed, the other held until released, so the interleaving is observable. */
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

const SUBORDINATES: Parameters<typeof SubordinateTabs>[0]["subordinates"] = [
  { name: "coupon-tester", actorId: galleryActorId("coupon-tester"), displayName: "Coupon tester", role: "QA", createdBy: "orchestrator", status: "working", currentTask: "Running the checkout regression suite", createdAt: NOW - 36e5, dismissedAt: null },
  { name: "migration-review", actorId: galleryActorId("migration-review"), displayName: "Migration review", role: "Reviewer", createdBy: "orchestrator", status: "awaiting_input", currentTask: "Needs a call on the backfill order", createdAt: NOW - 72e5, dismissedAt: null },
  { name: "docs", actorId: galleryActorId("docs"), displayName: "Release notes", role: "Writer", createdBy: "user", status: "idle", currentTask: null, createdAt: NOW - 108e5, dismissedAt: null },
  // A one-click agent the titler has not reached: blank name, shown as "New agent".
  { name: "agent-4f2c", actorId: galleryActorId("agent-4f2c"), displayName: "", role: "agent", createdBy: "user", status: "idle", currentTask: null, createdAt: NOW - 6e5, dismissedAt: null },
];

/* The open tab is the strip's hook, so a gate can compare strips. */
interface TabStripCase {
  readonly open?: string;
  readonly width: number;
  readonly body: string;
}

const TAB_STRIPS: readonly TabStripCase[] = [
  { width: 520, body: "Main chat body" },
  { width: 380, body: "Main chat body" },
  { open: "coupon-tester", width: 520, body: "Subordinate chat body" },
  // Still under its codename (blank display name); last in the roster, so the strip is wide enough to keep it visible.
  { open: "agent-4f2c", width: 760, body: "Codename chat body" },
];

/* On the chat column's own ground: elsewhere hides the seam under review. */
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

/** Internal only: the gate asserts this string never reaches the document. */
const AGENTCHATS_MISSION = "Audit the checkout flow end to end and fix what breaks";

type GalleryRosterEntry = Parameters<typeof SubordinateTabs>[0]["subordinates"][number];

const AGENTCHATS_SEED: readonly GalleryRosterEntry[] = [
  // Distinctive: the gate asserts it never renders; subordination shows as hierarchy, not a badge.
  { name: "scout", actorId: galleryActorId("scout"), displayName: "Checkout scout", role: "Fixture-role QA lead", createdBy: "user", status: "idle", currentTask: null, createdAt: NOW - 36e5, dismissedAt: null },
  // Agent-created: keeps the confirmation path, unlike the user-created seed.
  { name: "auto-scout", actorId: galleryActorId("auto-scout"), displayName: "Auto scout", role: "Fixture-role QA lead", createdBy: "orchestrator", status: "idle", currentTask: null, createdAt: NOW - 18e5, dismissedAt: null },
];

const AGENTCHATS_ROWS = 40;

/** Wired like SubordinateChatColumn: no title bar (rename is on the tab), same mode segment and per-conversation state hook. */
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
  const missions = useRef<Record<string, string>>({});

  const create = async () => {
    maybeRefuseCreate();
    const name = `agent-${++counter.current}`;
    missions.current[name] = AGENTCHATS_MISSION;
    setRoster((current) => [...current, {
      name, actorId: galleryActorId(name), displayName: "", role: "agent", createdBy: "user",
      status: "idle", currentTask: null, createdAt: NOW, dismissedAt: null,
    }]);
    await navigate(`/workspace/checkout-fixes/agents/${name}`);
  };

  const send = (agent: string) => (text: string, mode: ChatMode) => {
    setSent((current) => [...current, { agent, mode, text }]);
    setTranscripts((current) => ({ ...current, [agent]: [...(current[agent] ?? []), text] }));
    // The first-message titler, as the `subordinates_changed` delivery.
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
            // Mirrors core `dismiss`: `keepHistory` defaults to keeping; delete takes the conversation. The gate reads this, not the dialog.
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

/* Everything the agent emits that must survive a narrow chat column. */
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

const SURFACE_STEPS = [
  ["recessed", "--c-recessed"], ["base", "--c-bg"], ["panel", "--c-sidebar"],
  ["card", "--c-surface"], ["raised", "--c-elevated"], ["overlay", "--c-overlay"],
] as const;

/** Role names only: per-theme contrast ratios are asserted by `scripts/palette-ux`. */
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

/* The signed-out pages: the real document text written into this window, so the gates audit the shipped cascade and scripts. */

/** The install command is production's, not this dev server's. */
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

/** The four candidate marks at 16px and hero size, in both faces; `KINU_MARK` in `public-shell.ts` names the one that ships. */
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
            {/* The sidebar lockup as Sidebar.tsx ships it (mark 20px + display face). */}
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

/* At the width Column C gets. */
/* Real docstrings from the registry, so length problems are visible. `release` is illustrative: getToolDescriptions() lists only
   BUILTIN_TOOLS. `exposure` is declared reach (TOOL_REACH); `wired` is whether this agent has it (`report` is false on an orchestrator). */
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

/* The thread ends on a bare `slate://` address: the markdown pass must turn it into the card, not a link. */
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

// One pending approval: the digest binds the source's deployTarget, which the owner must be able to read first.
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

/** The engine's substrate missing: nothing on the pipeline can run. */
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


// The plan at its real shape: several steps, one active, one with subtasks, one dropped.
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

/** Root plan and tasks plus one subordinate's plan, so both owners' rows draw. */
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

/** Without it a release approval lights nothing while a running job carries a digit. */
const PENDING_ACTIONS: PendingAction[] = [
  // Parked commands, the one kind decided in the queue itself.
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

const SHELL_PENDING_ACTIONS = PENDING_ACTIONS.filter((action) => action.kind === "release_approval");


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

/** As core draws it: every member classified, each mutating one's risk worded for the visibility, and the digest slate behind the peer hop. */
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

/** Live mode with capability graph and one public share, or blueprint mode at inspection (`sharedialog-blueprint`). */
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

/** Routed so `useParams` names the id; `&viewer=signedout` renders the sign-in branch. */
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

  // The crafted rows the CHANGELOG digest names, with their EMA scores.
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


/** One decision waiting, no background work: the plan read has only a closed task and no job has ever run. */
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

/** Both reads refuse, so Now and the journal each owe a retry; the running job is a prop, so Now still shows it. */
const failedReadsRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (method === "listWorkspaceWork") throw new Error("plan fixture failed");

  if (method === "getEvolutionChangelog") throw new Error("journal fixture failed");

  return workRpc<T>(method, args);
};

const NO_QUEUE: PendingAction[] = [];

const NO_JOBS: BackgroundJob[] = [];

function workLane(lane: string | null) {
  if (lane === "settled") {
    return { jobs: NO_JOBS, queue: PENDING_ACTIONS, rpc: settledOnlyRpc, memory: [] };
  }

  if (lane === "failed") {
    return { jobs: BACKGROUND_JOBS.filter((job) => job.status === "running"), queue: NO_QUEUE, rpc: failedReadsRpc, memory: [] };
  }

  return { jobs: BACKGROUND_JOBS, queue: PENDING_ACTIONS, rpc: workRpc, memory: WORK_MEMORIES };
}

/** Oldest first, the order `getMemoryContent` parses; Learnings renders the reverse. */
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

/** Both halves of a shell approval: the queue that grants, the list that revokes. Fed directly: `?frame=settings` needs a live agent socket. */
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

const PARKED_ONLY: PendingAction[] = PENDING_ACTIONS.filter((a) => a.kind === "deferred_action");

const settledEmptyRpc: Rpc = async <T,>(method: string, args?: unknown[]): Promise<T> => {
  if (method === "listWorkspaceWork") return rpcResult({ plans: [], tasks: [] }).json<T>();

  if (method === "getEvolutionChangelog") return rpcResult({ entries: [], unseenCount: 0, seenAt: 0 }).json<T>();

  return stubRpc<T>(method, args);
};

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

/** Every environment reachable: two rows describing the same thing only show as a duplicate together. */
const ENVIRONMENT_EXECUTORS: ExecutorInfo[] = [
  {
    name: "device", kind: "device", available: true, configured: true, active: true, status: "active",
    // The user's own device name from the consent contract; the card renders this, never "device".
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


/** Mutable so the gate can prove rename and delete; `binary-weights.bin` exercises the binary refusal. */
function seedCompositeTree(offlineDevice: boolean): Map<string, DirEntry[]> {
  const tree = new Map<string, DirEntry[]>([
    ["/", [
      { name: "home", type: "dir", mtimeMs: NOW - 4 * 36e5 },
      ...(offlineDevice ? [] : [{ name: "pc", type: "dir" as const, mtimeMs: NOW - 60e3 }]),
      { name: "sandbox", type: "dir", mtimeMs: NOW - 30 * 60e3 },
    ]],
    ["/home", [{ name: "main", type: "dir", mtimeMs: NOW - 4 * 36e5 }]],
    ["/home/main", [
      { name: "memory", type: "dir", mtimeMs: NOW - 26e5 },
      { name: "skills", type: "dir", mtimeMs: NOW - 20 * 864e5 },
      { name: "AGENTS.md", type: "file", size: 2_148, mtimeMs: NOW - 3 * 864e5 },
      { name: "SOUL.md", type: "file", size: 913, mtimeMs: NOW - 9 * 864e5 },
      { name: "notes.md", type: "file", size: 4_402, mtimeMs: NOW - 42e5 },
      { name: "binary-weights.bin", type: "file", size: 4_089_446, mtimeMs: NOW - 6 * 864e5 },
    ]],
    ["/home/main/memory", [{ name: "MEMORY.md", type: "file", size: 1_204, mtimeMs: NOW - 26e5 }]],
    ["/home/main/skills", [{ name: "sql-triage.md", type: "file", size: 2_010, mtimeMs: NOW - 20 * 864e5 }]],
    ["/sandbox", [{ name: "workspace", type: "dir", mtimeMs: NOW - 30 * 60e3 }]],
    ["/sandbox/workspace", [
      { name: "build.log", type: "file", size: 18_211, mtimeMs: NOW - 31 * 60e3 },
      { name: "dist", type: "dir", mtimeMs: NOW - 30 * 60e3 },
    ]],
    ["/sandbox/workspace/dist", [{ name: "app.js", type: "file", size: 220_114, mtimeMs: NOW - 30 * 60e3 }]],
  ]);

  if (!offlineDevice) {
    // `/pc/<name>` and `/pc/<name>/home` are absent: the machine's path guard refuses everything outside `PC_CONSENTED_ROOT`.
    tree.set("/pc", [{ name: PC_SEGMENT, type: "dir", mtimeMs: NOW - 36e5 }]);
    tree.set(PC_CONSENTED_ROOT, [
      { name: "quarterly-report.txt", type: "file", size: 8_412, mtimeMs: NOW - 2 * 36e5 },
      { name: "shot.png", type: "file", size: 1_204_002, mtimeMs: NOW - 5 * 36e5 },
      { name: "notes.html", type: "file", size: 402, mtimeMs: NOW - 36e5 },
    ]);
  }

  return tree;
}

/** As `deviceMountSegment` keys a fleet of one. */
const PC_SEGMENT = "Ashish's MacBook";

const PC_MOUNT = `/pc/${PC_SEGMENT}`;

/** Production learns it from the machine (`deviceFiles`' homeDir); a bare `/pc/<name>` lands here. */
const PC_CONSENTED_ROOT = `${PC_MOUNT}/home/dev`;

const FILES_TEXT = {
  "/home/main/notes.md": "# Checkout coupon regression\n\n- kind:null rows come from the 0412 migration\n- the serializer guards only percentage coupons\n- fix drafted in packages/checkout/src/apply-coupon.ts\n",
  "/home/main/SOUL.md": "I keep this workspace's changes small and proven.\n",
  "/home/main/AGENTS.md": "## Working agreements\n\nRun the checkout suite before claiming a fix.\n",
  [`${PC_CONSENTED_ROOT}/quarterly-report.txt`]: "Q3 numbers, draft 2 — do not circulate.\n",
  [`${PC_CONSENTED_ROOT}/notes.html`]: "<h1>Q3 close</h1><p>Signed off by finance.</p>\n",
  "/sandbox/workspace/build.log": "$ bun run build\nbundled 412 modules in 1.9s\nok\n",
} satisfies Record<string, string>;

interface PreviewDeferred {
  readonly promise: Promise<{ content: string; revision: number }>;
  resolve(value: { content: string; revision: number }): void;
}

/** One stateful frame for Environment and Files: `onSurface` is real, so a card's Files action lands the drive. */
function DriveFrame({ initialSurface, offlineDevice, width, deferPreview = false }: {
  initialSurface: SurfaceKind;
  offlineDevice: boolean;
  width: string;
  /** Transport input only; FilesSurface/FileViewer decide whether it may paint after the resource identity changes. */
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
      // As `read-models/files.ts` mountLanding resolves it; `/pc` lands on itself.
      const dir = asked === PC_MOUNT ? PC_CONSENTED_ROOT : asked;
      const entries = store.get(dir);

      if (entries !== undefined) return rpcResult(v.parse(JsonValueSchema, { path: dir, entries })).json<T>();

      // In the words of `deviceFiles`' path guard.
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
      // Collect first: keys set while iterating a Map are visited, so a rename into its own subtree would loop.
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

      // Map iterators are deletion-safe by spec.
      for (const key of store.keys()) {
        if (key === path || key.startsWith(`${path}/`)) store.delete(key);
      }

      contents.delete(path);

      return rpcResult({ ok: true }).json<T>();
    }

    return stubRpc<T>(method, args);
  };

  // Echoes each command line ending in LF, like a program: the pane must convert it to CR LF and keep a pasted multi-line command as one call.
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
              const path = "/home/main/notes.md";
              contents.set(path, "# Fresh after refresh\n\nThe older reply must not reclaim this preview.\n");
              store.set("/home/main", (store.get("/home/main") ?? []).map((entry) => (
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

// Every block is fed so its type roles render at real scale.

/** Typed so fixtures track `RunSummary`. The second run is silent (no provider report) and must render unreported, not free; longer than one page for the pager. */
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

/** One entry per changelog kind. `supervisefresh` answers empty until `gallery:supervise-evolve`; its jobs read fails until
 *  `gallery:supervise-jobs-heal`; `gallery:supervise-evolution-fail` throws once. `changesOnly` filters measurement kinds before the limit, as the real read does. */
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

/** The newest change inside the limit, as the real `changesOnly` read answers. */
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
      // Consumed once, so the failure lands over last-good entries.
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


/** `cacheRead` is a subset of `input`, never an addition. */
const AGENT_TOKENS: Usage = {
  input: 21_480_312, output: 512_884, cacheRead: 18_942_006, reasoning: 41_220,
};

/** As Workers AI reports it: `neurons`, Cloudflare's billing unit, comes back on every call and the Cost block must carry it. */
const AGENT_TOKENS_METERED: Usage = { ...AGENT_TOKENS, neurons: 2_639_183 };

/**
 * One producer per absence rule the Cost block claims (a zero must never stand in for a silence), in
 * `workspaceSpend` order (read-models/workspace-spend.ts): largest measured total first, unmeasured last.
 */
const ACTIVITY_PRODUCERS: ProducerSpend[] = [
  {
    source: "agent", calls: 344, callsWithoutUsage: 0, usage: AGENT_TOKENS_METERED,
    usd: 11.98, unpricedCalls: 0,
  },
  {
    source: "judge", calls: 62, callsWithoutUsage: 0,
    usage: {
      input: 1_284_400, output: 96_120, cacheRead: 812_000,
      cacheWrite: 96_400, cacheWrite1h: 71_200,
    },
    usd: 3.41, unpricedCalls: 0,
  },
  {
    source: "fast", calls: 210, callsWithoutUsage: 0,
    usage: { input: 402_118, output: 18_440, neurons: 50_467 },
    usd: 0.0142, unpricedCalls: 44,
  },
  {
    source: "head", calls: 12, callsWithoutUsage: 2,
    usage: { input: 288_004, output: 31_902 }, usd: 0.86, unpricedCalls: 0,
  },
  {
    source: "mcts", calls: 28, callsWithoutUsage: 0,
    usage: { input: 96_210, output: 12_004, neurons: 12_986 },
    unpricedCalls: 28,
  },
  {
    source: "platform", calls: 91, callsWithoutUsage: 91, usage: {},
    unpricedCalls: 0,
  },
];

/** Everything measured and priced over the whole log, on Anthropic: the neurons column must vanish, not print dashes. */
const CLEAN_PRODUCERS: ProducerSpend[] = [
  {
    source: "agent", calls: 344, callsWithoutUsage: 0, usage: AGENT_TOKENS,
    usd: 11.98, unpricedCalls: 0,
  },
  {
    source: "judge", calls: 62, callsWithoutUsage: 0,
    usage: { input: 1_284_400, output: 96_120, cacheRead: 812_000 },
    usd: 3.41, unpricedCalls: 0,
  },
  {
    source: "fast", calls: 210, callsWithoutUsage: 0,
    usage: { input: 402_118, output: 18_440 }, usd: 0.42, unpricedCalls: 0,
  },
];

const ACTIVITY_CONTEXT: ContextComposition = {
  segments: [
    { plane: "system", label: "Core instructions", chars: 18_400, items: 1 },
    { plane: "system", label: "Code execution and learned capabilities", chars: 3_120, items: 1 },
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

/** One nested label and one spent: a dollar cap, a token cap, blended pricing, and a `spent` badge. */
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

/** Oldest first, as `readActivityLog` returns. `elapsedMs: 0` (a row cut outside a turn) must read as an em dash, not 0 ms. */
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

const ACTIVITY_ACCOUNTS: readonly AccountSpend[] = [
  {
    provider: "anthropic", account: "work", calls: 402, callsWithoutUsage: 0, unpricedCalls: 0,
    usd: 9.4312, usage: { input: 14_220_118, output: 402_551, cacheRead: 12_880_004 },
    quota: {
      at: NOW - 40e3,
      windows: [
        { measure: "requests", limit: 50, remaining: 3, resetsAt: NOW + 22e3 },
        { measure: "input-tokens", limit: 40_000, remaining: 31_200, resetsAt: NOW + 22e3 },
      ],
    },
  },
  {
    provider: "codex", account: "main", calls: 214, callsWithoutUsage: 0, unpricedCalls: 0,
    usd: 5.1204, usage: { input: 8_104_220, output: 228_101, cacheRead: 6_874_002 },
    quota: {
      at: NOW - 95e3,
      windows: [
        { measure: "300m", usedPercent: 41, resetsAt: NOW + 7_380e3 },
        { measure: "10080m", usedPercent: 12, resetsAt: NOW + 388_800e3 },
      ],
    },
  },
  {
    provider: "anthropic", account: "main", calls: 38, callsWithoutUsage: 0, unpricedCalls: 0,
    usd: 1.7126, usage: { input: 1_226_706, output: 40_698 },
  },
  {
    provider: null, account: null, calls: 93, callsWithoutUsage: 93, unpricedCalls: 0, usage: {},
  },
];

/** Every qualifier live at once (truncated window, silent and partial producers, unpriced calls): the caveat line must stay one line. */
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
      calls: 747, callsWithoutUsage: 93, unpricedCalls: 72,
      usd: 16.2642,
      usage: {
        input: 23_551_044, output: 671_350, cacheRead: 19_754_006, reasoning: 41_220,
        neurons: 2_702_636,
        // Only `judge` writes cache and reports the retention split.
        cacheWrite: 96_400, cacheWrite1h: 71_200,
      },
    },
    coverage: {
      calls: 747, measured: 654, reported: 654 / 747, silent: ["platform"], partial: ["head"],
    },
    // (23_551_044 + 671_350 - 21_480_312 - 512_884) / (23_551_044 + 671_350)
    offTurnShare: 0.09203045743537984,
    missions: ACTIVITY_MISSIONS,
    accounts: ACTIVITY_ACCOUNTS,
  },
  log: ACTIVITY_LOG,
};

/** A provider without neurons and nothing left to qualify. */
const ACTIVITY_CLEAN: ActivitySnapshot = {
  ...ACTIVITY_SNAPSHOT,
  latest: { ...ACTIVITY_LATEST, usage: { input: 148_204, output: 1_842, cacheRead: 131_072, reasoning: 604 } },
  telemetry: { ...ACTIVITY_SNAPSHOT.telemetry, tokens: AGENT_TOKENS },
  spend: {
    producers: CLEAN_PRODUCERS,
    total: {
      calls: 616, callsWithoutUsage: 0, unpricedCalls: 0, usd: 15.81,
      usage: {
        input: 23_166_830, output: 627_444, cacheRead: 19_754_006, reasoning: 41_220,
      },
    },
    coverage: { calls: 616, measured: 616, reported: 1, silent: [], partial: [] },
    // (23_166_830 + 627_444 - 21_480_312 - 512_884) / (23_166_830 + 627_444)
    offTurnShare: 0.07569375724596598,
    missions: [],
    accounts: [],
  },
};

/** No model call at all: `coverage.reported` is null and the panel must say there is no fraction, not 0%. */
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
    total: { calls: 0, callsWithoutUsage: 0, usage: {}, unpricedCalls: 0 },
    coverage: { calls: 0, measured: 0, reported: null, silent: [], partial: [] },
    offTurnShare: null,
    missions: [],
    accounts: [],
  },
  log: [],
};

const activityRpc = (snapshot: ActivitySnapshot): Rpc =>
  async <T,>(method: string, args?: unknown[]): Promise<T> => (
    method === "getActivitySnapshot" ? rpcResult(v.parse(JsonValueSchema, snapshot)).json<T>() : stubRpc<T>(method, args)
  );

/** One message per state the `chat` frame folds or cannot pre-expand; auto-expanded on mount below. */
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

/** Fifty observations, three changes and one preview call placed mid-run with an `observe` shape, so only the preview rule can keep it. */
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

/** Credential-shaped fields nested where a webhook or MCP call puts them, plus free-text previews with the same token; `?frame=toolrun&secrets=1` asserts every secret is masked. */
/** Assembled in parts: the commit-tier secret scan shares the preview's redaction patterns, so a literal would block the commit. */
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

/** The token in a protocol-level failure's `errorText`. */
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

/** Clicks open every collapsed row after mount: the toggle is local state, and a gallery-only prop would change the real component. */
function useAutoExpandToolCalls(): void {
  useEffect(() => {
    const clickAll = () => {
      for (const element of document.querySelectorAll('button[aria-expanded="false"]')) {
        if (element instanceof HTMLButtonElement) element.click();
      }
    };

    const id = setTimeout(() => {
      clickAll();
      // A group's toggle mounts its members' toggles a render later.
      requestAnimationFrame(() => requestAnimationFrame(clickAll));
    }, 50);

    return () => clearTimeout(id);
  }, []);
}

/** A turn in flight, in each state its tail can be in; the part `state` fields are the AI SDK stream reducer's real ones. */
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

/** Rendered as the last message of an open stream, the only condition that draws a live tail. */
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

/** One per severity: `nit` stays quiet, `blocker` is the loudest thing in the column, all readable without a click. */
const ADVISOR_NOTES = {
  nit: "The commit message says 'fix typo' but the diff also renames two exported symbols. Split it or say so.",
  concern: "The retry loop in deploy.sh has no backoff cap. A stuck registry keeps it spinning for the whole turn budget.",
  blocker: "The migration drops coupons.kind while the old worker is still deployed. Roll the worker first or every checkout 500s.",
} satisfies Record<AdvisorSeverity, string>;

/** Core's rank order; metadata is the pair `classifyProgrammaticTurn` reads, taken from core. Held to the classifier in `tests/unit-background-event.test.ts`. */
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

/** One dropped connection failing every actor read at once; the banner text comes from the shipped formatter. */
const LOST = "Network connection lost.";

const OUTAGE: WorkspaceErrors = { snapshot: LOST, memoryContent: LOST };

/** One rung of the snapshot ladder; any two rungs rendering the same is the defect. */
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


/** Five transcript states that must not render as one blank pane. */
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
      {/* The chat chip derives its head id, so needs no canvas selection; both statuses offer different things. */}
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
            // Unreachable here: picking needs a hydrated take set.
            onPick={() => Promise.reject(new Error("no take set in this frame"))}
            onDismiss={() => {}} />
        ))}
      </div>
    </div>
  );
}

/** Routed: the surface builds its full-screen permalink from the route's `agentId`. */
const EXPLORATION_FRAMES = {
  forks: true, forkconfig: true, forkmerge: true, forkpreset: true,
  forkfanin: true, forkrefused: true, forkrunning: true, forklive: true,
} satisfies Record<string, true>;

const GALLERY_WORKSPACE = "checkout-fixes";

/** Opened by the fixture, not a prop: the card ships shut, and `details` carries openness in the DOM. */
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
 * The page a feedback screenshot is taken of: `[data-secret-input]` (a password, redacted without annotation), `[data-secret-token]`
 * (marked text), `[data-visible-copy]` (negative control: must not be uniform). `?noise=1` drives the oversized refusal with real bytes.
 */
function FeedbackFrame({ noise }: { noise: boolean }) {
  const noiseRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = noiseRef.current;

    if (canvas === null) return;
    const context = canvas.getContext("2d");

    if (context === null) return;
    // Random pixels do not compress, so the PNG crosses the 8 MiB limit the endpoint and client enforce.
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
        {/* Intrinsic size, not `w-full`: a scaled-down canvas resamples into pixels that compress back under the limit. */}
        {noise && <canvas ref={noiseRef} width={1280} height={4000} style={{ width: 1280, height: 4000 }} />}
      </div>
      <FeedbackButton />
    </div>
  );
}

/**
 * The real secret-bearing surfaces (issued webhook secret, its curl, the create dialog field, the MCP headers editor) for the capture.
 * `?modal=1` renders the dialog alone. Secrets are distinctive: each must be in the live page and absent from the clone and pixels.
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
        {/* One stage or the other: a dimmed card behind a scrim measures neither. */}
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
 * A routed page in the shipped shell, so the report carries the router-resolved route and workspace. Bands and cells are exact
 * solid fills, so a sampled pixel names which one the capture caught; the gate reads the fill via `getComputedStyle`.
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

/** Must never reach a log: V8 puts `${name}: ${message}` on the first line of `error.stack`. */
const RENDER_FAULT_MESSAGE =
  "Cannot read properties of undefined (reading 'kind') for coupon MESSAGE_LEAKS_IF_REPORTED_0001";

/** One error across every render attempt, minted inside the first render: a fresh one per attempt could not prove the boundary dedupes. */
let renderFault: TypeError | null = null;

/** `?huge=1`: a stack far over the request bound, so the client must fit the report. */
const HUGE_STACK = new URLSearchParams(location.search).get("huge") === "1";

const HUGE_FRAME = "    at applyCoupon (http://127.0.0.1/assets/index-a1b2c3.js:1:2345)";

/** Throw count: without it "one caught error, one report" is vacuous. */
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

/** The trigger sits outside the shipped ErrorBoundary so the same error can be caught again after "Try again". */
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

/**
 * Whether this document's bundle has the chunk: a reload (`navigation.type`) or the gate declaring it fixed. Not an attempt
 * counter: React re-renders a failed subtree in development, which would make it succeed unasked.
 */
function chunkIsPresent(): boolean {
  if (sessionStorage.getItem(CHUNK_FIXED_KEY) !== null) return true;
  const [navigation] = performance.getEntriesByType("navigation");

  return navigation instanceof PerformanceNavigationTiming && navigation.type === "reload";
}

/** Attempts per loader: only the rejected loader may be regenerated. */
const lazyAttempts = { stale: 0, healthy: 0 };

function recordAttempt(which: "stale" | "healthy"): void {
  lazyAttempts[which] += 1;
  document.body.dataset[which === "stale" ? "lazyStaleAttempts" : "lazyHealthyAttempts"] =
    String(lazyAttempts[which]);
}

/** `?failure=app`: an ordinary error, proving skew alone never authorises a reload. */
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

/** A real code-split chunk (`gallery-lazy-healthy.tsx` says why); its attempt count shows a regenerated loader clears only its own memo. */
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

/* The three Sandbox modes side by side: sandboxed, off, and on without bwrap (no commands run). The roster is a prop, so this is the Devices card's markup. */
function galleryDevice(id: string, label: string, sandbox: UserDevice["sandbox"]): UserDevice {
  return {
    id, label, os: "linux", hostname: label, connected: true,
    createdAt: NOW - 30 * 864e5, lastSeenAt: NOW - 60e3, expiresAt: NOW + 60 * 864e5,
    lastIp: "192.0.2.9", lastAgent: "kinu-device", replacedAt: null, revokedAt: null, unstoppedAt: null, reuseDetectedAt: null, wholeMachine: false,
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

/** The shipped shell as App.tsx composes it; the background's contrast and UX gate are measured here. */
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
          <Route path={APP_ROUTES.drive} element={<DriveRoute tab="mine" />} />
          <Route path={APP_ROUTES.driveFolder} element={<DriveRoute tab="mine" />} />
          <Route path={APP_ROUTES.shared} element={<DriveRoute tab="shared" />} />
        </Route>
      </Routes>
    ),
  };
}

function explore(node: React.ReactNode, entries: string[], frameName: string) {
  if (frameName in EXPLORATION_FRAMES) {
    return {
      entries: [`/workspace/${GALLERY_WORKSPACE}`],
      node: <Routes><Route path="/workspace/:agentId" element={node} /></Routes>,
    };
  }

  return { node, entries };
}


/** `&devices=offline|offline-many|none`: the refused-call notice exists only as a socket push, delivered after mount. */
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

/** Before the OAuth client is registered; `?state=configured` shows sign-in. */
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
              : "This Kinu has no Cloudflare OAuth client configured yet.",
          }}
        />
      </div>
    ),
  };
}

/** `?state=running` shows a run in flight; otherwise one build behind its channel. */
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

/** Routed: FilesSurface reads `agentId` for the raw-bytes route. `&offline=device` shows the disconnected row, `&wide=1` the ≥64rem side-panel preview. */
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

/** The only dynamic import in this dispatch: the page pulls d3 and the tree renderer. It reads through `useKinu`, resolved to `gallery-agent-stub` here. */
async function mctsExplorerFrame(run: string): Promise<MountedFrame> {
  const { default: MCTSExplorer } = await import("@/pages/MCTSExplorer");
  serveGalleryRpc(focusRun(run));

  return {
    entries: [`/mcts/checkout-fixes?run=${run}`],
    node: <Routes><Route path="/mcts/:agentId" element={<div className="h-screen p-bg p-text"><MCTSExplorer /></div>} /></Routes>,
  };
}

/** Routed: the page builds back-links and breadcrumbs from `agentId`. */
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

/** Routed: tab, account and workspace selection live in the URL. */
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

/** In the real chrome: the sidebar's route logic decides what renders at "/". */
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

/** Routed so the report's route and workspace come from a resolved `/workspace/:agentId`. */
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

/** Calls `pageDeployedBuildSha` at load like `index.tsx`, and replaceStates the address bar: the report reads `location.pathname`, which the MemoryRouter leaves at `/`. */
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

/** Leaves the address bar alone: recovery ends in `location.reload()`, and a rewritten path would get Vite's SPA fallback `index.html`. */
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

/** Routed so create lands on the new conversation's URL and Main goes back. */
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

/** Owns a real root connection for the plan-arrival hint; the surfaces read fixture props. */
function previewTabsFrame(): MountedFrame {
  serveGalleryRpc(stubRpc);

  return { entries: ["/"], node: <PreviewTabsGallery /> };
}

function GalleryNavigator() {
  const navigate = useNavigate();

  useEffect(() => {
    Object.assign(window, { galleryNavigate: async (path: string) => { await navigate(path); } });
  }, [navigate]);

  return null;
}

/** Both app routes as App.tsx keys them, so creating an agent can navigate. */
function workspacePageFrame(): MountedFrame {
  serveGalleryRpc(workspacePageRpc);

  seedFrameTranscript(new URLSearchParams(location.search).get("transcript"));
  scheduleDeviceNotice(new URLSearchParams(location.search).get("devices"));

  return {
    entries: [`/workspace/${WORKSPACE_PAGE_NAME}`],
    node: (
      <>
        <GalleryNavigator />
        <Routes>
          <Route path="/workspace/:agentId" element={<div className="h-screen p-bg p-text"><WorkspacePage /></div>} />
          <Route path="/workspace/:agentId/agents/:subName" element={<div className="h-screen p-bg p-text"><WorkspacePage /></div>} />
        </Routes>
      </>
    ),
  };
}

/** `&section=devices` goes through the router: the page reads the hash off `useLocation`. */
function userSettingsStateFrame(): MountedFrame {
  const section = new URLSearchParams(location.search).get("section");

  return {
    entries: [section === null ? "/user/settings" : `/user/settings#${section}`],
    node: <div className="min-h-screen p-bg p-text"><UserSettingsPage /></div>,
  };
}

async function mount() {
  const document_ = publicDocument(frame);

  if (document_ !== null) {
    writeDocument(document_);

    return;
  }

  let node: React.ReactNode;
  let entries = ["/"];

  // Frames fully fixed by name; `entries` is the MemoryRouter location for frames that read a route param.
  const fixtureFrames = new Map<string, { node: React.ReactNode; entries: string[] }>([
    ["supervise", { node: <SuperviseFrame />, entries: ["/"] }],
    ["supervisefresh", { node: <SuperviseFrame evolved={false} />, entries: ["/"] }],
    ["activity", { node: <Shell surface={ACTIVITY_SURFACE} rpc={activityRpc(ACTIVITY_SNAPSHOT)} />, entries: ["/"] }],
    ["activityclean", { node: <Shell surface={ACTIVITY_SURFACE} rpc={activityRpc(ACTIVITY_CLEAN)} />, entries: ["/"] }],
    ["activityempty", { node: <Shell surface={ACTIVITY_SURFACE} rpc={activityRpc(ACTIVITY_FRESH)} />, entries: ["/"] }],
    ["activitycache", { node: <div className="p-6 max-w-2xl"><CacheBlock cacheHit={ACTIVITY_CACHE_HIT} /></div>, entries: ["/"] }],
    ["blueprint", { node: <BlueprintFrame />, entries: [`/shared/blueprint/${encodeURIComponent(BLUEPRINT_ID)}`] }],
    ["chat-slate", { node: <ChatSlateFrame />, entries: ["/"] }],
    // `&path=/projects/ops` opens a folder; `shared` is the other tab; `drive-recipient` holds only what others shared.
    ["drive", { node: <DrivePageFrame />, entries: [`${APP_ROUTES.drive}${new URLSearchParams(location.search).get("path") ?? ""}`] }],
    ["shared", { node: <DrivePageFrame />, entries: [APP_ROUTES.shared] }],
    ["drive-empty", { node: <DrivePageFrame />, entries: [APP_ROUTES.drive] }],
    ["drive-recipient", { node: <DrivePageFrame />, entries: [APP_ROUTES.drive] }],
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
    // `&panel=providers|mcp|cli` picks the modal's body.
    ["setupmodal", { node: <SetupModalFrame />, entries: ["/"] }],
    // `&step=0..3` picks the wizard panel.
    ["welcome", { node: <WelcomeFrame />, entries: ["/welcome"] }],
    // `&view=list` seeds the workspaces page's stored choice.
    ["workspaces", { node: <WorkspacesFrame />, entries: ["/workspaces"] }],
    ["chatcode", { node: <ChatCodeFrame />, entries: ["/"] }],
    ["plugins", { node: <PluginsFrame />, entries: ["/plugins"] }],
    ["devices", { node: <DevicesFrame />, entries: ["/devices"] }],
    ["devices-empty", { node: <DevicesFrame />, entries: ["/devices"] }],
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
    ["settings", settingsFrame],
    ["control", controlFrame],
    ["home", homeFrame],
    ["diff-design", async () => {
      const { default: diffDesignFrame } = await import("@/gallery-diff-design");

      return diffDesignFrame();
    }],
    ["drive-design", () => Promise.resolve(driveDesignFrame())],
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
  else if (frame === "activitylog") node = <div className="p-6 max-w-2xl"><LogBlock log={ACTIVITY_LOG} /></div>;
  else if (frame === "workspacepage") ({ node, entries } = workspacePageFrame());
  else if (frame === "usersettingsstate") ({ node, entries } = userSettingsStateFrame());
  else if (frame === "devicesandbox") node = <DeviceSandboxFrame />;
  else if (dynamicFixture !== undefined) ({ node, entries } = await dynamicFixture());
  else node = <All />;

  ({ node, entries } = explore(node, entries, frame));


  const root = document.getElementById("root");

  if (root === null) throw new Error("gallery root is missing");

  createRoot(root).render(
    // Every frame mounts under the shell's three stores; a frame mounting `Layout` gets its nearer store, as the app does.
    <StrictMode>
      <MemoryRouter initialEntries={entries}>
        <AccountProvider><WorkspaceRosterProvider>{node}</WorkspaceRosterProvider></AccountProvider>
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
