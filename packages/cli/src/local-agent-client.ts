import { LocalAgentSession, type LocalAgentSessionOpts, type SessionEvent } from '@proteus/cli-backend';
import type { AgentClient, AgentClientEvent, AgentClientSendOptions, AgentTurnResult } from './agent-client.js';

interface PendingLocalTurn {
  result: AgentTurnResult;
  onEvent?: (event: AgentClientEvent) => void;
  error: Error | null;
}

export class LocalAgentClient implements AgentClient {
  readonly session: LocalAgentSession;
  private pending: PendingLocalTurn | null = null;

  constructor(opts: LocalAgentSessionOpts) {
    this.session = new LocalAgentSession({
      ...opts,
      onEvent: (event) => {
        this.handleEvent(event);
        opts.onEvent(event);
      },
    });
  }

  async send(prompt: string, opts: AgentClientSendOptions = {}): Promise<AgentTurnResult> {
    if (this.pending) throw new Error('local agent turn already in progress');
    const pending: PendingLocalTurn = {
      result: { text: '', toolCalls: [], steps: 0 },
      onEvent: opts.onEvent,
      error: null,
    };
    this.pending = pending;
    try {
      await this.session.send(prompt);
      if (pending.error) throw pending.error;
      return pending.result;
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }

  stop(): void {
    this.session.interrupt();
  }

  close(): void {
    void this.session.end();
  }

  private handleEvent(event: SessionEvent): void {
    const pending = this.pending;
    if (!pending) return;
    switch (event.type) {
      case 'text-delta':
        pending.result.text += event.delta;
        pending.onEvent?.(event);
        return;
      case 'tool-call':
        pending.result.toolCalls.push({ name: event.toolName, args: event.args });
        pending.onEvent?.(event);
        return;
      case 'tool-result': {
        const call = [...pending.result.toolCalls].reverse().find((item) => item.name === event.toolName && item.result === undefined);
        if (call) call.result = event.result;
        pending.onEvent?.(event);
        return;
      }
      case 'turn-end':
        pending.result = {
          text: event.turn.assistantResponse,
          steps: event.turn.steps,
          toolCalls: event.turn.toolCalls.map((call) => ({
            name: call.name,
            args: call.args,
            result: call.result === undefined ? undefined : String(call.result),
          })),
        };
        return;
      case 'error':
        pending.error = new Error(event.message);
        return;
    }
  }
}
