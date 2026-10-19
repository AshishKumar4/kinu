/**
 * Explore in the gallery: `explore` (the feed; `&kind=`, `&category=`, `&q=` as its URL takes them) and
 * `explore-workspace&id=<blueprint>` (`&install=1` with Install open), in the product's own shell. `/api/explore` is
 * answered here from a fixed feed of the owner's kind of work, ranked as the index would; pictures are the gallery's own
 * files (gallery-pictures.ts).
 */
import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import * as v from "valibot";
import { Loader } from "@cloudflare/kumo";
import type { GalleryListing } from "@kinu.run/core";
import Layout from "@/components/layout";
import type { BlueprintPage, ExploreItem, ExploreNeed, WorkspaceCard } from "@/lib/explore-api";

const ExplorePage = lazy(() => import("@/pages/ExplorePage"));

const ExploreWorkspacePage = lazy(() => import("@/pages/ExploreWorkspacePage"));

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

/** In trending order: Kinu's own first, then what people use most this week. */
const ITEMS: readonly ExploreItem[] = [
  workspace({
    id: "personal-assistant", title: "Personal assistant", category: "work", maker: KINU, picture: "pic-assistant", installs: 12_480, stars: 3_120, listedAt: NOW - 30 * DAY, featured: true,
    line: "Your mail, GitHub and Cloudflare read for you, a brief each morning, and bigger work run in workspaces of its own.",
    needs: [need("google", "read", "To read your Gmail and mark what matters. It drafts; you send."), need("github", "read", "Your reviews, mentions and repositories."), need("cloudflare", "read", "Your Workers' errors and deploys.")],
  }),
  workspace({
    id: "worker-on-call", title: "Worker on-call", category: "developer", maker: KINU, picture: "pic-deploys", installs: 4_210, stars: 1_040, listedAt: NOW - 21 * DAY, featured: true,
    line: "Watches a Cloudflare Worker's errors and latency, reads the logs when they rise, and proposes the fix.",
    needs: [need("cloudflare", "read", "Workers Logs and analytics for the Worker you name."), need("github", "write", "To open the fix as a pull request.")],
  }),
  workspace({
    id: "release-manager", title: "Release manager", category: "developer", maker: KINU, picture: "pic-release", installs: 2_980, stars: 702, listedAt: NOW - 14 * DAY, featured: true,
    line: "Cuts the branch, writes the notes from merged PRs, deploys to staging with wrangler, and asks before production.",
    needs: [need("github", "write", "To cut release branches and tag."), need("cloudflare", "write", "To deploy to staging and, once you approve, production.")],
  }),
  workspace({
    id: "research-desk", title: "Research desk", category: "work", maker: KINU, picture: "pic-report", installs: 3_560, stars: 911, listedAt: NOW - 9 * DAY, featured: true,
    line: "Reads the sources, checks the claims, and writes a report you can share, with every citation kept.",
    needs: [],
  }),
  app({
    workspace: "ravi", slate: "pr-board", title: "PR review board", category: "developer", owner: { name: "Ravi Menon" }, stars: 412, viewers: 1_840, listedAt: NOW - 20 * DAY, picture: "pic-pr-board",
    line: "Every pull request waiting on you, across your repositories, sorted by how long it has waited.",
  }, [need("github", "read", "To list the pull requests that wait on you.")]),
  workspace({
    id: "issue-triage", title: "Issue triage", category: "developer", maker: { name: "Lina Park", kinu: false }, picture: "pic-incident", installs: 1_390, stars: 388, listedAt: NOW - 6 * DAY,
    line: "Labels every new issue, finds its duplicates, answers the easy ones, and hands you the rest by morning.",
    needs: [need("github", "write", "To label issues and post the answers you approve.")],
  }),
  app({
    workspace: "tom", slate: "worker-logs", title: "Workers logs explorer", category: "developer", owner: { name: "Tom Okafor" }, stars: 296, viewers: 1_120, listedAt: NOW - 4 * DAY, picture: "pic-logs",
    line: "Your Worker's logs, filtered by status and route, with the stack every error shares pulled to the top.",
  }, [need("cloudflare", "read", "To read Workers Logs.")]),
  workspace({
    id: "firmware-lab", title: "Firmware lab", category: "developer", maker: { name: "Rohan Iyer", kinu: false }, picture: "pic-ghidra", installs: 640, stars: 251, listedAt: NOW - 11 * DAY,
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

const PAGES = new Map<string, Omit<BlueprintPage, "workspace">>([
  ["personal-assistant", {
    version: "1.4", updatedAt: NOW - 3 * DAY,
    about: [
      { title: "Reads your mail for you", body: "Mail to your kinu.run address and your Gmail. It marks what matters with one line on why, and drafts the replies you'd send." },
      { title: "A brief each morning", body: "What waits on you, what moved overnight, and what your workspaces did, in its chat on Home at the time you choose." },
      { title: "Watches GitHub and Cloudflare", body: "Your reviews and mentions, your Workers' errors and deploys; it speaks up when something changes." },
      { title: "Runs the bigger work", body: "Asked for a release or a report, it proposes a workspace for it, starts it once you agree, and checks on it in each brief." },
    ],
    inside: {
      agents: [{ name: "Kinu", about: "One chat, yours: Home opens on it. Rename it as you like." }],
      automations: [
        { label: "Morning brief", when: "weekdays at the time you choose", does: "Writes the brief from your mail, GitHub, Cloudflare and workspaces." },
        { label: "GitHub", when: "every 15 minutes", does: "Reads new reviews and mentions; tells you when one waits on you." },
        { label: "Mail", when: "as it arrives", does: "Marks the Important, drafts the replies, leaves the rest." },
        { label: "Cloudflare", when: "every 10 minutes", does: "Reads your Workers' error rates and deploys." },
      ],
      slates: [],
      layout: "focus",
      soul: "# Kinu\n\n## Mission\nBe {{owner}}'s personal assistant: read their mail, GitHub and Cloudflare, brief them each morning, and run larger work in workspaces of their own.\n\n## How\n- Mark mail Important only when it needs them, with one line on why.\n- Draft; never send without approval.\n- For anything bigger than a reply, propose a workspace and check on it in each brief.\n",
    },
    asks: ["Sending mail as you", "Creating a workspace", "Starting work in another workspace", "Anything that writes to GitHub or deploys"],
  }],
]);

/** A blueprint page for any other workspace in the feed: its card's words, and a plain inside. */
function pageOf(card: WorkspaceCard): BlueprintPage {
  const own = PAGES.get(card.id);

  if (own !== undefined) return { workspace: card, ...own };

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

/** `/api/explore*` answered from the feed above; anything else goes on. */
export function installExploreFixture(): void {
  const next = window.fetch.bind(window);

  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.pathname === "/api/explore") return feed(url.searchParams);
    const [, , , , id, action] = url.pathname.split("/");

    if (url.pathname.startsWith("/api/explore/workspaces/") && id !== undefined) {
      const found = ITEMS.find((item) => item.kind === "workspace" && item.workspace.id === id);

      if (found?.kind !== "workspace") return Response.json({ error: "No such workspace blueprint" }, { status: 404 });

      if (action === "install" && request.method === "POST") return Response.json({ workspace: id });

      return Response.json(pageOf(found.workspace));
    }

    return next(input, init);
  }, { preconnect: next.preconnect });
}

const loading = (node: React.ReactNode) => <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader size="base" /></div>}>{node}</Suspense>;

/** `explore` or `explore-workspace`, in the product's shell. */
export function exploreFrame(frame: string) {
  installExploreFixture();
  const search = new URLSearchParams(location.search);
  const id = v.parse(v.string(), search.get("id") ?? "personal-assistant");
  const feedQuery = new URLSearchParams([...search].filter(([key]) => ["q", "kind", "category", "sort"].includes(key))).toString();

  return {
    entries: [frame === "explore-workspace" ? `/explore/workspaces/${id}${search.has("install") ? "?install=1" : ""}` : `/explore${feedQuery === "" ? "" : `?${feedQuery}`}`],
    node: (
      <Routes>
        <Route element={<Layout />}>
          <Route path="/explore" element={loading(<ExplorePage />)} />
          <Route path="/explore/workspaces/:blueprint" element={loading(<ExploreWorkspacePage />)} />
          <Route path="*" element={<div className="h-full" data-gallery-blank />} />
        </Route>
      </Routes>
    ),
  };
}
