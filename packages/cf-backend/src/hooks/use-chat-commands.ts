/** A chat column's slash commands (`SlashMenu`): every chat's, then its workspace's own, and why the last did nothing. */
import { useCallback, useState } from "react";
import { Effect } from "effect";
import { detach } from "@kinu.run/core/obs";
import type { ComposerNotice } from "@/components/Composer";
import { useSlashMenu, type ComposerCommand, type SlashMenuControl } from "@/components/SlashMenu";
import { chatCommands, type ChatCommandHandles } from "@/lib/chat-commands";

export interface ChatCommandsControl {
  readonly slash: SlashMenuControl;
  /** What the column's Send does: runs the command its draft names, else sends the draft. */
  readonly submit: () => void;
  /** Why the last command did nothing, until it is dismissed or another runs. */
  readonly notices: readonly ComposerNotice[];
}

export function useChatCommands(input: {
  readonly chat: Omit<ChatCommandHandles, "say">;
  /** The workspace's own, told how to say what one did or why it did nothing. */
  readonly own: ((say: (words: string, tone?: "info") => void) => readonly ComposerCommand[]) | undefined;
  readonly draft: string;
  readonly send: () => void;
}): ChatCommandsControl {
  const [said, setSaid] = useState<{ readonly words: string; readonly tone: "info" | "warning" } | null>(null);
  const say = (words: string, tone: "info" | "warning" = "warning"): void => { setSaid({ words, tone }); };

  const commands = [...chatCommands({ ...input.chat, say }), ...input.own?.(say) ?? []]
    .map((command): ComposerCommand => ({ ...command, run: (argument) => Effect.andThen(Effect.sync(() => { setSaid(null); }), command.run(argument)) }));

  const slash = useSlashMenu({ commands, draft: input.draft, setDraft: input.chat.setDraft });
  const { send } = input;

  const submit = useCallback(() => {
    const named = slash.commandOf();

    if (named === null) {
      send();

      return;
    }

    detach(named);
  }, [slash, send]);

  return {
    slash,
    submit,
    notices: said === null ? [] : [{ id: "command", tone: said.tone, text: said.words, onDismiss: () => { setSaid(null); }, hooks: { "data-command-notice": "" } }],
  };
}
