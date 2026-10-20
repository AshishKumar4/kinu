/**
 * The whole app's design bar (gallery-app.tsx): the owner's live switches, each a parameter of the gallery's own address
 * so one setting holds from page to page and survives a reload, and the review's ways to the pages no sidebar links.
 * Review chrome, never product: the app's own stores do the switching (its theme store for look and mode, `data-layout`
 * for PageHeader's margins, `data-chat-font` for gallery-chat-fonts.ts).
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { PaletteIcon, XIcon } from "@phosphor-icons/react";
import { Effect } from "effect";
import * as v from "valibot";
import { detach } from "@kinu.run/core/obs";
import { THEME_NAMES, type ThemeName } from "@kinu.run/core";
import { setMode, wearTheme, type ThemeMode } from "@/hooks/use-theme";
import { CHAT_FACES, CHAT_FACE_NAMES, installChatFaces, type ChatFaceName } from "@/gallery-chat-fonts";
import { SELF_DEPLOY_STATES } from "@/gallery-self-deploy";

const LAYOUTS = ["today", "a", "b"] as const;

type Layout = (typeof LAYOUTS)[number];

const DEVICES = ["desktop", "phone"] as const;

type Device = (typeof DEVICES)[number];

export interface Design {
  readonly look: ThemeName;
  readonly mode: ThemeMode;
  readonly layout: Layout;
  readonly font: ChatFaceName;
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
    look: oneOf(params.get("look"), THEME_NAMES, "warm"),
    mode: oneOf(params.get("mode"), MODES, preferredMode()),
    layout: oneOf(params.get("layout"), LAYOUTS, "today"),
    font: oneOf(params.get("font"), CHAT_FACE_NAMES, "schibsted"),
    device: oneOf(params.get("device"), DEVICES, "desktop"),
  };
}

const listeners = new Set<() => void>();

let current: Design = readDesign();

/** The design on the page: the theme store's look and mode, the margins and the chat face. */
function apply(design: Design): void {
  const root = document.documentElement;

  wearTheme(design.look);
  setMode(design.mode);

  if (design.layout === "today") delete root.dataset.layout;
  else root.dataset.layout = design.layout;

  if (design.font === "schibsted") delete root.dataset.chatFont;
  else root.dataset.chatFont = design.font;
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

const LAYOUT_NAMES: Record<Layout, string> = { today: "Today", a: "A: each centred", b: "B: one frame" };

const LOOK_NAMES: Record<ThemeName, string> = { graphite: "Graphite", warm: "Warm" };

/** Pages no sidebar links: onboarding and self-deploy. Every other page is reached through the app's own sidebar. */
const ELSEWHERE: readonly (readonly [string, string])[] = [["Home", "/"], ["Onboarding", "/welcome"], ["Self-deploy", "/deploy"]];

function summary(design: Design): string {
  return [LOOK_NAMES[design.look], design.mode, LAYOUT_NAMES[design.layout].split(":")[0], CHAT_FACES[design.font].label, design.device].join(" · ");
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

  // Folded, it names the design on screen, so a page is never read without knowing what it wears.
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} data-design-bar="closed"
        className="fixed bottom-4 right-4 z-[80] flex items-center gap-2 rounded-full p-card border p-border px-3 py-2 text-xs p-shadow-overlay p-text">
        <PaletteIcon size={15} className="p-accent" />
        <span className="font-semibold">Design</span>
        <span className="p-text-3">{summary(design)}</span>
      </button>
    );
  }

  return (
    <aside data-design-bar aria-label="Design" className="fixed bottom-4 right-4 z-[80] max-h-[calc(100vh-2rem)] w-72 overflow-y-auto p-card border p-border p-4 p-shadow-overlay">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold p-text">Design</span>
        <button type="button" onClick={() => setOpen(false)} aria-label="Hide the design bar" className="p-text-3 hover:p-text"><XIcon size={14} /></button>
      </div>
      <div className="space-y-3">
        <Section title="Switches">
          <Choice label="Palette" value={design.look} options={THEME_NAMES} name={(look) => LOOK_NAMES[look]} onPick={(look) => setDesign({ look })} />
          <Choice label="Mode" value={design.mode} options={MODES} name={(mode) => (mode === "light" ? "Light" : "Dark")} onPick={(mode) => setDesign({ mode })} />
          <Choice label="Margins" value={design.layout} options={LAYOUTS} name={(layout) => LAYOUT_NAMES[layout]} onPick={(layout) => setDesign({ layout })} />
          <Choice label="Chat font" value={design.font} options={CHAT_FACE_NAMES} name={(font) => CHAT_FACES[font].label} onPick={(font) => setDesign({ font })} />
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
