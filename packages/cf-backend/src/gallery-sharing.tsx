/**
 * Gallery frames for sharing (docs/SLATE-SHARING-SECURITY.md §6, the v7 states), drawn by the real live page, part
 * frames and share sheet over a typed fake room: its socket pushes a fixture `RoomView` and applies each call to it as
 * the room would, so every control works.
 *
 * `frame=room&state=<state>`: the live page as one person sees it. `frame=room-slate&scene=<scene>`: the slate's own page,
 * which embeds its parts. `frame=room-part&part=<key>`: one part's frame. `frame=room-closed&state=<closed>`: the page a
 * closed room shows.
 */
import { useLocation, useSearchParams } from "react-router-dom";
import * as v from "valibot";
import { RoomClientFrameSchema } from "@kinu.run/core";
import type {
  ForkPreview, PartView, RoomAccess, RoomAsk, RoomCall, RoomEnded, RoomEntry, RoomPerson, RoomReach, RoomServerFrame, RoomSource, RoomView, SheetView,
  WorkspaceEntry,
} from "@kinu.run/core";
import { FilledButton } from "@/components/ui/FilledButton";
import type { RoomLive, RoomSocket } from "@/hooks/use-room";
import { CLOSED, Closed, LiveSlate, type LiveOpened } from "@/pages/LiveSlatePage";
import { PartFrame, useSlateScheme } from "@/pages/PartFramePage";

// ── People, sources and reaches ─────────────────────────────────────────────────────────────────────────────────

const SAM: RoomPerson = { email: "sam@acme.dev", name: "Sam Rivera" };

const BEN: RoomPerson = { email: "ben@acme.dev", name: "Ben Ito" };

const ALICE: RoomPerson = { email: "alice@acme.dev", name: "Alice Chen" };

const CHLOE: RoomPerson = { email: "chloe@acme.dev", name: "Chloe Park" };

const BOB: RoomPerson = { email: "bob@outside.io", name: "Bob Reyes" };

const DANA: RoomPerson = { email: "dana@acme.dev", name: null };

const GITHUB = { title: "GitHub", kind: "github" } as const;

const WORKSPACE_FILES = { title: "Sam's workspace", kind: "workspace" } as const;

const METRICS = { title: "acme-metrics", kind: "mcp" } as const;

const SAM_NOTES: RoomSource = { holder: SAM, service: WORKSPACE_FILES, scope: "notes.md", label: "notes.md", checkable: false };

const ALICE_REPO: RoomSource = { holder: ALICE, service: GITHUB, scope: "acme/secret", label: "acme/secret", checkable: false };

const SAM_METRICS: RoomSource = { holder: SAM, service: METRICS, scope: "deploys", label: "acme-metrics", checkable: false };

const READ_PRS: RoomReach = { service: GITHUB, tools: [{ name: "list_pull_requests", title: "List pull requests", readOnly: true }], scope: null, effect: false };

const READ_LINEAR: RoomReach = {
  service: { title: "Linear", kind: "mcp" }, tools: [{ name: "list_issues", title: "List issues", readOnly: true }], scope: null, effect: false,
};

const READ_DEPLOYS: RoomReach = { service: METRICS, tools: [{ name: "deploys", title: "Deploys", readOnly: true }], scope: "deploys", effect: false };

const START_JOB: RoomReach = {
  service: { title: "acme-ci", kind: "mcp" }, tools: [{ name: "start_job", title: "Start deploy job", readOnly: false }], scope: null, effect: true,
};

// ── What the parts hold, as their script-free frames render it ───────────────────────────────────────────────

/** A page of static HTML for a part's sealed frame: what the room would serve at `content`. */
const sealed = (body: string) => `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><meta charset="utf-8"><body style="margin:0;font:13px/1.45 system-ui,sans-serif;color:#1f2937;background:#fff">${body}</body>`,
)}`;

const CONTENT = {
  prs: sealed(`<ul style="list-style:none;margin:0;padding:0">${["Fix coupon rounding on checkout", "Cache the cart's tax lookup", "Retry a declined card once", "Move prices to integer cents"]
    .map((row) => `<li style="padding:8px 10px;border-bottom:1px solid #eef1f5">${row}</li>`).join("")}</ul>`),
  notes: sealed(`<ul style="margin:0;padding:8px 10px 8px 26px"><li>Ship the coupon fix before Friday's sale.</li><li>Prices move to cents next sprint.</li></ul>`),
  blocker: sealed(`<p style="margin:0;padding:8px 10px;font-weight:600">Rotate the payments key before the sale</p>`),
  issues: sealed(`<ul style="list-style:none;margin:0;padding:0">${["Checkout rounds coupons down", "Promo banner flickers on Safari", "Retry declined cards once"]
    .map((row) => `<li style="padding:8px 10px;border-bottom:1px solid #eef1f5">${row}</li>`).join("")}</ul>`),
  deploys: sealed(`<div style="display:flex;align-items:flex-end;gap:10px;height:120px;padding:10px">${[["Mon", 4], ["Tue", 7], ["Wed", 3], ["Thu", 9], ["Fri", 5]]
    .map(([day, count]) => `<div style="flex:1;text-align:center"><div style="height:${String(Number(count) * 11)}px;background:#5f9b6b;border-radius:3px 3px 0 0"></div><div style="font-size:11px;color:#6b7280">${String(day)}</div></div>`).join("")}</div>`),
};

// ── The two slates ──────────────────────────────────────────────────────────────────────────────────────────

type Scene = "pr-board" | "release";

const SCENES: Record<Scene, { readonly title: string; readonly heading: string; readonly parts: readonly { readonly key: string; readonly label: string; readonly height: number }[] }> = {
  "pr-board": {
    title: "PR review board",
    heading: "Reviews · acme/storefront",
    parts: [{ key: "prs", label: "Your pull requests", height: 230 }, { key: "notes", label: "Notes", height: 120 }, { key: "blocker", label: "Blockers", height: 120 }],
  },
  release: {
    title: "Release dashboard",
    heading: "Release · this week",
    parts: [{ key: "issues", label: "Open issues", height: 230 }, { key: "deploys", label: "Deploy metrics", height: 230 }],
  },
};

/** Each part as the person who can see it sees it. */
const SEEN = new Map<string, PartView>([
  ["prs", { state: "shown", key: "prs", fn: "listPullRequests", from: [], content: CONTENT.prs }],
  ["notes", { state: "shown", key: "notes", fn: "readNotes", from: [], content: CONTENT.notes }],
  ["blocker", { state: "shown", key: "blocker", fn: "rotateBlocker", from: [ALICE_REPO], content: CONTENT.blocker }],
  ["issues", { state: "shown", key: "issues", fn: "listIssues", from: [], content: CONTENT.issues }],
  ["deploys", { state: "shown", key: "deploys", fn: "weeklyDeploys", from: [], content: CONTENT.deploys }],
]);

const placeholder = (key: string, fn: string, sources: RoomSource[], asked = false): PartView => ({ state: "placeholder", key, fn, sources, asked });

// ── The states ──────────────────────────────────────────────────────────────────────────────────────────────

interface RoomState {
  readonly scene: Scene;
  /** Null: signed out, by the link. */
  readonly me: RoomPerson | null;
  readonly access: RoomAccess;
  readonly parts?: Partial<Readonly<Record<string, PartView>>>;
  readonly asks?: readonly RoomAsk[];
  readonly ended?: RoomEnded;
  /** The owner's sheet, as the room keeps it. */
  readonly sheet?: SheetView;
  readonly opened?: LiveOpened;
}

const PEOPLE = [{ person: BEN, role: "edit" }, { person: ALICE, role: "edit" }, { person: CHLOE, role: "use" }, { person: DANA, role: "use" }] as const;

const SHEET: SheetView = {
  audience: "people", url: "https://kinu.run/s/acme/pr-board?k=k4m2xq", people: [...PEOPLE], privateOf: [ALICE], listing: null, lends: [], uses: [], secret: null,
};

const LENDS: SheetView = {
  ...SHEET,
  audience: "anyone",
  people: [],
  privateOf: [],
  lends: [
    { fn: "weeklyDeploys", reach: READ_DEPLOYS, free: false, shown: "everyone", on: true, suspendedBy: null },
    { fn: "searchNotes", reach: { ...READ_DEPLOYS, scope: "deploy notes", tools: [{ name: "search", title: "Search notes", readOnly: true }] }, free: true, shown: "holder", on: true, suspendedBy: null },
    { fn: "startDeployJob", reach: START_JOB, free: false, shown: "everyone", on: true, suspendedBy: null },
  ],
  uses: [
    { fn: "weeklyDeploys", person: BEN, calls: 14, lastAt: Date.now() - 2 * 3_600_000 },
    { fn: "searchNotes", person: CHLOE, calls: 3, lastAt: Date.now() - 26 * 3_600_000 },
    { fn: "startDeployJob", person: BOB, calls: 1, lastAt: Date.now() - 5 * 60_000 },
  ],
};

const STATES = new Map<string, RoomState>([
  // Ben, added with Edit: the board as it is used, together.
  ["live", { scene: "pr-board", me: BEN, access: "edit" }],
  // Chloe, added with Use, before her GitHub is connected; then with it connected but not yet allowed here.
  ["live-connect", { scene: "pr-board", me: CHLOE, access: "use", parts: { prs: { state: "needs-connection", key: "prs", fn: "listPullRequests", reach: READ_PRS, connected: false } } }],
  ["live-grant", {
    scene: "release", me: CHLOE, access: "link",
    parts: { issues: { state: "needs-connection", key: "issues", fn: "listIssues", reach: READ_LINEAR, connected: true } },
    opened: { decide: { kind: "allow", part: "issues" } },
  }],
  // Alice, whose own private card the board holds; then choosing whom to show it to.
  ["live-mine", { scene: "pr-board", me: ALICE, access: "edit", parts: { blocker: { state: "mine", key: "blocker", fn: "rotateBlocker", source: ALICE_REPO, shownTo: "me", content: CONTENT.blocker } } }],
  ["live-show", {
    scene: "pr-board", me: ALICE, access: "edit",
    parts: { blocker: { state: "mine", key: "blocker", fn: "rotateBlocker", source: ALICE_REPO, shownTo: "me", content: CONTENT.blocker } },
    opened: { decide: { kind: "show", part: "blocker" } },
  }],
  // Bob, by the link, who can read neither Alice's repository nor Sam's notes.
  ["live-source", {
    scene: "pr-board", me: BOB, access: "link",
    parts: { notes: placeholder("notes", "readNotes", [SAM_NOTES], true), blocker: placeholder("blocker", "rotateBlocker", [{ ...ALICE_REPO, checkable: true }]) },
  }],
  // Alice, after Ben changed her part; then using it again.
  ["live-edited", { scene: "pr-board", me: ALICE, access: "edit", parts: { prs: { state: "edited", key: "prs", fn: "listPullRequests", editor: BEN, reach: READ_PRS } } }],
  ["live-use-again", {
    scene: "pr-board", me: ALICE, access: "edit",
    parts: { prs: { state: "edited", key: "prs", fn: "listPullRequests", editor: BEN, reach: READ_PRS } },
    opened: { decide: { kind: "allow", part: "prs" } },
  }],
  // Someone signed out, by the link: everything they may see, and sign-in where they act.
  ["live-signed-out", {
    scene: "pr-board", me: null, access: "link",
    parts: { prs: { state: "needs-sign-in", key: "prs", fn: "listPullRequests" }, notes: placeholder("notes", "readNotes", [SAM_NOTES]), blocker: placeholder("blocker", "rotateBlocker", [ALICE_REPO]) },
  }],
  ["live-removed", { scene: "pr-board", me: BEN, access: "edit", ended: { kind: "removed", by: SAM } }],
  ["live-stopped", { scene: "pr-board", me: CHLOE, access: "link", ended: { kind: "stopped", by: SAM } }],
  // The release dashboard: Linear is each person's own, deploys Sam's lend.
  ["live-lent", { scene: "release", me: CHLOE, access: "link", parts: { issues: { state: "needs-connection", key: "issues", fn: "listIssues", reach: READ_LINEAR, connected: false } } }],
  ["live-lent-connected", { scene: "release", me: CHLOE, access: "link" }],
  ["live-lent-signed-out", { scene: "release", me: null, access: "link", parts: { issues: { state: "needs-sign-in", key: "issues", fn: "listIssues" } } }],
  ["live-lent-private", { scene: "release", me: CHLOE, access: "link", parts: { deploys: placeholder("deploys", "weeklyDeploys", [SAM_METRICS]) } }],
  ["live-lent-edited", { scene: "release", me: CHLOE, access: "link", parts: { deploys: { state: "waiting", key: "deploys", fn: "weeklyDeploys", holder: SAM } } }],
  // Sam's decisions, asked of him as the holder.
  ["live-decide", {
    scene: "release", me: SAM, access: "owner", sheet: LENDS,
    asks: [{ kind: "show", id: "ask-show", from: BOB, part: { key: "deploys", fn: "weeklyDeploys" }, source: SAM_METRICS }],
  }],
  ["live-effect", {
    scene: "release", me: SAM, access: "owner", sheet: LENDS,
    asks: [{ kind: "effect", id: "ask-effect", from: BEN, fn: "startDeployJob", service: START_JOB.service, tool: { name: "start_job", title: "Start deploy job", readOnly: false }, scope: null, argument: "week 41" }],
  }],
  ["live-lend", {
    scene: "release", me: SAM, access: "owner", sheet: LENDS,
    asks: [{ kind: "lend", id: "ask-lend", from: CHLOE, fn: "weeklyDeploys", editor: BEN }],
  }],
  ["live-outflow", {
    scene: "pr-board", me: ALICE, access: "edit",
    asks: [{
      kind: "outflow", id: "ask-outflow", fn: "mailBlocker", source: ALICE_REPO, service: { title: "Gmail", kind: "mcp" },
      tool: { name: "send", title: "Send mail", readOnly: false }, argument: "to bob@acme.dev",
    }],
  }],
  // The owner's sheet: the people; the link with private items and the Gallery; the lends; a key in the code.
  ["sheet", { scene: "pr-board", me: SAM, access: "owner", sheet: SHEET, opened: { sheet: true } }],
  ["sheet-link", { scene: "pr-board", me: SAM, access: "owner", sheet: { ...SHEET, audience: "anyone", privateOf: [ALICE, BEN] }, opened: { sheet: true } }],
  ["sheet-listed", { scene: "pr-board", me: SAM, access: "owner", sheet: { ...SHEET, audience: "anyone", listing: { line: "Every pull request waiting on you.", category: "developer" } }, opened: { sheet: true } }],
  ["sheet-lends", { scene: "release", me: SAM, access: "owner", sheet: LENDS, opened: { sheet: true } }],
  ["sheet-widened", {
    scene: "release", me: SAM, access: "owner",
    sheet: { ...LENDS, lends: LENDS.lends.map((lend) => (lend.fn === "searchNotes" ? { ...lend, on: false, suspendedBy: BEN } : lend)) },
    opened: { sheet: true },
  }],
  ["sheet-secret", {
    scene: "release", me: SAM, access: "owner", sheet: { ...SHEET, audience: "only-you", url: null, people: [], privateOf: [], secret: { file: "server.ts", line: 12, kind: "API key" } },
    opened: { sheet: true },
  }],
  ["sheet-only", { scene: "pr-board", me: SAM, access: "owner", sheet: { ...SHEET, audience: "only-you", url: null, people: [], privateOf: [] }, opened: { sheet: true } }],
  // Fork, and an editor's Edit.
  ["fork", { scene: "release", me: CHLOE, access: "link", opened: { pick: "fork" } }],
  ["edit", { scene: "pr-board", me: BEN, access: "edit", opened: { pick: "edit" } }],
]);

const LIVE: RoomState = { scene: "pr-board", me: BEN, access: "edit" };

const stateOf = (name: string | null): RoomState => STATES.get(name ?? "live") ?? LIVE;

/** Who is here besides the session's own person, as presence carries them. */
function presenceOf(state: RoomState): RoomView["presence"] {
  const here = [SAM, BEN, ALICE, CHLOE].filter((person) => person.email !== state.me?.email);

  return {
    here: [...(state.me === null ? [] : [{ person: state.me, where: null, typing: null }]), ...here.map((person) => ({ person, where: null, typing: null }))],
    signedOut: 3,
  };
}

function viewOf(state: RoomState): RoomView {
  const scene = SCENES[state.scene];
  const parts = Object.fromEntries(scene.parts.map(({ key }): [string, PartView] => [key, state.parts?.[key] ?? SEEN.get(key) ?? { state: "running", key, fn: key }]));

  return {
    session: {
      me: state.me,
      access: state.access,
      title: scene.title,
      owner: SAM,
      members: state.access === "link" ? [] : [SAM, ...PEOPLE.map(({ person }) => person)],
      mayEdit: state.access === "owner" || state.access === "edit",
      mayFork: state.me !== null,
      frame: `/gallery.html?frame=room-slate&scene=${state.scene}`,
    },
    presence: presenceOf(state),
    parts,
    asks: [...(state.asks ?? [])],
    ended: state.ended ?? null,
    sheet: state.access === "owner" ? (state.sheet ?? SHEET) : null,
  };
}

// ── The fake room: answers each call as the room would, then pushes the next view ──────────────────────────

/** A part shown once its person allowed, checked or was shown it: what its sealed frame then holds. */
const opened = (part: PartView): PartView => SEEN.get(part.key) ?? part;

function applied(view: RoomView, call: RoomCall): RoomView {
  const part = "part" in call ? view.parts[call.part] : undefined;
  const withPart = (next: PartView) => ({ ...view, parts: { ...view.parts, [next.key]: next } });
  const sheet = view.sheet;
  const withSheet = (next: Partial<SheetView>) => (sheet === null ? view : { ...view, sheet: { ...sheet, ...next } });
  const without = (ask: string) => ({ ...view, asks: view.asks.filter((each) => each.id !== ask) });

  switch (call.op) {
    case "setAudience": return withSheet({ audience: call.audience, url: call.audience === "only-you" ? null : SHEET.url });
    case "invite": return withSheet({ people: [...(sheet?.people ?? []), { person: { email: call.email, name: null }, role: call.role }] });
    case "setRole": return withSheet({ people: (sheet?.people ?? []).map((each) => (each.person.email === call.email ? { ...each, role: call.role } : each)) });
    case "remove": return withSheet({ people: (sheet?.people ?? []).filter((each) => each.person.email !== call.email), uses: (sheet?.uses ?? []).filter((use) => use.person.email !== call.email) });
    case "list": return withSheet({ listing: { line: call.line, category: call.category } });
    case "unlist": return withSheet({ listing: null });
    case "setLend": return withSheet({ lends: (sheet?.lends ?? []).map((lend) => (lend.fn === call.fn ? { ...lend, on: call.on, suspendedBy: call.on ? null : lend.suspendedBy } : lend)) });
    case "setLendShown": return withSheet({ lends: (sheet?.lends ?? []).map((lend) => (lend.fn === call.fn ? { ...lend, shown: call.shown } : lend)) });
    case "ask": return part?.state === "placeholder" ? withPart({ ...part, asked: true }) : view;
    case "allow":
    case "check": return part === undefined ? view : withPart(opened(part));
    case "show": return part?.state === "mine" ? withPart({ ...part, shownTo: call.scope }) : view;
    case "unshow": return part?.state === "mine" ? withPart({ ...part, shownTo: "me" }) : view;
    case "showTo":
    case "showToMembers":
    case "approve":
    case "send":
    case "decline": return without(call.ask);
    case "open":
    case "here":
    case "leave": return view;
  }
}

/** A socket that is the room: its first view after it opens, each call answered and its effect pushed. */
class FakeRoomSocket extends EventTarget implements RoomSocket {
  private view: RoomView;
  private closed = false;

  constructor(view: RoomView) {
    super();
    this.view = view;
    queueMicrotask(() => {
      if (this.closed) return;

      this.dispatchEvent(new Event("open"));
      this.push({ view: this.view });
    });
  }

  send(data: string): void {
    const frame = v.safeParse(RoomClientFrameSchema, JSON.parse(data));

    if (!frame.success) return;

    this.view = applied(this.view, frame.output.call);
    this.push({ id: frame.output.id, ok: true });
    this.push({ view: this.view });
  }

  close(): void {
    this.closed = true;
  }

  private push(frame: RoomServerFrame): void {
    queueMicrotask(() => { if (!this.closed) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) })); });
  }
}

const fakeLive = (state: RoomState): RoomLive => () => new FakeRoomSocket(viewOf(state));

const ROSTER: readonly WorkspaceEntry[] = [
  { name: "storefront", displayName: "Storefront", createdAt: 1_760_000_000_000, lastVisited: 1_760_400_000_000 },
  { name: "ops-board", displayName: "Ops board", createdAt: 1_760_100_000_000, lastVisited: 1_760_300_000_000 },
];

const FORK_PREVIEW: ForkPreview = {
  title: "Release dashboard",
  owner: SAM,
  parts: [{ fn: "listIssues", lent: false, needs: { title: "Linear", kind: "mcp" } }, { fn: "weeklyDeploys", lent: true, needs: null }],
};

/** Answers the room's HTTP routes in the gallery: its entry, and its fork's preview. */
export function installRoomFixture(frame: string): void {
  if (!frame.startsWith("room")) return;

  const next = window.fetch.bind(window);

  window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(new Request(input, init).url).pathname;

    if (path.startsWith("/api/rooms/") && path.endsWith("/fork")) return Promise.resolve(Response.json(FORK_PREVIEW));

    if (path.startsWith("/api/rooms/") && path.endsWith("/entry")) {
      const entry: RoomEntry = { title: SCENES[stateOf(new URLSearchParams(location.search).get("state")).scene].title, owner: SAM, access: "edit" };

      return Promise.resolve(Response.json(entry));
    }

    return next(input, init);
  }, { preconnect: next.preconnect });
}

// ── The frames ──────────────────────────────────────────────────────────────────────────────────────────────

export function RoomFrame() {
  const [search] = useSearchParams();
  const location = useLocation();
  const state = stateOf(search.get("state"));
  const scene = SCENES[state.scene];

  // Where a control took the app, and what it carried there: the frame's tests read it.
  if (location.pathname !== "/") {
    const opening = v.safeParse(v.object({ opening: v.string() }), location.state);

    return <div data-gallery-landed={location.pathname} data-gallery-opening={opening.success ? opening.output.opening : undefined} />;
  }

  return (
    <LiveSlate room={{ workspace: "acme", slate: state.scene }} entry={{ title: scene.title, owner: SAM, access: state.access }} linkKey={null}
      live={fakeLive(state)} opened={state.opened} workspaces={ROSTER} />
  );
}

/** The slate's own page: its own look, light in either theme, with its parts' frames where it puts them. */
export function RoomSlateFrame() {
  const [search] = useSearchParams();
  const scene = SCENES[search.get("scene") === "release" ? "release" : "pr-board"];

  return (
    <div className="min-h-screen bg-white p-5 text-[#1f2937] sm:p-8" data-mode="light">
      <h1 className="text-[17px] font-bold">{scene.heading}</h1>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {scene.parts.map((part) => (
          <section key={part.key} className="overflow-hidden rounded-lg border border-[#e5e7eb]">
            <h2 className="border-b border-[#eef1f5] px-3 py-2 text-xs font-bold text-[#4a5568]">{part.label}</h2>
            <iframe src={`/gallery.html?frame=room-part&part=${part.key}&scheme=light`} title={part.label} data-slate-part={part.key}
              className="block w-full border-0" style={{ height: part.height }} />
          </section>
        ))}
      </div>
    </div>
  );
}

export function RoomPartFrame() {
  const [search] = useSearchParams();

  useSlateScheme(search.get("scheme"));

  return <PartFrame part={search.get("part") ?? ""} />;
}

export function RoomClosedFrame() {
  const [search] = useSearchParams();
  const asked = search.get("state");
  const closed = asked === "missing" || asked === "stopped" ? CLOSED[asked] : CLOSED["not-shared"];

  return <Closed {...closed} action={<FilledButton>Go to Kinu</FilledButton>} />;
}

export const ROOM_STATES = [...STATES.keys()];
