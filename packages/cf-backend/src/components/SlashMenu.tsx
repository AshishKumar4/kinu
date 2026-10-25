/**
 * A chat's slash commands, as its composer offers them: a draft that is one word starting with `/` lists the commands it
 * matches over the field, ranked as the CLI's palette ranks them; arrows move, Tab completes, Enter runs, Escape closes.
 * A sent draft whose first word names a command runs it instead of being sent; any other draft starting with `/` (a
 * path, say) is sent as it is.
 */
import { Effect } from "effect";
import { useId, useState, type KeyboardEvent } from "react";
import { filterCommands, type SlashCommandInfo } from "@kinu.run/core";
import { detach } from "@kinu.run/core/obs";

export interface ComposerCommand extends SlashCommandInfo {
  /** What it does with the words after its name (empty when there are none), having answered every failure. */
  readonly run: (argument: string) => Effect.Effect<void>;
  /** It clears the draft itself once its words are taken, so words the chat does not take stay in the field. */
  readonly takesWords?: true;
}

/** Whether `command` needs words after its name before it runs: its usage names one in angle brackets. */
function needsArgument(command: SlashCommandInfo): boolean {
  return command.usage?.includes("<") === true;
}

/** The command a draft's first word names, exactly or by an alias, and the words after it; null for a draft naming none. */
function namedIn(commands: readonly ComposerCommand[], draft: string): { readonly command: ComposerCommand; readonly argument: string } | null {
  const trimmed = draft.trim();

  if (!trimmed.startsWith("/")) return null;
  const word = trimmed.split(/\s/u, 1)[0] ?? "";
  const name = word.toLowerCase();
  const command = commands.find((each) => each.name === name || each.aliases?.some((alias) => alias === name) === true);

  // The words after the name as typed, past the one space or line that parts them: their lines and indents are theirs.
  return command === undefined ? null : { command, argument: trimmed.slice(word.length).replace(/^[^\S\n]*\n?/u, "") };
}

export interface SlashMenuControl {
  /** The commands the draft matches, while the menu is open; empty while it is closed. */
  readonly offered: readonly ComposerCommand[];
  readonly highlighted: ComposerCommand | undefined;
  readonly listId: string;
  readonly optionId: (command: ComposerCommand) => string;
  readonly choose: (command: ComposerCommand) => Effect.Effect<void>;
  /** What a key the open menu answers does; null for a key that is not the menu's. */
  readonly onKey: (event: KeyboardEvent<HTMLTextAreaElement>) => Effect.Effect<void> | null;
  /** What a sent draft does when it names a command, which it is then not sent; null for one naming none. */
  readonly commandOf: () => Effect.Effect<void> | null;
}

export function useSlashMenu({ commands, draft, setDraft }: {
  commands: readonly ComposerCommand[];
  draft: string;
  setDraft: (draft: string) => void;
}): SlashMenuControl {
  const listId = useId();
  // The highlight and the close belong to the draft they were made on: a new keystroke starts from the best match.
  const [pick, setPick] = useState({ draft: "", index: 0 });
  const [closedOn, setClosedOn] = useState<string | null>(null);
  const matched = commands.length > 0 && /^\/\S*$/u.test(draft) && closedOn !== draft ? filterCommands(commands, draft) : [];
  const index = pick.draft === draft ? Math.min(pick.index, matched.length - 1) : 0;
  const highlighted = matched[index];

  const run = (command: ComposerCommand, argument: string): Effect.Effect<void> => (command.takesWords === true
    ? command.run(argument)
    : Effect.andThen(Effect.sync(() => { setDraft(""); }), command.run(argument)));

  // One that needs words is completed for them instead.
  const choose = (command: ComposerCommand): Effect.Effect<void> => (needsArgument(command) ? Effect.sync(() => { setDraft(`${command.name} `); }) : run(command, ""));

  const keyed = (key: string, shift: boolean, chosen: ComposerCommand): Effect.Effect<void> | null => {
    if (key === "ArrowDown" || key === "ArrowUp") {
      const by = key === "ArrowDown" ? 1 : -1;

      return Effect.sync(() => { setPick({ draft, index: (index + by + matched.length) % matched.length }); });
    }

    if (key === "Tab") return Effect.sync(() => { setDraft(`${chosen.name} `); });

    if (key === "Escape") return Effect.sync(() => { setClosedOn(draft); });

    return key === "Enter" && !shift ? choose(chosen) : null;
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): Effect.Effect<void> | null => {
    const answered = highlighted === undefined ? null : keyed(event.key, event.shiftKey, highlighted);

    if (answered !== null) event.preventDefault();

    return answered;
  };

  const commandOf = (): Effect.Effect<void> | null => {
    const named = namedIn(commands, draft);

    if (named === null) return null;

    return needsArgument(named.command) && named.argument === "" ? choose(named.command) : run(named.command, named.argument);
  };

  return { offered: matched, highlighted, listId, optionId: (command) => `${listId}${command.name}`, choose, onKey, commandOf };
}

/** The open menu, over the composer's top edge: each command's name, the words it takes and what it does. */
export function SlashMenu({ menu }: { menu: SlashMenuControl }) {
  return (
    <div id={menu.listId} role="listbox" aria-label="Commands" data-slash-menu className="p-menu p-slash-menu">
      {menu.offered.map((command) => (
        // The field keeps the focus: a press picks without taking it, as a key would.
        <div key={command.name} id={menu.optionId(command)} role="option" aria-selected={command === menu.highlighted}
          data-highlighted={command === menu.highlighted ? "" : undefined} data-slash-command={command.name} className="p-menu-item"
          onMouseDown={(event) => { event.preventDefault(); }} onClick={() => { detach(menu.choose(command)); }}>
          <span className="t-mono shrink-0">{command.usage ?? command.name}</span>
          <span className="t-meta min-w-0 truncate">{command.description}</span>
        </div>
      ))}
    </div>
  );
}
