import * as readline from 'node:readline';
import { CloudAgentClient } from './cloud-agent-client.js';
import type { AgentTurnResult } from './agent-client.js';
import { ACCENT, DIM, ERR, createTypingIndicator, printToolCall, printToolResult } from './display.js';
import type { CliSession } from './session.js';

export interface CloudChatLoopOptions {
  origin: string;
  token: string;
  agentName: string;
  cloudName: string;
  session: CliSession;
}

export async function runCloudChatLoop(opts: CloudChatLoopOptions): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  const client = new CloudAgentClient({ origin: opts.origin, token: opts.token, name: opts.cloudName });

  if (tty) {
    console.log(`\n${ACCENT(opts.agentName)} ${DIM('cloud chat')}`);
    console.log(DIM('Type /exit to leave.\n'));
    rl.setPrompt(`${ACCENT(opts.agentName)} ${DIM('>')} `);
    rl.prompt();
  }

  try {
    for await (const raw of rl) {
      const message = raw.trim();
      if (!message) {
        if (tty) rl.prompt();
        continue;
      }
      if (message === '/exit' || message === '/quit' || message === 'exit' || message === 'quit') break;
      if (message === '/help') {
        console.log(DIM('Commands: /help, /exit'));
        if (tty) rl.prompt();
        continue;
      }

      opts.session.append('user', { text: message, cwd: process.cwd(), backend: 'cloud' });
      const typing = createTypingIndicator(opts.agentName);
      typing.start();
      try {
        const result = await client.send(message, { cwd: process.cwd() });
        typing.stop();
        opts.session.append('assistant', {
          text: result.text,
          toolCalls: result.toolCalls ?? [],
          steps: result.steps ?? 0,
          backend: 'cloud',
        });
        renderCloudTurn(result);
      } catch (err) {
        typing.stop();
        const messageText = err instanceof Error ? err.message : String(err);
        opts.session.append('error', { message: messageText, backend: 'cloud' });
        console.log(`\n${ERR('error')} ${messageText}`);
      }

      if (tty) rl.prompt();
    }
  } finally {
    client.close();
    rl.close();
  }
}

export function renderCloudTurn(result: AgentTurnResult): void {
  for (const call of result.toolCalls ?? []) {
    printToolCall(call.name, toRecord(call.args));
    if (call.result !== undefined) printToolResult(call.result);
  }
  if (result.text.trim()) console.log(result.text);
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { input: value };
}
