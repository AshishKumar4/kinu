/**
 * Classic readline chat surface for both backends, driven by an AgentClient. First Ctrl+C during a turn stops it;
 * a second (or Ctrl+C while idle) exits. A line typed mid-turn steers the running turn.
 */

import * as readline from 'node:readline';
import { renderChangelogText } from '@kinu.run/core';
import { EMPTY_MODEL_MENU } from '@kinu.run/core';
import { forkCandidates, type AgentClient, type AgentClientEvent } from './agent-client';
import { describeBranchStatus, executeSlashCommand, isBranchStatusEvent, performUndo, renderPlanReview, renderStatusLines, renderTakesText, type SlashOutcome } from './slash-commands';
import { describePromptAttachment, resolvePromptAttachments } from './attachments';
import { watchTerminalConsents } from './consent-watch';
import {
  connectDevice,
  defaultDeviceName,
  describeConnectOutcome,
  deviceStatusLine,
  dismissDeviceConnectPrompt,
  killSessionDaemon,
  shouldOfferDeviceConnect,
} from './device-connect';
import { requireAuthConfig } from './config';
import {
  printToolCall, printToolResult, printEvolutionEvent, createTurnStatus, formatFailure,
  ACCENT, DIM, MUTED, ERR, OK, WARN, type TurnStatus,
} from './display';
import { renderThrownChain } from '@kinu.run/core/obs';
import { clipText, type WorkMode } from '@kinu.run/core';

export interface ChatLoopOpts {
  client: AgentClient;
}

export async function runChatLoop(opts: ChatLoopOpts): Promise<void> {
  let client = opts.client;
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  // Reset per user turn so the name header prints once and the status line stops on first output.
  let turnStatus = createTurnStatus({ hold: () => consentAskPending || rl.line.length > 0 });
  let headerPrinted = false;
  let turnInFlight = false;
  let interruptRequested = false;
  let exiting = false;
  /** Counts paired turn events, covering cascaded turns past send(). */
  let activeTurns = 0;
  /** Drained FIFO before the next prompt. */
  const queuedInputs: string[] = [];
  let pendingPrefill: string | null = null;
  /** Answer lines to a consent question must not be read as steering input. */
  let consentAskPending = false;

  const onClientEvent = (event: AgentClientEvent) => {
    if (event.type === 'turn-start') activeTurns += 1;
    else if (event.type === 'turn-end') activeTurns = Math.max(0, activeTurns - 1);
    renderClientEvent({
      event, agentName: client.agentName, status: turnStatus,
      getHeader: () => headerPrinted, setHeader: (printed) => { headerPrinted = printed; },
    });
  };

  let unsubscribe = client.subscribe(onClientEvent);

  const onExit = async () => {
    if (exiting) return;
    exiting = true;
    unsubscribe();
    // close() flushes a partial evolution window; cap it so Ctrl+C never hangs.
    const cap = Promise.withResolvers<void>();
    setTimeout(cap.resolve, 5000);

    try {
      await Promise.race([client.close(), cap.promise]);
    } catch (err) {
      console.log(WARN('\n  This session did not close cleanly. Its last evolution window may not have flushed.'));
      console.log(formatFailure({ cause: err }));
    }

    // A session daemon lives as long as the chat it was started for.
    try {
      killSessionDaemon();
    } catch (err) {
      console.log(formatFailure({ cause: err }));
    }

    console.log(DIM('\n  Goodbye.\n'));
    rl.close();
    process.exit(0);
  };

  const onInterrupt = async (): Promise<void> => {
    if (turnInFlight && !interruptRequested) {
      interruptRequested = true;
      client.stop();
      console.log(WARN('\n  Interrupting the active turn… (Ctrl+C again to exit)'));

      // Interrupt means stop — held messages must not auto-fire afterwards.
      if (queuedInputs.length > 0) {
        console.log(WARN(`  Dropping ${queuedInputs.length} queued message(s):`));

        for (const queued of queuedInputs.splice(0)) console.log(DIM(`    ⧗ ${queued}`));
      }

      return;
    }

    try {
      await onExit();
    } catch (cause) {
      console.log(`\n${formatFailure({ cause })}\n`);
      rl.close();
      process.exit(1);
    }
  };

  rl.on('SIGINT', onInterrupt);
  process.on('SIGINT', onInterrupt);

  // Lines answering a consent question are excluded.
  const onMidTurnLine = async (input: string) => {
    const command = input.split(/\s+/, 1)[0].toLowerCase();

    if (command === '/stop') {
      client.stop();

      return;
    }

    if (command === '/queue') {
      const text = input.slice('/queue'.length).trim();

      if (text) {
        queuedInputs.push(text);
        console.log(DIM(`  ⧗ queued: sends after this turn (${queuedInputs.length} waiting)`));
      } else {
        console.log(DIM('  Usage while a turn runs: /queue <text>'));
      }

      return;
    }

    if (command === '/branch') {
      const text = input.slice('/branch'.length).trim();

      if (!text) console.log(DIM('  Usage while a turn runs: /branch <text>. It runs the redirect in parallel.'));
      else if (!client.branch(text, { cwd: process.cwd() })) {
        queuedInputs.push(text);
        console.log(DIM('  ⧗ the turn just finished. Queued to send next.'));
      }

      return;
    }

    if (input.startsWith('/')) {
      console.log(DIM('  A turn is running. Type to steer it, or use /queue <text>, /branch <text>, /stop.'));

      return;
    }

    const resolved = await resolvePromptAttachments(input, { limitBytes: client.inlineAttachmentLimitBytes });

    for (const problem of resolved.errors) console.log(WARN(`  ${problem}`));
    const payload = resolved.files.length > 0 ? { text: resolved.text, files: resolved.files } : resolved.text;

    const sent = await client.send(payload, { cwd: process.cwd() });

    if (sent.landed === 'mid-turn') console.log(DIM('  ↪ steering the running turn'));
    else console.log(DIM('  ⧗ the turn had just finished, so this ran as the next message.'));
  };

  rl.on('line', async (line) => {
    if (!turnInFlight || consentAskPending || exiting) return;
    const input = line.trim();

    if (!input) return;

    try {
      await onMidTurnLine(input);
    } catch (cause) {
      console.log(`\n${formatFailure({ cause })}\n`);
    }
  });

  await client.connect();

  if (tty) {
    console.log(`\n${ACCENT(client.agentName)} ${DIM(`${client.mode} chat`)}`);
    console.log(DIM('Type a message, /help for commands, /exit to leave. Ctrl+C interrupts a running turn.'));
    console.log(DIM('While a turn runs: type+Enter steers it · /queue <text> sends after · /fork walks back.\n'));
  }

  if (client.mode === 'cloud') await maybeOfferDeviceConnect(rl, tty);

  const promptLabel = () => tty ? `${ACCENT(client.agentName)} ${DIM('›')} ` : '';

  /** A cascaded turn starts moments after the previous turn-end, so idle holds through a short debounce. */
  const waitForTurnsToSettle = async () => {
    for (;;) {
      while (activeTurns > 0 && !exiting) await sleep(25);

      if (exiting) return;
      await sleep(60);

      if (activeTurns === 0) return;
    }
  };

  const consentAsk = async (question: string, signal: AbortSignal) => {
    consentAskPending = true;
    turnStatus.clear();

    try {
      return await ask(rl, question, signal);
    } finally {
      consentAskPending = false;

      if (turnInFlight) turnStatus.resume();
    }
  };

  const runTurn = async (input: string, mode?: WorkMode) => {
    const resolved = await resolvePromptAttachments(input, { limitBytes: client.inlineAttachmentLimitBytes });

    for (const problem of resolved.errors) console.log(WARN(`  ${problem}`));

    if (resolved.attached.length > 0) {
      console.log(DIM(`  + ${resolved.attached.map(describePromptAttachment).join(' · ')}`));
    }

    headerPrinted = false;
    turnInFlight = true;
    interruptRequested = false;
    turnStatus.show('thinking');

    const consentWatch = client.consents
      ? watchTerminalConsents(client.consents, client.agentName, consentAsk)
      : null;

    try {
      await client.send(
        resolved.files.length > 0 ? { text: resolved.text, files: resolved.files } : resolved.text,
        { cwd: process.cwd(), ...(mode !== undefined && { mode }) },
      );
      await waitForTurnsToSettle();
    } catch (err) {
      turnStatus.clear();
      console.log(`\n${formatFailure({ cause: err })}\n`);
    } finally {
      consentWatch?.stop();
      turnInFlight = false;
      turnStatus.clear();
    }

    console.log('\n');
  };

  const handleFork = async (ref: string | undefined) => {
    const history = await client.history();
    const candidates = forkCandidates(history);

    if (candidates.length === 0) {
      console.log(WARN('  No user messages to walk back to.'));

      return;
    }

    if (!ref) {
      console.log(`\n${DIM('Walk back to (1 = most recent):')}`);

      for (const [i, candidate] of candidates.entries()) {
        console.log(`  ${ACCENT(String(i + 1))} ${clipText(candidate.text.replace(/\s+/g, ' '), 100)}`);
      }

      console.log(DIM('Fork with /fork <number>. The conversation restarts just before that message.\n'));

      return;
    }

    const index = Number.parseInt(ref, 10) - 1;
    const picked = Number.isInteger(index) ? candidates[index] : undefined;

    if (!picked) {
      console.log(WARN(`  No walk-back candidate "${ref}". List them with /fork.`));

      return;
    }

    const result = await client.fork(picked);

    if (result.client !== client) {
      unsubscribe();
      const previous = client;
      client = result.client;
      unsubscribe = client.subscribe(onClientEvent);
      turnStatus = createTurnStatus({ hold: () => consentAskPending || rl.line.length > 0 });
      // Connect the replacement first so a failed close never leaves the loop on an unconnected client.
      await client.connect();
      await previous.close();
    }

    console.log(`\n${DIM('Forked')} ${ACCENT(result.label)}${DIM('. Edit the message and press Enter to resend.')}\n`);
    pendingPrefill = picked.text;
  };

  while (!exiting) {
    while (!exiting && queuedInputs.length > 0) {
      const queued = queuedInputs.shift();

      if (queued === undefined) break;
      await runTurn(queued);
    }

    const prefill = pendingPrefill;
    pendingPrefill = null;
    const line = await ask(rl, promptLabel(), undefined, prefill ?? undefined);

    if (line === null) break; // EOF
    const input = line.trim();

    if (!input) continue;

    if (input.startsWith('/')) {
      try {
        const outcome = await executeSlashCommand(client, input);

        if (outcome.kind === 'queue') {
          queueOrExplain(outcome.text, queuedInputs);
          continue;
        }

        if (outcome.kind === 'branch') {
          // Idle — there is no live turn to branch from; run it normally.
          await branchOrExplain(outcome.text, runTurn);
          continue;
        }

        if (outcome.kind === 'plan') {
          await planOrExplain(outcome.text, runTurn);
          continue;
        }

        if (outcome.kind === 'fork') {
          await handleFork(outcome.ref);
          continue;
        }

        if (outcome.kind === 'undo') {
          await runUndo(client, outcome.ref, handleFork);
          continue;
        }

        const done = await applySlashOutcome(client, rl, outcome);

        if (done === 'exit') {
          await onExit();

          return;
        }
      } catch (err) {
        console.log(`\n${formatFailure({ cause: err })}\n`);
      }

      continue;
    }

    await runTurn(input);
  }

  await onExit();
}

/** Resolves null on EOF/close (piped input ends cleanly) and on abort. Settling always detaches listeners. */
function ask(rl: readline.Interface, prompt: string, signal?: AbortSignal, prefill?: string): Promise<string | null> {
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

    try {
      rl.question(prompt, settle);

      if (prefill) rl.write(prefill);
    } catch (error) {
      // Stdin hit EOF. Stderr, because stdout carries only the conversation.
      process.stderr.write(`note: readline closed before the prompt: ${renderThrownChain({ cause: error })}\n`);
      settle(null);
    }
  });
}

/** Offer once per invocation to connect this PC when a cloud chat opens with none; persisted "don't ask
 * again". Non-interactive stdin gets the `kinu connect` instruction instead. */
async function maybeOfferDeviceConnect(rl: readline.Interface, tty: boolean): Promise<void> {
  if (!(await shouldOfferDeviceConnect())) return;

  if (!tty) {
    console.log(MUTED('No computer is connected. Connect this one with: kinu connect'));

    return;
  }

  console.log(`${WARN('Let this agent use this computer?')}`);
  console.log(MUTED(`  Linking installs the Kinu daemon and registers this machine as "${defaultDeviceName()}".`));
  console.log(MUTED('  A workspace you approve runs commands here in a sandbox.'));
  console.log(MUTED('  You approve each workspace once, and revoke it in Account settings → Devices.'));
  await promptDeviceConnect(rl, { allowDismiss: true });
  console.log('');
}

async function promptDeviceConnect(rl: readline.Interface, opts: { allowDismiss: boolean }): Promise<void> {
  const choices = opts.allowDismiss
    ? `[c] connect and stay connected · [s] this session only · [n] not now · [d] don't ask again ›`
    : `[c] connect and stay connected · [s] this session only · [n] not now ›`;

  for (;;) {
    const answer = (await ask(rl, `${DIM(choices)} `))?.trim().toLowerCase();

    if (answer === undefined || answer === 'n' || answer === 'no') return; // EOF or not now

    if (answer === 'c' || answer === 's') {
      await runDeviceConnect(answer === 's');

      return;
    }

    if (opts.allowDismiss && answer === 'd') {
      await dismissDeviceConnectPrompt();
      console.log(DIM(`  Kinu won't ask again. Connect later with /connect or kinu connect.`));

      return;
    }

    console.log(DIM(opts.allowDismiss ? '  Answer c, s, n or d.' : '  Answer c, s or n.'));
  }
}

async function runDeviceConnect(session: boolean): Promise<void> {
  try {
    const auth = requireAuthConfig();
    let waiting = false;

    const result = await connectDevice(auth, {
      session,
      label: defaultDeviceName(),
      onWaiting: () => {
        if (!waiting) {
          process.stdout.write(DIM('  Waiting for the daemon to connect'));
          waiting = true;
        }

        process.stdout.write(DIM('.'));
      },
    });

    if (waiting) process.stdout.write('\n');
    const outcome = describeConnectOutcome(result, session);
    console.log(`  ${outcome.ok ? OK('✓') : ERR('✗')} ${outcome.message}`);
  } catch (err) {
    console.log(`  ${ERR('✗')} ${renderThrownChain({ cause: err })}`);
  }
}

async function applySlashOutcome(client: AgentClient, rl: readline.Interface, outcome: SlashOutcome): Promise<'ok' | 'exit'> {
  switch (outcome.kind) {
    case 'exit':
      return 'exit';
    case 'text':
      console.log(`\n${MUTED(outcome.text)}\n`);

      return 'ok';
    case 'model-set':
      console.log(`\n${DIM('Model:')} ${ACCENT(outcome.spec)}\n`);

      return 'ok';
    case 'effort-set':
      console.log(`\n${DIM('Reasoning effort:')} ${ACCENT(outcome.effort)}\n`);

      return 'ok';
    case 'role-set':
      console.log(`\n${DIM('Role:')} ${ACCENT(outcome.role)}\n`);

      return 'ok';
    case 'status':
      console.log('');

      for (const line of renderStatusLines(outcome.status)) console.log(`  ${DIM(line)}`);
      console.log('');

      return 'ok';
    case 'changelog':
      console.log(`\n${MUTED(renderChangelogText(outcome.view.entries, { unseenCount: outcome.view.unseenCount }))}`);

      if (outcome.view.entries.some((entry) => entry.revert)) {
        console.log(MUTED('Revert a line with /changelog revert <n>. Keeping is the default.'));
      }

      console.log('');

      return 'ok';
    case 'takes':
      console.log(`\n${MUTED(renderTakesText(outcome.set))}\n`);

      return 'ok';
    case 'settings': {
      const commands = ['/model', '/effort'];

      if (client.localControls) commands.push('/approval', '/always');
      console.log(`\n${DIM('Settings:')} use ${commands.join(', ')}, or open the full-screen TUI.\n`);

      return 'ok';
    }

    case 'theme':
      console.log(`\n${DIM('Theme:')} the full-screen TUI has the picker; ~/.kinu/tui.json holds the choice.\n`);

      return 'ok';
    case 'model-picker': {
      const current = await client.getModelSpec();
      console.log(`\n${DIM('Model:')} ${ACCENT(current ?? '(default)')}`);
      const menu = await client.listModels().catch(() => EMPTY_MODEL_MENU);

      if (menu.models.length > 0) {
        console.log(DIM('Available (set with /model <spec>):'));

        for (const model of menu.models.slice(0, 40)) console.log(`  ${ACCENT(model.spec)}  ${DIM(model.label)}`);

        if (menu.models.length > 40) console.log(DIM(`  … ${menu.models.length - 40} more`));
      }

      for (const failure of menu.failures) {
        console.log(WARN(`  ! ${failure.label ?? failure.provider} could not be listed: ${failure.reason}`));
      }

      console.log('');

      return 'ok';
    }

    case 'device-connect': {
      console.log(`\n${DIM('Devices:')} ${await deviceStatusLine()}`);

      if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
        await promptDeviceConnect(rl, { allowDismiss: false });
      } else {
        console.log(MUTED('Connect this computer with: kinu connect'));
      }

      console.log('');

      return 'ok';
    }

    case 'cancel':
      console.log(DIM('  Nothing to cancel.'));

      return 'ok';
    case 'queue':
    case 'branch':
    case 'plan':
    case 'fork':
    case 'undo':
      // runChatLoop intercepts surface-owned outcomes before this.
      return 'ok';
    case 'unknown':
      console.log(WARN(`  Unknown command: ${outcome.command}. Type /help`));

      return 'ok';
  }
}

async function planOrExplain(
  text: string | undefined,
  runTurn: (text: string, mode?: WorkMode) => Promise<void>,
): Promise<void> {
  if (text === undefined || text === '') {
    console.log(DIM('  Usage: /plan <what to plan>. It drafts a plan you approve with /plan approve.'));

    return;
  }

  await runTurn(text, 'plan');
}

async function branchOrExplain(text: string | undefined, runTurn: (text: string) => Promise<void>): Promise<void> {
  if (text === undefined || text === '') {
    console.log(DIM('  Usage: /branch <text>. It runs a redirect as a parallel branch during a turn.'));

    return;
  }

  await runTurn(text);
}

/** When files came back, offer the matching conversation walk-back too. */
async function runUndo(
  client: Pick<AgentClient, 'checkpoints'>,
  ref: string | undefined,
  handleFork: (ref: string | undefined) => Promise<void>,
): Promise<void> {
  const undone = await performUndo(client, ref);
  console.log(`\n${MUTED(undone.text)}\n`);

  if (!undone.restored) return;
  console.log(DIM('Files restored. To also walk the conversation back:'));
  await handleFork(undefined);
}

function queueOrExplain(text: string | undefined, queued: string[]): void {
  if (text === undefined || text === '') {
    console.log(DIM('  Usage: /queue <text>. It sends after the running turn, or at once when idle.'));

    return;
  }

  queued.push(text);
}

/** Status-line labels are only states the turn actually entered; vocabulary matches the TUI phase line. */
interface ClientEventRender {
  readonly event: AgentClientEvent;
  readonly agentName: string;
  readonly status: TurnStatus;
  readonly getHeader: () => boolean;
  readonly setHeader: (printed: boolean) => void;
}

function renderClientEvent({ event, agentName, status, getHeader, setHeader }: ClientEventRender): void {
  const header = () => {
    if (getHeader()) return;
    status.clear();
    process.stdout.write(`\n${ACCENT(agentName)} ${DIM('›')} `);
    setHeader(true);
  };

  switch (event.type) {
    case 'turn-start':
      if (event.kind === 'programmatic') {
        status.clear();
        setHeader(false);
        console.log(`\n${DIM(`» ${event.event ?? 'event'}`)} ${MUTED(clipText(event.text, 80))}`);
        status.show('running background work');
      } else {
        // A cascaded user turn gets its own name header when its response starts.
        setHeader(false);
        status.show('thinking');
      }

      break;
    case 'text-delta':
      header();
      process.stdout.write(event.delta);
      break;
    case 'tool-call':
      status.clear();
      printToolCall(event.toolName, event.args);
      status.show(`calling ${event.toolName}`);
      break;
    case 'tool-result':
      status.clear();
      printToolResult(event.result, event);
      status.show(`finished ${event.toolName}`);
      break;
    case 'step-finish':
      status.show(`step ${event.stepIndex}`);
      break;
    case 'evolution':
    case 'background':
      printEvolutionEvent(event.event, event.message);
      break;
    case 'error':
      status.clear();
      console.log(`\n${formatFailure({ cause: event.message })}\n`);
      break;
    case 'broadcast':
      if (isBranchStatusEvent(event.event)) {
        status.clear();
        console.log(`\n${DIM(describeBranchStatus(event.event))}`);
      }

      // The plan as it now stands is what the owner decides on.
      if (event.event.type === 'plan_updated' && event.event.plan) {
        status.clear();
        console.log(`\n${renderPlanReview(event.event.plan)}\n`);
      }

      break;
    case 'turn-end':
    case 'run-event':
      break;
  }
}
