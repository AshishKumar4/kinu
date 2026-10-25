/**
 * The slash commands every chat column runs (`SlashMenu`): its turn, its model and effort, its mode, and the words of its
 * conversation. A workspace's own chat adds the workspace's commands to these.
 */
import { Cause, Effect } from "effect";
import { conversationMarkdown, isReasoningEffort, lastAnswer, REASONING_EFFORTS, slashCommand, type ConversationMessage, type ReasoningEffort, type WorkMode } from "@kinu.run/core";
import { attempt, renderThrownChain, type KinuError } from "@kinu.run/core/obs";
import type { ComposerCommand } from "@/components/SlashMenu";
import { saveBlob } from "@/lib/workspace-archive";

export interface ChatCommandHandles {
  /** The whole conversation, oldest first, from its history pages; null while the chat's agent is not known yet. */
  readonly history: (() => Promise<readonly ConversationMessage[]>) | null;
  /** What its export is named by: its agent's name once the chat has read it, else the column's label. */
  readonly name: string | undefined;
  readonly label: string;
  readonly stop: () => void;
  readonly setModel: (spec: string) => Promise<string | null>;
  readonly setEffort: (effort: ReasoningEffort) => Promise<void>;
  readonly mode: WorkMode;
  readonly setMode: (mode: WorkMode) => void;
  /** Sends `words` as a message, in `mode` where one is named; false when the chat could not take them. */
  readonly send: (words: string, mode?: WorkMode) => boolean;
  /** The draft as sent, which a command that takes words clears once they are taken. */
  readonly draft: string;
  readonly setDraft: (draft: string) => void;
  /** Whether a turn runs, and how words run beside it where this chat can branch: the draft is cleared if the branch
   *  is taken, and kept, with the reason said, if it is refused. */
  readonly live: boolean;
  readonly branchBeside: ((words: string, draft: string) => void) | undefined;
  /** Says why a command did nothing, where the chat's notices are. */
  readonly say: (words: string) => void;
}

/** `effect` with any failure said where the chat's notices are: what a key or a press runs. */
function told(effect: Effect.Effect<void, unknown>, say: (words: string) => void): Effect.Effect<void> {
  return Effect.catchCause(effect, (failed) => Effect.sync(() => { say(renderThrownChain({ cause: Cause.squash(failed) })); }));
}

/** The whole conversation, read when a command needs it, with `use` given it. */
function conversation(at: ChatCommandHandles, use: (rows: readonly ConversationMessage[]) => Effect.Effect<void, KinuError>): Effect.Effect<void> {
  const { history } = at;

  if (history === null) return Effect.sync(() => { at.say("This chat's history has not loaded yet."); });

  return told(Effect.flatMap(Effect.promise(history), use), at.say);
}

/** `words` sent as a message, the draft cleared once they are taken; untaken, they stay where they were typed. */
function sent(at: ChatCommandHandles, words: string, mode?: WorkMode): void {
  if (at.send(words, mode)) at.setDraft("");
}

export function chatCommands(at: ChatCommandHandles): ComposerCommand[] {
  return [
    { ...slashCommand("/stop"), run: () => Effect.sync(at.stop) },
    { ...slashCommand("/model", "/model <model>"), run: (spec) => told(Effect.promise(async () => { await at.setModel(spec); }), at.say) },
    {
      ...slashCommand("/effort", "/effort <level>"),
      run: (level) => (isReasoningEffort(level)
        ? told(Effect.promise(async () => at.setEffort(level)), at.say)
        : Effect.sync(() => { at.say(`"${level}" is no effort level. Choose one of ${REASONING_EFFORTS.join(", ")}.`); })),
    },
    {
      ...slashCommand("/plan", "/plan [text]"),
      takesWords: true,
      run: (text) => Effect.sync(() => {
        at.setMode("plan");

        if (text === "") at.setDraft("");
        else sent(at, text, "plan");
      }),
    },
    {
      ...slashCommand("/branch", "/branch <text>"),
      takesWords: true,
      run: (words) => Effect.sync(() => {
        // With no turn to branch from, the words are a message of their own, as the CLI sends them.
        if (!at.live) sent(at, words);
        else if (at.mode === "plan") at.say("A Plan turn runs no branch beside it. Switch to Auto, or send the words to the running turn.");
        else if (at.branchBeside === undefined) at.say("This chat runs no branch beside its turn.");
        else at.branchBeside(words, at.draft);
      }),
    },
    {
      ...slashCommand("/copy"),
      run: () => conversation(at, (rows) => {
        const answer = lastAnswer(rows);

        if (answer === undefined) return Effect.sync(() => { at.say("This chat has no answer to copy yet."); });

        return attempt({ doing: "copying the last answer", otherwise: "unavailable" }, async () => navigator.clipboard.writeText(answer));
      }),
    },
    {
      ...slashCommand("/export"),
      run: () => conversation(at, (rows) => {
        const title = at.name ?? at.label;

        return saveBlob(new Blob([conversationMarkdown(title, rows)], { type: "text/markdown" }), `${title}.md`);
      }),
    },
  ];
}
