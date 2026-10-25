/**
 * The slash commands a workspace's own chat adds to every chat's (`chatCommands`): its conversation, its name, the
 * surfaces beside it, and the settings it runs by. Each opens what the page already offers for it.
 */
import { Cause, Effect } from "effect";
import { APP_ROUTES, slashCommand, type ConversationMessage, type SurfaceKind } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import type { ComposerCommand } from "@/components/SlashMenu";
import { settingsPath } from "@/components/SettingsRail";

export interface WorkspaceCommandHandles {
  readonly workspace: string;
  /** The whole conversation, oldest first, from its history pages, never the window the tab holds; null while the
   *  chat's agent is not known yet. */
  readonly history: (() => Promise<readonly ConversationMessage[]>) | null;
  /** Asks to start a new conversation, as the chat's Clear does. */
  readonly clear: () => void;
  /** Renames the chat's agent, as its tab's Rename does, saying why where it cannot. */
  readonly rename: (name: string) => Effect.Effect<void>;
  /** Asks to walk the chat back to just before message `id`, as its row's Revert does. */
  readonly walkBack: (id: string) => void;
  readonly show: (surface: SurfaceKind) => void;
  readonly go: (path: string) => Effect.Effect<void>;
  readonly say: (words: string) => void;
}

export function workspaceCommands(at: WorkspaceCommandHandles): ComposerCommand[] {
  const settings = `/workspace/${at.workspace}/settings`;

  const go = (path: string) => () => at.go(path);

  const show = (surface: SurfaceKind) => () => Effect.sync(() => { at.show(surface); });

  return [
    { ...slashCommand("/clear"), run: () => Effect.sync(at.clear) },
    { ...slashCommand("/rename", "/rename <name>"), run: at.rename },
    {
      ...slashCommand("/fork", "/fork [n]"),
      // The n-th of the owner's own messages from the newest, the newest by default; a steer joined a turn, not its own.
      run: (count) => Effect.catchCause(Effect.flatMap(Effect.promise(async () => at.history?.() ?? []), (rows) => Effect.sync(() => {
        const back = count === "" ? 1 : Number(count);
        const sent = rows.filter((row) => row.role === "user" && row.steered !== true);
        const id = Number.isInteger(back) && back > 0 ? sent.at(-back)?.id : undefined;

        if (id === undefined) at.say(`This chat has ${String(sent.length)} of your messages to walk back before; "${count}" names none of them.`);
        else at.walkBack(id);
      })), (failed) => Effect.sync(() => { at.say(`Could not read this chat's history: ${renderThrownChain({ cause: Cause.squash(failed) })}`); })),
    },
    { ...slashCommand("/tree"), run: show("Swarms") },
    { ...slashCommand("/jobs"), run: show("Work") },
    { ...slashCommand("/memory"), run: show("Agent") },
    { ...slashCommand("/changelog"), run: show("Agent") },
    { ...slashCommand("/settings"), run: go(settings) },
    { ...slashCommand("/approval"), run: go(settings) },
    { ...slashCommand("/advisor"), run: go(settings) },
    { ...slashCommand("/stats"), run: go(settingsPath("usage")) },
    { ...slashCommand("/accounts"), run: go(settingsPath("providers")) },
    { ...slashCommand("/models"), run: go(settingsPath("models")) },
    { ...slashCommand("/connect"), run: go(settingsPath("devices")) },
    { ...slashCommand("/theme"), run: go(settingsPath("appearance")) },
    { ...slashCommand("/resume"), run: go(APP_ROUTES.workspaces) },
  ];
}
