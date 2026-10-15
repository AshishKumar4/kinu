/**
 * Gallery frames (`gallery-list`, `gallery-slate&slate=<slate>`) on a fixed set of listings: `/api/gallery` answers as
 * the Gallery's contract says (room-api.ts), sorted, filtered and searched here, six to a page; a star and a report are
 * taken; a listed slate's fork admits only its link's key.
 */
import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import * as v from "valibot";
import { Loader } from "@cloudflare/kumo";
import { APP_ROUTES, type ForkPreview, type GalleryListing, type GallerySlate } from "@kinu.run/core";
import Sidebar from "@/components/Sidebar";

const GalleryPage = lazy(() => import("@/pages/GalleryPage"));

const GallerySlatePage = lazy(() => import("@/pages/GallerySlatePage"));

const NOW = Date.now();

const DAY = 864e5;

const listing = (
  workspace: string, slate: string, key: string, rest: Omit<GalleryListing, "workspace" | "slate" | "url" | "starred" | "featured"> & { featured?: boolean },
): GalleryListing => ({ workspace, slate, url: `/s/${workspace}/${slate}?k=${key}`, starred: false, ...rest, featured: rest.featured ?? false });

const GITHUB = { title: "GitHub", kind: "github" } as const;

const MODEL = { title: "Model", kind: "ai" } as const;

/** In trending order, as the Gallery answers it unsorted. */
const LISTINGS: readonly GalleryListing[] = [
  listing("ravi", "pr-board", "p8x2", {
    title: "PR review board", line: "Every pull request waiting on you, across your repositories, sorted by how long it has waited.",
    category: "developer", owner: { name: "Ravi Menon" }, stars: 412, listedAt: NOW - 20 * DAY, needs: [GITHUB], featured: true,
  }),
  listing("ana", "trip", "t5c1", {
    title: "Trip budget splitter", line: "Log what each person paid; it says who owes whom, in as few payments as possible.",
    category: "money", owner: { name: "Ana Souza" }, stars: 287, listedAt: NOW - 3 * DAY, needs: [], featured: true,
  }),
  listing("alice", "habits", "h2b6", {
    title: "Habit tracker", line: "A week of habits on one screen. Tap a day to mark it.", category: "home", owner: { name: "Alice Chen" }, stars: 233,
    listedAt: NOW - 12 * DAY, needs: [],
  }),
  listing("jules", "digest", "d9e4", {
    title: "Morning reading", line: "Five things worth reading today on the topics you choose, summarised by your model.", category: "work",
    owner: { name: "Jules Martin" }, stars: 198, listedAt: NOW - DAY, needs: [MODEL],
  }),
  listing("priya", "standup", "s3f7", {
    title: "Standup notes", line: "Turns yesterday's commits and calendar into a three-line standup.", category: "work", owner: { name: "Priya Shah" },
    stars: 164, listedAt: NOW - 6 * DAY, needs: [MODEL, GITHUB],
  }),
  listing("tom", "recipe", "r1a8", {
    title: "Recipe scaler", line: "Paste a recipe and scale it to any number of people, in grams.", category: "home", owner: { name: "Tom Okafor" },
    stars: 121, listedAt: NOW - 9 * DAY, needs: [],
  }),
  listing("mei", "poll", "l6q0", {
    title: "Team lunch poll", line: "One question, a few options, results live for everyone voting.", category: "fun", owner: { name: "Mei Lin" },
    stars: 96, listedAt: NOW - 2 * DAY, needs: [],
  }),
];

/** Each listed slate's own page; Morning reading runs with its author's lend and has no counts yet. */
const PAGES = {
  "pr-board": { files: ["package.json", "server.ts", "board.tsx", "github.ts", "README.md"], updatedAt: NOW - 3 * DAY, readsAuthor: false, forks: 86, people: 1200 },
  digest: { files: ["package.json", "server.ts", "reading.tsx"], updatedAt: NOW - DAY, readsAuthor: true },
} satisfies Record<string, Omit<GallerySlate, "listing">>;

const pageOf = (slate: string): Omit<GallerySlate, "listing"> => (slate === "pr-board" || slate === "digest" ? PAGES[slate] : { files: ["package.json"], updatedAt: NOW, readsAuthor: false });

const PAGE_SIZE = 6;

const FORK_PREVIEW = (found: GalleryListing): ForkPreview => ({
  title: found.title,
  owner: { email: `${found.workspace}@example.com`, name: found.owner.name },
  parts: found.needs.map((need, at) => ({ fn: `part${String(at)}`, lent: false, needs: need })),
});

const ORDER = {
  trending: () => 0,
  new: (a: GalleryListing, b: GalleryListing) => b.listedAt - a.listedAt,
  stars: (a: GalleryListing, b: GalleryListing) => b.stars - a.stars,
} as const;

const SortSchema = v.picklist(["trending", "new", "stars"] as const);

const StarSchema = v.object({ workspace: v.string(), slate: v.string(), on: v.boolean() });

function page(listings: readonly GalleryListing[], search: URLSearchParams): Response {
  const q = (search.get("q") ?? "").toLowerCase();
  const category = search.get("category");
  const sort = v.parse(SortSchema, search.get("sort") ?? "trending");
  const at = Number(search.get("page") ?? "0");

  const found = listings
    .filter((each) => category === null || each.category === category)
    .filter((each) => q === "" || [each.title, each.line, each.owner.name].some((text) => text.toLowerCase().includes(q)))
    .sort(ORDER[sort]);

  const listed = found.slice(at * PAGE_SIZE, (at + 1) * PAGE_SIZE);

  return Response.json({ listings: listed, next: found.length > (at + 1) * PAGE_SIZE ? at + 1 : null });
}

export function installGalleryFixture(frame: string): void {
  if (frame !== "gallery-list" && frame !== "gallery-slate") return;

  const next = window.fetch.bind(window);
  // Stars as this person leaves them.
  let listings = [...LISTINGS];
  // What the page asked the Gallery, in order, on the root for a test to read: its fetches never reach the network.
  const asked: { path: string; search: string; body: string | null }[] = [];

  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const [, api, area, workspace, slate, rest] = url.pathname.split("/");
    const found = listings.find((each) => each.workspace === workspace && each.slate === slate);

    if (api !== "api" || (area !== "gallery" && area !== "rooms")) return next(input, init);

    asked.push({ path: url.pathname, search: url.search, body: request.method === "POST" ? await request.clone().text() : null });
    document.documentElement.setAttribute("data-gallery-asked", JSON.stringify(asked));
    document.documentElement.setAttribute("data-gallery-asked-paths", asked.map((each) => each.path).join("\n"));

    if (url.pathname === "/api/gallery") return page(listings, url.searchParams);

    if (url.pathname === "/api/gallery/star" && request.method === "POST") {
      const star = v.parse(StarSchema, await request.json());

      listings = listings.map((each) => (each.workspace === star.workspace && each.slate === star.slate
        ? { ...each, starred: star.on, stars: each.stars + (star.on ? 1 : -1) }
        : each));

      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/api/gallery/report" && request.method === "POST") return new Response(null, { status: 204 });

    if (found === undefined) return Response.json({ error: "There's no slate here" }, { status: 404 });

    if (area === "gallery" && rest === undefined) return Response.json({ listing: found, ...pageOf(found.slate) });

    // The fork admits by the link's key, as the room does.
    if (area === "rooms" && rest === "fork") {
      return found.url.endsWith(`?k=${url.searchParams.get("k") ?? ""}`)
        ? Response.json(FORK_PREVIEW(found))
        : Response.json({ error: "This slate isn't shared with you" }, { status: 403 });
    }

    return next(input, init);
  }, { preconnect: next.preconnect });
}

/** The page a gallery frame opens on: the Gallery, or `&slate=`'s own page. */
export function galleryEntry(frame: string, search: URLSearchParams): string {
  const asked = LISTINGS.find((each) => each.slate === search.get("slate")) ?? LISTINGS[0];

  return frame === "gallery-slate" && asked !== undefined ? `/gallery/${asked.workspace}/${asked.slate}` : APP_ROUTES.gallery;
}

export function GalleryAppFrame() {
  return (
    <div className="flex h-screen w-screen overflow-hidden p-bg p-text">
      <aside className="hidden w-60 shrink-0 border-r p-border p-sidebar md:block"><Sidebar /></aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader size="base" /></div>}>
          <Routes>
            <Route path={APP_ROUTES.gallery} element={<GalleryPage />} />
            <Route path={APP_ROUTES.gallerySlate} element={<GallerySlatePage />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}
