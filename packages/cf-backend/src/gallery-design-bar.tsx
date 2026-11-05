/**
 * The whole app's design bar (gallery-app.tsx): the owner's live switches, each a parameter of the gallery's own address
 * so one setting holds from page to page and survives a reload, and the review's ways to the pages no sidebar links.
 * Review chrome, never product: the app's own stores do the switching (its theme store for look and mode, `data-face`
 * and `data-face-scope` for gallery-chat-fonts.ts, `data-background` for AppBackground).
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { PaletteIcon, XIcon } from "@phosphor-icons/react";
import { Effect } from "effect";
import * as v from "valibot";
import { detach, detachPromise } from "@kinu.run/core/obs";
import { APP_ROUTES, DEFAULT_THEME, modeFor, PREFERS_LIGHT, THEME_NAMES, type ThemeName } from "@kinu.run/core";
import { setMode, wearTheme, type ThemeMode } from "@/hooks/use-theme";
import { CHAT_FACES, CHAT_FACE_NAMES, FACE_SCOPES, installChatFaces, type ChatFaceName, type FaceScope } from "@/gallery-chat-fonts";
import { DEPLOY_FIXTURE_STATES, deployStateHref } from "@/gallery-deploy-fixture";

/** Where the Activity switches show: the assistant's own. */
const ACTIVITY_PAGE = "/workspace/personal-assistant/activity";

const BACKGROUNDS = ["today", "quiet", "none"] as const;

type Background = (typeof BACKGROUNDS)[number];

const DEVICES = ["desktop", "phone"] as const;

type Device = (typeof DEVICES)[number];

/** A workspace's Activity: as it ships, or the single log proposed for review (gallery-activity-log.tsx). */
const ACTIVITY_VIEWS = ["ships", "log"] as const;

type ActivityViewName = (typeof ACTIVITY_VIEWS)[number];

/** How times are worded: each surface's own, as it ships, or the one rule (audit #23, gallery-activity-log.tsx). */
const TIME_WORDINGS = ["ships", "one"] as const;

type TimeWording = (typeof TIME_WORDINGS)[number];

/** Kumo's parts as Kinu restyles them with `!important`, as it ships, or as Kumo draws them (audit #27). */
const KUMO_LOOKS = ["ships", "own"] as const;

type KumoLook = (typeof KUMO_LOOKS)[number];

/** The page's states for the review: as it would be mid-morning, at rest, before anything, reading, and failed. */
export const ACTIVITY_STATES = [
  { id: "live", label: "Working, and asking" },
  { id: "rest", label: "At rest" },
  { id: "fresh", label: "Nothing yet" },
  { id: "reading", label: "Reading" },
  { id: "failed", label: "Could not read" },
] as const;


export interface Design {
  readonly look: ThemeName;
  readonly mode: ThemeMode;
  readonly font: ChatFaceName;
  readonly scope: FaceScope;
  readonly background: Background;
  readonly device: Device;
  readonly activity: ActivityViewName;
  readonly times: TimeWording;
  readonly kumo: KumoLook;
}

const MODES = ["light", "dark"] as const satisfies readonly ThemeMode[];

function oneOf<T extends string>(said: string | null, options: readonly T[], fallback: T): T {
  return options.find((each) => each === said) ?? fallback;
}

function preferredMode(): ThemeMode {
  return modeFor(null, window.matchMedia(PREFERS_LIGHT).matches);
}

function readDesign(): Design {
  const params = new URLSearchParams(location.search);

  return {
    // The product's own look, and the owner's pick of face: Inter on every page.
    look: oneOf(params.get("look"), THEME_NAMES, DEFAULT_THEME),
    mode: oneOf(params.get("mode"), MODES, preferredMode()),
    font: oneOf(params.get("font"), CHAT_FACE_NAMES, "inter"),
    scope: oneOf(params.get("scope"), FACE_SCOPES, "everywhere"),
    background: oneOf(params.get("background"), BACKGROUNDS, "quiet"),
    device: oneOf(params.get("device"), DEVICES, "desktop"),
    activity: oneOf(params.get("activity"), ACTIVITY_VIEWS, "ships"),
    times: oneOf(params.get("times"), TIME_WORDINGS, "ships"),
    kumo: oneOf(params.get("kumo"), KUMO_LOOKS, "ships"),
  };
}

/*
 * The Kumo switch (audit #27): Kinu's restyle is index.css's `!important` declarations on the classes its `ui/` wrappers
 * put on Kumo's parts. "Kumo's own" takes those declarations out of the page's stylesheets, and "as it ships" puts each
 * back where it was, so the product's CSS is never edited and what differs is exactly what the overrides do.
 */
/** The classes the `ui/` wrappers put on Kumo's parts, and the Kumo markup the stylesheet reaches into. */
const KUMO_PARTS = /\.p-select|\.p-popover|\.p-tooltip|data-tooltip-body|\.p-meter-|\.p-copy-field|\.p-composer-model|\.landing-tabs|\.p-background-sheet/u;

interface Taken {
  readonly style: CSSStyleDeclaration;
  readonly property: string;
  readonly value: string;
}

let taken: readonly Taken[] = [];

function* styleRules(rules: CSSRuleList): Generator<CSSStyleRule> {
  for (const rule of rules) {
    if (rule instanceof CSSStyleRule) {
      yield rule;
      yield* styleRules(rule.cssRules);
    } else if (rule instanceof CSSGroupingRule) yield* styleRules(rule.cssRules);
  }
}

function sheetRules(sheet: CSSStyleSheet): CSSRuleList | null {
  // A stylesheet from another origin cannot be read; none of Kinu's is one.
  return sheet.href === null || new URL(sheet.href).origin === location.origin ? sheet.cssRules : null;
}

/** Kumo's parts as Kumo draws them (`true`), or as Kinu restyles them. */
function wearKumoOwn(own: boolean): void {
  if (!own) {
    for (const { style, property, value } of taken) style.setProperty(property, value, "important");
    taken = [];

    return;
  }

  if (taken.length > 0) return;
  const found: Taken[] = [];

  for (const sheet of document.styleSheets) {
    const rules = sheetRules(sheet);

    if (rules === null) continue;

    for (const rule of styleRules(rules)) {
      if (!KUMO_PARTS.test(rule.selectorText)) continue;

      for (const property of rule.style) {
        if (rule.style.getPropertyPriority(property) !== "important") continue;
        found.push({ style: rule.style, property, value: rule.style.getPropertyValue(property) });
      }
    }
  }

  for (const { style, property } of found) style.removeProperty(property);
  taken = found;
}

const listeners = new Set<() => void>();

let current: Design = readDesign();

/** The design on the page: the theme store's look and mode, the face, and the new-workspace page's field. */
function apply(design: Design): void {
  const root = document.documentElement;

  wearTheme(design.look);
  setMode(design.mode);

  if (design.font === "schibsted") delete root.dataset.face;
  else root.dataset.face = design.font;

  root.dataset.faceScope = design.scope;

  if (design.background === "today") delete root.dataset.background;
  else root.dataset.background = design.background;

  wearKumoOwn(design.kumo === "own");
}

/** Every switch is a parameter of the address, so a reload and the phone window open on the same design. */
function write(design: Design): void {
  const params = new URLSearchParams(location.search);

  for (const [key, value] of Object.entries(design)) params.set(key, value);
  history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
}

function setDesign(change: Partial<Design>): void {
  current = { ...current, ...change };
  write(current);
  apply(current);

  for (const listener of listeners) listener();
}

export function useDesign(): Design {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);

    return () => listeners.delete(listener);
  }, () => current);
}

/** Once, before the app mounts: the faces' rules in the head and the design the address names on the page. */
export function startDesign(): void {
  installChatFaces();
  apply(current);
}

/** Where the phone window says it is, to the page that holds it. */
const PlaceSchema = v.object({ galleryAt: v.string() });

/**
 * The page on screen as the frame's `&at=`, so a reload, a shared link and the phone window open on it. Inside the
 * phone window it also tells the page around it, which follows, so leaving the phone keeps the page.
 */
export function KeepPlace() {
  const { pathname, search, hash } = useLocation();
  const at = `${pathname}${search}${hash}`;

  useEffect(() => {
    const params = new URLSearchParams(location.search);

    if (params.get("at") !== at) {
      params.set("at", at);
      history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
    }

    if (window.parent !== window) window.parent.postMessage({ galleryAt: at }, location.origin);
  }, [at]);

  return null;
}

function Choice<T extends string>({ label, value, options, name, onPick }: {
  label: string; value: T; options: readonly T[]; name: (option: T) => string; onPick: (option: T) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="p-meta p-text-3">{label}</div>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
        {options.map((option) => (
          <button key={option} type="button" role="radio" aria-checked={option === value} onClick={() => onPick(option)} data-design-choice={`${label}:${option}`}
            className={`rounded-md border px-2 py-1 text-xs transition-colors ${option === value ? "border-[var(--c-accent)] p-text" : "p-border p-text-2 hover:p-text"}`}>
            {name(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

const LOOK_NAMES: Record<ThemeName, string> = { graphite: "Graphite", warm: "Warm" };

const SCOPE_NAMES: Record<FaceScope, string> = { chat: "Chat", everywhere: "Everywhere" };

const BACKGROUND_NAMES: Record<Background, string> = { today: "Today", quiet: "Quiet", none: "None" };

const BACKGROUND_WHY: Record<Background, string> = {
  today: "As it ships: the mesh through the outer third, firing on its own.",
  quiet: "Fainter, held to the edges and bare in the middle; it lights near the pointer and draws nothing while nothing moves.",
  none: "The plain ground, as every chat has.",
};

/** Pages no sidebar links: onboarding and self-deploy. Every other page is reached through the app's own sidebar. */
const ELSEWHERE: readonly (readonly [string, string])[] = [["Home", "/"], ["New workspace", "/new"], ["Onboarding", "/welcome"], ["Self-deploy", "/deploy"]];

const ACTIVITY_WHY: Record<ActivityViewName, string> = {
  ships: "Activity as it ships: the chat's turns by day and its watches; helpers and jobs are read in the inspector's Work.",
  log: "One log for the workspace: now, what needs you, what is coming, and everything done, by its agent, helpers, jobs and watches.",
};

const KUMO_WHY: Record<KumoLook, string> = {
  ships: "Kinu's restyle: index.css's `!important` declarations on Kumo's select, popover, tooltip, meter, copy field, composer model and landing tabs.",
  own: "Kumo's own: those declarations taken out, and nothing else changed. What differs is all they do; what does not is safe to delete.",
};

const TIMES_WHY: Record<TimeWording, string> = {
  ships: "Each surface's own: the chat's clock (2:10 AM), the pill's \"3 min\", the jobs' \"in 3m\", the roster's \"3m ago\".",
  one: "One rule: \"just now\", \"12 min ago\" and \"in 20 min\" when near; the clock the same day; \"Yesterday, 4:10 PM\"; the weekday; the date.",
};

function summary(design: Design): string {
  return [LOOK_NAMES[design.look], design.mode, `${CHAT_FACES[design.font].label} (${design.scope})`, `background ${design.background}`, design.device, `activity ${design.activity}`, `times ${design.times}`, `kumo ${design.kumo}`].join(" · ");
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5 border-t p-border pt-3 first:border-t-0 first:pt-0">
      <h2 className="p-meta font-medium p-text-2">{title}</h2>
      {children}
    </section>
  );
}

export function DesignBar() {
  const design = useDesign();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);

  /** A switch, and the page that shows it when this one cannot: the background is drawn on New workspace alone. */
  const switchTo = (change: Partial<Design>, showing: string | null): Effect.Effect<void> => Effect.gen(function* () {
    setDesign(change);

    if (showing !== null) yield* Effect.promise(async () => navigate(showing));
  });

  // Folded, it stays clear of the page's own controls and names the design on screen on hover.
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} data-design-bar="closed" title={summary(design)}
        className="group fixed bottom-4 right-4 z-[80] flex items-center gap-2 rounded-full p-card border p-border px-3 py-2 text-xs p-shadow-overlay p-text">
        <PaletteIcon size={15} className="p-accent-fg" />
        <span className="font-semibold">Design</span>
        <span className="hidden p-text-3 group-hover:inline">{summary(design)}</span>
      </button>
    );
  }

  return (
    <aside data-design-bar aria-label="Design" className="fixed bottom-4 right-4 z-[80] max-h-[calc(100vh-2rem)] w-72 overflow-y-auto p-card border p-border p-4 p-shadow-overlay">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="min-w-0"><span className="block text-sm font-semibold p-text">Design</span><span className="block truncate p-meta p-text-3">{summary(design)}</span></span>
        <button type="button" onClick={() => setOpen(false)} aria-label="Hide the design bar" className="p-text-3 hover:p-text"><XIcon size={14} /></button>
      </div>
      <div className="space-y-3">
        <Section title="Switches">
          <Choice label="Palette" value={design.look} options={THEME_NAMES} name={(look) => LOOK_NAMES[look]} onPick={(look) => setDesign({ look })} />
          <Choice label="Mode" value={design.mode} options={MODES} name={(mode) => (mode === "light" ? "Light" : "Dark")} onPick={(mode) => setDesign({ mode })} />
          <Choice label="Font" value={design.font} options={CHAT_FACE_NAMES} name={(font) => CHAT_FACES[font].label} onPick={(font) => setDesign({ font })} />
          <Choice label="Font reaches" value={design.scope} options={FACE_SCOPES} name={(scope) => SCOPE_NAMES[scope]} onPick={(scope) => setDesign({ scope })} />
          <Choice label="Background on New workspace" value={design.background} options={BACKGROUNDS} name={(background) => BACKGROUND_NAMES[background]} onPick={(background) => detach(switchTo({ background }, pathname.startsWith(APP_ROUTES.newWorkspace) ? null : APP_ROUTES.newWorkspace))} />
          <p className="p-meta p-text-3" data-design-why="background">{BACKGROUND_WHY[design.background]}</p>
          <Choice label="Device" value={design.device} options={DEVICES} name={(device) => (device === "phone" ? "Phone" : "Desktop")} onPick={(device) => setDesign({ device })} />
          <Choice label="A workspace's Activity" value={design.activity} options={ACTIVITY_VIEWS} name={(view) => (view === "log" ? "Single log" : "As it ships")}
            onPick={(activity) => detach(switchTo({ activity }, pathname.endsWith("/activity") ? null : ACTIVITY_PAGE))} />
          <p className="p-meta p-text-3" data-design-why="activity">{ACTIVITY_WHY[design.activity]}</p>
          <Choice label="Times" value={design.times} options={TIME_WORDINGS} name={(times) => (times === "one" ? "One wording" : "As it ships")}
            onPick={(times) => detach(switchTo({ times }, pathname.endsWith("/activity") ? null : ACTIVITY_PAGE))} />
          <p className="p-meta p-text-3" data-design-why="times">{TIMES_WHY[design.times]}</p>
          <Choice label="Kumo's parts" value={design.kumo} options={KUMO_LOOKS} name={(kumo) => (kumo === "own" ? "Kumo's own" : "As it ships")} onPick={(kumo) => setDesign({ kumo })} />
          <p className="p-meta p-text-3" data-design-why="kumo">{KUMO_WHY[design.kumo]}</p>
        </Section>
        <Section title="Go to">
          <div className="flex flex-wrap gap-1">
            {ELSEWHERE.map(([label, path]) => (
              <button key={path} type="button" onClick={() => detachPromise(() => navigate(path))} className="rounded-md border p-border px-2 py-1 text-xs p-text-2 hover:p-text">{label}</button>
            ))}
          </div>
        </Section>
        {pathname.endsWith("/activity") && design.activity === "log" && (
          <Section title="This page's states">
            <ul className="space-y-0.5">
              {ACTIVITY_STATES.map((state) => (
                <li key={state.id}>
                  <button type="button" onClick={() => detachPromise(() => navigate(`${pathname}?activitystate=${state.id}`))} data-activity-state={state.id}
                    className="block w-full rounded-md px-2 py-1 text-left t-meta p-text-2 hover:bg-[var(--c-hover)] hover:p-text">{state.label}</button>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {pathname === "/deploy" && (
          <Section title="This page's states">
            <ul className="space-y-0.5">
              {/* The real page, read again from the start in each: its door answers the state's fixtures. */}
              {DEPLOY_FIXTURE_STATES.map((state) => (
                <li key={state.id}>
                  <a href={deployStateHref(state.id)} data-deploy-state={state.id} className="block w-full rounded-md px-2 py-1 text-left t-meta p-text-2 hover:bg-[var(--c-hover)] hover:p-text">{state.label}</a>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </aside>
  );
}

/** The phone: the same address in a 390-wide window of its own, its own viewport, without the bar; the bar stays here. */
export function PhoneWindow({ children }: { children: ReactNode }) {
  const design = useDesign();
  const navigate = useNavigate();

  // The page follows the window, so the address (and leaving the phone) holds the page the window is on.
  useEffect(() => {
    const stop = new AbortController();

    const follow = (event: MessageEvent): Effect.Effect<void> => {
      const place = v.safeParse(PlaceSchema, event.data);

      return event.origin === location.origin && place.success ? Effect.promise(async () => navigate(place.output.galleryAt, { replace: true })) : Effect.void;
    };

    window.addEventListener("message", (event) => detach(follow(event)), { signal: stop.signal });

    return () => stop.abort();
  }, [navigate]);

  // Opened again on each switch, at the page the address holds then; a page the window moves to never reloads it.
  const src = useMemo(() => {
    const params = new URLSearchParams(location.search);

    for (const [key, value] of Object.entries(design)) params.set(key, value);
    params.set("device", "frame");

    return `${location.pathname}?${params.toString()}`;
  }, [design]);

  return (
    <div className="flex min-h-screen items-center justify-center p-bg py-8">
      <iframe key={src} title="The app at phone width" src={src} width={390} height={844}
        className="rounded-[28px] border-8 border-[var(--c-fill)] p-shadow-overlay" />
      {children}
    </div>
  );
}
