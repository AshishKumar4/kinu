/**
 * Gallery frames (`gallery-list`, `gallery-slate&slate=<slate>`; `&signed=out` for a visitor, `&fork=1` back from
 * signing in to fork) on a fixed set of listings: `/api/gallery` answers as the Gallery's contract says (room-api.ts),
 * sorted, filtered and searched here, six to a page; a star and a report are taken. Each listing but Team lunch poll has
 * a picture; a test or a shot answers its reads.
 */
import { lazy, Suspense, type ReactNode } from "react";
import { Route, Routes } from "react-router-dom";
import * as v from "valibot";
import { Loader } from "@cloudflare/kumo";
import { APP_ROUTES, type GalleryListing, type GallerySlate } from "@kinu.run/core";
import GalleryShell from "@/components/gallery/GalleryShell";

const GalleryPage = lazy(() => import("@/pages/GalleryPage"));

const GallerySlatePage = lazy(() => import("@/pages/GallerySlatePage"));

const NOW = Date.now();

const DAY = 864e5;

const listing = (
  workspace: string, slate: string, key: string, rest: Omit<GalleryListing, "workspace" | "slate" | "share" | "url" | "starred" | "featured"> & { featured?: boolean },
): GalleryListing => ({ workspace, slate, share: `share-${key}`, url: `/s/${workspace}/${slate}?k=${key}`, starred: false, ...rest, featured: rest.featured ?? false });

/** A picture's digest: any 64 hex characters name one version. */
const PICTURES = {
  "pr-board": "fb78dc00234ee9eeda9437ad7af4cd8c89a6836d2111827b4df00569ecd26b74", trip: "34a389d790fc2bdd8458e5f1cde6933c97d11eeda65cf328b64460f0d68f04b5", habits: "d68cffa59de9dff4b72aaaa70edfd8f4a957c580c654b7da4b0fcea7ad307a95", digest: "0bf474896363505e5ea5e5d6ace8ebfb13a760a409b1fb467d428fc716f9f284", standup: "c0fbdc38b1762851a9221b774a130fd2ae0bf78c61bd69eb334f8cd2caa08319", recipe: "e1d8e552330911f9f779f85b6f2c00a15e790dcc3fbb3b28f5da1d660a30c5b8",
} as const;

/** In trending order, as the Gallery answers it unsorted. */
const LISTINGS: readonly GalleryListing[] = [
  listing("ravi", "pr-board", "p8x2", {
    title: "PR review board", line: "Every pull request waiting on you, across your repositories, sorted by how long it has waited.",
    category: "developer", owner: { name: "Ravi Menon" }, stars: 412, listedAt: NOW - 20 * DAY, featured: true, picture: PICTURES["pr-board"],
  }),
  listing("ana", "trip", "t5c1", {
    title: "Trip budget splitter", line: "Log what each person paid; it says who owes whom, in as few payments as possible.",
    category: "money", owner: { name: "Ana Souza" }, stars: 287, listedAt: NOW - 3 * DAY, featured: true, picture: PICTURES.trip,
  }),
  listing("alice", "habits", "h2b6", {
    title: "Habit tracker", line: "A week of habits on one screen. Tap a day to mark it.", category: "home", owner: { name: "Alice Chen" }, stars: 233,
    listedAt: NOW - 12 * DAY, picture: PICTURES.habits,
  }),
  listing("jules", "digest", "d9e4", {
    title: "Morning reading", line: "Five things worth reading today on the topics you choose, summarised by your model.", category: "work",
    owner: { name: "Jules Martin" }, stars: 198, listedAt: NOW - DAY, picture: PICTURES.digest,
  }),
  listing("priya", "standup", "s3f7", {
    title: "Standup notes", line: "Turns yesterday's commits and calendar into a three-line standup.", category: "work", owner: { name: "Priya Shah" },
    stars: 164, listedAt: NOW - 6 * DAY, picture: PICTURES.standup,
  }),
  listing("tom", "recipe", "r1a8", {
    title: "Recipe scaler", line: "Paste a recipe and scale it to any number of people, in grams.", category: "home", owner: { name: "Tom Okafor" },
    stars: 121, listedAt: NOW - 9 * DAY, picture: PICTURES.recipe,
  }),
  listing("mei", "poll", "l6q0", {
    title: "Team lunch poll", line: "One question, a few options, results live for everyone voting.", category: "fun", owner: { name: "Mei Lin" },
    stars: 96, listedAt: NOW - 2 * DAY,
  }),
];

/** Each listed slate's own page; Morning reading has no counts yet. */
/** What each slate's page says beside its listing: its counts, and what of a visitor's own it uses. */
const PAGES = {
  "pr-board": { forks: 86, people: 1200, needs: [{ kind: "github", title: "GitHub" }, { kind: "ai", title: "AI" }] },
  digest: { needs: [] },
} satisfies Record<string, Omit<GallerySlate, "listing">>;

const pageOf = (slate: string): Omit<GallerySlate, "listing"> => (slate === "pr-board" || slate === "digest" ? PAGES[slate] : {});

const PAGE_SIZE = 6;

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

  const visitor = new URLSearchParams(location.search).get("signed") === "out";

  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const [, api, area, workspace, slate, rest] = url.pathname.split("/");

    if (url.pathname === "/api/auth/me") {
      return visitor
        ? Response.json({ error: "Sign in." }, { status: 401 })
        : Response.json({ user: { id: "owner", email: "owner@example.com", provider: "google", signedInWith: "Google", displayName: "Owner" } });
    }

    const found = listings.find((each) => each.workspace === workspace && each.slate === slate);

    if (api !== "api" || area !== "gallery") return next(input, init);

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

    return next(input, init);
  }, { preconnect: next.preconnect });
}

/** The page a gallery frame opens on: the Gallery, or `&slate=`'s own page. */
export function galleryEntry(frame: string, search: URLSearchParams): string {
  const asked = LISTINGS.find((each) => each.slate === search.get("slate")) ?? LISTINGS[0];

  if (frame !== "gallery-slate" || asked === undefined) return APP_ROUTES.gallery;

  return `/gallery/${asked.workspace}/${asked.slate}${search.has("fork") ? "?fork=1" : ""}`;
}

const loading = (shown: ReactNode) => <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader size="base" /></div>}>{shown}</Suspense>;

export function GalleryAppFrame() {
  return (
    <Routes>
      <Route element={<GalleryShell />}>
        <Route path={APP_ROUTES.gallery} element={loading(<GalleryPage />)} />
        <Route path={APP_ROUTES.gallerySlate} element={loading(<GallerySlatePage />)} />
      </Route>
    </Routes>
  );
}
