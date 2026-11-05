/**
 * Design-system gallery: the real components over mock data, so signed-in surfaces can be screenshotted without auth.
 * Served by gallery.vite.config.ts; `?frame=` selects a frame (full list: the dispatch in `mount()`). /api/user/* GETs are stubbed in-page.
 */
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { answerPictures } from "@kinu.run/core/web/picture-src";
import { galleryPicture } from "@/gallery-pictures";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { diagnostics, renderThrownChain, toKinuError } from "@kinu.run/core/obs";
import "virtual:kinu-theme.css";
import "./index.css";
import { approvalDocument, authDocument, installDocument, loginDocument } from "@kinu.run/core";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AgentsNavProvider } from "@/hooks/use-agents-nav";
import { startTheme } from "@/hooks/use-theme";
import { WorkspaceRosterProvider } from "@/hooks/use-workspace-roster";
import { AccountProvider } from "@/hooks/use-account";
import { SHARED_SLATE_PAGE, sharedSlateDocument } from "@/gallery-parts";
import { frame } from "@/gallery-data";
// The page-wide stand-ins, installed before the first frame mounts.
import "@/gallery-stubs";
import { accountFrames } from "@/gallery-account-frames";
import { activityFrames } from "@/gallery-activity-frames";
import { chatFrames } from "@/gallery-chat-frames";
import { All, chromeFrames } from "@/gallery-chrome-frames";
import { sharingFrames } from "@/gallery-sharing-frames";
import { swarmFrames } from "@/gallery-swarm-frames";
import { workspaceFrames } from "@/gallery-workspace-frames";
import { framed, type FrameTable } from "@/gallery-shared";

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

  // The frame asked for, from the module that holds it; the index of every frame when none is named.
  const table: FrameTable = { ...chatFrames, ...swarmFrames, ...workspaceFrames, ...activityFrames, ...sharingFrames, ...accountFrames, ...chromeFrames };
  const asked = Object.hasOwn(table, frame) ? table[frame] : undefined;
  let { node, entries } = asked === undefined ? framed(<All />) : await asked();

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
