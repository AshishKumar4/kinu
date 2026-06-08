import * as readline from 'node:readline';
import { runCloudTurn, type CloudTurnResult } from './cloud-api.js';
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
        const result = await runCloudTurn(opts.origin, opts.token, opts.cloudName, message, process.cwd());
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
    rl.close();
  }
}

export function renderCloudTurn(result: CloudTurnResult): void {
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
