/** The gallery's page-wide stand-ins, installed as it loads: /api fetches, sockets and window hooks answering from fixtures. */
import { deployFixture } from "@/gallery-deploy-fixture";
import { GOOGLE_OAUTH_CRED_KEY, restoredRows, requestUrl, type RosterFrame } from "@kinu.run/core";
import { delegatedTaskMetadata } from "@kinu.run/core";
import { toKinuError, tolerate } from "@kinu.run/core/obs";
import { hostedActorSocketPath, SLATE_PUSH_EVENT, mcpPresetById, type McpPreset, READS_CHANGED_EVENT } from "@kinu.run/core";
import { galleryCloudflareAccounts, galleryGatewayCredits, galleryWebSearchChain, galleryWebSearchTest } from "./gallery-web-search";
import { galleryUsername } from "./gallery-mail-address";
import { secretsFixture } from "@/gallery-secrets";
import { FEEDBACK_ENDPOINT } from "@kinu.run/core";
import { CLIENT_ERROR_ENDPOINT } from "@kinu.run/core";
import { WorkspaceOverviewSchema } from "@kinu.run/core";
import { profileCatalogCanonical } from "@kinu.run/core";
import { installDriveFixture } from "@/gallery-drive";
import { installGalleryFixture } from "@/gallery-listings";
import { installPartsFixture, installShareModeFixture } from "@/gallery-parts";
import type { SharePreapproval } from "@kinu.run/core";
import { MESSAGE_AMENDED_FRAME, TURN_CLAIM_FRAME, UIMessageSchema, BUILTIN_PROFILE_CATALOG, validateProfileCatalog, DEVICE_TIERS, JsonObjectSchema, JsonValueSchema, DEFAULT_FILES_VIEW, FILES_VIEW_CONFIG_KEY, parseDeviceTier, type JsonObject, type JsonValue, type ProfileCatalogEnvelope, type AccountUsage } from "@kinu.run/core";
import { wireOf } from "@/lib/workspace-rpc";
import type { SubagentView } from "@kinu.run/core/protocol";
import type { UserDevice } from "@/lib/user-api";
import { ROSTER_SOCKET_ROUTE } from "@/lib/user-api";
import { McpServerSummarySchema, type McpServerSummary } from "@kinu.run/core";
import * as v from "valibot";
import { galleryChatStartsAt, galleryChatWindow, galleryServerPush, seedGalleryChat } from "@/gallery-agent-stub";
import { ACTIVITY_ACCOUNTS, AGENTS_PANEL, GALLERY_PC, GALLERY_SUBS, HISTORY_ROWS, JOBS_RUNNING, LIVE_SHARE, NOW, RESTED_AGENTS, SHELL_COMPUTER, SHELL_PC, WORKSPACE_PAGE_NAME, frame } from "@/gallery-data";
import { AGENT_ANSWERS, FORK_ANSWERS, GalleryShellSocket, STUB, annotationRelease, galleryActorId, galleryRoster, galleryRosterCounts, historyRow, msg, rosterAnswer, rosterAuthorityHold } from "@/gallery-shared";

/**
 * `&pcdesktop=ready|setup|permission`: the PC's screen as its daemon reports it (1014-t); absent, it has none.
 * `setup` poses a Mac with no compiler for its capture helper, as the daemon names the step.
 */
const SHELL_PC_DESKTOP: UserDevice["desktop"] = (() => {
  const state = SHELL_PC === null ? null : new URLSearchParams(location.search).get("pcdesktop");

  if (state === "ready") return { state, width: 1512, height: 982 };

  if (state === "setup") return { state, detail: "Install the Command Line Tools (xcode-select --install), then open this tab again." };

  return state === "permission" ? { state } : { state: "none" };
})();

// Declared before the shell mounts so the app background attaches its stepping controls here only (tests/browser/app-background-ux.test.ts).
window.__kinuGalleryStepping = true;

/** `welcome` poses as a new account (no stamp, no workspace); every other frame is an established one. */
const ACCOUNT_ONBOARDED_AT: number | null = frame === "welcome" ? null : NOW - 864e5;

const ACCOUNT_WORKSPACE_COUNT = frame === "welcome" ? 0 : 1;

const ACCOUNT_FIXTURE_FRAMES = new Set(["usersettingsstate", "setupmodal", "welcome", "workspaces", "plugins", "usermcp", "devices", "devices-empty", "secretpaste"]);

/* Account-settings failure rig: Codex stays failed until `gallery:settings-heal`, the gateway read pends until
   `gallery:settings-release`; sibling GETs settle immediately so branch-local publication is observable. */
const SETTINGS_GATEWAY_HOLD = Promise.withResolvers<void>();

let settingsCodexHealthy = false;

window.addEventListener("gallery:settings-heal", () => { settingsCodexHealthy = true; });

window.addEventListener("gallery:settings-release", () => SETTINGS_GATEWAY_HOLD.resolve());

// The whole app (gallery-app.tsx) shows every settings card settled, as the owner meets them.
if (frame === "whole") {
  settingsCodexHealthy = true;
  SETTINGS_GATEWAY_HOLD.resolve();
}

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
    transport: "auto", status: "connected", toolsCount: 14, allowedTools: null,
    signIn: false, error: null, presetId: null,
  },
  {
    id: "srv-linear", name: "linear", serverUrl: "https://mcp.linear.app/sse",
    transport: "sse", status: "needs_sign_in", toolsCount: 0,
    allowedTools: ["create_issue"], signIn: true,
    error: null, presetId: null,
  },
  {
    id: "srv-notion", name: "notion", serverUrl: "https://mcp.notion.com/sse",
    transport: "sse", status: "failed", toolsCount: 0, allowedTools: null,
    signIn: false, error: "The server refused the connection.", presetId: null,
  },
];

/** A name the account already claims refuses the preset's own add; 'github' is the GitHub preset's name. */
const GALLERY_UNCLAIMED_MCP = GALLERY_CUSTOM_MCP.filter((row) => row.name !== "github");

/** Mutable so the preset add is observable on the next GET. `mcp-preset=connected` swaps in the preset-tagged states; `mcp-preset=open` leaves every preset unclaimed.
 *  The whole app opens connected: a preset added is tagged, so the mockup shows GitHub once, under Connected. */
let galleryMcpRows: McpServerSummary[] = [...GALLERY_CUSTOM_MCP];

const mcpPresetVariant = new URLSearchParams(location.search).get("mcp-preset") ?? (frame === "whole" ? "connected" : null);

/** `&mcp-sign-in=refused`: a custom server's add needs a sign-in, and the account refuses to begin it. */
const MCP_SIGN_IN_REFUSED = new URLSearchParams(location.search).get("mcp-sign-in") === "refused";

if (mcpPresetVariant === "connected") {
  galleryMcpRows = [
    {
      id: "srv-preset-github", name: "GitHub", serverUrl: "https://api.githubcopilot.com/mcp/",
      transport: "streamable-http", status: "connected", toolsCount: 21, allowedTools: null,
      signIn: false, error: null, presetId: "github",
    },
    {
      id: "srv-preset-cloudflare", name: "Cloudflare", serverUrl: "https://mcp.cloudflare.com/mcp",
      transport: "streamable-http", status: "needs_sign_in", toolsCount: 0, allowedTools: null,
      signIn: true, error: null,
      presetId: "cloudflare",
    },
    ...GALLERY_UNCLAIMED_MCP,
  ];
} else if (mcpPresetVariant === "open") {
  galleryMcpRows = [...GALLERY_UNCLAIMED_MCP];
} else if (mcpPresetVariant === "token-failed") {
  // GitHub added with a personal access token, which the server refused: it authenticates by its token, never a sign-in.
  galleryMcpRows = [
    {
      id: "srv-preset-github", name: "GitHub", serverUrl: "https://api.githubcopilot.com/mcp/",
      transport: "streamable-http", status: "failed", toolsCount: 0, allowedTools: null,
      signIn: false, error: "The server refused the token.", presetId: "github",
    },
    ...GALLERY_UNCLAIMED_MCP,
  ];
}

/** `mcp-secrets=github` means GitHub alone; absent means every oauth-app preset is configured (production-shaped). */
const mcpSecrets = (() => {
  const raw = new URLSearchParams(location.search).get("mcp-secrets");

  const listed = raw === null ? ["github"] : raw.split(",");

  return new Set(listed.filter((entry) => entry.length > 0));
})();

function pluginsFixture(path: string): Response | null {
  if (path === "/api/user/devices/consents") {
    // The Devices frame and the whole app: one workspace the Workstation is allowed for, one it refused.
    return fixtureJson(frame === "devices" || frame === "whole"
      ? [
        { agentName: "api-worker", deviceId: "dev-1", policy: "allow", lastMethod: "exec", lastSummary: "bun test" },
        { agentName: "landing-page", deviceId: "dev-1", policy: "denied", lastMethod: "exec", lastSummary: null },
      ]
      : []);
  }

  return null;
}

/** The account's name as last saved here. */
let galleryDisplayName = "Owner";

/** An account's config row the gallery keeps in this browser, under `stored`; `seeded` until it is first set. */
interface StoredConfig { readonly stored: string; readonly seeded: () => string | null }

const STORED_CONFIG = new Map<string, StoredConfig>([
  ["sandbox_size", { stored: "gallery-computer-size", seeded: () => null }],
  // `&layout=tiles`, `&hidden=1`: Files opens drawn so, as an account that chose it would see it.
  [FILES_VIEW_CONFIG_KEY, { stored: "gallery-files-view", seeded: () => {
    const params = new URLSearchParams(location.search);

    return params.has("layout") || params.has("hidden")
      ? JSON.stringify({ layout: params.get("layout") === "list" ? "list" : DEFAULT_FILES_VIEW.layout, hidden: params.get("hidden") === "1" })
      : null;
  } }],
]);

function storedConfigFixture(path: string, method: string, body: BodyInit | null | undefined): Response | null {
  const key = path.startsWith("/api/user/config/") ? path.slice("/api/user/config/".length) : null;
  const config = key === null ? undefined : STORED_CONFIG.get(key);

  if (key === null || config === undefined) return null;

  if (method === "GET") return fixtureJson({ key, value: localStorage.getItem(config.stored) ?? config.seeded() });

  const { value } = v.parse(v.object({ value: v.string() }), JSON.parse(v.parse(v.string(), body)));

  localStorage.setItem(config.stored, value);

  return fixtureJson({ ok: true });
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
    const root = document.documentElement;
    root.dataset.galleryProfilePatches = String(Number(root.dataset.galleryProfilePatches ?? "0") + 1);
    const patch = v.safeParse(v.object({ displayName: v.string() }), JSON.parse(v.parse(v.string(), body)));

    // Kept, so a later read answers the name saved, as the account does.
    if (patch.success) galleryDisplayName = patch.output.displayName;

    return fixtureJson({
      email: "owner@example.com", displayName: galleryDisplayName,
      createdAt: NOW - 864e5, lastSeenAt: NOW,
      onboardedAt: ACCOUNT_ONBOARDED_AT, workspaceCount: ACCOUNT_WORKSPACE_COUNT, controlPlane: false,
    });
  }

  if (path === "/api/user/profile") {
    // Counted: the shell reads the account once, and every view of it shares that read.
    const root = document.documentElement;
    root.dataset.galleryProfileReads = String(Number(root.dataset.galleryProfileReads ?? "0") + 1);

    // The wizard's profile step renders only without a display name: `&noname=1` answers that account.
    if (frame === "welcome" && new URLSearchParams(location.search).get("noname") === "1") {
      return fixtureJson({
        email: "new@example.com", displayName: null, createdAt: NOW, lastSeenAt: NOW,
        onboardedAt: null, workspaceCount: 0, controlPlane: false,
      });
    }

    return fixtureJson({
      email: "owner@example.com", displayName: galleryDisplayName, createdAt: NOW - 864e5, lastSeenAt: NOW,
      onboardedAt: ACCOUNT_ONBOARDED_AT, workspaceCount: ACCOUNT_WORKSPACE_COUNT, controlPlane: false,
    });
  }

  return null;
}

const CHATGPT_DEVICE = new URLSearchParams(location.search).get("chatgpt") === "device";

const MODELS_FAIL = new URLSearchParams(location.search).get("models") === "fail";

/** `&cloudflare=off`: an account that has not connected Cloudflare, so its providers offer the connect. */
const CLOUDFLARE_OFF = new URLSearchParams(location.search).get("cloudflare") === "off";

/** `&claude=down`: Claude's sign-in cannot start. `&claude=held`: it starts once `gallery:claude-start` releases it, so a
 *  test sees what the click did before the start answered. */
const CLAUDE_START = new URLSearchParams(location.search).get("claude");

const claudeStartReleased = new Promise<void>((done) => { window.addEventListener("gallery:claude-start", () => { done(); }, { once: true }); });

async function claudeStartFixture(): Promise<Response> {
  if (CLAUDE_START === "down") return fixtureJson({ error: "Claude's sign-in could not start" }, 503);

  if (CLAUDE_START === "held") {
    await claudeStartReleased;
    document.documentElement.dataset.galleryClaudeStarted = "1";
  }

  return fixtureJson({ url: "https://claude.ai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=gallery" });
}

/** Workers AI's models, which an account offers only once Cloudflare is connected. */
const WORKERS_AI_MODELS = CLOUDFLARE_OFF ? [] : [{ spec: "workers-ai/llama-4", label: "Llama 4", provider: "workers-ai", reasoningEfforts: [] }];

const WORKSPACE_GONE = new URLSearchParams(location.search).get("gone") === "1";

/** `&visit=failed`: the roster cannot record the visit for a reason other than the workspace being gone. */
const VISIT_FAILS = new URLSearchParams(location.search).get("visit") === "failed";

const GALLERY_DEVICE = { id: "dev-1", label: "Owner's laptop" };

/** `&chatgpt=signed-in`: the account holds a ChatGPT sign-in, so its entry offers the disconnect; OpenAI refuses the revoke. */
let settingsChatGptSignedIn = new URLSearchParams(location.search).get("chatgpt") === "signed-in";

/** `&chatgpt=device`: the sign-in the machine opened, read on every poll until `gallery:chatgpt-signed-in` ends it, as one
 *  waits on its person, or a cancel does. */
let settingsChatGptMachineSignIn: { state: "open"; authorizeUrl: string; device: typeof GALLERY_DEVICE } | null = null;

window.addEventListener("gallery:chatgpt-signed-in", () => {
  settingsChatGptSignedIn = true;
  settingsChatGptMachineSignIn = null;
});

function galleryChatGptStatus() {
  return {
    signedIn: settingsChatGptSignedIn, email: settingsChatGptSignedIn ? "owner@example.com" : null, planEnabled: settingsChatGptSignedIn,
    pending: false, lastFailure: null, firstSignIn: false,
  };
}

/** Flips when the gallery's Claude sign-in finishes with the fixture's code. */
let settingsClaudeConnected = false;

/** Keys saved through the providers panel, listed after the stock ones; each body is kept on the page for a flow to read.
 *  `&keys=` names keys the account already holds (`tavily,exa`). */
const settingsSavedCredentials = new Map<string, JsonValue>((new URLSearchParams(location.search).get("keys")?.split(",") ?? [])
  .map((key) => [key, { kind: "bearer", token: "gallery" }]));

/** `&chatgpt=device`: a machine that signs in; without, none is connected yet. */
function chatgptFixture(path: string, method: string, body: BodyInit | null | undefined): Response | null {
  const [route, query] = path.split("?");

  if (route === "/api/user/chatgpt" && method === "DELETE") {
    settingsChatGptSignedIn = false;

    return fixtureJson({ unrevoked: query === "revoke=1" ? "OpenAI refused to revoke the refresh_token: The refresh token has already been used." : null });
  }

  if (path === "/api/user/chatgpt") {
    const root = document.documentElement;
    root.dataset.galleryChatgptReads = String(Number(root.dataset.galleryChatgptReads ?? "0") + 1);

    return fixtureJson(CHATGPT_DEVICE
      ? { device: GALLERY_DEVICE, status: galleryChatGptStatus(), account: null, machineSignIn: settingsChatGptMachineSignIn }
      : { device: null, status: null, account: settingsChatGptSignedIn ? { email: "owner@example.com" } : null, machineSignIn: null });
  }

  if (path === "/api/user/chatgpt/sign-in" && method === "POST") {
    if (!CHATGPT_DEVICE) return fixtureJson({ state: "waiting_for_machine" });
    settingsChatGptMachineSignIn = { state: "open", authorizeUrl: "about:blank", device: GALLERY_DEVICE };

    return fixtureJson(settingsChatGptMachineSignIn);
  }

  if (path === "/api/user/chatgpt/sign-in" && method === "DELETE") {
    settingsChatGptMachineSignIn = null;

    return fixtureJson({ cancelled: true });
  }

  if (path === "/api/user/chatgpt/paste/start" && method === "POST") {
    const root = document.documentElement;
    root.dataset.galleryPasteStarts = String(Number(root.dataset.galleryPasteStarts ?? "0") + 1);

    return fixtureJson({ authorizeUrl: "about:blank", redirectUri: "http://127.0.0.1:1455/auth/callback" });
  }

  if (path === "/api/user/chatgpt/paste/finish" && method === "POST") {
    if (v.is(v.string(), body) && body.includes("access_denied")) return fixtureJson({ outcome: "declined", email: null });

    // As the account words it (core's chatgpt-sign-in): an address that is not the one the sign-in ended on.
    if (v.is(v.string(), body) && !body.includes("127.0.0.1:1455/auth/callback")) {
      return fixtureJson({ error: "That's the sign-in page's own address. Paste the address of the page that didn't load after you signed in: it starts with http://127.0.0.1:1455/auth/callback.", code: "bad_input" }, 400);
    }

    settingsChatGptSignedIn = true;

    return fixtureJson({ outcome: "signed_in", email: "owner@example.com" });
  }

  if (path === "/api/user/devices" && method === "POST") return galleryRegister(body);

  return null;
}

async function settingsSectionsFixture(path: string, method: string, body: BodyInit | null | undefined): Promise<Response | null> {
  if (path === "/api/user/credentials") {
    return fixtureJson([
      { key: "anthropic.bearer", kind: "bearer" },
      { key: "anthropic.bearer@work", kind: "bearer" },
      ...(settingsClaudeConnected ? [{ key: "claude.oauth", kind: "oauth" }] : []),
      ...[...settingsSavedCredentials].map(([key, saved]) => ({ key, kind: v.parse(v.object({ kind: v.string() }), saved).kind })),
    ]);
  }

  if (path.startsWith("/api/user/credentials/") && method === "POST") {
    const key = decodeURIComponent(path.slice("/api/user/credentials/".length));

    settingsSavedCredentials.set(key, JSON.parse(v.parse(v.string(), body)));
    document.documentElement.dataset.gallerySavedCredentials = JSON.stringify(Object.fromEntries(settingsSavedCredentials));

    // The route's own answer: whether the store now holds the key.
    return fixtureJson({ ok: settingsSavedCredentials.has(key) });
  }

  if (path.startsWith("/api/user/credentials/") && method === "DELETE") {
    const key = decodeURIComponent(path.slice("/api/user/credentials/".length).split("?")[0] ?? "");

    settingsSavedCredentials.delete(key);

    // The route's own answer: no stored key here can be revoked at its provider.
    return fixtureJson({ ok: !settingsSavedCredentials.has(key), unrevoked: null });
  }

  if (path === "/api/user/claude/start" && method === "POST") return await claudeStartFixture();

  // `good-code` connects; any other code is refused as the account words Claude's refusal (claudeSignInRefusal).
  if (path === "/api/user/claude/finish" && method === "POST") {
    settingsClaudeConnected = v.parse(v.object({ code: v.string() }), JSON.parse(v.parse(v.string(), body))).code === "good-code";

    return fixtureJson(settingsClaudeConnected
      ? { connected: true }
      : { connected: false, error: "Claude didn't accept that code (Invalid authorization code). A code works once, for a few minutes: start the sign-in again and paste the new one." });
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
      ? fixtureJson({ connected: false, accountId: null, expiresAt: null })
      : fixtureJson({ error: "Codex status fixture failed" }, 503);
  }

  const chatgpt = chatgptFixture(path, method, body);

  if (chatgpt !== null) return chatgpt;

  if (path === "/api/user/models" && MODELS_FAIL) return fixtureJson({ error: "Failed to fetch" }, 503);

  if (path === "/api/user/models") {
    // Different effort lists per model: the tier levels are the model's, never a fixed three.
    return fixtureJson({
      models: [
        ...WORKERS_AI_MODELS,
        { spec: "anthropic/claude-opus-4-7", label: "Claude Opus 4.7", provider: "anthropic", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
        ...settingsChatGptSignedIn ? [{ spec: "chatgpt/gpt-5.5", label: "GPT-5.5", provider: "chatgpt", reasoningEfforts: [] }] : [],
        ...settingsSavedCredentials.has("groq.bearer")
          ? [{ spec: "groq/llama-3.3-70b-versatile", label: "Llama 3.3 70B", provider: "groq", reasoningEfforts: [] }]
          : [],
      ],
      failures: [],
      accounts: { anthropic: ["main", "work"] },
    });
  }

  // A models.dev provider beside the connected one: Groq, connected once its key is saved.
  if (path === "/api/user/providers/catalog") {
    return fixtureJson([
      { id: "anthropic", credKey: "anthropic.bearer", name: "Anthropic", connected: true },
      { id: "groq", credKey: "groq.bearer", name: "Groq", connected: settingsSavedCredentials.has("groq.bearer") },
    ]);
  }

  if (path === "/api/user/cloudflare/accounts") return Response.json(galleryCloudflareAccounts());

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

/** `&presets=down`: reads of the deployment's apps fail until `gallery:presets-up`, as a cold Worker's might. */
let presetsDown = new URLSearchParams(location.search).get("presets") === "down";

window.addEventListener("gallery:presets-up", () => { presetsDown = false; });

/** The deployment's apps, each read counted. */
function mcpPresetsFixture(): Response {
  const root = document.documentElement;
  root.dataset.galleryPresetReads = String(Number(root.dataset.galleryPresetReads ?? "0") + 1);

  if (presetsDown) return fixtureJson({ error: "the deployment's apps did not answer" }, 503);

  return fixtureJson([
    { id: "github", appConfigured: mcpSecrets.has("github") },
    { id: "cloudflare", appConfigured: true },
  ]);
}

/** A sign-in begun from a page: the row's own sign-in address, as the account answers it. Each begin's body is exposed so
 *  the gate can check which run it was begun for, newest last. */
function mcpConnectFixture(path: string, method: string, body: BodyInit | null | undefined): Response | null {
  const connecting = /^\/api\/user\/mcp\/servers\/([^/]+)\/connect$/u.exec(path);

  if (connecting === null || method !== "POST") return null;
  const row = galleryMcpRows.find((each) => each.id === decodeURIComponent(connecting[1] ?? ""));

  localStorage.setItem("gallery-mcp-connects", `${localStorage.getItem("gallery-mcp-connects") ?? ""}${typeof body === "string" ? body : ""}\n`);

  if (MCP_SIGN_IN_REFUSED) return fixtureJson({ error: "The MCP server's sign-in could not begin." }, 502);

  // On this origin, so a tab sent to the sign-in loads nothing from a provider.
  return row?.signIn === true ? fixtureJson({ authUrl: `${location.origin}/gallery-sign-in/${row.id}` }) : fixtureJson({ error: "waits for no sign-in" }, 400);
}

/** Whether an add signs in: only where an authorize URL exists, DCR always, oauth-app only while the frame claims the app;
 *  a custom server only where the frame refuses its sign-in. */
function gallerySignsIn(preset: McpPreset | undefined): boolean {
  if (preset === undefined) return MCP_SIGN_IN_REFUSED;

  return preset.auth === 'oauth' || (preset.auth === 'oauth-app' && mcpSecrets.has(preset.id));
}

function mcpServersFixture(path: string, method: string, body: BodyInit | null | undefined): Response | null {
  if (path === "/api/user/mcp/presets") return mcpPresetsFixture();

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

    const signIn = gallerySignsIn(preset);

    if (preset?.auth === 'oauth-app' && !signIn && addBody.output.headers === undefined) {
      return fixtureJson({ error: `'${preset.title}' needs either the deployment's OAuth app or a token in \`headers\`.` }, 400);
    }

    const id = `srv-add-${String(galleryMcpRows.length + 1)}`;

    // Exposed so the gate can check the posted payload.
    localStorage.setItem("gallery-mcp-add", JSON.stringify(addBody.output));

    galleryMcpRows = [...galleryMcpRows, {
      id, name,
      serverUrl: preset?.serverUrl ?? addBody.output.serverUrl ?? "",
      transport: preset?.transport ?? addBody.output.transport ?? "auto",
      status: signIn ? "needs_sign_in" : "connected",
      toolsCount: signIn ? 0 : 21,
      allowedTools: addBody.output.allowedTools ?? null,
      signIn, error: null,
      presetId: preset?.id ?? null,
    }];

    return fixtureJson({ id, signIn }, 201);
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

  if (path === "/api/user/devices" && method === "POST") return galleryRegister(body);

  if (path === "/api/user/devices") {
    if (frame === "devices-empty") return fixtureJson([]);
    const incident = localStorage.getItem("gallery-device-incident");

    if (incident === "acknowledged") return fixtureJson([]);
    const revoked = incident === "revoked" || incident === "cloned";

    return fixtureJson([
      {
        id: "dev-1", label: "Workstation", os: "linux", hostname: "workstation",
        connected: !revoked, createdAt: NOW - 864e5, lastSeenAt: NOW, expiresAt: NOW + 864e5,
        replacedAt: null,
        revokedAt: revoked ? NOW : null, unstoppedAt: incident === "revoked" ? NOW : null,
        cloneDetectedAt: incident === "cloned" ? NOW : null, wholeMachine: false,
        version: null, servedVersion: null, update: "unreported", updateRefusal: null,
        sandbox: {
          tier: parseDeviceTier(localStorage.getItem("gallery-device-tier")),
          capability: "sandboxed", reason: null, detail: null, gpu: ["/dev/nvidia0"],
        },
        desktop: { state: "none" },
      },
      // `&devices=history`: a refused update and a machine that has never connected.
      ...(new URLSearchParams(location.search).get("devices") === "history" ? [{
        id: "dev-3", label: "Lab box", os: "linux", hostname: "lab", connected: true, createdAt: NOW - 864e5, lastSeenAt: NOW, expiresAt: NOW + 864e5,
        replacedAt: null, revokedAt: null, unstoppedAt: null, cloneDetectedAt: null, wholeMachine: false,
        sandbox: { tier: "sandboxed", capability: "sandboxed", reason: null, detail: null, gpu: [] },
        desktop: { state: "none" },
        version: "0.2.0+older", servedVersion: "0.3.0+served", update: "refused", updateRefusal: "Bun 1.4.2 install failed: permission denied",
      }, {
        id: "dev-old", label: "Old box", os: "linux", hostname: "old", connected: false, createdAt: NOW - 90 * 864e5, lastSeenAt: null, expiresAt: null,
        replacedAt: null, revokedAt: null, unstoppedAt: null, cloneDetectedAt: null, wholeMachine: false,
        sandbox: { tier: "sandboxed", capability: "files_only", reason: null, detail: null, gpu: [] },
        desktop: { state: "none" },
        version: null, servedVersion: null, update: "unreported", updateRefusal: null,
      }] : []),
      ...(frame === "devices" ? [{
        id: "dev-2", label: "Owner laptop", os: "darwin", hostname: "ashish-mbp.local",
        connected: false, createdAt: NOW - 40 * 864e5, lastSeenAt: NOW - 7200e3, expiresAt: NOW + 50 * 864e5,
        replacedAt: null,
        revokedAt: null, unstoppedAt: null, cloneDetectedAt: null, wholeMachine: true,
        sandbox: { tier: "sandboxed", capability: "sandboxed", reason: null, detail: null, gpu: [] },
        desktop: { state: "none" },
        version: null, servedVersion: null, update: "unreported", updateRefusal: null,
      }] : []),
    ]);
  }

  return null;
}

/** A saved catalog reads back; `&chain=` starts it on a chosen web search. */
let galleryCatalog: Pick<ProfileCatalogEnvelope, "catalog" | "version"> = (() => {
  const webSearch = galleryWebSearchChain();

  return { catalog: webSearch === undefined ? BUILTIN_PROFILE_CATALOG : { ...BUILTIN_PROFILE_CATALOG, webSearch }, version: 0 };
})();

/** Hashed with WebCrypto: the gallery has no `node:crypto`. A stale write is refused. */
async function profileCatalogFixture(path: string, method: string, body: BodyInit | null | undefined): Promise<Response | null> {
  if (path !== "/api/user/profile-catalog") return null;

  if (method === "PUT") {
    const put = v.parse(v.object({ catalog: v.unknown(), expectedVersion: v.number() }), JSON.parse(v.parse(v.string(), body)));

    if (put.expectedVersion !== galleryCatalog.version) return fixtureJson({ error: "The catalog changed since you read it." }, 409);
    galleryCatalog = { catalog: validateProfileCatalog({ value: put.catalog }), version: galleryCatalog.version + 1 };
  }

  const bytes = new TextEncoder().encode(profileCatalogCanonical(galleryCatalog.catalog));

  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");

  return fixtureJson({
    authority: { kind: "account", accountId: "gallery" },
    version: galleryCatalog.version,
    digest,
    catalog: galleryCatalog.catalog,
  });
}

/** Answers the paths it owns, `null` for every other; sync or async. */
type SettingsSlice =
  (path: string, method: string, body: BodyInit | null | undefined)
    => Response | null | Promise<Response | null>;

/* Path sets are disjoint: the order is for reading, not routing. */
/** Settings → Memory: one fact an agent proposed and the owner accepted, one the owner promoted, one note, one waiting. */
const ACCOUNT_MEMORY_FIXTURE: JsonValue = {
  facts: [
    {
      key: "owner_name", value: "Ashish", importance: 0.9, veracity: "stated", lastObservedAt: NOW - 3 * 864e5,
      origin: { by: "agent", workspace: "Support inbox", agent: "main" },
      history: [{ forgotten: false, value: "Ashish", origin: { by: "agent", workspace: "Support inbox", agent: "main" }, at: NOW - 3 * 864e5 }],
    },
    {
      key: "reply_language", value: "English, short answers", importance: 0.7, veracity: "stated", lastObservedAt: NOW - 864e5,
      origin: { by: "owner" },
      history: [
        { forgotten: false, value: "English, short answers", origin: { by: "owner" }, at: NOW - 864e5 },
        { forgotten: false, value: "English", origin: { by: "owner", workspace: "API Worker" }, at: NOW - 6 * 864e5 },
      ],
    },
  ],
  notes: [{ id: "acn_1", content: "Invoices go to accounts@example.com on the first of each month.", origin: { by: "agent", workspace: "Support inbox", agent: "main" }, createdAt: NOW - 2 * 864e5 }],
};

/** The read and the roster socket answer one list of proposals, as the user object does. */
function accountMemoryFixture(path: string, method: string): Response | null {
  if (path !== "/api/user/memory" || method !== "GET") return null;
  const memory = v.parse(v.looseObject({ facts: v.array(JsonValueSchema) }), ACCOUNT_MEMORY_FIXTURE);

  return fixtureJson({ ...memory, facts: [...memory.facts, ...galleryKeptFacts], pending: galleryMemoryPending });
}

/** `&mail=off`: setup on a deployment with no mail domain, which offers no address. */
const WELCOME_MAIL_OFF = new URLSearchParams(location.search).get("mail") === "off";

/** The address setup's Mail step creates; none until it does. */
let welcomeAddress: string | null = null;

/** Setup's Mail step: the account has no address and may create one, checked and created through the address route. */
function welcomeMailFixture(path: string, method: string, body: BodyInit | null | undefined): Response | null {
  if (frame !== "welcome" || !path.startsWith("/api/user/mail/")) return null;

  if (path === "/api/user/mail/boxes") {
    return fixtureJson({ enabled: !WELCOME_MAIL_OFF, domain: WELCOME_MAIL_OFF ? null : "kinu.run", address: welcomeAddress, canCreate: !WELCOME_MAIL_OFF && welcomeAddress === null, boxes: [], archived: [] });
  }

  if (path.startsWith("/api/user/mail/address?")) return fixtureJson(galleryUsername(new URLSearchParams(path.split("?")[1]).get("username") ?? ""));

  if (path === "/api/user/mail/address" && method === "POST") {
    welcomeAddress = `${v.parse(v.object({ username: v.string() }), JSON.parse(v.parse(v.string(), body))).username}@kinu.run`;
    document.documentElement.dataset.galleryMailCreated = welcomeAddress;

    return fixtureJson({ address: welcomeAddress });
  }

  return null;
}

/** `&google=connected`: the account holds the Google connection until a disconnect, whose revocation Google refuses;
 *  else it is offered and not yet connected. */
let galleryGoogleHeld = new URLSearchParams(location.search).get("google") === "connected";

function googleConnectionFixture(path: string, method: string): Response | null {
  if (path.startsWith(`/api/user/credentials/${GOOGLE_OAUTH_CRED_KEY}`) && method === "DELETE") {
    galleryGoogleHeld = false;

    return fixtureJson({ unrevoked: path.endsWith("?revoke=1") ? "Google did not answer the revocation." : null });
  }

  if (path !== "/api/user/google") return null;

  return fixtureJson({ available: true, connection: galleryGoogleHeld ? { account: "owner.account@gmail.com", scopes: ["gmail.modify"] } : null });
}

/** Built-in sign-in off, as on an account with an OAuth app: the invite card stays away. */
function builtinAuthFixture(path: string): Response | null {
  return path === "/api/user/builtin-auth" ? fixtureJson({ enabled: false, owner: false }) : null;
}

const SETTINGS_SLICES: readonly SettingsSlice[] = [
  secretsFixture,
  galleryWebSearchTest,
  builtinAuthFixture,
  googleConnectionFixture,
  welcomeMailFixture,
  accountMemoryFixture,
  accountProfileFixture,
  settingsSectionsFixture,
  workspaceRosterFixture,
  mcpConnectFixture,
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

/** Every registration asked, by the name it carried; `&connect=fail-first` refuses the first. */
const galleryRegistrations: string[] = [];

let connectRegistrations = 0;

let connectRosterReads = 0;

/** The one registration answer every surface's connect panel reaches. */
function galleryRegister(body: BodyInit | null | undefined): Response {
  galleryRegistrations.push(v.parse(v.object({ label: v.optional(v.string()) }), JSON.parse(v.parse(v.string(), body))).label ?? "");
  document.documentElement.dataset.galleryRegistrations = JSON.stringify(galleryRegistrations);

  if (connectFixtureMode === "fail-first" && galleryRegistrations.length === 1) return fixtureJson({ error: "the hub is busy" }, 503);
  connectRegistrations += 1;

  return fixtureJson({ origin: location.origin, installCommand: GALLERY_CONNECT_COMMAND, deviceId: GALLERY_ISSUED_DEVICE }, 201);
}

/** The device the fixture's connect issues; `&connect=other` has another machine of the account connect instead. */
const GALLERY_ISSUED_DEVICE = "dev-issued";

function galleryConnectDevice(id: string, label: string, connected: boolean) {
  return {
    id, label, os: "darwin", hostname: "owner-mac", connected,
    createdAt: NOW, lastSeenAt: NOW, expiresAt: NOW + 864e5,
    replacedAt: null,
    revokedAt: null, unstoppedAt: null, cloneDetectedAt: null, wholeMachine: false,
    sandbox: { tier: "sandboxed", capability: "sandboxed", reason: null, detail: null, gpu: [] },
    desktop: id === GALLERY_PC.id ? SHELL_PC_DESKTOP : { state: "none" },
    version: null, servedVersion: null, update: "unreported", updateRefusal: null,
  };
}

function deviceConnectFixture(path: string, method: string, body: BodyInit | null | undefined): Response | null {
  if (path === "/api/user/devices" && method === "POST") return galleryRegister(body);

  if (path === "/api/user/devices" && method === "GET") {
    connectRosterReads += 1;
    // On the document, not `window`: `dataset` is a typed string map, a global is not.
    document.documentElement.dataset.galleryRosterReads = String(connectRosterReads);

    if (connectRegistrations === 0) return fixtureJson([]);

    const issued = galleryConnectDevice(GALLERY_ISSUED_DEVICE, "Owner PC", connectFixtureMode !== "stall" && connectFixtureMode !== "other");

    return fixtureJson(connectFixtureMode === "other" ? [issued, galleryConnectDevice("dev-other", "Laptop", true)] : [issued]);
  }

  if (path === "/api/user/devices/consents" && method === "GET") return fixtureJson([]);

  return null;
}

const rosterSockets = new Set<EventTarget>();

/** `&rosterSocket=refused` closes each socket unopened; `&session=expired` makes each roster read a 401. */
const galleryQuery = new URLSearchParams(location.search);

const ROSTER_SOCKET_REFUSED = galleryQuery.get("rosterSocket") === "refused";

const SESSION_EXPIRED = galleryQuery.get("session") === "expired";

/** `&roster=held` holds every roster read until `gallery:roster-release`; `&roster=empty` answers an account with none. */
const ROSTER_READ = galleryQuery.get("roster");

const rosterRelease = Promise.withResolvers<void>();

window.addEventListener("gallery:roster-release", () => rosterRelease.resolve());

const galleryRosterSockets: GalleryRosterSocket[] = [];

Object.assign(window, { galleryRosterSockets });

/** `&memory=waiting`: one account-memory proposal waits on the owner, sent as a roster socket opens, as the user
 *  object sends it; deciding it (`POST /api/user/memory/proposals/:id`) sends what is left. `&memory=timezone` waits
 *  with another, older one, and `gallery:memory-proposal` files the first while the page is open. */
const MEMORY_PROPOSALS = new Map<string, JsonValue>([
  ["waiting", {
    id: "amp_city", proposal: { kind: "fact", key: "owner_city", value: "Lisbon" },
    origin: { by: "agent", workspace: "api-worker", agent: "main" }, createdAt: NOW - 60_000,
  }],
  ["timezone", {
    id: "amp_1", proposal: { kind: "fact", key: "timezone", value: "Asia/Kolkata" },
    origin: { by: "background", workspace: "API Worker" }, createdAt: NOW - 36e5,
  }],
]);

const seededProposal = MEMORY_PROPOSALS.get(galleryQuery.get("memory") ?? "");

let galleryMemoryPending: JsonValue[] = seededProposal === undefined ? [] : [seededProposal];

window.addEventListener("gallery:memory-proposal", () => {
  galleryMemoryPending = [...galleryMemoryPending, MEMORY_PROPOSALS.get("waiting") ?? null];

  for (const socket of rosterSockets) galleryMemoryFrame(socket);
});

function galleryMemoryFrame(socket: EventTarget): void {
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "account_memory", pending: galleryMemoryPending }) }));
}

/** The facts the owner kept from proposals here. */
let galleryKeptFacts: JsonValue[] = [];

function keptFact(proposal: JsonValue): JsonValue {
  const { proposal: fact, origin } = v.parse(v.object({ proposal: v.object({ key: v.string(), value: v.string() }), origin: JsonValueSchema }), proposal);

  return {
    key: fact.key, value: fact.value, importance: 0.5, veracity: "stated", lastObservedAt: NOW, origin,
    history: [{ forgotten: false, value: fact.value, origin, at: NOW }],
  };
}

/** The owner's decision on a proposal, recorded (`data-gallery-memory-decisions`), then what is left sent to every page. */
function galleryMemoryDecision(path: string, method: string, body: BodyInit | null | undefined): Response | null {
  const id = /^\/api\/user\/memory\/proposals\/([^/]+)$/u.exec(path)?.[1];

  if (id === undefined || method !== "POST") return null;
  const { decision } = v.parse(v.object({ decision: v.string() }), JSON.parse(typeof body === "string" ? body : "{}"));
  const root = document.documentElement.dataset;

  root.galleryMemoryDecisions = `${root.galleryMemoryDecisions ?? ""}${decodeURIComponent(id)}:${decision} `;
  const decided = galleryMemoryPending.find((row) => v.parse(v.object({ id: v.string() }), row).id === decodeURIComponent(id));
  galleryMemoryPending = galleryMemoryPending.filter((row) => row !== decided);

  // A fact kept is a fact the next read answers, as the user object keeps it.
  if (decision === "accept" && decided !== undefined) galleryKeptFacts = [...galleryKeptFacts, keptFact(decided)];
  queueMicrotask(() => { for (const socket of rosterSockets) galleryMemoryFrame(socket); });

  // The route's own answer, as written: its body is the wire's, not a result this gallery decides.
  return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
}

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
      galleryMemoryFrame(this);
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

const realFetch = window.fetch.bind(window);

// `&anon=1` answers the profile with null (signed out), so every persist path is a no-op. Stub data, not a galleryFetch branch: that dispatch is at its complexity budget.
const ANONYMOUS_WORKSPACE = frame === 'workspacepage'
  && new URLSearchParams(location.search).get('anon') === '1';

if (ANONYMOUS_WORKSPACE) STUB.set('/api/user/profile', null);

// The session's own read in setup, as stub data for the same reason: `&noname=1` signed in with Cloudflare, which
// shares no name.
if (frame === "welcome") {
  STUB.set("/api/auth/me", new URLSearchParams(location.search).get("noname") === "1"
    ? { user: { id: "new", email: "new@example.com", provider: "cloudflare", signedInWith: "Cloudflare", displayName: null } }
    : { user: { id: "owner", email: "owner@example.com", provider: "google", signedInWith: "Google", displayName: "Owner" } });
}

function rosterRead(search: URLSearchParams): Promise<Response> {
  if (SESSION_EXPIRED) return Promise.resolve(fixtureJson({ error: "Sign in again." }, 401));

  const answer = () => fixtureJson(ROSTER_READ === "empty" ? { entries: [], total: 0, nextCursor: null, counts: galleryRosterCounts() } : rosterAnswer(search));

  return ROSTER_READ === "held" ? rosterRelease.promise.then(answer) : Promise.resolve(answer());
}

/** POSTs the gallery answers itself, by path: WorkspacePage records a visit on mount, where a 404 is a workspace the
 *  registry no longer holds; the shell, and a pointer resting on a workspace, wake it ahead of its open
 *  (hooks/use-wake-ahead.ts). */
const GALLERY_POSTS: readonly (readonly [RegExp, () => Response])[] = [
  // A share frame's standing approvals: none before its first share.
  [/^\/api\/shared\/live\/preapprovals$/, () => fixtureJson({ slate: "issue-triage", revision: "r2", preapproved: frame === "sharedialog-first" ? [] : STANDING })],
  [/^\/api\/user\/workspaces\/[^/]+\/touch$/, () => touchFixture()],
  [/^\/api\/workspaces\/[^/]+\/wake$/, () => new Response(null, { status: 204 })],
];

/** Every path fetched, so a gate can prove what the page did not read. */
function touchFixture(): Response {
  const root = document.documentElement;
  root.dataset.galleryTouches = String(Number(root.dataset.galleryTouches ?? "0") + 1);

  if (VISIT_FAILS) return fixtureJson({ error: "the roster is unavailable" }, 503);

  return WORKSPACE_GONE
    ? fixtureJson({ error: "No such workspace." }, 404)
    : new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
}

/** The account's own answers: Settings' frames whole, and on any page the owner's decision on a memory proposal. */
/** Uploads the files frame has asked about: the first over a file already listed is a conflict, the replace lands. */
const uploadsAsked = new Set<string>();

/**
 * The files frame's raw upload route: an upload over `AGENTS.md`, which the listing holds, answers as the route does for
 * a create over a file already there (412, naming its revision); the owner's replace that follows lands.
 */
function galleryUploadFixture(path: string, method: string): Response | null {
  if (method !== "PUT" || !/^\/api\/workspaces\/[^/]+\/files\?/.test(path)) return null;
  const target = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("path") ?? "";

  if (target.endsWith("/AGENTS.md") && !uploadsAsked.has(target)) {
    uploadsAsked.add(target);

    return Response.json({ error: "This file changed after you opened it.", revision: 7 }, { status: 412 });
  }

  // The route's own body, as the client parses it.
  return new Response('{"ok":true,"revision":8}', { headers: { "content-type": "application/json" } });
}

/** The PC this workspace holds: `&pc=ungranted` starts without, and the Env tab's one click grants it. */
let galleryPcGranted = (SHELL_PC ?? "granted") !== "ungranted";

/**
 * The owner's account in the Environment frames: one PC, connected unless `&offline=device` or `&pc=offline`, held by
 * the frame's workspace unless `&pc=ungranted`. Null outside those frames and under the connect rig's own roster.
 */
function accountMachinesFixture(asked: string, method: string): Response | null {
  // The path as asked, query and all: a grant names its workspace in `?agentName=`.
  const path = asked.split("?")[0] ?? asked;

  if ((frame !== "environment" && SHELL_PC === null) || connectFixtureActive || !path.startsWith("/api/user/devices")) return null;
  const query = new URLSearchParams(location.search);
  const connected = query.get("offline") !== "device" && SHELL_PC !== "offline";

  if (path === "/api/user/devices" && method === "GET") return fixtureJson([galleryConnectDevice(GALLERY_PC.id, GALLERY_PC.label, connected)]);

  if (path === "/api/user/devices/consents" && method === "GET") {
    return fixtureJson(galleryPcGranted ? [{ agentName: WORKSPACE_PAGE_NAME, deviceId: GALLERY_PC.id, policy: "allow", lastMethod: null, lastSummary: null }] : []);
  }

  if (path === `/api/user/devices/${GALLERY_PC.id}/consent` && method === "POST") {
    galleryPcGranted = true;

    return fixtureJson({ agentName: WORKSPACE_PAGE_NAME, deviceId: GALLERY_PC.id, policy: "allow", lastMethod: null, lastSummary: null });
  }

  return null;
}

function userFixture(path: string, method: string, body: BodyInit | null | undefined): Promise<Response> | null {
  // The deploy page's door (gallery-deploy-fixture.ts): its own sign-in, reads and run.
  const deploying = deployFixture(path, method, typeof body === "string" ? body : null);

  if (deploying !== null) return deploying;

  // No free tier binds the gallery's account: the limits' bar and Usage section stay away (the `limits` frame draws them).
  if (path === "/api/user/limits") return Promise.resolve(fixtureJson({ class: "operator", suspended: null, limits: [], computerSizeCap: null, freeTier: false }));

  // The account's choices, kept in this browser for every frame that reads one.
  const stored = storedConfigFixture(path, method, body);

  if (stored !== null) return Promise.resolve(stored);
  const machines = accountMachinesFixture(path, method);

  if (machines !== null) return Promise.resolve(machines);
  const upload = galleryUploadFixture(path, method);

  if (upload !== null) return Promise.resolve(upload);
  const decided = galleryMemoryDecision(path, method, body);

  if (decided !== null) return Promise.resolve(decided);

  // Read by Settings › Web search and by a chat whose search was refused, in any frame.
  if (path === "/api/user/cloudflare/credits") return Promise.resolve(Response.json(galleryGatewayCredits()));

  if (ACCOUNT_FIXTURE_FRAMES.has(frame) && path.startsWith("/api/user/")) return userSettingsFixture(path, method, body);

  // The whole app: the account's own reads; the roster, profile and model menu stay the shell's.
  if (frame === "whole" && path.startsWith("/api/user/") && !/^\/api\/user\/(?:workspaces(?:\/|$)|profile$|models$)/u.test(path)) return userSettingsFixture(path, method, body);
  const memory = accountMemoryFixture(path, method);

  return memory === null ? null : Promise.resolve(memory);
}

/** The stub for a read; one with a query (`?limit=3`) is answered as its path is. */
function stubbed(path: string): JsonValue | undefined {
  return STUB.get(path) ?? STUB.get(path.split("?")[0] ?? path);
}

const galleryRequests: string[] = [];

Object.assign(window, { galleryRequests });

const galleryFetch = Object.assign((input: RequestInfo | URL, init?: Parameters<typeof window.fetch>[1]) => {
  const parsedRequest = v.safeParse(v.instance(Request), input);
  const url = requestUrl(input);

  galleryRequests.push(new URL(url, location.origin).pathname);

  const path = url.startsWith("/") ? url : new URL(url, location.origin).pathname;
  const method = (init?.method ?? (parsedRequest.success ? parsedRequest.output.method : "GET")).toUpperCase();

  const user = userFixture(path, method, init?.body);

  if (user !== null) return user;

  if (connectFixtureActive && path.startsWith("/api/user/devices")) {
    const answer = deviceConnectFixture(path, method, init?.body);

    if (answer !== null) return Promise.resolve(answer);
  }

  const roster = new URL(url, location.origin);

  if (roster.pathname === "/api/user/workspaces" && method === "GET") {
    // Cloned per call: a `Response` body reads once and the provider has several reads in flight here.
    if (frame === "rosterauthority") return rosterAuthorityHold.promise.then((held) => held.clone());

    return rosterRead(roster.searchParams);
  }

  const response = stubbed(path);

  if (response !== undefined && (!init?.method || init.method === "GET")) {
    return Promise.resolve(new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } }));
  }

  const posted = method === "POST" ? GALLERY_POSTS.find(([route]) => route.test(path)) : undefined;

  if (posted !== undefined) return Promise.resolve(posted[1]());

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

installGalleryFixture(frame);

installPartsFixture(frame);

installShareModeFixture(frame, () => LIVE_SHARE, () => STANDING);

const TERMINAL_PATH = /^\/api\/workspaces\/[^/]+\/terminal$/u;

/** Every frame's roster socket is the fixture's; the environment frame's terminal socket is too. */
window.WebSocket = new Proxy(window.WebSocket, {
  construct(target, args: [string | URL, (string | string[])?]) {
    const [url, protocols] = args;
    const path = new URL(String(url), location.href).pathname;

    if (path === ROSTER_SOCKET_ROUTE) return new GalleryRosterSocket();

    if ((frame === "environment" || SHELL_COMPUTER || SHELL_PC !== null) && TERMINAL_PATH.test(path)) return new GalleryShellSocket(url);

    return protocols === undefined ? new target(url) : new target(url, protocols);
  },
});

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

    // As the gallery answers it, typed, with Column C's exploration stores; a method it does not answer is refused.
    const answerRpc = async (): Promise<JsonValue> => v.parse(JsonValueSchema, await wireOf({ ...FORK_ANSWERS, ...AGENT_ANSWERS })<JsonValue>(method, request.args ?? []) ?? null);

    // As the Agents SDK frames a call's outcome: its result, or its failure for the client to reject with.
    const reply = (body: JsonObject) => {
      const message = new MessageEvent("message", { data: JSON.stringify({ type: "rpc", id: request.id, ...body }) });

      this.onmessage?.(message);
      this.dispatchEvent(message);
    };

    answerRpc().then(
      (result) => { reply({ success: true, result }); },
      (...rejection: [unknown]) => { reply({ success: false, error: toKinuError({ doing: `answering ${method}`, cause: rejection[0], otherwise: "io" }).message }); },
    );
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

/** A frame the gate makes the server send: cards and steers carry an actor stamp, which no fixture read can produce; `reads_changed` names reads to redo; `turn_claim` is the root's claim as it changes; `head_stream` and `head_activity` are a swarm head's live paint and landed step. */
const GalleryPushFrameSchema = v.object({
  type: v.picklist(["signal_card", "steer_status", READS_CHANGED_EVENT, TURN_CLAIM_FRAME, "head_stream", "head_activity", "subagent_event", "model_fallback", "provider_wait"]),
  reads: v.optional(v.array(v.string())),
  claim: v.optional(JsonObjectSchema),
  headId: v.optional(v.string()),
  kind: v.optional(v.string()),
  delta: v.optional(v.string()),
  actorId: v.optional(v.string()),
  id: v.optional(v.string()),
  state: v.optional(v.string()),
  text: v.optional(v.string()),
  metadata: v.optional(JsonObjectSchema),
  steerId: v.optional(v.string()),
  status: v.optional(v.string()),
  atStep: v.optional(v.number()),
  // When a card's signal was delivered, on the server's clock.
  at: v.optional(v.number()),
  // An agent given work or reporting on it (`subagent_event`), at the time it happened.
  subagent: v.optional(v.string()),
  content: v.optional(v.string()),
  task: v.optional(v.string()),
  timestamp: v.optional(v.number()),
  // Another model taking over a turn (`model_fallback`).
  message: v.optional(v.string()),
  // A provider asking the turn to wait (`provider_wait`).
  provider: v.optional(v.string()),
  waitMs: v.optional(v.number()),
  attempt: v.optional(v.number()),
  source: v.optional(v.string()),
});

// A row the room stamped after it ended, sent alone as the room sends it (`MESSAGE_AMENDED_FRAME`).
window.addEventListener("gallery:amend-row", (event: Event) => {
  const detail = event instanceof CustomEvent ? v.safeParse(v.object({ message: UIMessageSchema }), event.detail) : null;

  if (detail?.success === true) galleryServerPush(JSON.stringify({ type: MESSAGE_AMENDED_FRAME, message: detail.output.message }));
});

// What an answer's page's server pushes, told to the tab as the workspace tells it (`SLATE_PUSH_EVENT`).
window.addEventListener("gallery:slate-push", (event: Event) => {
  const detail = event instanceof CustomEvent ? v.safeParse(v.object({ page: v.string(), data: JsonValueSchema }), event.detail) : null;

  if (detail?.success === true) galleryServerPush(JSON.stringify({ type: SLATE_PUSH_EVENT, ...detail.output }));
});

window.addEventListener("gallery:push-frame", (event: Event) => {
  const detail = event instanceof CustomEvent ? v.safeParse(GalleryPushFrameSchema, event.detail) : null;

  if (detail?.success !== true) return;

  galleryServerPush(JSON.stringify(detail.output));
});

if (AGENTS_PANEL) {
  seedGalleryChat([
    // Hired by Main: its task arrives as an event naming the hirer, never as the person speaking.
    msg({ id: "ca-u1", role: "user", createdAt: NOW - 6 * 60e3, metadata: delegatedTaskMetadata("main", "build"), parts: [{ type: "text", text: "Audit every route for a read of the old database binding." }] }),
    msg({ id: "ca-a1", role: "assistant", createdAt: NOW - 5 * 60e3, parts: [{ type: "text", text: "Two routes still read env.DB themselves; both are in routes/webhooks.ts." }] }),
  ], hostedActorSocketPath("binding-auditor"));

  const docs: SubagentView & { actorId: string } = {
    name: "docs", actorId: galleryActorId("docs"), displayName: "Docs writer", role: "agent", nameOrigin: "user", origin: "user",
    lifetime: "durable", status: "idle", currentTask: null, createdAt: NOW, dismissedAt: null,
  };

  GALLERY_SUBS.push(docs);
}

window.addEventListener("gallery:annotation-save", () => {
  annotationRelease.shift()?.();
  document.documentElement.dataset.galleryAnnotationsWaiting = String(annotationRelease.length);
});

new MutationObserver(() => {
  galleryServerPush(JSON.stringify({ type: READS_CHANGED_EVENT, reads: ["getExposedPorts"] }));
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-preview-arrived", "data-sandbox-starting", "data-sandbox-ports"] });

/**
 * `gallery:live-window` with `{ rows, edited?, cleared? }`: the socket's live window moves to those history rows, `edited`
 * saying more live than stored; `cleared` is another tab's clear, which empties the store too.
 */
const LiveWindowSchema = v.object({ rows: v.array(v.number()), edited: v.optional(v.number()), cleared: v.optional(v.boolean()) });

window.addEventListener("gallery:live-window", (event: Event) => {
  const asked = v.parse(LiveWindowSchema, event instanceof CustomEvent ? event.detail : null);

  if (asked.cleared === true) document.documentElement.dataset.historyCleared = "1";

  const entries = asked.rows.map((index) => {
    const row = historyRow(index);

    return index === asked.edited ? { ...row, parts: row.parts.map((part) => (typeof part.text === "string" ? { ...part, text: `${part.text} Edited live.` } : part)) } : row;
  });

  const first = asked.rows[0];

  galleryChatWindow("", restoredRows(entries), first !== undefined && first > 0 ? { before: first } : null);
});

// The seeded rows follow the stored ones.
if (HISTORY_ROWS > 0) galleryChatStartsAt("", { before: HISTORY_ROWS });

window.addEventListener("gallery:jobs", (event) => {
  JOBS_RUNNING.at = v.parse(v.object({ running: v.boolean() }), event instanceof CustomEvent ? event.detail : null).running;
  galleryServerPush(JSON.stringify({ type: READS_CHANGED_EVENT, reads: ["listBackgroundJobs"] }));
});

window.addEventListener("gallery:agent-rested", (event) => {
  RESTED_AGENTS.add(v.parse(v.object({ key: v.string() }), event instanceof CustomEvent ? event.detail : null).key);
  galleryServerPush(JSON.stringify({ type: READS_CHANGED_EVENT, reads: ["listWorkspaceAgents"] }));
});

window.addEventListener("gallery:arrive-ask", () => {
  document.documentElement.dataset.galleryArrived = "1";
  galleryServerPush(JSON.stringify({ type: READS_CHANGED_EVENT, reads: ["listPendingActions"] }));
});

/** The owner's "Always for this slate" answers at the slate's revision now: a GitHub change on one org, and a file write. */
const STANDING: SharePreapproval[] = [
  { slate: "issue-triage", namespace: "mcp.github", member: "create_issue", root: { org: "acme" }, revision: "r2" },
  { slate: "issue-triage", namespace: "workspace", member: "fs.write", root: {}, revision: "r2" },
];
