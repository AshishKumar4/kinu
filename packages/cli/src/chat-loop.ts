/**
 * Classic readline chat surface for both backends, driven by an AgentClient. First Ctrl+C during a turn stops it;
 * a second (or Ctrl+C while idle) exits. A line typed mid-turn steers the running turn.
 */

import * as readline from 'node:readline';
import { renderChangelogText } from '@kinu.run/core/tui';
import { forkCandidates, type AgentClient, type AgentClientEvent } from './agent-client';
import { describeBranchStatus, executeSlashCommand, isBranchStatusEvent, performUndo, renderPlanReview, renderStatusLines, renderTakesText, type SlashOutcome } from './slash-commands';
import { describePromptAttachment, resolvePromptAttachments } from './attachments';
import { watchTerminalConsents } from './consent-watch';
import {
  connectDevice,
  defaultDeviceName,
  describeConnectOutcome,
  waitingDots,
  deviceStatusLine,
  dismissDeviceConnectPrompt,
  killSessionDaemon,
  shouldOfferDeviceConnect,
} from './device-connect';
import { requireAuthConfig } from './config';
import {
  printStepCut, printToolCall, printToolResult, printEvolutionEvent, createTurnStatus, formatFailure,
  ACCENT, DIM, MUTED, ERR, OK, WARN, type TurnStatus,
} from './display';
import { renderThrownChain, detach } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import { initialInputState, reduceInput, type InputMachineEvent, type WorkMode } from '@kinu.run/core';
import { clipText } from '@kinu.run/core/tui';

export interface ChatLoopOpts {
  client: AgentClient;
}

export async function runChatLoop(opts: ChatLoopOpts): Promise<void> {
  let client = opts.client;
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Reset per user turn so the name header prints once and the status line stops on first output.
  let turnStatus = createTurnStatus({ hold: () => consentAskPending || rl.line.length > 0 });
  let headerPrinted = false;
  let interruptRequested = false;
  let exiting = false;
  /** The TUI's input machine: turns counted by their events, and what waits behind them. */
  let machine = initialInputState;
  /** Sends not yet answered: a turn is owed from the moment its send leaves. */
  let sending = 0;
  /** Resolves the prompt loop's wait once no turn runs and none is owed. */
  let idle: (() => void) | null = null;
  let pendingPrefill: string | null = null;
  /** Answer lines to a consent question must not be read as steering input. */
  let consentAskPending = false;

  const busy = () => machine.activeTurns > 0 || sending > 0;

  const settleIfIdle = () => {
    if (busy() || idle === null) return;
    const resolve = idle;
    idle = null;
    resolve();
  };

  const dispatch = (event: InputMachineEvent) => {
    const transition = reduceInput(machine, event);
    machine = transition.state;

    for (const effect of transition.effects) {
      if (effect.kind === 'interrupt') client.stop();
      else if (effect.kind === 'set-input') pendingPrefill = effect.text;
      else if (effect.kind === 'hint') console.log(DIM(`  ${effect.text}`));
      // The machine releases a queued prompt as a turn settles; it is sent once that event's handling has returned.
      else if (effect.kind === 'send-queued') queueMicrotask(() => detach(Effect.promise(async () => runTurn(effect.text))));
      else if (effect.kind === 'send-branch' && !client.branch(effect.text, { cwd: process.cwd() })) {
        console.log(DIM('  ⧗ the turn just finished. Queued to send next.'));
        dispatch({ type: 'queue', text: effect.text });
      }
    }

    settleIfIdle();
  };

  const onClientEvent = (event: AgentClientEvent) => {
    if (event.type === 'turn-start') dispatch({ type: 'turn-start' });
    else if (event.type === 'turn-end') dispatch({ type: 'turn-settled' });
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
    if (busy() && !interruptRequested) {
      interruptRequested = true;
      console.log(WARN('\n  Interrupting the active turn… (Ctrl+C again to exit)'));
      const queued = machine.queue.length;

      dispatch({ type: 'interrupt', draft: rl.line });

      // Held messages never fire after a stop; they come back as the next prompt's text.
      if (queued > 0) console.log(WARN(`  ${String(queued)} queued message(s) are back in the next prompt.`));

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

  rl.on('SIGINT', () => detach(Effect.promise(onInterrupt)));
  process.on('SIGINT', () => detach(Effect.promise(onInterrupt)));

  // Lines answering a consent question are excluded.
  const onMidTurnLine = async (input: string) => {
    const command = input.split(/\s+/, 1)[0].toLowerCase();

    if (command === '/stop') {
      client.stop();

      return;
    }

    if (command === '/queue') {
      const text = input.slice('/queue'.length).trim();

      if (!text) console.log(DIM('  Usage while a turn runs: /queue <text>'));
      dispatch({ type: 'queue', text });

      if (text && machine.queue.length > 0) console.log(DIM(`  ⧗ queued: sends after this turn (${String(machine.queue.length)} waiting)`));

      return;
    }

    if (command === '/branch') {
      const text = input.slice('/branch'.length).trim();

      if (!text) console.log(DIM('  Usage while a turn runs: /branch <text>. It runs the redirect in parallel.'));
      else dispatch({ type: 'branch', draft: text });

      return;
    }

    if (input.startsWith('/')) {
      console.log(DIM('  A turn is running. Type to steer it, or use /queue <text>, /branch <text>, /stop.'));

      return;
    }

    const resolved = await resolvePromptAttachments(input, { limitBytes: client.inlineAttachmentLimitBytes, planes: client.planes ?? undefined });

    for (const problem of resolved.errors) console.log(WARN(`  ${problem}`));
    const payload = resolved.files.length > 0 ? { text: resolved.text, files: resolved.files } : resolved.text;

    const sent = await client.send(payload, { cwd: process.cwd() });

    if (sent.landed === 'mid-turn') console.log(DIM('  ↪ steering the running turn'));
    else console.log(DIM('  ⧗ the turn had just finished, so this ran as the next message.'));
  };

  rl.on('line', (line) => detach(Effect.promise(async () => { if (!busy() || consentAskPending || exiting) return;
  const input = line.trim();
  
  if (!input) return;
  
  try {
    await onMidTurnLine(input);
  } catch (cause) {
    console.log(`\n${formatFailure({ cause })}\n`);
  } })));

  await client.connect();

  if (tty) {
    console.log(`\n${ACCENT(client.agentName)} ${DIM(`${client.mode} chat`)}`);
    console.log(DIM('Type a message, /help for commands, /exit to leave. Ctrl+C interrupts a running turn.'));
    console.log(DIM('While a turn runs: type+Enter steers it · /queue <text> sends after · /fork walks back.\n'));
  }

  if (client.mode === 'cloud') await maybeOfferDeviceConnect(rl, tty);

  const promptLabel = () => tty ? `${ACCENT(client.agentName)} ${DIM('›')} ` : '';

  /** No turn runs and none is owed: the machine settles queued sends itself, so the loop only waits for the end. */
  const settled = () => new Promise<void>((resolve) => {
    idle = resolve;
    settleIfIdle();
  });

  const consentAsk = async (question: string, signal: AbortSignal) => {
    consentAskPending = true;
    turnStatus.clear();

    try {
      return await ask(rl, question, signal);
    } finally {
      consentAskPending = false;

      if (busy()) turnStatus.resume();
    }
  };

  const runTurn = async (input: string, mode?: WorkMode) => {
    const resolved = await resolvePromptAttachments(input, { limitBytes: client.inlineAttachmentLimitBytes, planes: client.planes ?? undefined });

    for (const problem of resolved.errors) console.log(WARN(`  ${problem}`));

    if (resolved.attached.length > 0) {
      console.log(DIM(`  + ${resolved.attached.map(describePromptAttachment).join(' · ')}`));
    }

    headerPrinted = false;
    interruptRequested = false;
    sending += 1;
    turnStatus.show('thinking');

    const consentWatch = client.consents
      ? watchTerminalConsents(client.consents, client.agentName, consentAsk)
      : null;

    try {
      await client.send(
        resolved.files.length > 0 ? { text: resolved.text, files: resolved.files } : resolved.text,
        { cwd: process.cwd(), ...(mode !== undefined && { mode }) },
      );
    } catch (err) {
      turnStatus.clear();
      console.log(`\n${formatFailure({ cause: err })}\n`);
    } finally {
      consentWatch?.stop();
      sending -= 1;
      turnStatus.clear();
      console.log('\n');
      settleIfIdle();
    }
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
    await settled();
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
          queueOrExplain(outcome.text, dispatch);
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
    console.log(MUTED('No PC is connected. Connect this one with: kinu connect'));

    return;
  }

  console.log(`${WARN('Let this agent use this PC?')}`);
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
    const dots = waitingDots('  ');
    const result = await connectDevice(auth, { session, label: defaultDeviceName(), onWaiting: dots.onWaiting });
    dots.end();
    const outcome = describeConnectOutcome(result, session);
    console.log(`  ${outcome.ok ? OK('✓') : ERR('✗')} ${outcome.message}`);
  } catch (err) {
    console.log(`  ${ERR('✗')} ${renderThrownChain({ cause: err })}`);
  }
}

function showText(outcome: Extract<SlashOutcome, { kind: 'text' }>): void {
  if (outcome.copy !== undefined) process.stdout.write(`\x1b]52;c;${Buffer.from(outcome.copy).toString('base64')}\x07`);
  console.log(`\n${MUTED(outcome.text)}\n`);
}

/** Line mode shows the questions; the full-screen chat and the web app answer them. */
function showQuestions(outcome: Extract<SlashOutcome, { kind: 'questions' }>): void {
  for (const question of outcome.asking.asked.questions) console.log(`\n  ${question.question}\n${question.options.map((option) => `    - ${option.label}`).join('\n')}`);
  console.log(`\n${MUTED('Answer it in the web app or in the full-screen chat; this line mode cannot.')}\n`);
}

function showChangelog(outcome: Extract<SlashOutcome, { kind: 'changelog' }>): void {
  console.log(`\n${MUTED(renderChangelogText(outcome.view.entries, { unseenCount: outcome.view.unseenCount }))}`);

  if (outcome.view.entries.some((entry) => entry.revert)) {
    console.log(MUTED('Revert a line with /changelog revert <n>. Keeping is the default.'));
  }

  console.log('');
}

async function applySlashOutcome(client: AgentClient, rl: readline.Interface, outcome: SlashOutcome): Promise<'ok' | 'exit'> {
  switch (outcome.kind) {
    case 'exit':
      return 'exit';
    case 'text':
      showText(outcome);

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
    case 'questions':
      showQuestions(outcome);

      return 'ok';
    case 'changelog':
      showChangelog(outcome);

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
      const menu = await client.listModels();

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

function queueOrExplain(text: string | undefined, dispatch: (event: InputMachineEvent) => void): void {
  if (text === undefined || text === '') {
    console.log(DIM('  Usage: /queue <text>. It sends after the running turn, or at once when idle.'));

    return;
  }

  dispatch({ type: 'queue', text });
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
    case 'step-cut':
      status.clear();
      printStepCut();
      break;
    case 'reasoning-delta':
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

      if (event.event.type === 'model_fallback') {
        status.clear();
        console.log(`\n${DIM(event.event.message ?? '')}`);
      }

      break;
    case 'turn-end':
    case 'run-event':
      break;
  }
}
