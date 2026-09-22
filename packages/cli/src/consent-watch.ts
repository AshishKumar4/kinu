/**
 * The one device-consent poll/present/resolve loop for every CLI surface. Each consent is presented at most once while pending;
 * stopping aborts an in-flight question and best-effort denies it so the blocked device RPC unblocks.
 */

import type {
  DeviceConsentDecision,
  DeviceConsentSurface,
  PendingDeviceConsent,
} from './agent-client';
import { DIM, ERR, MUTED, WARN } from './display';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';
import { waitForAnswer } from '@kinu.run/core';

const CONSENT_POLL_MS = 750;

export type ConsentNoteKind = 'resolved' | 'stale' | 'error';

export interface ConsentWatchOptions {
  /** Resolves `null` when the surface can only print instructions, `'cancelled'` on abort; must settle promptly on abort. */
  present(
    consent: PendingDeviceConsent,
    signal: AbortSignal,
  ): Promise<DeviceConsentDecision | 'cancelled' | null>;
  note(kind: ConsentNoteKind, message: string): void;
}

export interface ConsentWatcher {
  stop(): void;
  /** Settles once the loop has ended after `stop`. */
  done: Promise<void>;
}

export function watchDeviceConsents(
  consents: DeviceConsentSurface,
  opts: ConsentWatchOptions,
): ConsentWatcher {
  const abort = new AbortController();
  const handled = new Set<string>();

  const tick = async () => {
    try {
      const pending = await consents.listPending();

      if (abort.signal.aborted) return;

      // Ids that left the pending list never reappear; forgetting them keeps the set bounded.
      const live = new Set(pending.map((item) => item.consentId));

      for (const id of handled) if (!live.has(id)) handled.delete(id);

      const consent = pending.find((item) => !handled.has(item.consentId));

      if (!consent) return;

      const outcome = await opts.present(consent, abort.signal);
      handled.add(consent.consentId);

      if (outcome === 'cancelled') {
        // Deny so the blocked device RPC unblocks; reported here because the outer guard drops 'cancelled' failures.
        try {
          await consents.resolve(consent.consentId, 'deny');
        } catch (err) {
          opts.note('error', `Could not withdraw the request to use ${consent.deviceLabel}. It expires on its own: ${renderThrownChain({ cause: err })}`);
        }

        return;
      }

      if (outcome === null) return;
      const result = await consents.resolve(consent.consentId, outcome);

      if (abort.signal.aborted) return;

      if (result.ok) opts.note('resolved', decisionFeedback(outcome));
      else opts.note('stale', 'That request is no longer waiting for an answer.');
    } catch (err) {
      if (!abort.signal.aborted) {
        opts.note('error', renderThrownChain({ cause: err }));
      }
    }
  };

  // Runs until `stop`; a failure past the tick's own reporting ends the loop and is recorded, never an unhandled rejection.
  const done = (async () => {
    try {
      await waitForAnswer(async () => {
        await tick();

        return undefined;
      }, { intervalMs: CONSENT_POLL_MS, signal: abort.signal });
    } catch (cause) {
      diagnostics.failure(
        'consent.poll_failed',
        toKinuError({ doing: 'polling pending device consents', cause, otherwise: 'io' }),
      );
    }
  })();

  return {
    stop() {
      abort.abort();
    },
    done,
  };
}

function decisionFeedback(decision: DeviceConsentDecision): string {
  if (decision === 'deny') return 'Denied.';

  return decision === 'always' ? 'Approved (always).' : 'Approved once.';
}

/** Resolves null on EOF or abort. */
export type ConsentAskLine = (question: string, signal: AbortSignal) => Promise<string | null>;

/** Interactive stdin gets a y/a/n prompt; non-interactive runs print instructions once per request so the turn never stalls silently. */
export function watchTerminalConsents(
  consents: DeviceConsentSurface,
  agentName: string,
  askLine: ConsentAskLine,
): ConsentWatcher {
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;

  return watchDeviceConsents(consents, {
    present: (consent, signal) => {
      if (!tty) {
        console.log(`\n${WARN(`The agent wants to use ${consent.deviceLabel}`)} (${consent.method}: ${consent.command || 'command'}).`);
        console.log(MUTED(`  Approve or deny from the Kinu app, or run: kinu chat ${agentName}`));

        return Promise.resolve(null);
      }

      return promptConsentDecision(consent, askLine, signal);
    },
    note: (kind, message) => {
      console.log(kind === 'error' ? `${ERR('error')} ${message}` : DIM(`  ${message}`));
    },
  });
}

/** `kinu exec`: denies every pending consent (fail closed) and flags the run via `onDenied`. "Always" devices raise none. */
export function watchHeadlessConsents(
  consents: DeviceConsentSurface,
  agentName: string,
  opts: { json: boolean; onDenied(): void },
): ConsentWatcher {
  const instructions = `Pre-authorize with "always allow" via kinu chat ${agentName} or the Kinu app, then re-run.`;

  return watchDeviceConsents(consents, {
    present: (consent) => {
      opts.onDenied();

      if (opts.json) {
        process.stdout.write(`${JSON.stringify({
          type: 'consent_denied',
          consentId: consent.consentId,
          deviceLabel: consent.deviceLabel,
          method: consent.method,
          command: consent.command,
          message: `Denied: nobody was at the terminal to approve it. ${instructions}`,
        })}\n`);
      } else {
        console.error(`\n${WARN('Denied: nobody was at the terminal to approve it')} ${consent.method} on ${consent.deviceLabel}: ${consent.command || '(command)'}`);
        console.error(MUTED(`  ${instructions}`));
      }

      return Promise.resolve('deny');
    },
    note: (kind, message) => {
      // The consent_denied line already reports the outcome.
      if (kind === 'error') console.error(`${ERR('error')} ${message}`);
    },
  });
}

async function promptConsentDecision(
  consent: PendingDeviceConsent,
  askLine: ConsentAskLine,
  signal: AbortSignal,
): Promise<DeviceConsentDecision | 'cancelled'> {
  console.log(`\n${WARN(`This agent wants to use ${consent.deviceLabel}`)}`);
  console.log(`  ${DIM('Device:')}  ${consent.deviceLabel}`);
  console.log(`  ${DIM('Method:')}  ${consent.method}`);
  console.log(`  ${DIM('Command:')} ${consent.command || '(command)'}`);

  while (!signal.aborted) {
    const answer = await askLine(`${DIM('[y] allow once · [a] always allow · [n] deny ›')} `, signal);

    if (signal.aborted) return 'cancelled';

    if (answer === null) return 'deny'; // EOF
    const normalized = answer.trim().toLowerCase();

    if (normalized === 'y' || normalized === 'yes' || normalized === 'o') return 'once';

    if (normalized === 'a' || normalized === 'always') return 'always';

    if (normalized === 'n' || normalized === 'no') return 'deny';
    console.log(DIM('  Answer y, a or n.'));
  }

  return 'cancelled';
}
