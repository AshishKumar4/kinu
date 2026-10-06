/** The workspace's bar: its name, a browser-style tab per chat the person opened, then +. One hairline draws the
 *  bottom rule and the open tab's silhouette, and glides between tabs. */
import { Effect } from "effect";
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link } from "react-router-dom";
import { PencilSimpleIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import type { PanelAgent } from "@kinu.run/core";
import { detach, showing } from "@kinu.run/core/obs";
import { composing } from "@/components/ui/form";
import { ChatMascot, WorkspaceLogo, mascotSeed } from "./Marks";

type Rename = (name: string) => Promise<void>;

/** Without `rename` an item keeps its name; without `remove` it stays. */
interface BarItem {
  readonly key: string;
  readonly label: string;
  readonly to: string;
  readonly activity?: PanelAgent["activity"];
  readonly mascot?: string;
  readonly logo?: string | null;
  readonly rename?: { readonly value: string; readonly save: Rename };
  readonly remove?: () => void;
  /** The × empties the chat instead of deleting it. */
  readonly clears?: boolean;
  readonly title?: boolean;
  /** A chat's path, `main` for Main: the handle flows and tests address a tab by. */
  readonly tab?: string;
}

export interface ChatTab {
  readonly agent: PanelAgent;
  readonly to: string;
  readonly rename: Rename;
  readonly remove?: () => void;
  readonly clears?: boolean;
}

export interface WorkspaceHeaderProps {
  readonly workspace: { readonly name: string; readonly title: string; readonly logo?: string | null; readonly to: string; readonly rename: Rename; readonly editValue: string; readonly remove: () => void };
  readonly chats: readonly ChatTab[];
  /** `overview` for the workspace's own page; null when the shown chat has no tab. */
  readonly active: string | null;
  readonly newChat: string;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
}

export function WorkspaceHeader({ workspace, chats, active, newChat, leading, trailing }: WorkspaceHeaderProps) {
  const items: BarItem[] = [
    { key: "overview", label: workspace.title, logo: workspace.logo ?? null, to: workspace.to, title: true, rename: { value: workspace.editValue, save: workspace.rename }, remove: workspace.remove },
    ...chats.map(({ agent, to, rename, remove, clears }) => ({
      key: agent.key, label: agent.label, to, activity: agent.activity, mascot: mascotSeed(workspace.name, agent.key), rename: { value: agent.label, save: rename },
      ...(remove && { remove }), ...(clears === true && { clears }),
      tab: agent.open.kind === "chat" ? agent.open.path ?? "main" : agent.key,
    })),
  ];

  const strip = useRef<HTMLUListElement>(null);
  const outline = useTabOutline(strip, active, items.map((item) => `${item.key}:${item.label}`).join("|"));

  return (
    <header className="p-bar" data-workspace-bar>
      {leading && <div className="p-bar-menu">{leading}</div>}
      <nav className="p-bar-strip" data-overflow={outline.overflow} aria-label="Chats">
        <ul ref={strip} className="p-bar-tabs">
          {items.map((item, index) => (
            <BarTab key={item.key} item={item} active={item.key === active} afterActive={index > 0 && items[index - 1]?.key === active} />
          ))}
          <li className="p-bar-new">
            <Link to={newChat} className="p-bar-icon" aria-label="New chat" title="New chat"><PlusIcon size={15} /></Link>
          </li>
          <TabOutline outline={outline} />
        </ul>
      </nav>
      {trailing && <div className="p-bar-trailing">{trailing}</div>}
    </header>
  );
}

function BarTab({ item, active, afterActive }: { item: BarItem; active: boolean; afterActive: boolean }) {
  const [editing, setEditing] = useState(false);

  return (
    <li className="p-bar-tab p-halo" data-key={item.key} data-agent-tab={item.tab} data-status={item.activity} data-active={active ? "" : undefined}
      data-after-active={afterActive ? "" : undefined} data-title={item.title === true ? "" : undefined}>
      {editing && item.rename ? (
        <RenameField value={item.rename.value} hint={item.label} subject={item.title ? "Workspace name" : "Chat name"} save={item.rename.save} done={() => setEditing(false)} />
      ) : (
        <>
          {/* Sizes the tab to its label at rest, so revealing the actions ellipsizes the label instead of moving the strip. */}
          <span className="p-bar-sizer" aria-hidden>
            {(item.mascot !== undefined || item.title === true) && <span className="p-mascot" />}
            {item.label}
          </span>
          <Link to={item.to} className="p-bar-link" aria-current={active ? "page" : undefined}
            title={item.title ? "Workspace overview" : undefined}>
            {item.mascot !== undefined && <ChatMascot seed={item.mascot} activity={item.activity} />}
            {item.title === true && <WorkspaceLogo title={item.label} logo={item.logo} />}
            <span className="p-status-label truncate">{item.label}</span>
          </Link>
          {(item.rename !== undefined || item.remove !== undefined) && (
            <span className="p-bar-actions">
              {item.rename && (
                <button type="button" className="p-bar-action" onClick={() => setEditing(true)}
                  aria-label={`Rename ${item.label}`} title="Rename"><PencilSimpleIcon size={12} /></button>
              )}
              {item.remove && (
                <button type="button" className="p-bar-action" data-danger onClick={item.remove}
                  aria-label={`${item.clears === true ? "Clear" : "Delete"} ${item.label}`} title={item.clears === true ? "Clear" : "Delete"}><XIcon size={12} /></button>
              )}
            </span>
          )}
        </>
      )}
    </li>
  );
}

function RenameField({ value, hint, subject, save, done }: { value: string; hint: string; subject: string; save: Rename; done: () => void }) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);

  const commit = useCallback(() => detach(Effect.gen(function* () {
    const name = draft.trim();

    if (saving.current) return;

    if (name === "" || name === value) {
      done();

      return;
    }

    saving.current = true;

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(async () => save(name));
      done();
    }), showing(setError)), Effect.sync(() => { saving.current = false; }));
  })), [draft, value, save, done]);

  return (
    <span className="p-bar-rename">
      <input autoFocus value={draft} maxLength={60} aria-label={subject} placeholder={hint} size={Math.max(draft.length, hint.length, 6)}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (composing(event.nativeEvent)) return;

          if (event.key === "Enter") commit();

          if (event.key === "Escape") done();
        }} />
      {error && <span role="alert" data-failure className="p-bar-rename-error">{error}</span>}
    </span>
  );
}

type Overflow = "none" | "start" | "end" | "both";

function overflowOf(list: HTMLElement): Overflow {
  const start = list.scrollLeft > 1;
  const end = list.scrollWidth - list.clientWidth - list.scrollLeft > 1;

  if (start && end) return "both";

  if (start) return "start";

  return end ? "end" : "none";
}

/** The open tab's edges in the strip's content; with none, the rule runs flat. */
interface OutlineGeometry { readonly left: number; readonly right: number; readonly width: number }

const FLARE = 8;

interface TabOutlineState {
  readonly geometry: OutlineGeometry | null;
  readonly glide: boolean;
  readonly overflow: Overflow;
  readonly settle: () => void;
}

/** One hairline in five parts: rule, concave flare, the tab's body, flare, rule. */
function TabOutline({ outline }: { outline: TabOutlineState }) {
  const { geometry, glide, settle } = outline;

  if (geometry === null) return null;
  const { left, right, width } = geometry;
  const flat = left === right;

  return (
    <li aria-hidden className="p-bar-outline" style={{ width }} data-glide={glide ? "" : undefined} onTransitionEnd={settle}>
      <span data-part="arm-start" style={{ width: flat ? width : left + 1 }} />
      {!flat && <>
        <span data-part="flare-start" style={{ left: left + 1 }} />
        <span data-part="body" style={{ left: left + FLARE, width: right - left - 2 * FLARE }} />
        <span data-part="flare-end" style={{ left: right - FLARE - 1 }} />
        <span data-part="arm-end" style={{ left: right - 1 }} />
      </>}
    </li>
  );
}

/**
 * Measures the open tab inside the strip's scrolled content. Only a selection change glides; a resize, a rename or
 * the first paint lands in place, so nothing moves that the person did not move.
 */
function useTabOutline(strip: RefObject<HTMLUListElement | null>, active: string | null, layout: string): TabOutlineState {
  const [geometry, setGeometry] = useState<OutlineGeometry | null>(null);
  const [glide, setGlide] = useState(false);
  const [overflow, setOverflow] = useState<Overflow>("none");
  const shownKey = useRef<string | null>(null);

  useLayoutEffect(() => {
    const list = strip.current;

    if (list === null) return undefined;
    const tab = active === null ? null : list.querySelector<HTMLElement>(`[data-key="${CSS.escape(active)}"]`);

    const place = () => {
      const last = list.querySelector<HTMLElement>(".p-bar-new");
      const width = Math.max(list.clientWidth, (last?.offsetLeft ?? 0) + (last?.offsetWidth ?? 0));

      setGeometry(tab === null ? { left: width, right: width, width } : { left: tab.offsetLeft, right: tab.offsetLeft + tab.offsetWidth, width });
      setOverflow(overflowOf(list));
    };

    if (shownKey.current !== null && active !== null && shownKey.current !== active) setGlide(true);
    shownKey.current = active;
    place();

    if (tab !== null) list.scrollLeft = Math.min(tab.offsetLeft, Math.max(list.scrollLeft, tab.offsetLeft + tab.offsetWidth - list.clientWidth));

    const observer = new ResizeObserver(place);
    const scrolled = () => setOverflow(overflowOf(list));

    observer.observe(list);

    for (const child of list.children) observer.observe(child);

    list.addEventListener("scroll", scrolled, { passive: true });

    return () => {
      observer.disconnect();
      list.removeEventListener("scroll", scrolled);
    };
  }, [strip, active, layout]);

  return { geometry, glide, overflow, settle: () => setGlide(false) };
}
