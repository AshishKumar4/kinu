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
import { detach } from "@kinu.run/core/obs";
import { APP_ROUTES, DEFAULT_THEME, THEME_NAMES, type ThemeName } from "@kinu.run/core";
import { setMode, wearTheme, type ThemeMode } from "@/hooks/use-theme";
import { CHAT_FACES, CHAT_FACE_NAMES, FACE_SCOPES, installChatFaces, type ChatFaceName, type FaceScope } from "@/gallery-chat-fonts";
import { SELF_DEPLOY_STATES } from "@/gallery-self-deploy";

const BACKGROUNDS = ["today", "quiet", "none"] as const;

type Background = (typeof BACKGROUNDS)[number];

const DEVICES = ["desktop", "phone"] as const;

type Device = (typeof DEVICES)[number];

export interface Design {
  readonly look: ThemeName;
  readonly mode: ThemeMode;
  readonly font: ChatFaceName;
  readonly scope: FaceScope;
  readonly background: Background;
  readonly device: Device;
}

const MODES = ["light", "dark"] as const satisfies readonly ThemeMode[];

function oneOf<T extends string>(said: string | null, options: readonly T[], fallback: T): T {
  return options.find((each) => each === said) ?? fallback;
}

function preferredMode(): ThemeMode {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
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
  };
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

function summary(design: Design): string {
  return [LOOK_NAMES[design.look], design.mode, `${CHAT_FACES[design.font].label} (${design.scope})`, `background ${design.background}`, design.device].join(" · ");
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
        <PaletteIcon size={15} className="p-accent" />
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
        </Section>
        <Section title="Go to">
          <div className="flex flex-wrap gap-1">
            {ELSEWHERE.map(([label, path]) => (
              <button key={path} type="button" onClick={() => detach(Effect.promise(async () => navigate(path)))} className="rounded-md border p-border px-2 py-1 text-xs p-text-2 hover:p-text">{label}</button>
            ))}
          </div>
        </Section>
        {pathname === "/deploy" && (
          <Section title="This page's states">
            <ul className="space-y-0.5">
              {SELF_DEPLOY_STATES.map((state) => (
                <li key={state.label}>
                  <button type="button" onClick={state.open} className="w-full rounded-md px-2 py-1 text-left text-xs p-text-2 hover:bg-[var(--c-elevated)] hover:p-text">{state.label}</button>
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
        className="rounded-[28px] border-8 border-[var(--c-elevated)] p-shadow-overlay" />
      {children}
    </div>
  );
}
