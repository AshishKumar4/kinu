/**
 * Personal parts in the gallery (docs/SLATE-SHARING-NIMBUS.md §3): `part-host` is an app page hosting a slate's page,
 * itself framing three part frames (`part-frame&part=<part>`), as a share or the owner's preview does. The part routes
 * answer here, at the top, as the server would for one signed-in viewer:
 *
 * - `standup` asks to use the viewer's GitHub, then shows their open pull requests, with a refresh and a "Show to
 *   everyone" the viewer can confirm. Its consent was given for an earlier revision of the code, so it says it changed.
 * - `deploy` shows a field for what to deploy and its button. That run asks to use the viewer's Vercel, then for their
 *   approval of one effect with its payload, then shows done; each decision resumes it with what the viewer typed.
 * - `team` is a part the slate does not declare for this share: a stub that says what to do.
 *
 * `part-host-refused` is the same page as its runs are refused: the viewer's session has ended for `standup`, the
 * workspace fails `deploy`'s run, and `team`'s own code fails.
 *
 * `shared-live` is the same slate entered as a share: the share's page opens it (`/api/shared/live/open`) and frames it
 * under Kinu's bar, hosting its parts as the visitor; `shared-live-signed-out` is a share that names people, entered
 * signed out. `part-previews` is the owner's own two previews of it, in the
 * workspace's column and in an answer in the chat; their page is the slate's server's, served by a test.
 *
 * What the page asked is on the root for a test to read; the slate's page is drawn here, as its own author would.
 */
import { useRef } from "react";
import { Route, Routes } from "react-router-dom";
import * as v from "valibot";
import {
  APP_ROUTES, LIVE_SHARE_LISTING_PATH, LIVE_SHARE_MODE_PATH, LIVE_SHARE_OPEN_PATH, LIVE_SHARE_PREAPPROVAL_WITHDRAW_PATH, SlatePreapprovalWithdrawSchema, LiveShareBodySchema, LiveShareListingBodySchema, LiveShareModeBodySchema, PartRunRequestSchema, slatePartFramePath, type OwnedLiveShare,
  type PartRunAnswer, type PartRunRequest, type SharePreapproval, type SlateConsent, type SlatePreapprovals,
} from "@kinu.run/core";
import { InlineSlate } from "@/components/slates/InlineSlate";
import { SlateInlineContext } from "@/components/slates/context";
import { PartView, SealedContent, shownMarkup } from "@/components/sharing/PartView";
import { SLATE_GALLERY_URL } from "@/gallery-slate-fallback";
import { usePartHost } from "@/hooks/use-part-host";
import { answeringRpc } from "@/lib/workspace-rpc";
import LiveSharePage from "@/pages/LiveSharePage";
import PartFramePage from "@/pages/PartFramePage";

/** The slate's address and the revision of its code now. */
const SLATE_AT = { workspace: "sam-ops", slate: "team-board", title: "Team board", revision: "r2" } as const;

const { workspace: WORKSPACE, slate: SLATE, title: TITLE, revision: REVISION } = SLATE_AT;

/** What each part asks of the viewer's grants, at this revision. */
const ASKS = {
  github: { server: "mcp.github", serverTitle: "GitHub", root: { org: "acme" }, tools: ["list_pull_requests"], effects: false, revision: REVISION },
  vercel: { server: "mcp.vercel", serverTitle: "Vercel", root: { project: "site" }, tools: ["deploy"], effects: true, revision: REVISION },
};

const { github: GITHUB, vercel: VERCEL } = ASKS;

/** The standup part's own markup, and what it proposes to show everyone. */
const STANDUP = {
  html: `<ul style="margin:0;padding-left:18px;font:13px/1.6 system-ui;color:#1f2937"><li>#412 Health check fails after the binding rename</li><li>#409 Drop the old banner</li></ul>`,
  show: { label: "Your open pull requests, as the team sees them", value: { author: "you", open: [412, 409] } },
};

/** The slate's own page, as its author drew it: three part frames in its layout. `gallery` is this gallery's own address. */
function slatePage(gallery: string): string {
  const frame = (part: string, height: number) => `<section style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;display:flex;flex-direction:column">
    <h2 style="margin:0;padding:8px 12px;font:600 12px system-ui;color:#4a5568;border-bottom:1px solid #eef1f5">${part}</h2>
    <iframe data-slate-part="${part}" src="${gallery}?frame=part-frame&part=${part}&scheme=light" style="border:0;width:100%;flex:1;min-height:${String(height)}px"></iframe>
  </section>`;

  return `<!doctype html><body style="margin:0;padding:16px;background:#f8fafc;font-family:system-ui">
    <h1 style="margin:0 0 12px;font:600 18px system-ui;color:#111827">${TITLE}</h1>
    <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))">${frame("standup", 190)}${frame("deploy", 150)}${frame("team", 150)}</div>
  </body>`;
}

/** Each part's run refused (`part-host-refused`), as the session gate, the workspace and the slate's own code refuse it. */
function refusedRun(part: string): Response {
  if (part === "standup") return Response.json({ error: "No Kinu session in request" }, { status: 401 });

  if (part === "deploy") return Response.json({ error: "The workspace didn't answer in time." }, { status: 503 });

  return Response.json({ kind: "failed", message: "Team board's code failed: digest is not a function." } satisfies PartRunAnswer);
}

/** The slate's page, as the share's host serves it (`?frame=shared-slate-page`), at an address of the gallery's own. */
export const SHARED_SLATE_PAGE = "shared-slate-page";

/** The slate's page as a whole document, for `SHARED_SLATE_PAGE`. */
export function sharedSlateDocument(): string {
  return slatePage(location.origin + location.pathname);
}

/**
 * The share's entry (`LIVE_SHARE_OPEN_PATH`): the slate's page as its host serves it, at an address of the page's own
 * origin, which the share's page frames with its host context as a host's address is. A share that names people answers
 * no one signed out.
 */
function openedShare(frame: string): Response {
  if (frame === "shared-live-signed-out") return Response.json({ error: "Sign in to open this share" }, { status: 401 });

  return Response.json({ url: `${location.origin}${location.pathname}?frame=${SHARED_SLATE_PAGE}`, slate: SLATE, title: TITLE });
}

/** The part routes, answered at the top as the server answers its one viewer. */
export function installPartsFixture(frame: string): void {
  if (!["part-host", "part-host-refused", "shared-live", "shared-live-signed-out", "part-previews"].includes(frame)) return;

  const next = window.fetch.bind(window);
  const consents: SlateConsent[] = [{ workspace: WORKSPACE, slate: SLATE, ...GITHUB, revision: "r1" }];
  const approved = new Set<string>();
  const asked: { path: string; body: string | null }[] = [];
  // Each stopped run is its own: the server names it afresh every time a run stops on a decision.
  let stopped = 0;
  const stop = (part: string) => `run-${part}-${String(stopped += 1)}`;

  const answerFor = (part: string, { action, continuation }: PartRunRequest): PartRunAnswer => {
    if (part === "standup") {
      return consents.some((given) => given.server === GITHUB.server && given.revision === REVISION)
        ? { kind: "shown", revision: REVISION, html: STANDUP.html, actions: [{ id: "refresh", label: "Refresh" }], show: STANDUP.show }
        : { kind: "needs-consent", ask: GITHUB, continuation: stop("standup") };
    }

    if (part === "deploy") {
      const ref = action?.id === "deploy" && typeof action.input === "string" ? action.input : null;

      if (ref === null) {
        return { kind: "shown", revision: REVISION, html: `<p style="margin:0;font:13px system-ui;color:#1f2937">site is on main in production.</p>`, actions: [{ id: "deploy", label: "Deploy", input: { kind: "text", maxLength: 64 } }], show: null };
      }

      if (!consents.some((given) => given.server === VERCEL.server)) return { kind: "needs-consent", ask: VERCEL, continuation: stop("deploy") };

      if (continuation !== null && approved.has("approval-1")) return { kind: "shown", revision: REVISION, html: `<p style="margin:0;font:13px system-ui;color:#166534">Deployed ${ref} to production.</p>`, actions: [], show: null };

      return { kind: "needs-approval", ask: { id: "approval-1", server: VERCEL.server, serverTitle: VERCEL.serverTitle, tool: "deploy", toolTitle: "Create deployment", root: VERCEL.root, payload: { project: "site", target: "production", ref } }, continuation: stop("deploy") };
    }

    return { kind: "stub", reason: "no-part", message: "Sam can turn on My access for this part in the slate's share sheet." };
  };

  // The viewer's decisions: a consent read or given, an effect approved or declined, a showing confirmed.
  const decided = ({ kind, verb, part, method, body }: { kind?: string; verb?: string; part: string; method: string; body: string | null }): Response => {
    if (kind === "consents" && method === "GET") return Response.json({ consents });

    if (kind === "consents") {
      const given = v.parse(v.object({ server: v.string(), revision: v.string() }), JSON.parse(body ?? "{}"));
      const ask = given.server === GITHUB.server ? GITHUB : VERCEL;

      consents.push({ workspace: WORKSPACE, slate: SLATE, ...ask });

      return new Response(null, { status: 204 });
    }

    if (kind === "approvals") {
      if (v.parse(v.object({ decision: v.string() }), JSON.parse(body ?? "{}")).decision === "approve") approved.add(part);

      return new Response(null, { status: 204 });
    }

    if (kind === "parts" && (verb === "show" || verb === "release")) return new Response(null, { status: 204 });

    return Response.json({ error: "No such route." }, { status: 404 });
  };

  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const [, api, area, workspace, slate, kind, part, verb] = url.pathname.split("/");

    if (url.pathname === LIVE_SHARE_OPEN_PATH) return openedShare(frame);

    if (api !== "api" || area !== "slates" || workspace !== WORKSPACE || decodeURIComponent(slate ?? "") !== SLATE) return next(input, init);

    const body = request.method === "POST" ? await request.clone().text() : null;

    asked.push({ path: url.pathname, body });
    document.documentElement.setAttribute("data-gallery-asked", JSON.stringify(asked));

    if (kind === "parts" && verb === "run" && frame === "part-host-refused") return refusedRun(decodeURIComponent(part ?? ""));

    if (kind === "parts" && verb === "run") {
      return Response.json(answerFor(decodeURIComponent(part ?? ""), v.parse(PartRunRequestSchema, JSON.parse(body ?? "{}"))));
    }

    return decided({ kind, verb, part: decodeURIComponent(part ?? ""), method: request.method, body });
  }, { preconnect: window.fetch.preconnect });
}

/**
 * The share dialog's mode switch and Gallery listing (`sharedialog`), answered as the routes do: each answers the share as
 * it now is, and a share on the owner's access is refused a listing. A standing approval taken back answers the rest of
 * `standing`, and what was sent is on the root for a test to read. `shown` and `standing` are read at the first call, as
 * the gallery defines them further down.
 */
export function installShareModeFixture(frame: string, shown: () => OwnedLiveShare, standing: () => readonly SharePreapproval[]): void {
  if (frame !== "sharedialog" && frame !== "sharedialog-first") return;

  const next = window.fetch.bind(window);
  let share: OwnedLiveShare | null = null;
  let left: readonly SharePreapproval[] | null = null;

  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;

    // A new share: what the sheet sent is on the root for a test to read, and an empty copy is shared as the fork.
    if (path === "/api/shared/live" && request.method === "POST") {
      const body = v.parse(LiveShareBodySchema, await request.json());

      document.documentElement.setAttribute("data-gallery-shared", JSON.stringify(body));

      const made: OwnedLiveShare = { ...shown(), id: "live-new", slate: body.start === "empty" ? `${body.slate}-copy` : body.slate, mode: body.mode ?? "own", grantRevision: body.revision ?? null, stale: false, gallery: null };

      return Response.json({ share: made, url: `https://${made.slate}.example.kinu.run/` });
    }

    if (path === LIVE_SHARE_PREAPPROVAL_WITHDRAW_PATH) {
      const { slate, entry } = v.parse(SlatePreapprovalWithdrawSchema, await request.json());

      document.documentElement.setAttribute("data-gallery-withdrawn", JSON.stringify(entry));
      left = (left ?? standing()).filter((each) => JSON.stringify([each.slate, each.namespace, each.member, each.root]) !== JSON.stringify([entry.slate, entry.namespace, entry.member, entry.root]));

      return Response.json({ slate, revision: "r2", preapproved: [...left] } satisfies SlatePreapprovals);
    }

    if (path !== LIVE_SHARE_MODE_PATH && path !== LIVE_SHARE_LISTING_PATH) return next(input, init);

    const was = share ?? shown();

    if (path === LIVE_SHARE_MODE_PATH) {
      const body = v.parse(LiveShareModeBodySchema, await request.json());

      share = body.mode === "own" ? { ...was, mode: "own", grantRevision: null, stale: false } : { ...was, mode: "owner", grantRevision: body.revision, stale: false };

      return Response.json(share);
    }

    const body = v.parse(LiveShareListingBodySchema, await request.json());

    if (body.listed && was.mode === "owner") return Response.json({ error: "A share on your access is never listed in the Gallery" }, { status: 400 });

    share = { ...was, gallery: body.listed ? { line: body.line, category: body.category } : null };

    return Response.json(share);
  }, { preconnect: window.fetch.preconnect });
}

/** An app page hosting the slate's page, as the share's page and the owner's previews do. */
export function PartHostFrame() {
  const slateFrame = useRef<HTMLIFrameElement | null>(null);
  const decision = usePartHost({ workspace: WORKSPACE, slate: SLATE, title: TITLE, slateFrame });

  return (
    <div className="flex h-dvh flex-col p-bg">
      <iframe ref={slateFrame} title={TITLE} srcDoc={slatePage(location.origin + location.pathname)} data-slate-page className="block min-h-0 w-full flex-1 border-0" />
      {decision}
    </div>
  );
}

/** The share's page, at the share's address. */
export function SharedLiveFrame() {
  return (
    <Routes>
      <Route path={APP_ROUTES.sharedLive} element={<LiveSharePage />} />
    </Routes>
  );
}

export const SHARED_LIVE_ENTRY = `/shared/live/${WORKSPACE}/share-1`;

/** The workspace's previews ask where the slate's page is served; its preview host answers there. */
const previewRpc = answeringRpc({ previewSlate: () => ({ ok: true, value: { url: SLATE_GALLERY_URL, port: 8789, sized: false } }) });

/** The owner's own previews of the slate, in its workspace: in the column, and in an answer in the chat. */
export function PartPreviewsFrame() {
  return (
    <Routes>
      <Route path={APP_ROUTES.workspace} element={
        <SlateInlineContext.Provider value={{ rpc: previewRpc }}>
          <div className="grid h-dvh grid-cols-2 gap-4 p-bg p-4 p-text">
            <section data-slate-preview-display="pane" className="flex min-h-0 flex-col">
              <InlineSlate id={SLATE} rpc={previewRpc} display="pane" />
            </section>
            <section data-slate-preview-display="inline" className="min-h-0 overflow-y-auto t-body">
              <p>Here is the board.<span className="block my-2"><InlineSlate id={SLATE} rpc={previewRpc} display="inline" /></span></p>
            </section>
          </div>
        </SlateInlineContext.Provider>
      } />
    </Routes>
  );
}

export const PART_PREVIEWS_ENTRY = `/workspace/${WORKSPACE}`;

/** One part frame, at its route as the slate's page addresses it. */
export function PartFrameFrame() {
  return (
    <Routes>
      <Route path={APP_ROUTES.liveSlatePart} element={<PartFramePage />} />
    </Routes>
  );
}

/** The part frame's address, as the slate's page writes it (`slatePartFramePath`). */
export function partFrameEntry(search: URLSearchParams): string {
  return slatePartFramePath(WORKSPACE, SLATE, search.get("part") ?? "standup", []) + (search.has("scheme") ? `&scheme=${search.get("scheme") ?? ""}` : "");
}

/** Every state a personal part shows its viewer, side by side, as the slate's page frames each (`part-states`). */
const STATES: readonly { name: string; answer: PartRunAnswer }[] = [
  { name: "Asks to use a connection", answer: { kind: "needs-consent", ask: GITHUB, continuation: "run-1" } },
  { name: "Shown, with its own controls", answer: { kind: "shown", revision: REVISION, html: STANDUP.html, actions: [{ id: "refresh", label: "Refresh" }], show: STANDUP.show } },
  { name: "An effect waits for approval", answer: { kind: "needs-approval", ask: { id: "approval-1", server: VERCEL.server, serverTitle: VERCEL.serverTitle, tool: "deploy", toolTitle: "Create deployment", root: VERCEL.root, payload: { project: "site", target: "production" } }, continuation: "run-1" } },
  { name: "Signed out", answer: { kind: "stub", reason: "signed-out", message: "Sign in to see your own part of Team board." } },
  { name: "Not shared with this person", answer: { kind: "stub", reason: "no-part", message: "Sam can turn on My access for this part in the slate's share sheet." } },
  { name: "Its run failed", answer: { kind: "failed", message: "GitHub didn't answer in time. Your token is fine; try again." } },
];

export function PartStatesFrame() {
  const controls = { act: () => undefined, decide: () => undefined, signIn: () => undefined, retry: () => undefined };

  return (
    <div className="min-h-dvh p-bg p-6">
      <div className="mx-auto grid max-w-5xl gap-4 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
        {STATES.map((state) => (
          <section key={state.name} data-part-state={state.answer.kind} className="flex flex-col overflow-hidden rounded-xl border p-border p-surface">
            <h2 className="border-b p-border px-3 py-2 t-status p-text-2">{state.name}</h2>
            <div className="flex h-56 flex-col gap-1.5 p-3 p-text">
              <SealedContent html={shownMarkup(state.answer)} />
              <PartView answer={state.answer} slate={TITLE} controls={controls} />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
