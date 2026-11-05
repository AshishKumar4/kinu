/** The page-wide frames: the modal, feedback, the error boundary, lazy routes, the design frames and the index. */
import { TextInput } from "@/components/ui/Field";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { SystemFrame } from "@/gallery-system";
import { Route, Routes } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { TrashIcon, BrainIcon, ListIcon } from "@phosphor-icons/react";
import { markDocument } from "@kinu.run/core";
import Sidebar from "@/components/Sidebar";
import { KinuLogo, KinuMark } from "@/components/ui/KinuLogo";
import Layout from "@/components/layout";
import { MarkdownContent, CodeBlock } from "@/components/surfaces/shared";
import { Empty } from "@/components/ui/Empty";
import { Notice } from "@/components/ui/Notice";
import { Modal } from "@/components/ui/Modal";
import { FeedbackButton } from "@/components/FeedbackButton";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { APP_ROUTES } from "@kinu.run/core";
import { CHUNK_FIXED_KEY, lazyRoute } from "@/lazy-route";
import { useTheme } from "@/hooks/use-theme";
import { CreateWebhookModal, NewWebhookCard } from "@/components/WorkspaceAutomations";
import { AddServerCard } from "@/components/account/McpServersPanel";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { ChatMessages, GalleryComposer, GalleryWorkspaceHeader, galleryActorId, type MountedFrame } from "@/gallery-shared";
import { framed, type FrameTable } from "@/gallery-shared";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b p-border">
      <h2 className="px-6 pt-6 pb-2 t-status uppercase p-text-3">{title}</h2>
      <div className="px-6 pb-8">{children}</div>
    </section>
  );
}

function Controls() {
  return (
    <div className="space-y-6 max-w-2xl">
      {/* The one Button's filled looks: primary, and the confirm dialog's destructive. */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="md">Primary</Button>
        <Button variant="destructive" size="md">danger</Button>
        <Button variant="secondary" size="sm">Kumo secondary</Button>
        <Button variant="ghost" size="sm">Kumo ghost</Button>
        <Button variant="danger" size="sm">Danger</Button>
        <Button variant="secondary" size="md" disabled>Disabled</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="px-1.5 py-0.5 rounded-sm t-meta t-mono p-badge-neutral">workspace</span>
        <span className="px-1.5 py-0.5 rounded-sm t-meta t-mono p-badge-success">sandbox</span>
        <span className="px-1.5 py-0.5 rounded-sm t-meta t-mono p-badge-warning">device</span>
        <span className="px-1.5 py-0.5 rounded-sm t-meta p-badge-danger">failed</span>
        <span className="size-1.5 rounded-full p-dot-success animate-pulse" title="working" />
        <span className="size-1.5 rounded-full p-dot-accent" title="unseen" />
      </div>
      <div className="space-y-2">
        <Notice tone="success">Deployed to staging — 14 tests green.</Notice>
        <Notice tone="warning">The device runtime is not provisioned yet.</Notice>
        <Notice tone="danger">Could not remove: workspace has a live turn.</Notice>
        <Notice tone="info">Evolution changelog has 3 unseen entries.</Notice>
      </div>
      <div className="max-w-md space-y-2">
        <input className="w-full px-3 py-1.5 border p-border p-card t-body t-mono" placeholder="raw input (fork modal style)" />
        <textarea rows={2} className="block w-full resize-y rounded-md border p-border p-bg px-3 py-3 t-body p-text placeholder:p-text-3 transition-all" placeholder="mission textarea (home page style)" />
      </div>
      <Empty icon={BrainIcon} title="No exploration trees yet">Exploration trees appear when the agent runs agents.swarm with a depth to investigate subproblems.</Empty>
    </div>
  );
}

export function All() {
  return (
    <div className="p-bg p-text min-h-screen">
      <Section title="Chat column"><div className="@container max-w-3xl border p-border rounded-lg overflow-hidden"><GalleryWorkspaceHeader /><ChatMessages /><GalleryComposer /></div></Section>
      <Section title="Controls">{<Controls />}</Section>
    </div>
  );
}

/* Each strip opens a different tab; the narrowest overflows. */
const TAB_STRIPS: readonly { readonly open: string; readonly width: number }[] = [
  { open: "main", width: 760 },
  { open: galleryActorId("docs"), width: 560 },
  { open: "overview", width: 380 },
];

function TabsFrame() {
  return (
    <div className="p-bg min-h-screen p-8 space-y-8">
      {TAB_STRIPS.map((one) => (
        <div key={`${one.open}-${one.width}`} data-tab-strip={one.open} className="flex flex-col overflow-hidden" style={{ width: one.width, height: 150 }}>
          <GalleryWorkspaceHeader active={one.open} />
          <div className="flex-1 px-5 py-4 t-body p-text-3">Chat body</div>
        </div>
      ))}
    </div>
  );
}

/* Everything the agent emits that must survive a narrow chat column. */
const MARKDOWN_SAMPLE = `Here is what the deploy is doing wrong, and the patch.

The Worker reads \`env.DB\` after the config renamed the binding to \`SESSIONS_DB\`, so every route that opens the database calls \`undefined.prepare\`. Fix is one line in \`db.ts\` plus an index in the migration.

\`\`\`ts
function openDb(env: Env): D1Database {
  const db = env.SESSIONS_DB ?? env.DB;
  if (db === undefined) throw new MissingBinding(\`no database bound as SESSIONS_DB\`, { worker: "api" });
  return db;
}
\`\`\`

\`\`\`sql
CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions (expires_at) WHERE expires_at IS NOT NULL;
\`\`\`

\`\`\`bash
bun test workers/api --reporter=verbose && bunx wrangler deploy --env staging --var STRICT_BINDINGS:1
\`\`\`

plain fence, no language: code-block styling still applies even when there are no language-specific tokens to highlight
\`\`\`

| Route | Binding | p95 ms | Status |
| --- | --- | ---: | --- |
| /api/users | SESSIONS_DB | 38 | ok |
| /api/health | DB | 41 | **500** |

1. Patch openDb
2. Add the regression test
   - one for \`SESSIONS_DB\`
   - one for the old \`DB\` name
3. Re-run the suite

> The rename shipped before the tests read the binding, which is why nothing failed in CI.

See [the config change](https://example.com/commits/3f2a91c) for the original.`;

function MarkdownFrame() {
  return (
    <div className="p-bg min-h-screen p-8 flex flex-wrap gap-8 items-start">
      {[420, 720].map((w) => (
        <div key={w}>
          <div className="t-label mb-2">{w}px</div>
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
          <Button variant="destructive" size="md">Remove</Button>
        </>}
      >
        <p className="text-xs p-text-2 leading-relaxed">
          Remove <span className="font-medium p-text">API Worker</span> and delete everything in it? This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}

const SURFACE_STEPS = [
  ["sunken", "--c-sunken"], ["base", "--c-bg"], ["panel", "--c-sidebar"],
  ["card", "--c-surface"], ["fill", "--c-fill"], ["overlay", "--c-overlay"],
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
        <div className="t-label mb-1">{mode}</div>
        <h1 className="t-title p-text" style={{ fontSize: 22, lineHeight: "28px" }}>Surface ladder, text roles, accent intent, status</h1>
        <p className="t-meta p-text-3 mt-1">The plate names the mode it is drawn in, and every value below is read from the live cascade — one palette, two modes.</p>
      </div>
      <div>
        <div className="t-label mb-2">Surfaces — six steps</div>
        <div className="flex rounded-lg overflow-hidden border p-border">
          {SURFACE_STEPS.map(([name, variable]) => (
            <div key={name} className="flex-1 h-24 flex items-end p-2" style={{ background: `var(${variable})` }}>
              <span className="t-meta p-text-3">{name}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="t-label mb-2">Text roles</div>
        <div className="space-y-1.5">
          {TEXT_STEPS.map(([name, variable]) => (
            <div key={name} className="p-body" style={{ color: `var(${variable})`}}>The agent resumed turn 41 from step 3 — {name}</div>
          ))}
        </div>
      </div>
      <div>
        <div className="t-label mb-2">The accent carries intent only</div>
        <div className="flex items-center gap-3 flex-wrap">
          <Button variant="primary">Primary action</Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <a className="p-accent-fg t-body underline underline-offset-2"href="#top">A link</a>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full p-selected">
            <span className="size-1.5 rounded-full p-dot-accent animate-pulse"/>
            <span className="t-meta p-accent-fg font-medium">working</span>
          </span>
        </div>
      </div>
      <div>
        <div className="t-label mb-2">Status — AA in every theme</div>
        <div className="flex items-center gap-2 flex-wrap">
          {STATUS_STEPS.map((name) => (
            <span key={name} className={`px-2 py-0.5 p-badge-${name}`}>{name}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The favicon file as a browser rasterises it at `size`, blown up so its pixels stay square. */
function FaviconRaster({ size }: { size: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const image = new Image(size, size);
    image.onload = () => canvas.current?.getContext("2d")?.drawImage(image, 0, 0, size, size);
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markDocument())}`;
  }, [size]);

  return <canvas ref={canvas} width={size} height={size} style={{ width: 96, height: 96, imageRendering: "pixelated" }} />;
}

const BROWSER_TABS = [
  { strip: "#DEE1E6", tab: "#FFFFFF", text: "#1F1F1F" },
  { strip: "#202124", tab: "#35363A", text: "#E8EAED" },
] as const;

/** The mark where it appears: the favicon in both browsers' tabs and pixel for pixel, the rail, the sidebar, the phone bar and the hero. */
function MarksFrame() {
  const favicon = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markDocument())}`;

  return (
    <div className="p-bg p-text min-h-screen p-10 space-y-8">
      <section className="flex flex-wrap items-end gap-10">
        <div className="space-y-2">
          <div className="t-label">Favicon, 16px</div>
          {BROWSER_TABS.map((browser) => (
            <div key={browser.strip} className="w-[300px] rounded-[10px] px-2 pt-2"style={{ background: browser.strip }}>
              <div className="flex h-[34px] w-[200px] items-center gap-2 rounded-t-[8px] px-3 text-[12px]"style={{ background: browser.tab, color: browser.text, fontFamily: "Arial, sans-serif"}}>
                <img src={favicon} width={16} height={16} alt=""/>API Worker · Kinu
              </div>
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <div className="t-label">16 and 32, pixel for pixel</div>
          <div className="flex gap-3"><FaviconRaster size={16} /><FaviconRaster size={32} /></div>
        </div>
        <div className="space-y-2">
          <div className="t-label">Mark</div>
          <div className="flex items-end gap-6">
            {[16, 20, 32, 64, 112].map((size) => <KinuMark key={size} size={size} />)}
          </div>
        </div>
      </section>
      <section className="flex flex-wrap items-start gap-10 border-t p-border pt-8">
        <div className="space-y-2">
          <div className="t-label">Rail</div>
          <div className="flex w-14 flex-col items-center gap-1 rounded-[10px] border p-border p-sidebar py-3"><span className="flex size-9 items-center justify-center"><KinuMark size={20} /></span></div>
        </div>
        <div className="space-y-2">
          <div className="t-label">Sidebar</div>
          <div className="h-[220px] w-60 overflow-hidden rounded-[10px] border p-border p-sidebar"><Sidebar onCollapse={() => {}} /></div>
        </div>
        <div className="space-y-2">
          <div className="t-label">Phone bar</div>
          <div className="flex h-14 w-[390px] items-center gap-1 rounded-[10px] border p-border p-sidebar px-3">
            <span className="flex size-9 items-center justify-center p-text-2"><ListIcon size={18} /></span>
            <span className="flex items-center rounded-md px-2 py-1.5"><KinuLogo compact /></span>
          </div>
        </div>
      </section>
      <section className="space-y-2 border-t p-border pt-8">
        <div className="t-label">Hero</div>
        <span className="inline-flex items-center gap-5 t-page-title p-text"><KinuMark size={76} /><span>Kinu</span></span>
      </section>
    </div>
  );
}

/**
 * The page a feedback screenshot is taken of: `[data-secret-input]` (a password, redacted without annotation), `[data-secret-token]`
 * (marked text), `[data-visible-copy]` (negative control: must not be uniform). `?noise=1`drives the oversized refusal with real bytes.
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
        <span className="t-item t-mono font-semibold">Account settings</span>
        <FeedbackButton compact />
      </header>
      <div className="space-y-5 p-6">
        <p data-visible-copy className="max-w-xl p-text-2">
          Connected providers bill to your own account. Rotating a key takes effect on the next
          turn; running turns keep the credential they started with.
        </p>
        <label className="block max-w-sm space-y-1.5">
          <span className="text-xs p-text-2">Anthropic API key</span>
          <TextInput
            data-secret-input
            type="password"
            defaultValue="gallery-placeholder-not-a-key"
          />
        </label>
        <div className="max-w-sm space-y-1.5">
          <span className="text-xs p-text-2">Device token</span>
          <code
            data-secret-token
            data-feedback-redact
            className="block rounded-md border p-border px-3 py-2 text-[12.5px]"
          >
            ptc_LEAKED_IF_REDACTION_FAILS_0123456789
          </code>
        </div>
        {/* Intrinsic size, not`w-full`: a scaled-down canvas resamples into pixels that compress back under the limit. */}
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
          <CreateWebhookModal agentName="api-worker"
            onClose={() => { /* the dialog stays up for the capture */ }}
            onCreated={() => { /* the gate never submits */ }} />
        ) : (
          <>
            <NewWebhookCard
              result={{ trigger_id: "01K5ZQ8F2P0000000000000001", url: "/api/workspaces/api-worker/webhook/01K5ZQ8F2P0000000000000001/v1-8b2e4d17c9053fa6be71204d8ac3915f", auth_mode: "hmac", secret: LEAK_HMAC }}
              onDismiss={() => { /* the card stays up for the capture */ }}
            />
            <NewWebhookCard
              result={{ trigger_id: "01K5ZQ8F2P0000000000000002", url: "/api/workspaces/api-worker/webhook/01K5ZQ8F2P0000000000000002/v1-1d7fa39c50b2e846c3915f7b204d8ae2", auth_mode: "bearer", secret: LEAK_BEARER }}
              onDismiss={() => { /* the card stays up for the capture */ }}
            />
            <AddServerCard onCancel={() => { /* the form stays up for the capture */ }}
              onAdded={() => { /* nothing is added; the gate never submits */ }}
              onConnected={() => { /* nothing connects; the gate never submits */ }} />
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
        <p data-visible-copy className="max-w-xl t-body p-text-2">
          A screenshot is taken of the page as the reporter left it. A pane they scrolled to the
          line that failed has to arrive on that line, not back at the top.
        </p>
        <div className="p-group max-w-fit">
          <div className="border-b p-border px-3 py-2 t-label">Nested panes</div>
          <div data-scroll-outer style={{ height: 180, width: 520, overflowY: "auto", overflowX: "hidden"}}>
            {SCROLL_BANDS.map((fill, band) => (
              <div key={fill} data-scroll-band={band} style={{ height: 180, background: fill }}>
                {band === 2 && (
                  <div data-scroll-inner style={{ height: 120, width: 480, overflowX: "auto", overflowY: "hidden"}}>
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

/** Must never reach a log: V8 puts`${name}: ${message}` on the first line of `error.stack`. */
const RENDER_FAULT_MESSAGE =
  "Cannot read properties of undefined (reading 'prepare') for session MESSAGE_LEAKS_IF_REPORTED_0001";

/** One error across every render attempt, minted inside the first render: a fresh one per attempt could not prove the boundary dedupes. */
let renderFault: TypeError | null = null;

/** `?huge=1`: a stack far over the request bound, so the client must fit the report. */
const HUGE_STACK = new URLSearchParams(location.search).get("huge") === "1";

const HUGE_FRAME = "    at openDb (http://127.0.0.1/assets/index-a1b2c3.js:1:2345)";

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
    <div className="h-full overflow-y-auto p-bg p-text"data-render-failure>
      <div className="space-y-4 p-6">
        <p data-scene-copy className="max-w-xl t-body p-text-2">
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
        <div className="p-group max-w-2xl"style={{ height: 340 }}>
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
      `Failed to fetch dynamically imported module: ${location.origin}/assets/SwarmExplorer-a1b2c3.js`,
    );
}

const StaleChunkRoute = lazyRoute(async () => {
  recordAttempt("stale");

  if (!chunkIsPresent()) throw fixtureFailure();

  return { default: () => <p data-lazy-loaded className="text-sm p-text-2">The split route rendered.</p> };
});

/** A real code-split chunk (`gallery-lazy-healthy.tsx`says why); its attempt count shows a regenerated loader clears only its own memo. */
const HealthyChunkRoute = lazyRoute(async () => {
  recordAttempt("healthy");
  const { default: LazyHealthyRoute } = await import("./gallery-lazy-healthy");

  return { default: LazyHealthyRoute };
});

function LazyRouteScene() {
  return (
    <div className="h-full overflow-y-auto p-bg p-text"data-lazy-scene>
      <div className="space-y-4 p-6">
        <p data-scene-copy className="max-w-xl t-body p-text-2">
          A code-split route is a hashed asset. A tab held open across a deploy cannot load one,
          and reloading is the whole fix — once, and only when the origin really has moved.
        </p>
        <div className="p-group max-w-2xl"style={{ height: 260 }}>
          <ErrorBoundary label="swarm-explorer">
            <Suspense fallback={<p data-lazy-pending className="p-6 p-text-3">Loading…</p>}>
              <StaleChunkRoute />
            </Suspense>
          </ErrorBoundary>
        </div>
        <div className="p-group max-w-2xl"style={{ height: 120 }}>
          <ErrorBoundary label="control-plane">
            <Suspense fallback={<p className="p-6 p-text-3">Loading…</p>}>
              <HealthyChunkRoute />
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}

/** Routed so the report's route and workspace come from a resolved `/workspace/:agentId`. */
function feedbackRoutedFrame(): MountedFrame {
  return {
    entries: ["/workspace/api-worker"],
    node: (
      <Routes>
        <Route element={<Layout />}>
          <Route path="/workspace/:agentId" element={<FeedbackScrollScene />} />
        </Route>
      </Routes>
    ),
  };
}

/** ReplaceStates the address bar: the report reads `location.pathname`, which the MemoryRouter leaves at `/`. */
function errorBoundaryFrame(): MountedFrame {
  history.replaceState(null, "", `/workspace/api-worker${location.search}`);

  return {
    entries: ["/workspace/api-worker"],
    node: (
      <Routes>
        <Route element={<Layout />}>
          <Route path={APP_ROUTES.workspace} element={<RenderFailureScene />} />
        </Route>
      </Routes>
    ),
  };
}

/**
 * A read reloaded faster than it answers, as the Work read is while a turn runs: each press asks again, and each load
 * waits until the test answers it, with the count of tasks the server had when it read.
 */
function ReloadsFrame() {
  const load = useCallback(() => new Promise<number>((answer) => {
    (window.__reloads ??= []).push(answer);
  }), []);

  const tasks = useAsyncResource(load);

  return (
    <div className="p-6 flex items-center gap-3">
      <button type="button" className="p-row-hover px-2 py-1 rounded border p-border" onClick={tasks.reload}>Reload</button>
      <span data-reloads-shown>{lastValue(tasks.resource) ?? "none"}</span>
    </div>
  );
}

/** Frames that take no setting from the query: the design system's own, and the hooks' small stages. */
const DESIGN_FRAMES = new Map([
  ["reloads", <ReloadsFrame />],
  ["palette", <Palette />],
  ["marks", <MarksFrame />],
  ["tabs", <TabsFrame />],
  ["markdown", <MarkdownFrame />],
  ["coderendering", <CodeRenderingFrame />],
  ["system", <SystemFrame />],
]);

function lazyRouteFrame(): MountedFrame {
  return {
    entries: ["/workspace/api-worker"],
    node: (
      <Routes>
        <Route element={<Layout />}>
          <Route path={APP_ROUTES.workspace} element={<LazyRouteScene />} />
        </Route>
      </Routes>
    ),
  };
}

/** This module's frames, by `?frame=`: gallery.tsx mounts the one asked for. */
export const chromeFrames: FrameTable = {
  modal: () => framed(<GalleryModal />),
  feedback: () => framed(<FeedbackFrame noise={new URLSearchParams(location.search).get("noise") === "1"} />),
  feedbacksecrets: () => framed(<FeedbackSecretsFrame modal={new URLSearchParams(location.search).get("modal") === "1"} />),
  feedbackrouted: () => feedbackRoutedFrame(),
  errorboundary: () => errorBoundaryFrame(),
  lazyroute: () => lazyRouteFrame(),
  // The design system's own frames, each a page of its parts.
  ...Object.fromEntries([...DESIGN_FRAMES].map(([key, node]) => [key, () => framed(node)])),
};
