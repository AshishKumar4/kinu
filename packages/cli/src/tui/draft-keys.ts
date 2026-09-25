/** Each handler owns its preventDefault: which keys the editor still sees is behaviour. */
import type { RefObject } from 'react';
import type { KeyEvent, TextareaRenderable } from '@opentui/core';
import type { TuiActionId } from './actions';
import type { InputEffect, InputMachineEvent } from '@kinu.run/core';
import type { ActiveSurface } from './chat-app';

export interface PromptHistoryCursor {
  index: number;
  draft: string;
}

/** False means the editor keeps the key. */
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
  input: RefObject<TextareaRenderable | null>;
  /** Newest last. */
  promptHistory: readonly string[];
  /** Live cursor read: a keypress may land before the last one re-rendered. */
  promptCursor(): PromptHistoryCursor | null;
  setPromptCursor(cursor: PromptHistoryCursor | null): void;
  /** Resets every lane that tracks the draft. */
  setInputText(text: string): void;
  undoDraft(): void;
  externalDraft(text: string): Promise<string>;
  expandPastes(text: string): string;
  rememberPrompt(text: string): void;
  setSelectionPending(pending: boolean): void;
  focusInput(): void;
  addError(error: { cause: unknown }): void;
  dispatchInput(event: InputMachineEvent): InputEffect[];
  runInputEffects(effects: InputEffect[]): void;
  hasUserMessages(): boolean;
  openSurface(surface: ActiveSurface): void;
}

/** A new chord is a binding plus one row here. */
export function composerKeyHandlers(deps: ComposerKeyDeps): Partial<Record<TuiActionId, (key: KeyEvent) => void | Promise<void>>> {
  const historyStep = (previous: boolean) => (key: KeyEvent): void => {
    const stepped = promptHistoryStep(deps.input.current, deps.promptHistory, deps.promptCursor(), previous);

    if (stepped === false) return;
    key.preventDefault();
    deps.setInputText(stepped.text);
    deps.input.current?.gotoBufferEnd();
    deps.setPromptCursor(stepped.cursor);
  };

  const submitDraft = (event: (draft: string) => InputMachineEvent) => (key: KeyEvent): void => {
    key.preventDefault();

    return deps.runInputEffects(deps.dispatchInput(event(deps.expandPastes(deps.input.current?.plainText ?? ''))));
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
    'conversation.branch': submitDraft((draft) => ({ type: 'branch', draft })),
    'queue.add': submitDraft((text) => ({ type: 'queue', text })),
    'queue.edit-last': () => {
      deps.dispatchInput({ type: 'backspace', draft: deps.input.current?.plainText ?? '' });
    },
    'conversation.cancel': (key) => {
      key.preventDefault();

      return escapeDraft();
    },
  };
}
