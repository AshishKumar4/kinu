/** What the chat scene says and how it reads its client: transcript lines, the header's meter, the composer's words. */
import type { CliRenderer } from '@opentui/core';
import { offeredReasoningEfforts, type ReasoningEffort, type TierId, describeProviderError, specWithoutAccount, turnFailure, type AgentModelEntry, type BroadcastEvent } from '@kinu.run/core';
import { TUI_COMPOSER_PLACEHOLDER, TUI_COMPOSER_STEERING_PLACEHOLDER, type TurnMeter } from '@kinu.run/core/tui';
import type { AgentClientEvent, AgentClientStatus, AgentTranscriptMessage } from '../agent-client';
import type { OfferedCommand, SlashOutcome } from '../slash-commands';
import type { DisplayMessage } from './messages';
import { renderThrownChain } from '@kinu.run/core/obs';
import { Effect } from 'effect';

export function copyRefused(outcome: Extract<SlashOutcome, { kind: 'text' }>, renderer: CliRenderer): string | null {
  if (outcome.copy === undefined || renderer.copyToClipboardOSC52(outcome.copy)) return null;

  return 'This terminal does not accept clipboard writes (OSC 52), so nothing was copied.';
}

export interface ContextNumber {
  readonly tokens: number;
  readonly window: number | undefined;
}

export function contextNumberOf(event: BroadcastEvent): ContextNumber | null {
  const { type, contextTokens, contextWindow } = event;

  return type === 'context_fill' && contextTokens !== undefined ? { tokens: contextTokens, window: contextWindow } : null;
}

export function recordedContext(status: AgentClientStatus | null): ContextNumber | null {
  const fill = status?.context ?? null;

  return fill === null ? null : { tokens: fill.tokens, window: fill.window ?? undefined };
}

export function headerMeter(
  live: ContextNumber | null, status: AgentClientStatus | null, catalogWindow: number | undefined,
): { tokens: number | null; window: number | undefined } {
  const context = live ?? recordedContext(status);

  return context === null ? { tokens: null, window: catalogWindow } : { tokens: context.tokens, window: context.window ?? catalogWindow };
}

export function composerTakesKeys(ready: boolean, connectFailed: boolean, overlayOpen: boolean): boolean {
  return (ready || connectFailed) && !overlayOpen;
}

export function composerPlaceholderFor(ready: boolean, isProcessing: boolean, connectFailed: boolean): string {
  if (connectFailed) return 'Not connected · Enter to try again';

  if (!ready) return 'Connecting…';

  return isProcessing ? TUI_COMPOSER_STEERING_PLACEHOLDER : TUI_COMPOSER_PLACEHOLDER;
}

export function writeLiveMessage(
  ref: { readonly current: string | null },
  setMessages: (update: (prev: DisplayMessage[]) => DisplayMessage[]) => void,
): (value: string | null) => void {
  return (value) => {
    const id = ref.current;

    if (!id || value === null) return;
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: value } : m)));
  };
}

export function countStreamed(meter: TurnMeter | null, delta: string): void {
  if (meter) meter.streamedChars += delta.length;
}

export function commandWorking(commands: readonly OfferedCommand[], submitted: string): string | null {
  const name = submitted.split(/\s/u)[0]?.toLowerCase();

  return commands.find((command) => command.name === name)?.working ?? null;
}

export function phaseLineLabel(isProcessing: boolean, turnPhase: string | null, nextTier: TierId | null, commandPhase: string | null): string | null {
  if (isProcessing) return turnPhase ?? 'thinking';

  if (commandPhase !== null) return commandPhase;

  return nextTier === null ? null : `next turn · ${nextTier}`;
}

/** Plain text: the TUI styles system messages itself. */
export function errorLine(message: string): string {
  return `Error: ${describeProviderError({ cause: message })}`;
}

/** History as the live turn drew it: an answer whose turn failed is followed by the failure's error line. */
export function shownHistory(history: readonly AgentTranscriptMessage[]): DisplayMessage[] {
  return history.flatMap((row): DisplayMessage[] => {
    const failure = turnFailure({ metadata: row.metadata });

    return failure === null ? [row] : [row, { id: `${row.id}-failure`, role: 'system', content: errorLine(failure) }];
  });
}

export function lastUrlFromMessages(messages: DisplayMessage[]): string | null {
  const urlRe = /https?:\/\/[^\s)\]}>'"]+/g;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg.role !== 'assistant' && msg.role !== 'system') continue;
    const matches = msg.content.match(urlRe);

    if (matches && matches.length > 0) return matches[matches.length - 1];
  }

  return null;
}

/** A read's failure as the transcript says it: what could not be read, and why. */
export function unreadLine(what: string, failed: { readonly cause: unknown }): string {
  return errorLine(`${what} could not be ${what === 'Earlier messages' ? 'loaded' : 'read'}: ${renderThrownChain(failed)}`);
}

/** A client call, its rejection kept as it came for the caller to say. */
export function tried<A>(call: () => PromiseLike<A>): Effect.Effect<A, { readonly cause: unknown }> {
  return Effect.tryPromise({ try: async () => call(), catch: (cause) => ({ cause }) });
}

export function welcomeMessage(agentName: string): DisplayMessage {
  return { id: 'welcome', role: 'system', content: `Connected to ${agentName}. Type a message or /help for commands.` };
}

export function effortsForModel(
  catalog: readonly AgentModelEntry[],
  spec: string,
  status: AgentClientStatus | null,
): ReasoningEffort[] {
  const listed = specWithoutAccount(spec);

  return offeredReasoningEfforts(catalog.find((model) => model.spec === listed)?.reasoningEfforts, status?.reasoningEffort);
}

export function persistedTranscriptEvent(event: AgentClientEvent): boolean {
  return event.type === 'turn-start'
    || event.type === 'text-delta'
    || event.type === 'tool-call'
    || event.type === 'tool-result'
    || event.type === 'step-cut'
    || event.type === 'step-finish'
    || event.type === 'turn-end'
    || event.type === 'error';
}

/** The model a status names; none before the first status arrives. */
export function modelOf(status: AgentClientStatus | null): string {
  return status?.model ?? '';
}

/** A status update setting its model; none before the first status arrives. */
export function withModel(spec: string): (current: AgentClientStatus | null) => AgentClientStatus | null {
  return (current) => current === null ? current : { ...current, model: spec };
}

export interface CaughtFailure {
  cause: unknown;
}
