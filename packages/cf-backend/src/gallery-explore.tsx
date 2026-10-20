/**
 * Explore in the gallery: `explore` (the feed; `&kind=`, `&category=`, `&q=` as its URL takes them) and
 * `explore-workspace&id=<blueprint>` (`&install=1` with Install open; `&assistant=1` once it is the person's), in the
 * product's own shell; `&signed=out` for a visitor's page, under the public bar. With `&assistant=1` the roster holds the assistant marked Home, and `&at=assistant` opens its
 * own address with the roster's read held 1.5 s, so the page draws before it knows it is Home. `/api/explore` is
 * answered here from a fixed feed of the owner's kind of work, ranked as the index would, Kinu's own read from core.
 * Kinu's blueprints show their served pictures; an app's picture is a listing's read, which a test or a shot answers.
 */
import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import * as v from "valibot";
import { Loader } from "@cloudflare/kumo";
import { blueprintPage, kinuBlueprint, kinuListings, RosterPageSchema, type GalleryListing, type RosterEntry } from "@kinu.run/core";
import Layout from "@/components/layout";
import { VisitorShell } from "@/components/gallery/GalleryShell";
import type { BlueprintPage, ExploreItem, ExploreNeed, WorkspaceCard } from "@/lib/explore-api";

const ExplorePage = lazy(() => import("@/pages/ExplorePage"));

const ExploreWorkspacePage = lazy(() => import("@/pages/ExploreWorkspacePage"));

const WorkspacePage = lazy(() => import("@/pages/WorkspacePage"));

const NewWorkspacePage = lazy(async () => ({ default: (await import("@/pages/HomePage")).NewWorkspacePage }));

const NOW = Date.now();

const DAY = 864e5;

const need = (connection: string | null, access: ExploreNeed["access"], why: string, secret: string | null = null): ExploreNeed => ({ connection, secret, access, why });

const workspace = (card: Omit<WorkspaceCard, "starred" | "featured"> & { featured?: boolean }): ExploreItem => ({
  kind: "workspace", workspace: { starred: false, featured: false, ...card },
});

const app = (listing: Omit<GalleryListing, "share" | "url" | "starred" | "featured">, needs: readonly ExploreNeed[]): ExploreItem => ({
  kind: "app", needs: [...needs],
  app: { share: `share-${listing.slate}`, url: `/s/${listing.workspace}/${listing.slate}`, starred: false, featured: false, ...listing },
});

const KINU = { name: "Kinu", kinu: true };

/** The numbers a busy deployment's index holds for Kinu's own blueprints. */
const KINU_NUMBERS = new Map([
  ["personal-assistant", { installs: 12_480, stars: 3_120, listedAt: NOW - 30 * DAY }],
  ["worker-on-call", { installs: 4_210, stars: 1_040, listedAt: NOW - 21 * DAY }],
  ["release-manager", { installs: 2_980, stars: 702, listedAt: NOW - 14 * DAY }],
  ["research-desk", { installs: 3_560, stars: 911, listedAt: NOW - 9 * DAY }],
]);

/** In trending order: Kinu's own first, as core keeps them (blueprints/kinu.ts), then what people use most now. */
const ITEMS: readonly ExploreItem[] = [
  ...kinuListings().map((listing) => workspace({ ...listing, maker: KINU, featured: true, installs: 0, stars: 0, listedAt: NOW, ...KINU_NUMBERS.get(listing.id) })),
  app({
    workspace: "ravi", slate: "pr-board", title: "PR review board", category: "developer", owner: { name: "Ravi Menon" }, stars: 412, viewers: 1_840, listedAt: NOW - 20 * DAY, picture: "pic-pr-board",
    line: "Every pull request waiting on you, across your repositories, sorted by how long it has waited.",
  }, [need("github", "read", "To list the pull requests that wait on you.")]),
  workspace({
    id: "issue-triage", title: "Issue triage", category: "developer", maker: { name: "Lina Park", kinu: false }, picture: null, installs: 1_390, stars: 388, listedAt: NOW - 6 * DAY,
    line: "Labels every new issue, finds its duplicates, answers the easy ones, and hands you the rest by morning.",
    needs: [need("github", "write", "To label issues and post the answers you approve.")],
  }),
  app({
    workspace: "tom", slate: "worker-logs", title: "Workers logs explorer", category: "developer", owner: { name: "Tom Okafor" }, stars: 296, viewers: 1_120, listedAt: NOW - 4 * DAY, picture: "pic-logs",
    line: "Your Worker's logs, filtered by status and route, with the stack every error shares pulled to the top.",
  }, [need("cloudflare", "read", "To read Workers Logs.")]),
  workspace({
    id: "firmware-lab", title: "Firmware lab", category: "developer", maker: { name: "Rohan Iyer", kinu: false }, picture: null, installs: 640, stars: 251, listedAt: NOW - 11 * DAY,
    line: "Ghidra on its own computer: loads a firmware image, maps its functions, and walks you to the interesting ones.",
    needs: [],
  }),
  app({
    workspace: "priya", slate: "workers-health", title: "Workers health", category: "developer", owner: { name: "Priya Shah" }, stars: 233, viewers: 905, listedAt: NOW - 2 * DAY, picture: "pic-deploys",
    line: "Requests, 5xx rate, p95 and deploys for every Worker on your account, on one page.",
  }, [need("cloudflare", "read", "Analytics and deployments for your Workers.")]),
  app({
    workspace: "ana", slate: "do-sqlite-notes", title: "Durable Objects SQLite notes", category: "work", owner: { name: "Ana Souza" }, stars: 141, viewers: 512, listedAt: NOW - 3 * DAY, picture: "pic-report",
    line: "What changed in Durable Objects SQLite storage each month, and what each change means for an app.",
  }, []),
];

/** A blueprint's page: Kinu's own as the server makes it, and any other in the feed its card's words and a plain inside. */
function pageOf(card: WorkspaceCard): BlueprintPage {
  const own = kinuBlueprint(card.id);

  if (own !== undefined) return blueprintPage(own, card);

  return {
    workspace: card, version: "1.0", updatedAt: card.listedAt,
    about: [{ title: card.title, body: card.line }],
    inside: { agents: [{ name: "Main", about: "The workspace's chat." }], automations: [], slates: [], layout: "workbench", soul: `# ${card.title}\n\n## Mission\n${card.line}\n` },
    asks: ["Anything that writes outside the workspace"],
  };
}

const PAGE_SIZE = 12;

function feed(search: URLSearchParams): Response {
  const q = (search.get("q") ?? "").trim().toLowerCase();
  const kind = search.get("kind");
  const category = search.get("category");
  const sort = search.get("sort") ?? "trending";
  const title = (item: ExploreItem) => (item.kind === "app" ? item.app.title : item.workspace.title);
  const line = (item: ExploreItem) => (item.kind === "app" ? item.app.line : item.workspace.line);
  const stars = (item: ExploreItem) => (item.kind === "app" ? item.app.stars : item.workspace.stars);
  const listed = (item: ExploreItem) => (item.kind === "app" ? item.app.listedAt : item.workspace.listedAt);

  const items = ITEMS
    .filter((item) => kind === null || item.kind === kind)
    .filter((item) => category === null || (item.kind === "app" ? item.app.category : item.workspace.category) === category)
    .filter((item) => q === "" || `${title(item)} ${line(item)}`.toLowerCase().includes(q));

  // Trending is the feed's own order.
  if (sort === "new") items.sort((a, b) => listed(b) - listed(a));

  if (sort === "stars") items.sort((a, b) => stars(b) - stars(a));

  return Response.json({ items: items.slice(0, PAGE_SIZE), next: items.length > PAGE_SIZE ? 1 : null });
}

/** A blueprint by id, as the feed lists it. */
const blueprintOf = (id: string) => ITEMS.flatMap((item) => (item.kind === "workspace" && item.workspace.id === id ? [item.workspace] : []))[0];

/** `/api/explore*` answered from the feed above, and an install answered as made: its body is kept on the page as
 *  `data-explore-installed` for a test to read. Anything else goes on. */
function installExploreFixture(): void {
  const next = window.fetch.bind(window);

  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const [, , area, kind, id, action] = url.pathname.split("/");

    if (url.pathname === "/api/explore") return feed(url.searchParams);


    if (area === "explore" && kind === "workspaces" && id !== undefined && action === "star" && request.method === "POST") {
      document.documentElement.dataset.exploreStarred = JSON.stringify({ id: decodeURIComponent(id), body: await request.json() });

      return new Response(null, { status: 204 });
    }

    // `&assistant=1`: the person already has the Personal assistant, and the roster lists it as Home.
    const query = new URLSearchParams(location.search);
    const assistant = query.has("assistant");

    if (url.pathname === "/api/user/assistant") return Response.json({ workspace: assistant ? ASSISTANT.name : null });

    // A workspace made by hand: its body is kept on the page as `data-explore-created` for a test to read.
    if (url.pathname === "/api/user/workspaces" && request.method === "POST") {
      document.documentElement.dataset.exploreCreated = JSON.stringify(await request.json());

      return Response.json({ name: "api-worker-9c1d", displayName: "API Worker", createdAt: NOW, lastVisited: NOW }, { status: 201 });
    }

    if (url.pathname === "/api/user/workspaces" && assistant) {
      if (query.get("at") === "assistant") await new Promise((resolve) => setTimeout(resolve, 1500));
      const page = v.parse(RosterPageSchema, await (await next(input, init)).json());

      return Response.json({ ...page, entries: [ASSISTANT, ...page.entries], total: page.total + 1, counts: { ...page.counts, all: page.counts.all + 1, idle: page.counts.idle + 1 } });
    }

    if (area === "explore" && kind === "workspaces" && id !== undefined) {
      const found = blueprintOf(decodeURIComponent(id));

      return found === undefined ? Response.json({ error: "No such workspace blueprint" }, { status: 404 }) : Response.json(pageOf(found));
    }

    if (area === "user" && kind === "blueprints" && id !== undefined && action === "install" && request.method === "POST") {
      document.documentElement.dataset.exploreInstalled = JSON.stringify({ id: decodeURIComponent(id), body: await request.json() });

      return Response.json({ workspace: `${decodeURIComponent(id)}-4f2a` }, { status: 201 });
    }

    return next(input, init);
  }, { preconnect: next.preconnect });
}

const ASSISTANT: RosterEntry = {
  name: "personal-assistant-4f2a", displayName: "Personal assistant", createdAt: NOW - DAY, lastVisited: NOW, overview: null, decisions: 0, logo: null, home: true,
};

const loading = (node: React.ReactNode) => <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader size="base" /></div>}>{node}</Suspense>;

/** A visitor's account reads, refused as the gate refuses them and kept on the page as `data-explore-account-reads`. */
function refuseAccountReads(): void {
  const next = window.fetch.bind(window);
  const asked: string[] = [];

  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);

    if (!pathname.startsWith("/api/user/")) return next(input, init);
    asked.push(`${request.method} ${pathname}`);
    document.documentElement.dataset.exploreAccountReads = JSON.stringify(asked);

    return Response.json({ error: "No Kinu session in request" }, { status: 401 });
  }, { preconnect: next.preconnect });
}

/** `explore` or `explore-workspace`, in the product's shell. */
export function exploreFrame(frame: string) {
  installExploreFixture();
  const search = new URLSearchParams(location.search);
  const id = v.parse(v.string(), search.get("id") ?? "personal-assistant");
  const feedQuery = new URLSearchParams([...search].filter(([key]) => ["q", "kind", "category", "sort"].includes(key))).toString();
  const opened = frame === "explore-workspace" ? `/explore/workspaces/${id}${search.has("install") ? "?install=1" : ""}` : `/explore${feedQuery === "" ? "" : `?${feedQuery}`}`;

  const pages = (
    <>
      <Route path="/explore" element={loading(<ExplorePage />)} />
      <Route path="/explore/workspaces/:blueprint" element={loading(<ExploreWorkspacePage />)} />
    </>
  );

  if (search.get("signed") === "out") {
    refuseAccountReads();

    return { entries: [opened], node: <Routes><Route element={<VisitorShell />}>{pages}</Route></Routes> };
  }

  return {
    entries: [search.get("at") === "assistant" ? `/workspace/${ASSISTANT.name}` : opened],
    node: (
      <Routes>
        <Route element={<Layout />}>
          {pages}
          <Route path="/new" element={loading(<NewWorkspacePage />)} />
          {search.get("at") === "assistant" && <Route path="/workspace/:agentId" element={loading(<WorkspacePage />)} />}
          <Route index element={<div className="h-full" data-gallery-home />} />
          <Route path="*" element={<div className="h-full" data-gallery-blank />} />
        </Route>
      </Routes>
    ),
  };
}
