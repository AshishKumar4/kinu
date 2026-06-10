/**
 * Interactive chat REPL — the single classic (readline) chat surface for both
 * backends, parameterized by an AgentClient. The client owns transport,
 * recording, and history; this renders its streaming event feed, dispatches
 * slash commands through the shared command core, surfaces device-consent
 * requests inline while a turn is processing, and maps the first Ctrl+C during
 * a turn to client.stop() (second Ctrl+C, or Ctrl+C while idle, exits).
 */

import * as readline from 'node:readline';
import type { AgentClient, AgentClientEvent } from './agent-client.js';
import { executeSlashCommand, renderStatusLines, type SlashOutcome } from './slash-commands.js';
import { describePromptAttachment, resolvePromptAttachments } from './attachments.js';
import { watchTerminalConsents } from './consent-watch.js';
import { renderSessionBrowser, selectSession } from './tui/session-browser.js';
import {
  printToolCall, printToolResult, printEvolutionEvent, createTypingIndicator,
  ACCENT, DIM, MUTED, ERR, WARN,
} from './display.js';

export interface ChatLoopOpts {
  client: AgentClient;
  initialPrompt?: string;
}

export async function runChatLoop(opts: ChatLoopOpts): Promise<void> {
  const { client } = opts;
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Per-turn render state — reset on every user turn so the agent-name header
  // prints once per turn and the typing indicator stops on first output.
  const typing = createTypingIndicator(client.agentName);
  let headerPrinted = false;
  let turnInFlight = false;
  let interruptRequested = false;
  let exiting = false;

  const unsubscribe = client.subscribe((event) =>
    renderClientEvent(event, client.agentName, typing, () => headerPrinted, (v) => { headerPrinted = v; }));

  const onExit = async () => {
    if (exiting) return;
    exiting = true;
    unsubscribe();
    // close() flushes a partial evolution window; cap it so Ctrl+C never hangs.
    try { await Promise.race([client.close(), new Promise((r) => setTimeout(r, 5000))]); } catch { /* best effort */ }
    console.log(DIM('\n  Goodbye.\n'));
    rl.close();
    process.exit(0);
  };

  const onInterrupt = () => {
    if (turnInFlight && !interruptRequested) {
      interruptRequested = true;
      client.stop();
      console.log(WARN('\n  Interrupting the active turn… (Ctrl+C again to exit)'));
      return;
    }
    void onExit();
  };
  rl.on('SIGINT', onInterrupt);
  process.on('SIGINT', onInterrupt);

  await client.connect();
  if (tty) {
    console.log(`\n${ACCENT(client.agentName)} ${DIM(`${client.mode} chat`)}`);
    console.log(DIM('Type a message, /help for commands, /exit to leave. Ctrl+C interrupts a running turn.\n'));
  }

  const prompt = tty ? `${ACCENT(client.agentName)} ${DIM('›')} ` : '';

  const runTurn = async (input: string) => {
    // @path mentions (plus quoted/~ path tokens) become attachments: images
    // and PDFs inline as file parts, other files stay path references.
    const prompt = await resolvePromptAttachments(input);
    for (const problem of prompt.errors) console.log(WARN(`  ${problem}`));
    if (prompt.attached.length > 0) {
      console.log(DIM(`  📎 ${prompt.attached.map(describePromptAttachment).join(' · ')}`));
    }
    headerPrinted = false;
    turnInFlight = true;
    interruptRequested = false;
    typing.start();
    const consentWatch = client.consents
      ? watchTerminalConsents(client.consents, client.agentName, (question, signal) => ask(rl, question, signal))
      : null;
    try {
      await client.send(
        prompt.files.length > 0 ? { text: prompt.text, files: prompt.files } : prompt.text,
        { cwd: process.cwd() },
      );
    } catch (err) {
      typing.stop();
      console.log(`\n${ERR('error')} ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      consentWatch?.stop();
      turnInFlight = false;
      typing.stop();
    }
    console.log('\n');
  };

  if (opts.initialPrompt?.trim()) {
    await runTurn(opts.initialPrompt.trim());
  }

  while (!exiting) {
    const line = await ask(rl, prompt);
    if (line === null) break; // EOF
    const input = line.trim();
    if (!input) continue;

    if (input.startsWith('/')) {
      try {
        const done = await applySlashOutcome(client, await executeSlashCommand(client, input));
        if (done === 'exit') { await onExit(); return; }
      } catch (err) {
        console.log(`\n${ERR('error')} ${err instanceof Error ? err.message : String(err)}\n`);
      }
      continue;
    }

    await runTurn(input);
  }

  await onExit();
}

/** Read one line; resolves null on EOF/close (so piped input terminates
 *  cleanly) and on abort (a consent question cancelled by turn end). Settling
 *  always detaches the listeners, so abandoned questions never leak them. */
function ask(rl: readline.Interface, prompt: string, signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (answer: string | null) => {
      if (settled) return;
      settled = true;
      rl.off('close', onClose);
      signal?.removeEventListener('abort', onAbort);
      resolve(answer);
    };
    const onClose = () => settle(null);
    const onAbort = () => settle(null);
    rl.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    rl.question(prompt, settle);
  });
}

async function applySlashOutcome(client: AgentClient, outcome: SlashOutcome): Promise<'ok' | 'exit'> {
  switch (outcome.kind) {
    case 'exit':
      return 'exit';
    case 'text':
      console.log(`\n${MUTED(outcome.text)}\n`);
      return 'ok';
    case 'model-set':
      console.log(`\n${DIM('Model:')} ${ACCENT(outcome.spec)}\n`);
      return 'ok';
    case 'status':
      console.log('');
      for (const line of renderStatusLines(outcome.status)) console.log(`  ${DIM(line)}`);
      console.log('');
      return 'ok';
    case 'model-picker': {
      const current = await client.getModelSpec();
      console.log(`\n${DIM('Model:')} ${ACCENT(current ?? '(default)')}`);
      const models = await client.listModels().catch(() => []);
      if (models.length > 0) {
        console.log(DIM('Available (set with /model <spec>):'));
        for (const model of models.slice(0, 40)) console.log(`  ${ACCENT(model.spec)} ${DIM('—')} ${model.label}`);
        if (models.length > 40) console.log(DIM(`  … ${models.length - 40} more`));
      }
      console.log('');
      return 'ok';
    }
    case 'sessions': {
      const sessions = client.listSessions();
      if (outcome.mode === 'resume' && outcome.resumeRef) {
        const selected = selectSession(sessions, outcome.resumeRef);
        if (!selected) {
          console.log(WARN(`  No matching session for "${outcome.resumeRef}".`));
          return 'ok';
        }
        await client.resumeConversation(selected.info.id);
        console.log(`\n${DIM('Resumed')} ${ACCENT(selected.label)}\n`);
        return 'ok';
      }
      console.log(`\n${MUTED(renderSessionBrowser(outcome.mode, sessions))}`);
      if (outcome.mode === 'resume') console.log(MUTED('Resume with /resume <number|id>.'));
      console.log('');
      return 'ok';
    }
    case 'cancel':
      console.log(DIM('  Nothing to cancel.'));
      return 'ok';
    case 'unknown':
      console.log(WARN(`  Unknown command: ${outcome.command}. Type /help`));
      return 'ok';
  }
}

/** Render one AgentClientEvent to the terminal. */
function renderClientEvent(
  event: AgentClientEvent, agentName: string, typing: { stop: () => void },
  getHeader: () => boolean, setHeader: (v: boolean) => void,
): void {
  const header = () => {
    if (getHeader()) return;
    typing.stop();
    process.stdout.write(`\n${ACCENT(agentName)} ${DIM('›')} `);
    setHeader(true);
  };
  switch (event.type) {
    case 'turn-start':
      if (event.kind === 'programmatic') {
        typing.stop();
        setHeader(false);
        console.log(`\n${DIM(`⚡ ${event.event ?? 'event'}`)} ${MUTED(event.text.slice(0, 80))}`);
      }
      break;
    case 'text-delta':
      header();
      process.stdout.write(event.delta);
      break;
    case 'tool-call':
      typing.stop();
      printToolCall(event.toolName, event.args);
      break;
    case 'tool-result':
      printToolResult(event.result);
      break;
    case 'evolution':
      printEvolutionEvent(event.event, event.message);
      break;
    case 'error':
      typing.stop();
      console.log(`\n${ERR('error')} ${event.message}\n`);
      break;
    case 'turn-end':
    case 'step-finish':
    case 'broadcast':
      break;
  }
}

