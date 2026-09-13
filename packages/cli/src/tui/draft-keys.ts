/**
 * Composer-draft keys: prompt-history navigation, undo, external editor,
 * clear, branch, queue. The scene feeds each bound action id to the map this
 * module returns; a handler owns its own preventDefault, because which keys
 * the editor should still see (an Up that stays in the draft, queue.edit-last)
 * is part of the behaviour.
 */
import type { RefObject } from 'react';
import type { KeyEvent, TextareaRenderable } from '@opentui/core';
import type { TuiActionId } from './actions';
import type { InputEffect, InputMachineEvent } from '@kinu.run/core';
import type { ActiveSurface } from './chat-app';

export interface PromptHistoryCursor {
  index: number;
  draft: string;
}

/** One history navigation. `previous` walks older; the cursor parks the draft
 *  being composed so leaving history returns to it. False is "the editor
 *  keeps the key": no input, a mid-buffer vertical move, or history
 *  exhausted. */
function promptHistoryStep(
  input: TextareaRenderable | null,
  history: readonly string[],
  cursor: PromptHistoryCursor | null,
  previous: boolean,
): { text: string; cursor: PromptHistoryCursor | null } | false {
  if (!input) return false;
  const row = input.logicalCursor.row;

  if (input.plainText !== '' && (previous ? row !== 0 : row !== input.lineCount - 1)) return false;

  if (history.length === 0 || (!previous && cursor === null)) return false;

  const saved = cursor ?? { index: history.length, draft: input.plainText };
  const index = Math.max(0, Math.min(history.length, saved.index + (previous ? -1 : 1)));

  return {
    text: history[index] ?? saved.draft,
    cursor: index === history.length ? null : { index, draft: saved.draft },
  };
}

export interface ComposerKeyDeps {
  /** The live editor, read per keystroke. */
  input: RefObject<TextareaRenderable | null>;
  /** The per-workspace history the cursor walks, newest last. */
  promptHistory: readonly string[];
  /** Stepped history cursor, read per keystroke — a keypress may land before
   *  the last one has re-rendered, so this is a live read, not a snapshot. */
  promptCursor(): PromptHistoryCursor | null;
  setPromptCursor(cursor: PromptHistoryCursor | null): void;
  /** Swap the composer's draft, resetting every lane that tracks it. */
  setInputText(text: string): void;
  undoDraft(): void;
  /** Open the draft in VISUAL/EDITOR; resolves to the edited text. */
  externalDraft(text: string): Promise<string>;
  /** Expand collapsed paste placeholders in a draft before it leaves the composer. */
  expandPastes(text: string): string;
  /** Append a draft to prompt history. */
  rememberPrompt(text: string): void;
  /** Move the walkback surface up one level and mark the editor busy meanwhile. */
  setSelectionPending(pending: boolean): void;
  focusInput(): void;
  addError(error: { cause: unknown }): void;
  dispatchInput(event: InputMachineEvent): InputEffect[];
  runInputEffects(effects: InputEffect[]): void;
  /** The draft as the machine should see it while a key is handled. */
  hasUserMessages(): boolean;
  openSurface(surface: ActiveSurface): void;
}

/** The composer-scope action handlers, keyed by the action id the dispatcher
 *  resolves. Adding a chord means adding a binding and one row here — the
 *  scene's useKeyboard stays a lookup. */
export function composerKeyHandlers(deps: ComposerKeyDeps): Partial<Record<TuiActionId, (key: KeyEvent) => void | Promise<void>>> {
  const historyStep = (previous: boolean) => (key: KeyEvent): void => {
    const stepped = promptHistoryStep(deps.input.current, deps.promptHistory, deps.promptCursor(), previous);

    if (stepped === false) return;
    key.preventDefault();
    deps.setInputText(stepped.text);
    deps.input.current?.gotoBufferEnd();
    deps.setPromptCursor(stepped.cursor);
  };

  const escapeDraft = () =>
    deps.runInputEffects(deps.dispatchInput({
      type: 'escape',
      now: Date.now(),
      draft: deps.input.current?.plainText ?? '',
      hasUserMessages: deps.hasUserMessages(),
    }));

  return {
    'editor.history-search': (key) => {
      key.preventDefault();
      deps.openSurface({ kind: 'history' });
    },
    'editor.undo': (key) => {
      key.preventDefault();
      deps.undoDraft();
    },
    'editor.external': async (key) => {
      key.preventDefault();
      deps.setSelectionPending(true);

      try {
        const edited = await deps.externalDraft(deps.expandPastes(deps.input.current?.plainText ?? ''));
        deps.setInputText(edited);
        deps.input.current?.gotoBufferEnd();
      } catch (cause) {
        deps.addError({ cause });
      } finally {
        deps.setSelectionPending(false);
        deps.input.current?.focus();
      }
    },
    'editor.history-previous': historyStep(true),
    'editor.history-next': historyStep(false),
    'editor.clear': (key) => {
      key.preventDefault();
      const text = deps.input.current?.plainText ?? '';

      if (text !== '') {
        deps.rememberPrompt(deps.expandPastes(text));
        deps.setInputText('');

        return;
      }

      return escapeDraft();
    },
    'conversation.branch': (key) => {
      key.preventDefault();

      return deps.runInputEffects(deps.dispatchInput({ type: 'branch', draft: deps.expandPastes(deps.input.current?.plainText ?? '') }));
    },
    'queue.add': (key) => {
      key.preventDefault();

      return deps.runInputEffects(deps.dispatchInput({ type: 'queue', text: deps.expandPastes(deps.input.current?.plainText ?? '') }));
    },
    'queue.edit-last': () => {
      deps.dispatchInput({ type: 'backspace', draft: deps.input.current?.plainText ?? '' });
    },
    'conversation.cancel': (key) => {
      key.preventDefault();

      return escapeDraft();
    },
  };
}
