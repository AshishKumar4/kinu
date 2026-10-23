/** A turn's tool calls as its client events arrive, the local client's and the cloud stream's alike. */
import * as v from 'valibot';
import { ToolOutcomeSchema } from '@kinu.run/core';
import type { AgentClientEvent, AgentTurnResult } from './agent-client';

export class TurnCalls {
  readonly calls: AgentTurnResult['toolCalls'] = [];
  private readonly byId = new Map<string, AgentTurnResult['toolCalls'][number]>();

  observe(event: AgentClientEvent): void {
    if (event.type === 'tool-call') {
      const call = { name: event.toolName, args: event.args };
      this.calls.push(call);
      this.byId.set(event.toolCallId, call);
    } else if (event.type === 'tool-result') {
      const call = this.byId.get(event.toolCallId);

      if (call === undefined) return;
      call.result = event.result;
      call.outcome = v.parse(ToolOutcomeSchema, event);
    }
  }

  /** The name a call was made under, once its call event arrived. */
  nameOf(toolCallId: string): string | undefined {
    return this.byId.get(toolCallId)?.name;
  }
}
