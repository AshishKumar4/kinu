/**
 * Interactive chat REPL — the single classic (readline) chat surface for both
 * backends, parameterized by an AgentClient. The client owns transport,
 * recording, and history; this renders its streaming event feed, dispatches
 * slash commands through the shared command core, surfaces device-consent
 * requests inline while a turn is processing, and maps the first Ctrl+C during
 * a turn to client.stop() (second Ctrl+C, or Ctrl+C while idle, exits).
 *
 * Steering trio (classic equivalents): a line typed while a turn runs STEERS
 * the running turn (client.steer); `/queue <text>` holds a message to send
 * after the turn; `/fork [n]` walks back to an earlier user message, forking
 * the conversation there and pre-filling the input with it for editing.
 */

import * as readline from 'node:readline';
import { renderChangelogText } from '@kinu.run/core';
import { EMPTY_MODEL_MENU } from './model-catalog';
import { forkCandidates, type AgentClient, type AgentClientEvent } from './agent-client';
import { describeBranchStatus, executeSlashCommand, isBranchStatusEvent, performUndo, renderStatusLines, renderTakesText, type SlashOutcome } from './slash-commands';
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
import { clipText } from './tui/format';

export interface ChatLoopOpts {
  client: AgentClient;
}

export async function runChatLoop(opts: ChatLoopOpts): Promise<void> {
  let client = opts.client;
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  // Per-turn render state — reset on every user turn so the agent-name header
  // prints once per turn and the status line stops on first output.
  let turnStatus = createTurnStatus({ hold: () => consentAskPending || rl.line.length > 0 });
  let headerPrinted = false;
  let turnInFlight = false;
  let interruptRequested = false;
  let exiting = false;
  /** Turn-lifecycle depth from paired turn-start/turn-end events — covers
   *  cascaded turns (leftover steers, cloud-steer follow-ups) past send(). */
  let activeTurns = 0;
  /** Messages held for after the current turn (/queue, or a steer that lost
   *  the race with turn end). Drained FIFO before the next prompt. */
  const queuedInputs: string[] = [];
  /** Input pre-filled into the next prompt (walk-back fork edit). */
  let pendingPrefill: string | null = null;
  /** True while a consent question owns the readline — its answer lines must
   *  not be mistaken for mid-turn steering input. */
  let consentAskPending = false;

  const onClientEvent = (event: AgentClientEvent) => {
    if (event.type === 'turn-start') activeTurns += 1;
    else if (event.type === 'turn-end') activeTurns = Math.max(0, activeTurns - 1);
    renderClientEvent(event, client.agentName, turnStatus, () => headerPrinted, (v) => { headerPrinted = v; });
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
      console.log(WARN('\n  This session did not close cleanly — its last evolution window may not have flushed.'));
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

  // Mid-turn input: a plain line steers the running turn; /queue holds it for
  // after; /stop interrupts. Lines answering a consent question are excluded.
  const onMidTurnLine = async (input: string) => {
    const command = input.split(/\s+/, 1)[0]!.toLowerCase();
    if (command === '/stop') {
      client.stop();
      return;
    }
    if (command === '/queue') {
      const text = input.slice('/queue'.length).trim();
      if (text) {
        queuedInputs.push(text);
        console.log(DIM(`  ⧗ queued — sends after this turn (${queuedInputs.length} waiting)`));
      } else {
        console.log(DIM('  Usage while a turn runs: /queue <text>'));
      }
      return;
    }
    if (command === '/branch') {
      const text = input.slice('/branch'.length).trim();
      if (!text) console.log(DIM('  Usage while a turn runs: /branch <text> — runs the redirect in parallel.'));
      else if (!client.branch(text, { cwd: process.cwd() })) {
        queuedInputs.push(text);
        console.log(DIM('  ⧗ the turn just finished — queued to send next'));
      }
      return;
    }
    if (input.startsWith('/')) {
      console.log(DIM('  A turn is running — type to steer it, or use /queue <text>, /branch <text>, /stop.'));
      return;
    }
    const resolved = await resolvePromptAttachments(input, { limitBytes: client.inlineAttachmentLimitBytes });
    for (const problem of resolved.errors) console.log(WARN(`  ${problem}`));
    const payload = resolved.files.length > 0 ? { text: resolved.text, files: resolved.files } : resolved.text;
    if (client.steer(payload, { cwd: process.cwd() })) {
      console.log(DIM('  ↪ steering the running turn'));
    } else {
      queuedInputs.push(input);
      console.log(DIM('  ⧗ the turn just finished — queued to send next'));
    }
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

  /** Wait until every cascaded turn settles — a leftover steer (local) or a
   *  steered follow-up (cloud) starts moments after the previous turn-end, so
   *  idle must hold through a short debounce. */
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

  const runTurn = async (input: string) => {
    // @path mentions (plus quoted/~ path tokens) become attachments: images
    // and PDFs inline as file parts, other files stay path references.
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
        { cwd: process.cwd() },
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
      candidates.forEach((candidate, i) => {
        console.log(`  ${ACCENT(String(i + 1))} ${clipText(candidate.text.replace(/\s+/g, ' '), 100)}`);
      });
      console.log(DIM('Fork with /fork <number> — the conversation restarts just before that message.\n'));
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
      // Bring the replacement up first: a failure closing the old session must not leave the loop
      // holding a client that was never connected.
      await client.connect();
      await previous.close();
    }
    console.log(`\n${DIM('Forked')} ${ACCENT(result.label)} ${DIM('— edit the message and press Enter to resend.')}\n`);
    pendingPrefill = picked.text;
  };

  while (!exiting) {
    // Drain messages queued during the previous turn, in order.
    while (!exiting && queuedInputs.length > 0) {
      await runTurn(queuedInputs.shift()!);
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
          if (outcome.text) queuedInputs.push(outcome.text);
          else console.log(DIM('  Usage: /queue <text> — it sends after the running turn (or immediately when idle).'));
          continue;
        }
        if (outcome.kind === 'branch') {
          // Idle — there is no live turn to branch from; run it normally.
          if (outcome.text) await runTurn(outcome.text);
          else console.log(DIM('  Usage: /branch <text> — runs a redirect as a parallel branch while a turn is running.'));
          continue;
        }
        if (outcome.kind === 'fork') {
          await handleFork(outcome.ref);
          continue;
        }
        if (outcome.kind === 'undo') {
          const undone = await performUndo(client, outcome.ref);
          console.log(`\n${MUTED(undone.text)}\n`);
          if (undone.restored) {
            // opencode parity: files came back — offer the conversation
            // walk-back through the existing fork mechanics.
            console.log(DIM('Files restored. To also walk the conversation back:'));
            await handleFork(undefined);
          }
          continue;
        }
        const done = await applySlashOutcome(client, rl, outcome);
        if (done === 'exit') { await onExit(); return; }
      } catch (err) {
        console.log(`\n${formatFailure({ cause: err })}\n`);
      }
      continue;
    }

    await runTurn(input);
  }

  await onExit();
}

/** Read one line; resolves null on EOF/close (so piped input terminates
 *  cleanly) and on abort (a consent question cancelled by turn end). Settling
 *  always detaches the listeners, so abandoned questions never leak them.
 *  `prefill` seeds the line buffer for editing (walk-back fork resend). */
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
      // Readline closed under us (stdin hit EOF) — settle as EOF. The reason goes
      // to stderr so stdout keeps carrying only the conversation.
      process.stderr.write(`note: readline closed before the prompt: ${renderThrownChain({ cause: error })}\n`);
      settle(null);
    }
  });
}

/**
 * The natural device-access flow: when a cloud chat opens with no PC
 * connected, offer to connect this one — once per CLI invocation, with a
 * persisted "don't ask again". Reuses the consent-watch ask pattern; a
 * non-interactive stdin gets the `kinu connect` instruction instead.
 */
async function maybeOfferDeviceConnect(rl: readline.Interface, tty: boolean): Promise<void> {
  if (!(await shouldOfferDeviceConnect())) return;
  if (!tty) {
    console.log(MUTED('No PC is connected for device access. Connect one with: kinu connect'));
    return;
  }
  console.log(`${WARN('Let this agent use this PC?')}`);
  console.log(MUTED(`  No PC is connected to your account yet. Linking installs the Kinu daemon`));
  console.log(MUTED(`  and registers this machine as "${defaultDeviceName()}". A workspace you grant`));
  console.log(MUTED('  access to can then run commands and read files here, as you — you approve'));
  console.log(MUTED('  each workspace once, and can revoke it in Account settings → Devices.'));
  await promptDeviceConnect(rl, { allowDismiss: true });
  console.log('');
}

async function promptDeviceConnect(rl: readline.Interface, opts: { allowDismiss: boolean }): Promise<void> {
  const choices = opts.allowDismiss
    ? `[c] connect & keep connected · [s] this session only · [n] not now · [d] don't ask again ›`
    : `[c] connect & keep connected · [s] this session only · [n] not now ›`;
  for (;;) {
    const answer = (await ask(rl, `${DIM(choices)} `))?.trim().toLowerCase();
    if (answer === undefined || answer === 'n' || answer === 'no') return; // EOF or not now
    if (answer === 'c' || answer === 's') {
      await runDeviceConnect(answer === 's');
      return;
    }
    if (opts.allowDismiss && answer === 'd') {
      dismissDeviceConnectPrompt();
      console.log(DIM(`  Won't ask again. Connect anytime with /connect or: kinu connect`));
      return;
    }
    console.log(DIM(opts.allowDismiss ? '  Please answer c, s, n, or d.' : '  Please answer c, s, or n.'));
  }
}

async function runDeviceConnect(session: boolean): Promise<void> {
  try {
    const auth = requireAuthConfig();
    let waiting = false;
    const result = await connectDevice(auth, {
      session,
      label: defaultDeviceName(),
      onPoll: () => {
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
        console.log(MUTED('Revert a line with /changelog revert <n>. Keeping is the default — no action needed.'));
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
        for (const model of menu.models.slice(0, 40)) console.log(`  ${ACCENT(model.spec)} ${DIM('—')} ${model.label}`);
        if (menu.models.length > 40) console.log(DIM(`  … ${menu.models.length - 40} more`));
      }
      for (const failure of menu.failures) {
        console.log(WARN(`  ! ${failure.label ?? failure.provider} could not be listed — ${failure.reason}`));
      }
      console.log('');
      return 'ok';
    }
    case 'device-connect': {
      console.log(`\n${DIM('Devices:')} ${await deviceStatusLine()}`);
      if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
        await promptDeviceConnect(rl, { allowDismiss: false });
      } else {
        console.log(MUTED('Connect this PC with: kinu connect'));
      }
      console.log('');
      return 'ok';
    }
    case 'cancel':
      console.log(DIM('  Nothing to cancel.'));
      return 'ok';
    case 'queue':
    case 'branch':
    case 'fork':
    case 'undo':
      // Surface-owned outcomes — runChatLoop intercepts them before this.
      return 'ok';
    case 'unknown':
      console.log(WARN(`  Unknown command: ${outcome.command}. Type /help`));
      return 'ok';
  }
}

/**
 * Render one AgentClientEvent to the terminal. The status line is part of the
 * same event flow: every label it shows is a state the turn actually entered —
 * `thinking` until output starts, the tool's name while its call runs — so the
 * line never spins a claim the client did not make. The vocabulary matches the
 * TUI's phase line word for word.
 */
function renderClientEvent(
  event: AgentClientEvent, agentName: string, status: TurnStatus,
  getHeader: () => boolean, setHeader: (v: boolean) => void,
): void {
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
        // A cascaded user turn (steer follow-up / queued leftover) gets its
        // own agent-name header when its response starts.
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
      printToolResult(event.result);
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
      break;
    case 'turn-end':
    case 'run-event':
      break;
  }
}
