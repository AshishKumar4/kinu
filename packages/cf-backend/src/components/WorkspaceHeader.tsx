/** The workspace's bar: its name, a browser-style tab per chat the person opened, then +. One hairline draws the
 *  bottom rule and the open tab's silhouette, and glides between tabs. */
import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChatsCircleIcon, GearIcon, PencilSimpleIcon, PlusIcon, UsersThreeIcon, XIcon } from "@phosphor-icons/react";
import { WORKSPACE_TITLE_MAX, type PanelAgent } from "@kinu.run/core";
import { useRename } from "@/hooks/use-rename";
import { composing } from "@/components/ui/form";
import { TabOutline, useTabOutline } from "@/components/ui/TabOutline";
import { ChatMascot, WorkspaceLogo } from "@/components/ui/Marks";
import { useMascotOf } from "@/hooks/use-chat-mascot";
import type { ChatActions } from "@/hooks/use-agents-nav";
import { InspectorToggle, type InspectorControl } from "@/components/WorkbenchPanels";
import { IconControl, IconLink } from "@/components/ui/IconControl";
import { PressableLink } from "@/components/ui/Pressable";
import { Count } from "@/components/ui/Badge";
import { BarRename } from "@/components/ui/ChromeButton";

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
  const mascotOf = useMascotOf(workspace.name);

  const items: BarItem[] = [
    { key: "overview", label: workspace.title, logo: workspace.logo ?? null, to: workspace.to, title: true, rename: { value: workspace.editValue, save: workspace.rename }, remove: workspace.remove },
    ...chats.map(({ agent, to, rename, remove, clears }) => ({
      key: agent.key, label: agent.label, to, activity: agent.activity, mascot: mascotOf(agent.key, agent.colour), rename: { value: agent.label, save: rename },
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
            <IconLink place="bar" to={newChat} aria-label="New chat" title="New chat"><PlusIcon size={15} /></IconLink>
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
                <IconControl place="tab" onClick={() => setEditing(true)} aria-label={`Rename ${item.label}`} title="Rename"><PencilSimpleIcon size={12} /></IconControl>
              )}
              {item.remove && (
                <IconControl place="tab" danger onClick={item.remove} aria-label={`${item.clears === true ? "Clear" : "Delete"} ${item.label}`} title={item.clears === true ? "Clear" : "Delete"}><XIcon size={12} /></IconControl>
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
      <BarRename autoFocus value={draft} maxLength={WORKSPACE_TITLE_MAX} aria-label={subject} placeholder={hint} size={Math.max(draft.length, hint.length, 6)}
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
      <IconControl place="bar" className="relative" onClick={onAgents} aria-label="All agents" title="All agents">
        <UsersThreeIcon size={16} />
        {/* The agents at work out of sight, those with no tab of their own, counted where the owner can open them. */}
        {working > 0 && (
          <Count count={working} tone="bar" data-working-agents={working} />
        )}
      </IconControl>
      <IconLink place="bar" to={`/workspace/${workspace}/settings`} aria-current={view === "settings" ? "page" : undefined} aria-label="Workspace settings" title="Workspace settings"><GearIcon size={16} /></IconLink>
      {view === undefined && inspector && <InspectorToggle control={inspector} />}
    </>
  );
}

/**
 * The bar of a workspace in the `focus` layout: who you are talking to, and what they are doing, in place of the chat
 * tabs; the tabs, the agents and the inspector one click away at its end.
 */
export function FocusBar({ workspace, agent, line, leading, trailing, tabs }: {
  workspace: { readonly name: string; readonly title: string; readonly logo?: string | null; readonly to: string };
  /** The chat shown: the workspace's main agent unless another is open. */
  agent: { readonly label: string; readonly seed: string; readonly colour: number; readonly activity?: PanelAgent["activity"] };
  /** What it is doing now, or what it watches while idle. */
  line: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Shows the chat tabs; absent when the workspace has one chat. */
  tabs?: { readonly count: number; readonly show: () => void };
}) {
  return (
    <header className="p-bar" data-workspace-bar data-layout="focus">
      {leading && <div className="p-bar-menu">{leading}</div>}
      <div className="flex min-w-0 flex-1 items-center gap-3 pl-4">
        <PressableLink to={workspace.to} className="flex w-auto min-w-0 items-center gap-3 py-1 pr-2"
          title={`${agent.label}: what it did and is doing`} data-focus-identity>
          <ChatMascot seed={agent.seed} colour={agent.colour} activity={agent.activity} size={24} />
          <span className="flex min-w-0 flex-col">
            <span className="t-label truncate p-text">{agent.label}</span>
            <span className="t-meta truncate p-text-3" data-focus-line>{line}</span>
          </span>
        </PressableLink>
      </div>
      <div className="p-bar-trailing">
        {tabs !== undefined && (
          <IconControl place="bar" className="relative" onClick={tabs.show} aria-label={`Show the ${String(tabs.count)} chats`} title="Show chats" data-focus-tabs>
            <ChatsCircleIcon size={16} />
            <Count count={tabs.count} tone="quiet" />
          </IconControl>
        )}
        {trailing}
      </div>
    </header>
  );
}
