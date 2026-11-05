/** The scene's one overlay, the first that is open: a panel over the transcript, or the command hints under the composer. */
import type { ReactNode, RefObject } from 'react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { Effect } from 'effect';
import { detach } from '@kinu.run/core/obs';
import type { AlternateTakeCandidate, AlternateTakeSet, AskingAgent, ChangelogEntry, OwnerAnswer } from '@kinu.run/core';
import type { AgentClient, ForkPoint } from '../agent-client';
import type { OfferedCommand } from '../slash-commands';
import type { ActiveSurface } from './chat-surface';
import { HubOverlay, SubagentChatOverlay, type TuiHubData, type TuiHubRow, type TuiSubagentChat } from './hubs';
import {
  ChangelogOverlay, CommandHintOverlay, CommandPaletteOverlay, ModelPickerOverlay, PromptHistoryOverlay, QuestionsOverlay, SettingsOverlay,
  TakesOverlay, ThemePickerOverlay, WalkbackOverlay, type TuiSettingChoice,
} from './overlays';
import { DEFAULT_TUI_THEME_SELECTION, type ThemeSelection } from './theme';
import { useTuiProduct } from './tui-shell';

export interface ChatOverlayProps {
  readonly surface: ActiveSurface;
  readonly width: number;
  readonly height: number;
  readonly client: AgentClient;
  readonly commands: readonly OfferedCommand[];
  readonly commandHints: readonly OfferedCommand[];
  readonly promptHistory: readonly string[];
  readonly settings: readonly TuiSettingChoice[];
  readonly modelSpec: string;
  readonly subagentChat: TuiSubagentChat | null;
  readonly subagentScrollRef: RefObject<ScrollBoxRenderable | null>;
  readonly hubLive: TuiHubData | undefined;
  readonly answered: readonly TuiHubRow[];
  readonly hubSelectedId: string | null;
  readonly canCreateAgent: boolean;
  readonly walkbackList: readonly ForkPoint[];
  readonly walkbackOpen: boolean;
  readonly close: () => void;
  readonly setInputText: (text: string) => void;
  readonly toInputEnd: () => void;
  readonly addMessage: (message: { role: 'system'; content: string }) => void;
  readonly openModelPicker: () => PromiseLike<void>;
  readonly handleSubmit: (text: string) => PromiseLike<void> | void;
  readonly selectModel: (spec: string) => PromiseLike<void>;
  readonly revertChangelogEntry: (entry: ChangelogEntry) => PromiseLike<void>;
  readonly answerQuestions: (asking: AskingAgent, answers: readonly OwnerAnswer[]) => Effect.Effect<void>;
  readonly pickTake: (set: AlternateTakeSet, candidate: AlternateTakeCandidate) => PromiseLike<void>;
  readonly performWalkback: (point: ForkPoint) => PromiseLike<void>;
}

/** A panel the reader opened to look or set: history, theme, settings, a helper's chat, a hub, the command palette. */
function panelOf(
  {
    surface: activeSurface, width, height, commands, promptHistory, settings, subagentChat, subagentScrollRef, hubLive, answered, hubSelectedId,
    canCreateAgent, close, setInputText, toInputEnd, openModelPicker, handleSubmit,
  }: ChatOverlayProps,
  { keybindings, preferences, updatePreferences }: ReturnType<typeof useTuiProduct>,
): ReactNode {
  const commandPalette = activeSurface?.kind === 'commands';
  const hubView = activeSurface?.kind === 'hub' ? activeSurface.view : null;
  const settingsOpen = activeSurface?.kind === 'settings';
  const themePickerOpen = activeSurface?.kind === 'theme';
  const subagentSurface = activeSurface?.kind === 'subagent' ? activeSurface : null;

  if (activeSurface?.kind === 'history') {
    return (
      <PromptHistoryOverlay entries={promptHistory} terminal={{ width, height }} onSelect={(text) => {
        close();
        setInputText(text);
        toInputEnd();
      }} />
    );
  }

  if (themePickerOpen) {
    return (
      <ThemePickerOverlay
        terminal={{ width, height }}
        selection={preferences.theme ?? DEFAULT_TUI_THEME_SELECTION}
        onSelect={(selection: ThemeSelection) => {
          close();
          updatePreferences((current) => ({ ...current, theme: selection }));
        }}
      />
    );
  }

  if (settingsOpen) {
    return (
      <SettingsOverlay
        settings={settings}
        terminal={{ width, height }}
        onSelect={(setting) => {
          close();

          if (setting.command.endsWith(' ')) {
            setInputText(setting.command);

            return;
          }

          detach(Effect.promise(async () => (setting.command === '/model' ? openModelPicker() : handleSubmit(setting.command))));
        }}
      />
    );
  }

  if (subagentSurface !== null) {
    return (
      <SubagentChatOverlay
        chat={subagentChat ?? { name: subagentSurface.path.join('/'), label: subagentSurface.label, messages: null, error: null }}
        width={width}
        height={height}
        scrollRef={(value) => { subagentScrollRef.current = value; }}
      />
    );
  }

  if (hubView !== null && hubLive !== undefined) {
    return (
      <HubOverlay
        view={hubView}
        data={{ ...hubLive, answered }}
        width={width}
        height={height}
        selectedAgentId={hubSelectedId}
        {...(canCreateAgent ? { newAgentHint: keybindings.hint('hub.new-agent') } : {})}
      />
    );
  }

  if (commandPalette) {
    return (
      <CommandPaletteOverlay
        commands={commands}
        terminal={{ width, height }}
        onSelect={(command) => {
          close();
          setInputText(`${command.name}${command.usage ? ' ' : ''}`);
        }}
      />
    );
  }

  return null;
}

/** A choice the scene asks for: a model, a revert, the owner's answers, a take, a point to walk back to. */
function choiceOf({
  surface: activeSurface, width, height, client, modelSpec, walkbackList, walkbackOpen, close, addMessage, selectModel, revertChangelogEntry,
  answerQuestions, pickTake, performWalkback,
}: ChatOverlayProps): ReactNode {
  const modelPicker = activeSurface?.kind === 'model' ? activeSurface : null;
  const changelogView = activeSurface?.kind === 'changelog' ? activeSurface.view : null;
  const takesView = activeSurface?.kind === 'takes' ? activeSurface.set : null;

  if (modelPicker) {
    return (
      <ModelPickerOverlay
        models={modelPicker.menu.models}
        failures={modelPicker.menu.failures}
        accounts={modelPicker.menu.accounts}
        currentSpec={modelSpec}
        terminal={{ width, height }}
        loading={modelPicker.loading}
        error={modelPicker.error}
        onSelect={(spec) => detach(Effect.promise(() => selectModel(spec)))}
        test={(spec, signal) => client.testModel(spec, signal)}
      />
    );
  }

  if (changelogView) {
    return (
      <ChangelogOverlay
        view={changelogView}
        terminal={{ width, height }}
        onSelect={(entry) => detach(Effect.promise(() => revertChangelogEntry(entry)))}
      />
    );
  }

  if (activeSurface?.kind === 'questions') {
    const { asking } = activeSurface;

    return (
      <QuestionsOverlay
        asking={asking}
        terminal={{ width, height }}
        onAnswer={(answers) => detach(answerQuestions(asking, answers))}
        onChat={() => {
          close();
          addMessage({ role: 'system', content: 'Write your answer as a message; it answers the open questions.' });
        }}
      />
    );
  }

  if (takesView) {
    return (
      <TakesOverlay
        set={takesView}
        terminal={{ width, height }}
        onSelect={(candidate) => detach(Effect.promise(() => pickTake(takesView, candidate)))}
      />
    );
  }

  if (walkbackOpen && walkbackList.length > 0) {
    return (
      <WalkbackOverlay
        candidates={walkbackList}
        terminal={{ width, height }}
        onSelect={(candidate) => detach(Effect.promise(() => performWalkback(candidate)))}
      />
    );
  }

  return null;
}

export function ChatOverlay(props: ChatOverlayProps): ReactNode {
  const product = useTuiProduct();

  return panelOf(props, product) ?? choiceOf(props) ?? <CommandHintOverlay commands={props.commandHints} terminal={{ width: props.width, height: props.height }} />;
}
