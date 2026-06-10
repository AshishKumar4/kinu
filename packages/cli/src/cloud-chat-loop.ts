import * as readline from 'node:readline';
import { CloudAgentClient } from './cloud-agent-client.js';
import type { AgentTurnResult } from './agent-client.js';
import { listCloudPendingConsents, resolveCloudDeviceConsent, type CloudPendingConsent } from './cloud-api.js';
import { ACCENT, DIM, ERR, WARN, createTypingIndicator, printToolCall, printToolResult } from './display.js';
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
        const result = await withConsentSurface(opts, { rl, interactive: tty, typing }, () =>
          client.send(message, { cwd: process.cwd() }));
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

const CONSENT_POLL_MS = 750;

interface ConsentUi {
  rl: readline.Interface;
  interactive: boolean;
  typing: { start(): void; stop(): void };
}

/** Surface device-consent requests while a cloud turn is in flight — the
 *  classic-loop counterpart of the TUI's DeviceConsentOverlay. Interactive
 *  stdin gets an inline y/a/n prompt (readline's question() consumes the
 *  answer line before the chat iterator sees it); piped stdin gets the
 *  pending request printed with how to approve it, instead of a silent
 *  5-minute auto-deny. */
async function withConsentSurface<T>(
  opts: CloudChatLoopOptions,
  ui: ConsentUi,
  run: () => Promise<T>,
): Promise<T> {
  let done = false;
  let wake: () => void = () => {};
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => { clearTimeout(timer); resolve(); };
  });
  const handled = new Set<string>();
  const poller = (async () => {
    while (!done) {
      await sleep(CONSENT_POLL_MS);
      if (done) return;
      let pending: CloudPendingConsent[];
      try { pending = await listCloudPendingConsents(opts.origin, opts.token, opts.cloudName); }
      catch { continue; }
      for (const consent of pending) {
        if (done || handled.has(consent.consentId)) continue;
        handled.add(consent.consentId);
        await presentConsent(opts, ui, consent);
      }
    }
  })();
  try {
    return await run();
  } finally {
    done = true;
    wake();
    await poller;
  }
}

async function presentConsent(opts: CloudChatLoopOptions, ui: ConsentUi, consent: CloudPendingConsent): Promise<void> {
  ui.typing.stop();
  console.log(`\n${WARN('Device access request')} — the agent wants to use ${ACCENT(consent.deviceLabel)}.`);
  console.log(`  ${DIM('method:')}  ${consent.method}`);
  console.log(`  ${DIM('command:')} ${consent.command || '(none)'}`);
  if (!ui.interactive) {
    console.log(DIM(
      `Non-interactive session: approve it from an interactive chat (proteus chat ${opts.agentName}) ` +
      'or the web chat. The request auto-denies in 5 minutes.',
    ));
    ui.typing.start();
    return;
  }
  const decision = await askConsentDecision(ui.rl);
  try {
    const result = await resolveCloudDeviceConsent(opts.origin, opts.token, opts.cloudName, consent.consentId, decision);
    if (!result.ok) console.log(DIM('That request is no longer pending.'));
  } catch (err) {
    console.log(`${ERR('error')} ${err instanceof Error ? err.message : String(err)}`);
  }
  ui.typing.start();
}

async function askConsentDecision(rl: readline.Interface): Promise<'once' | 'always' | 'deny'> {
  for (;;) {
    const answer = await new Promise<string>((resolve) =>
      rl.question(`${ACCENT('Allow?')} ${DIM('[y]es once / [a]lways / [n]o:')} `, resolve));
    const choice = answer.trim().toLowerCase();
    if (choice === 'y' || choice === 'yes' || choice === 'once') return 'once';
    if (choice === 'a' || choice === 'always') return 'always';
    if (choice === '' || choice === 'n' || choice === 'no' || choice === 'deny') return 'deny';
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
