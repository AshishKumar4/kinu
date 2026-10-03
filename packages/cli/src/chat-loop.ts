/**
 * Classic readline chat surface for both backends, driven by an AgentClient. First Ctrl+C during a turn stops it;
 * a second (or Ctrl+C while idle) exits. A line typed mid-turn steers the running turn.
 */

import { Cause, Effect } from 'effect';
import * as readline from 'node:readline';
import { renderChangelogText } from '@kinu.run/core/tui';
import { EMPTY_MODEL_MENU, type AgentModelMenu } from '@kinu.run/core';
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
  printToolCall, printToolResult, printEvolutionEvent, createTurnStatus, formatFailure,
  ACCENT, DIM, MUTED, ERR, OK, WARN, type TurnStatus,
} from './display';
import { renderThrownChain, detach, settle } from '@kinu.run/core/obs';
import { type WorkMode } from '@kinu.run/core';
import { clipText } from '@kinu.run/core/tui';

export interface ChatLoopOpts {
  client: AgentClient;
}

export function runChatLoop(opts: ChatLoopOpts): Promise<void> {
  return settle(Effect.gen(function* () {
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

    const onExit = (): Effect.Effect<void> => Effect.gen(function* () {
      if (exiting) return;
      exiting = true;
      unsubscribe();
      // close() flushes a partial evolution window; cap it so Ctrl+C never hangs.
      const cap = Promise.withResolvers<void>();
      setTimeout(cap.resolve, 5000);

      yield* Effect.catchCause(Effect.promise(() => Promise.race([client.close(), cap.promise])), (failed) => Effect.sync(() => {
        console.log(WARN('\n  This session did not close cleanly. Its last evolution window may not have flushed.'));
        console.log(formatFailure({ cause: Cause.squash(failed) }));
      }));

      // A session daemon lives as long as the chat it was started for.
      yield* Effect.catchCause(Effect.sync(() => killSessionDaemon()), printing);

      console.log(DIM('\n  Goodbye.\n'));
      rl.close();
      process.exit(0);
    });

    const onInterrupt = (): Effect.Effect<void> => Effect.suspend(() => {
      if (turnInFlight && !interruptRequested) {
        interruptRequested = true;
        client.stop();
        console.log(WARN('\n  Interrupting the active turn… (Ctrl+C again to exit)'));

        // Interrupt means stop — held messages must not auto-fire afterwards.
        if (queuedInputs.length > 0) {
          console.log(WARN(`  Dropping ${queuedInputs.length} queued message(s):`));

          for (const queued of queuedInputs.splice(0)) console.log(DIM(`    ⧗ ${queued}`));
        }

        return Effect.void;
      }

      return Effect.catchCause(onExit(), (failed) => Effect.sync(() => {
        console.log(`\n${formatFailure({ cause: Cause.squash(failed) })}\n`);
        rl.close();
        process.exit(1);
      }));
    });

    rl.on('SIGINT', () => detach(onInterrupt()));
    process.on('SIGINT', () => detach(onInterrupt()));

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

    rl.on('line', (line) => detach(Effect.suspend(() => {
      if (!turnInFlight || consentAskPending || exiting) return Effect.void;
      const input = line.trim();

      if (!input) return Effect.void;

      return Effect.catchCause(Effect.promise(() => onMidTurnLine(input)), printingBlock);
    })));

    yield* Effect.promise(() => client.connect());

    if (tty) {
      console.log(`\n${ACCENT(client.agentName)} ${DIM(`${client.mode} chat`)}`);
      console.log(DIM('Type a message, /help for commands, /exit to leave. Ctrl+C interrupts a running turn.'));
      console.log(DIM('While a turn runs: type+Enter steers it · /queue <text> sends after · /fork walks back.\n'));
    }

    if (client.mode === 'cloud') yield* maybeOfferDeviceConnect(rl, tty);

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

    const consentAsk = (question: string, signal: AbortSignal): Effect.Effect<string | null> => {
      consentAskPending = true;
      turnStatus.clear();

      return Effect.ensuring(ask(rl, question, signal), Effect.sync(() => {
        consentAskPending = false;

        if (turnInFlight) turnStatus.resume();
      }));
    };

    const runTurn = (input: string, mode?: WorkMode): Effect.Effect<void> => Effect.gen(function* () {
      const resolved = yield* Effect.promise(() => resolvePromptAttachments(input, { limitBytes: client.inlineAttachmentLimitBytes }));

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

      yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
        yield* Effect.promise(() => client.send(
          resolved.files.length > 0 ? { text: resolved.text, files: resolved.files } : resolved.text,
          { cwd: process.cwd(), ...(mode !== undefined && { mode }) },
        ));
        yield* Effect.promise(() => waitForTurnsToSettle());
      }), (failed) => Effect.sync(() => {
        turnStatus.clear();
        console.log(`\n${formatFailure({ cause: Cause.squash(failed) })}\n`);
      })), Effect.sync(() => {
        consentWatch?.stop();
        turnInFlight = false;
        turnStatus.clear();
      }));

      console.log('\n');
    });

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

    /** One slash command; `exit` once the session has closed. */
    const slashCommand = (input: string): Effect.Effect<'ok' | 'exit'> => Effect.gen(function* () {
      const outcome = yield* Effect.promise(() => executeSlashCommand(client, input));

      if (outcome.kind === 'queue') {
        queueOrExplain(outcome.text, queuedInputs);

        return 'ok';
      }

      // Idle — there is no live turn to branch from; run it normally.
      if (outcome.kind === 'branch') yield* branchOrExplain(outcome.text, runTurn);
      else if (outcome.kind === 'plan') yield* planOrExplain(outcome.text, runTurn);
      else if (outcome.kind === 'fork') yield* Effect.promise(() => handleFork(outcome.ref));
      else if (outcome.kind === 'undo') yield* Effect.promise(() => runUndo(client, outcome.ref, handleFork));
      else if ((yield* applySlashOutcome(client, rl, outcome)) === 'exit') {
        yield* onExit();

        return 'exit';
      }

      return 'ok';
    });

    while (!exiting) {
      while (!exiting && queuedInputs.length > 0) {
        const queued = queuedInputs.shift();

        if (queued === undefined) break;
        yield* runTurn(queued);
      }

      const prefill = pendingPrefill;
      pendingPrefill = null;
      const line = yield* ask(rl, promptLabel(), undefined, prefill ?? undefined);

      if (line === null) break; // EOF
      const input = line.trim();

      if (!input) continue;

      if (input.startsWith('/')) {
        if ((yield* Effect.catchCause(slashCommand(input), (failed) => Effect.as(printingBlock(failed), 'ok' as const))) === 'exit') return;

        continue;
      }

      yield* runTurn(input);
    }

    yield* onExit();
  }));
}

/** A failure the session survives, printed on its own lines. */
function printingBlock(failed: Cause.Cause<unknown>): Effect.Effect<void> {
  return Effect.sync(() => {
    console.log(`\n${formatFailure({ cause: Cause.squash(failed) })}\n`);
  });
}

/** A cleanup's failure, printed: the session goes on closing. */
function printing(failed: Cause.Cause<unknown>): Effect.Effect<void> {
  return Effect.sync(() => {
    console.log(formatFailure({ cause: Cause.squash(failed) }));
  });
}

/** Resolves null on EOF/close (piped input ends cleanly) and on abort. Settling always detaches listeners. */
function ask(rl: readline.Interface, prompt: string, signal?: AbortSignal, prefill?: string): Effect.Effect<string | null> {
  return Effect.suspend(() => {
    const answered = Promise.withResolvers<string | null>();
    let settled = false;

    const finish = (answer: string | null) => {
      if (settled) return;
      settled = true;
      rl.off('close', onClose);
      signal?.removeEventListener('abort', onAbort);
      answered.resolve(answer);
    };

    const onClose = () => finish(null);
    const onAbort = () => finish(null);
    rl.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });

    const asking = Effect.catchCause(Effect.sync(() => {
      rl.question(prompt, finish);

      if (prefill) rl.write(prefill);
    }), (failed) => Effect.sync(() => {
      // Stdin hit EOF. Stderr, because stdout carries only the conversation.
      process.stderr.write(`note: readline closed before the prompt: ${renderThrownChain({ cause: Cause.squash(failed) })}\n`);
      finish(null);
    }));

    return Effect.andThen(asking, Effect.promise(() => answered.promise));
  });
}

/** Offer once per invocation to connect this PC when a cloud chat opens with none; persisted "don't ask
 * again". Non-interactive stdin gets the `kinu connect` instruction instead. */
function maybeOfferDeviceConnect(rl: readline.Interface, tty: boolean): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (!(yield* Effect.promise(() => shouldOfferDeviceConnect()))) return;

    if (!tty) {
      console.log(MUTED('No computer is connected. Connect this one with: kinu connect'));

      return;
    }

    console.log(`${WARN('Let this agent use this computer?')}`);
    console.log(MUTED(`  Linking installs the Kinu daemon and registers this machine as "${defaultDeviceName()}".`));
    console.log(MUTED('  A workspace you approve runs commands here in a sandbox.'));
    console.log(MUTED('  You approve each workspace once, and revoke it in Account settings → Devices.'));
    yield* promptDeviceConnect(rl, { allowDismiss: true });
    console.log('');
  });
}

function promptDeviceConnect(rl: readline.Interface, opts: { allowDismiss: boolean }): Effect.Effect<void> {
  return Effect.gen(function* () {
    const choices = opts.allowDismiss
      ? `[c] connect and stay connected · [s] this session only · [n] not now · [d] don't ask again ›`
      : `[c] connect and stay connected · [s] this session only · [n] not now ›`;

    for (;;) {
      const answer = (yield* ask(rl, `${DIM(choices)} `))?.trim().toLowerCase();

      if (answer === undefined || answer === 'n' || answer === 'no') return; // EOF or not now

      if (answer === 'c' || answer === 's') {
        yield* runDeviceConnect(answer === 's');

        return;
      }

      if (opts.allowDismiss && answer === 'd') {
        yield* Effect.promise(() => dismissDeviceConnectPrompt());
        console.log(DIM(`  Kinu won't ask again. Connect later with /connect or kinu connect.`));

        return;
      }

      console.log(DIM(opts.allowDismiss ? '  Answer c, s, n or d.' : '  Answer c, s or n.'));
    }
  });
}

function runDeviceConnect(session: boolean): Effect.Effect<void> {
  return Effect.catchCause(Effect.gen(function* () {
    const auth = requireAuthConfig();
    const dots = waitingDots('  ');
    const result = yield* Effect.promise(() => connectDevice(auth, { session, label: defaultDeviceName(), onWaiting: dots.onWaiting }));
    dots.end();
    const outcome = describeConnectOutcome(result, session);
    console.log(`  ${outcome.ok ? OK('✓') : ERR('✗')} ${outcome.message}`);
  }), (failed) => Effect.sync(() => {
    console.log(`  ${ERR('✗')} ${renderThrownChain({ cause: Cause.squash(failed) })}`);
  }));
}

function showText(outcome: Extract<SlashOutcome, { kind: 'text' }>): void {
  if (outcome.copy !== undefined) process.stdout.write(`\x1b]52;c;${Buffer.from(outcome.copy).toString('base64')}\x07`);
  console.log(`\n${MUTED(outcome.text)}\n`);
}

function applySlashOutcome(client: AgentClient, rl: readline.Interface, outcome: SlashOutcome): Effect.Effect<'ok' | 'exit'> {
  return Effect.gen(function* () {
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
        const current = yield* Effect.promise(() => client.getModelSpec());
        console.log(`\n${DIM('Model:')} ${ACCENT(current ?? '(default)')}`);

        // A list that cannot be read is named as a failure, never shown as an empty menu.
        const menu = yield* Effect.catchCause(Effect.promise(() => client.listModels()), (failed): Effect.Effect<AgentModelMenu> => Effect.succeed({
          ...EMPTY_MODEL_MENU,
          failures: [{ provider: 'the model list', reason: renderThrownChain({ cause: Cause.squash(failed) }) }],
        }));

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
        console.log(`\n${DIM('Devices:')} ${yield* Effect.promise(() => deviceStatusLine())}`);

        if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
          yield* promptDeviceConnect(rl, { allowDismiss: false });
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
  });
}

function planOrExplain(
  text: string | undefined,
  runTurn: (text: string, mode?: WorkMode) => Effect.Effect<void>,
): Effect.Effect<void> {
  if (text === undefined || text === '') {
    console.log(DIM('  Usage: /plan <what to plan>. It drafts a plan you approve with /plan approve.'));

    return Effect.void;
  }

  return runTurn(text, 'plan');
}

function branchOrExplain(text: string | undefined, runTurn: (text: string) => Effect.Effect<void>): Effect.Effect<void> {
  if (text === undefined || text === '') {
    console.log(DIM('  Usage: /branch <text>. It runs a redirect as a parallel branch during a turn.'));

    return Effect.void;
  }

  return runTurn(text);
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
