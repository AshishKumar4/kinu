/**
 * Personal parts in the gallery (docs/SLATE-SHARING-NIMBUS.md §3): `part-host` is an app page hosting a slate's page,
 * itself framing three part frames (`part-frame&part=<part>`), as a share or the owner's preview does. The part routes
 * answer here, at the top, as the server would for one signed-in viewer:
 *
 * - `standup` asks to use the viewer's GitHub, then shows their open pull requests, with a refresh and a "Show to
 *   everyone" the viewer can confirm. Its consent was given for an earlier revision of the code, so it says it changed.
 * - `deploy` shows a deploy button whose run asks the viewer to approve one effect, with its payload, then shows done.
 * - `team` is a part the slate does not declare for this share: a stub that says what to do.
 *
 * What the page asked is on the root for a test to read; the slate's page is drawn here, as its own author would.
 */
import { useRef } from "react";
import { Route, Routes } from "react-router-dom";
import * as v from "valibot";
import {
  APP_ROUTES, PartRunRequestSchema, slatePartFramePath, type PartRunAnswer, type SlateConsent,
} from "@kinu.run/core";
import { usePartHost } from "@/hooks/use-part-host";
import PartFramePage from "@/pages/PartFramePage";

/** The slate's address and the revision of its code now. */
const SLATE_AT = { workspace: "sam-ops", slate: "team-board", title: "Team board", revision: "r2" } as const;

const { workspace: WORKSPACE, slate: SLATE, title: TITLE, revision: REVISION } = SLATE_AT;

/** What each part asks of the viewer's grants, at this revision. */
const ASKS = {
  github: { server: "mcp.github", root: { org: "acme" }, tools: ["list_pull_requests"], effects: false, revision: REVISION },
  vercel: { server: "mcp.vercel", root: { project: "site" }, tools: ["deploy"], effects: true, revision: REVISION },
};

const { github: GITHUB, vercel: VERCEL } = ASKS;

/** The standup part's own markup, and what it proposes to show everyone. */
const STANDUP = {
  html: `<ul style="margin:0;padding-left:18px;font:13px/1.6 system-ui;color:#1f2937"><li>#412 Fix checkout rounding</li><li>#409 Drop the old banner</li></ul>`,
  show: { label: "Your open pull requests, as the team sees them", value: { author: "you", open: [412, 409] } },
};

/** The slate's own page, as its author drew it: three part frames in its layout. */
function slatePage(origin: string): string {
  const frame = (part: string, height: number) => `<section style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;display:flex;flex-direction:column">
    <h2 style="margin:0;padding:8px 12px;font:600 12px system-ui;color:#4a5568;border-bottom:1px solid #eef1f5">${part}</h2>
    <iframe data-slate-part="${part}" src="${origin}/gallery.html?frame=part-frame&part=${part}&scheme=light" style="border:0;width:100%;flex:1;min-height:${String(height)}px"></iframe>
  </section>`;

  return `<!doctype html><body style="margin:0;padding:16px;background:#f8fafc;font-family:system-ui">
    <h1 style="margin:0 0 12px;font:600 18px system-ui;color:#111827">${TITLE}</h1>
    <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))">${frame("standup", 190)}${frame("deploy", 150)}${frame("team", 150)}</div>
  </body>`;
}

/** The part routes, answered at the top as the server answers its one viewer. */
export function installPartsFixture(frame: string): void {
  if (frame !== "part-host") return;

  const next = window.fetch.bind(window);
  const consents: SlateConsent[] = [{ workspace: WORKSPACE, slate: SLATE, ...GITHUB, revision: "r1" }];
  const approved = new Set<string>();
  const asked: { path: string; body: string | null }[] = [];

  const answerFor = (part: string, approval: string | null): PartRunAnswer => {
    if (part === "standup") {
      return consents.some((given) => given.server === GITHUB.server && given.revision === REVISION)
        ? { kind: "shown", revision: REVISION, html: STANDUP.html, actions: [{ id: "refresh", label: "Refresh" }], show: STANDUP.show }
        : { kind: "needs-consent", ask: GITHUB };
    }

    if (part === "deploy") {
      if (!consents.some((given) => given.server === VERCEL.server)) return { kind: "needs-consent", ask: VERCEL };

      if (approval !== null && approved.has(approval)) return { kind: "shown", revision: REVISION, html: `<p style="margin:0;font:13px system-ui;color:#166534">Deployed site to production.</p>`, actions: [], show: null };

      return { kind: "needs-approval", ask: { id: "approval-1", server: VERCEL.server, tool: "deploy", root: VERCEL.root, payload: { project: "site", target: "production", ref: "main" } } };
    }

    return { kind: "stub", reason: "no-part", message: "Sam can turn on My access for this part in the slate's share sheet." };
  };

  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const [, api, area, workspace, slate, kind, part, verb] = url.pathname.split("/");

    if (api !== "api" || area !== "slates" || workspace !== WORKSPACE || decodeURIComponent(slate ?? "") !== SLATE) return next(input, init);

    const body = request.method === "POST" ? await request.clone().text() : null;

    asked.push({ path: url.pathname, body });
    document.documentElement.setAttribute("data-gallery-asked", JSON.stringify(asked));

    if (kind === "parts" && verb === "run") {
      const run = v.parse(PartRunRequestSchema, JSON.parse(body ?? "{}"));

      return Response.json(answerFor(decodeURIComponent(part ?? ""), run.approval));
    }

    if (kind === "consents" && request.method === "GET") return Response.json({ consents });

    if (kind === "consents") {
      const given = v.parse(v.object({ server: v.string(), revision: v.string() }), JSON.parse(body ?? "{}"));
      const ask = given.server === GITHUB.server ? GITHUB : VERCEL;

      consents.push({ workspace: WORKSPACE, slate: SLATE, ...ask });

      return new Response(null, { status: 204 });
    }

    if (kind === "approvals") {
      if (v.parse(v.object({ decision: v.string() }), JSON.parse(body ?? "{}")).decision === "approve") approved.add(decodeURIComponent(part ?? ""));

      return new Response(null, { status: 204 });
    }

    if (kind === "parts" && verb === "show") return new Response(null, { status: 204 });

    return Response.json({ error: "No such route." }, { status: 404 });
  }, { preconnect: window.fetch.preconnect });
}

/** An app page hosting the slate's page, as the share's page and the owner's previews do. */
export function PartHostFrame() {
  const slateFrame = useRef<HTMLIFrameElement | null>(null);
  const decision = usePartHost({ workspace: WORKSPACE, slate: SLATE, title: TITLE, slateFrame });

  return (
    <div className="flex h-dvh flex-col p-bg">
      <iframe ref={slateFrame} title={TITLE} srcDoc={slatePage(location.origin)} data-slate-page className="block min-h-0 w-full flex-1 border-0" />
      {decision}
    </div>
  );
}

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
