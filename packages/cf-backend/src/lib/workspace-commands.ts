/**
 * The slash commands a workspace's own chat adds to every chat's (`chatCommands`): its conversation, its name, the
 * surfaces beside it, and the settings it runs by. Each opens what the page already offers for it.
 */
import { Cause, Effect } from "effect";
import { APP_ROUTES, COMPACTED, DEFAULT_ROLE_ID, describeTakePick, hasComparableTakes, slashCommand, type AlternateTakeSet, type CompactOutcome, type ConversationMessage, type SurfaceKind, type TakePickOutcome, workspaceRoute } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import type { ComposerCommand } from "@/components/SlashMenu";
import type { ComposerNotice } from "@/components/Composer";
import { settingsPath } from "@/components/SettingsRail";

export interface WorkspaceCommandHandles {
  readonly workspace: string;
  /** The whole conversation, oldest first, from its history pages, never the window the tab holds; null while the
   *  chat's agent is not known yet. */
  readonly history: (() => Promise<readonly ConversationMessage[]>) | null;
  /** Asks to start a new conversation, as the chat's Clear does. */
  readonly clear: () => void;
  /** Folds the conversation into a summary, or arms its provider to; refused while a turn runs. */
  readonly compact: () => Promise<CompactOutcome>;
  /** Renames the chat's agent, as its tab's Rename does, saying why where it cannot. */
  readonly rename: (name: string) => Effect.Effect<void>;
  /** Asks to walk the chat back to just before message `id`, as its row's Revert does. */
  readonly walkBack: (id: string) => void;
  readonly show: (surface: SurfaceKind) => void;
  readonly go: (path: string) => Effect.Effect<void>;
  /** Says what a command did, or why it did nothing (the default); `detail` is what the notice says once opened. */
  readonly say: (words: string, tone?: "info", detail?: ComposerNotice["detail"]) => void;
  /** The tools this chat's agent has: built in (whether this turn's tool set wires each) and crafted. */
  readonly tools: () => Promise<{
    readonly builtIn: readonly { readonly name: string; readonly summary: string; readonly wired: boolean }[];
    readonly crafted: readonly { readonly name: string; readonly description: string }[];
  }>;
  /** The agent's active role, and choosing another, which applies from its next turn. */
  readonly role: { readonly current: () => Promise<string | null>; readonly choose: (id: string) => Promise<string> };
  /** The newest turn's alternate takes, if any; opening their comparison, and picking one. */
  readonly takes: {
    readonly latest: AlternateTakeSet | undefined;
    readonly open: (set: AlternateTakeSet) => void;
    readonly pick: (set: AlternateTakeSet, nodeId: string) => Promise<TakePickOutcome>;
  };
}

/** `run`, its failure said with `doing`. */
function told(at: WorkspaceCommandHandles, doing: string, run: () => Promise<void>): Effect.Effect<void> {
  return Effect.catchCause(Effect.promise(run), (failed) => Effect.sync(() => { at.say(`Could not ${doing}: ${renderThrownChain({ cause: Cause.squash(failed) })}`); }));
}

/** `/role` shows the active role; `/role <id>` chooses one, as the CLI's does. */
function roleCommand(at: WorkspaceCommandHandles): ComposerCommand {
  return {
    ...slashCommand("/role", "/role [id]"),
    run: (id) => (id === ""
      ? told(at, "read the role", async () => { at.say(`Role: ${await at.role.current() ?? DEFAULT_ROLE_ID}`, "info"); })
      : told(at, "choose the role", async () => { at.say(`Role: ${await at.role.choose(id)}. It applies from the next turn.`, "info"); })),
  };
}

/** `/takes` opens the newest comparison; `/takes <n>` picks its n-th take. */
function takesCommand(at: WorkspaceCommandHandles): ComposerCommand {
  return {
    ...slashCommand("/takes", "/takes [n]"),
    run: (n) => {
      const set = at.takes.latest;

      if (!hasComparableTakes(set)) return Effect.sync(() => { at.say("No alternate takes yet. They appear after a /branch redirect settles."); });

      if (n === "") return Effect.sync(() => { at.takes.open(set); });
      const index = Number(n);
      const candidate = Number.isInteger(index) ? set.candidates[index - 1] : undefined;

      if (candidate === undefined) return Effect.sync(() => { at.say(`No take "${n}". /takes lists ${String(set.candidates.length)}.`); });

      return told(at, "pick the take", async () => { at.say(describeTakePick(await at.takes.pick(set, candidate.nodeId), index), "info"); });
    },
  };
}

/** `/fork` and `/undo` walk back to just before the n-th of the owner's own messages from the newest, the newest by
 *  default; a steer joined a turn, not its own. */
function walkBackCommand(at: WorkspaceCommandHandles, name: "/fork" | "/undo"): ComposerCommand {
  return {
    ...slashCommand(name, `${name} [n]`),
    run: (count) => Effect.catchCause(Effect.flatMap(Effect.promise(async () => at.history?.() ?? []), (rows) => Effect.sync(() => {
      const back = count === "" ? 1 : Number(count);
      const sent = rows.filter((row) => row.role === "user" && row.steered !== true);
      const id = Number.isInteger(back) && back > 0 ? sent.at(-back)?.id : undefined;

      if (id === undefined) at.say(`This chat has ${String(sent.length)} of your messages to walk back before; "${count}" names none of them.`);
      else at.walkBack(id);
    })), (failed) => Effect.sync(() => { at.say(`Could not read this chat's history: ${renderThrownChain({ cause: Cause.squash(failed) })}`); })),
  };
}

/** `/tools` names each tool the agent can use and what it is for, as the CLI lists them. */
function toolsCommand(at: WorkspaceCommandHandles): ComposerCommand {
  return {
    ...slashCommand("/tools"),
    run: () => told(at, "list the tools", async () => {
      const { builtIn, crafted } = await at.tools();
      const wired = builtIn.filter((tool) => tool.wired);
      const facts = [...wired.map((tool) => [tool.name, tool.summary] as const), ...crafted.map((tool) => [tool.name, tool.description] as const)];

      at.say(`${String(facts.length)} tools: ${String(wired.length)} built in, ${String(crafted.length)} crafted.`, "info", { facts });
    }),
  };
}

export function workspaceCommands(at: WorkspaceCommandHandles): ComposerCommand[] {
  const settings = workspaceRoute(at.workspace, "settings");

  const go = (path: string) => () => at.go(path);

  const show = (surface: SurfaceKind) => () => Effect.sync(() => { at.show(surface); });

  return [
    { ...slashCommand("/clear"), run: () => Effect.sync(at.clear) },
    {
      ...slashCommand("/compact"),
      run: () => Effect.matchCause(Effect.promise(at.compact), {
        onSuccess: (outcome) => { at.say(COMPACTED[outcome], outcome === "nothing" ? undefined : "info"); },
        onFailure: (failed) => { at.say(`Could not compact this conversation: ${renderThrownChain({ cause: Cause.squash(failed) })}`); },
      }),
    },
    { ...slashCommand("/rename", "/rename <name>"), run: at.rename },
    walkBackCommand(at, "/fork"),
    // The walk-back offers the files' restore wherever the device keeps their checkpoints.
    walkBackCommand(at, "/undo"),
    roleCommand(at),
    takesCommand(at),
    toolsCommand(at),
    { ...slashCommand("/status"), run: show("Agent") },
    { ...slashCommand("/refine"), run: show("Agent") },
    { ...slashCommand("/tree"), run: show("Swarms") },
    { ...slashCommand("/jobs"), run: show("Work") },
    { ...slashCommand("/memory"), run: show("Agent") },
    { ...slashCommand("/changelog"), run: show("Agent") },
    { ...slashCommand("/settings"), run: go(settings) },
    { ...slashCommand("/approval"), run: go(settings) },
    { ...slashCommand("/advisor"), run: go(settings) },
    { ...slashCommand("/instructions"), run: go(`${settings}#instructions`) },
    { ...slashCommand("/always"), run: go(`${settings}#always-active`) },
    { ...slashCommand("/stats"), run: go(settingsPath("usage")) },
    { ...slashCommand("/accounts"), run: go(settingsPath("providers")) },
    { ...slashCommand("/models"), run: go(settingsPath("models")) },
    { ...slashCommand("/connect"), run: go(settingsPath("devices")) },
    { ...slashCommand("/theme"), run: go(settingsPath("appearance")) },
    { ...slashCommand("/resume"), run: go(APP_ROUTES.workspaces) },
  ];
}
