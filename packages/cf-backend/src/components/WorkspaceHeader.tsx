/** The workspace's bar: its name, a browser-style tab per chat the person opened, then +. One hairline draws the
 *  bottom rule and the open tab's silhouette, and glides between tabs. */
import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { GearIcon, PencilSimpleIcon, PlusIcon, UsersThreeIcon, XIcon } from "@phosphor-icons/react";
import { WORKSPACE_TITLE_MAX, type PanelAgent } from "@kinu.run/core";
import { useRename } from "@/hooks/use-rename";
import { composing } from "@/components/ui/form";
import { TabOutline, useTabOutline } from "@/components/ui/TabOutline";
import { ChatMascot, WorkspaceLogo, mascotColour, mascotSeed } from "./Marks";
import type { ChatActions } from "@/hooks/use-agents-nav";
import { InspectorToggle, type InspectorControl } from "@/components/WorkbenchPanels";

type Rename = (name: string) => Promise<void>;

/** Without `rename` an item keeps its name; without `remove` it stays. */
interface BarItem {
  readonly key: string;
  readonly label: string;
  readonly to: string;
  readonly activity?: PanelAgent["activity"];
  readonly mascot?: { readonly seed: string; readonly colour: number };
  readonly logo?: string | null;
  readonly rename?: { readonly value: string; readonly save: Rename };
  readonly remove?: () => void;
  /** The × empties the chat instead of deleting it. */
  readonly clears?: boolean;
  readonly title?: boolean;
  /** A chat's path, `main` for Main: the handle flows and tests address a tab by. */
  readonly tab?: string;
}

export interface ChatTab extends ChatActions {
  readonly agent: PanelAgent;
  readonly to: string;
}

interface WorkspaceHeaderProps {
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
      key: agent.key, label: agent.label, to, activity: agent.activity, mascot: { seed: mascotSeed(workspace.name, agent.key), colour: mascotColour(workspace.name, agent.colour) }, rename: { value: agent.label, save: rename },
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
            {item.mascot !== undefined && <ChatMascot seed={item.mascot.seed} colour={item.mascot.colour} activity={item.activity} />}
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
  const { draft, setDraft, error, commit: commitName } = useRename(value, save, done);
  const commit = (): void => { commitName(draft); };

  return (
    <span className="p-bar-rename">
      <input autoFocus value={draft} maxLength={WORKSPACE_TITLE_MAX} aria-label={subject} placeholder={hint} size={Math.max(draft.length, hint.length, 6)}
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

/** The bar's trailing actions: every agent, with those at work out of sight counted; the workspace's settings; and, on a
 *  chat, the inspector's toggle. */
export function WorkspaceBarActions({ workspace, working, view, inspector, onAgents }: {
  workspace: string;
  /** The agents at work with no tab of their own. */
  working: number;
  view: string | undefined;
  inspector: InspectorControl | null;
  onAgents: () => void;
}) {
  return (
    <>
      <button type="button" onClick={onAgents} className="p-bar-icon relative" aria-label="All agents" title="All agents">
        <UsersThreeIcon size={16} />
        {/* The agents at work out of sight, those with no tab of their own, counted where the owner can open them. */}
        {working > 0 && (
          <span data-working-agents={working} className="p-agents-badge absolute -right-0.5 -top-0.5 min-w-[14px] rounded-full px-[3px] text-center text-[9px] font-semibold leading-[14px] tabular-nums">
            {working}
          </span>
        )}
      </button>
      <Link to={`/workspace/${workspace}/settings`} className="p-bar-icon" aria-current={view === "settings" ? "page" : undefined}
        aria-label="Workspace settings" title="Workspace settings"><GearIcon size={16} /></Link>
      {view === undefined && inspector && <InspectorToggle control={inspector} />}
    </>
  );
}
