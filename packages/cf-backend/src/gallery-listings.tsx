/**
 * A listed slate's page (`gallery-slate&slate=<slate>`; `&signed=out` for a visitor, `&fork=1` back from signing in to
 * fork) on a fixed set of listings: `/api/gallery` answers as the Gallery's contract says (room-api.ts), Explore's apps
 * of its category are its More like it, and a star and a report are taken. Each listing but Team lunch poll has a
 * picture; a test or a shot answers its reads.
 */
import { lazy, Suspense, type ReactNode } from "react";
import { Route, Routes } from "react-router-dom";
import * as v from "valibot";
import { Loader } from "@cloudflare/kumo";
import { APP_ROUTES, type GalleryListing, type GallerySlate } from "@kinu.run/core";
import GalleryShell from "@/components/gallery/GalleryShell";

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
    category: "developer", owner: { name: "Ravi Menon" }, stars: 412, viewers: 1840, listedAt: NOW - 20 * DAY, featured: true, picture: PICTURES["pr-board"],
  }),
  listing("ana", "trip", "t5c1", {
    title: "Trip budget splitter", line: "Log what each person paid; it says who owes whom, in as few payments as possible.",
    category: "money", owner: { name: "Ana Souza" }, stars: 287, viewers: 962, listedAt: NOW - 3 * DAY, featured: true, picture: PICTURES.trip,
  }),
  listing("alice", "habits", "h2b6", {
    title: "Habit tracker", line: "A week of habits on one screen. Tap a day to mark it.", category: "home", owner: { name: "Alice Chen" }, stars: 233, viewers: 705,
    listedAt: NOW - 12 * DAY, picture: PICTURES.habits,
  }),
  listing("jules", "digest", "d9e4", {
    title: "Morning reading", line: "Five things worth reading today on the topics you choose, summarised by your model.", category: "work",
    owner: { name: "Jules Martin" }, stars: 198, viewers: 688, listedAt: NOW - DAY, picture: PICTURES.digest,
  }),
  listing("priya", "standup", "s3f7", {
    title: "Standup notes", line: "Turns yesterday's commits and calendar into a three-line standup.", category: "work", owner: { name: "Priya Shah" },
    stars: 164, viewers: 391, listedAt: NOW - 6 * DAY, picture: PICTURES.standup,
  }),
  listing("tom", "recipe", "r1a8", {
    title: "Recipe scaler", line: "Paste a recipe and scale it to any number of people, in grams.", category: "home", owner: { name: "Tom Okafor" },
    stars: 121, viewers: 352, listedAt: NOW - 9 * DAY, picture: PICTURES.recipe,
  }),
  listing("mei", "poll", "l6q0", {
    title: "Team lunch poll", line: "One question, a few options, results live for everyone voting.", category: "fun", owner: { name: "Mei Lin" },
    stars: 96, viewers: 203, listedAt: NOW - 2 * DAY,
  }),
];

/** Each listed slate's own page; Morning reading has no counts yet. */
/** What each slate's page says beside its listing: its counts, and what of a visitor's own it uses. */
const PAGES = {
  "pr-board": { forks: 86, people: 1200, needs: [{ kind: "github", title: "GitHub" }, { kind: "ai", title: "AI" }] },
  digest: { needs: [] },
} satisfies Record<string, Omit<GallerySlate, "listing">>;

const pageOf = (slate: string): Omit<GallerySlate, "listing"> => (slate === "pr-board" || slate === "digest" ? PAGES[slate] : {});

const StarSchema = v.object({ workspace: v.string(), slate: v.string(), on: v.boolean() });

/** Explore's apps of `category`, as the slate page's More like it asks for them. */
function apps(listings: readonly GalleryListing[], search: URLSearchParams): Response {
  const category = search.get("category");

  return Response.json({ items: listings.filter((each) => category === null || each.category === category).map((app) => ({ kind: "app", app, needs: [] })), next: null });
}

/** `more`: listings past the slate page's own, Explore's apps in the whole app's frame (gallery-app.tsx). */
export function installGalleryFixture(frame: string, more: readonly GalleryListing[] = []): void {
  if (frame !== "gallery-slate" && frame !== "whole") return;

  const next = window.fetch.bind(window);
  // Stars as this person leaves them.
  let listings = [...LISTINGS, ...more.filter((each) => !LISTINGS.some((own) => own.workspace === each.workspace && own.slate === each.slate))];
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

    // The whole app's Explore answers its own feed.
    if (url.pathname === "/api/explore" && frame !== "whole") return apps(listings, url.searchParams);

    if (api !== "api" || area !== "gallery") return next(input, init);

    asked.push({ path: url.pathname, search: url.search, body: request.method === "POST" ? await request.clone().text() : null });
    document.documentElement.setAttribute("data-gallery-asked", JSON.stringify(asked));
    document.documentElement.setAttribute("data-gallery-asked-paths", asked.map((each) => each.path).join("\n"));

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

/** The page the frame opens on: `&slate=`'s own, the first listing's by default. */
export function galleryEntry(search: URLSearchParams): string {
  const asked = LISTINGS.find((each) => each.slate === search.get("slate")) ?? LISTINGS[0];

  return asked === undefined ? "/" : `/gallery/${asked.workspace}/${asked.slate}${search.has("fork") ? "?fork=1" : ""}`;
}

const loading = (shown: ReactNode) => <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader size="base" /></div>}>{shown}</Suspense>;

export function GalleryAppFrame() {
  return (
    <Routes>
      <Route element={<GalleryShell />}>
        <Route path={APP_ROUTES.gallerySlate} element={loading(<GallerySlatePage />)} />
      </Route>
    </Routes>
  );
}
