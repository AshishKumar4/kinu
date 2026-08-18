/**
 * Device-consent watching — the single poll/present/resolve loop behind every
 * CLI surface (readline REPL, one-shot run, TUI overlay).
 *
 * While a turn is processing, the watcher polls the client's pending device
 * consents and presents each one at most once: answered or instruction-printed
 * ids are remembered until they leave the pending list, so a poll tick that
 * races the server-side resolution can never re-prompt. Stopping the watcher
 * (the turn settled) aborts an in-flight question cleanly and best-effort
 * denies it so the blocked device RPC unblocks instead of waiting out its
 * timeout.
 */

import type {
  DeviceConsentDecision,
  DeviceConsentSurface,
  PendingDeviceConsent,
} from './agent-client';
import { DIM, ERR, MUTED, WARN } from './display';

const CONSENT_POLL_MS = 750;

export type ConsentNoteKind = 'resolved' | 'stale' | 'error';

export interface ConsentWatchOptions {
  /**
   * Present one pending consent and gather the user's decision. Resolve
   * `null` when the surface can only print instructions (non-interactive) and
   * `'cancelled'` when `signal` aborts mid-question — the promise MUST settle
   * promptly on abort. Each consent is presented at most once while it stays
   * pending.
   */
  present(
    consent: PendingDeviceConsent,
    signal: AbortSignal,
  ): Promise<DeviceConsentDecision | 'cancelled' | null>;
  /** Surface the outcome of a presented consent. */
  note(kind: ConsentNoteKind, message: string): void;
  pollMs?: number;
}

export interface ConsentWatcher {
  stop(): void;
}

export function watchDeviceConsents(
  consents: DeviceConsentSurface,
  opts: ConsentWatchOptions,
): ConsentWatcher {
  const abort = new AbortController();
  const handled = new Set<string>();
  let presenting = false;

  const tick = async () => {
    if (abort.signal.aborted || presenting) return;
    try {
      const pending = await consents.listPending();
      if (abort.signal.aborted) return;

      // Forget ids that left the pending list — they can never reappear, and
      // the set stays bounded across a long turn.
      const live = new Set(pending.map((item) => item.consentId));
      for (const id of handled) if (!live.has(id)) handled.delete(id);

      const consent = pending.find((item) => !handled.has(item.consentId));
      if (!consent) return;

      presenting = true;
      const outcome = await opts.present(consent, abort.signal);
      handled.add(consent.consentId);
      if (outcome === 'cancelled') {
        // The turn settled mid-question: deny so the blocked device RPC unblocks instead of
        // waiting out its timeout. Reported here rather than below because 'cancelled' means the
        // signal aborted, and the outer guard would drop the one failure that leaves a device hung.
        try {
          await consents.resolve(consent.consentId, 'deny');
        } catch (err) {
          opts.note('error', `Could not withdraw the PC access request — the device waits out its timeout: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      if (outcome === null) return; // instructions printed — nothing to resolve
      const result = await consents.resolve(consent.consentId, outcome);
      if (abort.signal.aborted) return;
      if (result.ok) opts.note('resolved', decisionFeedback(outcome));
      else opts.note('stale', 'That PC access request is no longer pending.');
    } catch (err) {
      if (!abort.signal.aborted) {
        opts.note('error', err instanceof Error ? err.message : String(err));
      }
    } finally {
      presenting = false;
    }
  };

  const interval = setInterval(() => { void tick(); }, opts.pollMs ?? CONSENT_POLL_MS);
  void tick();
  return {
    stop() {
      abort.abort();
      clearInterval(interval);
    },
  };
}

function decisionFeedback(decision: DeviceConsentDecision): string {
  return decision === 'deny' ? 'Denied.'
    : decision === 'always' ? 'Approved (always).'
    : 'Approved once.';
}

/** Read one line from the surface's stdin. Resolve null on EOF or abort. */
export type ConsentAskLine = (question: string, signal: AbortSignal) => Promise<string | null>;

/**
 * Terminal consent watcher shared by the readline REPL and one-shot runs:
 * interactive stdin gets an inline y/a/n prompt (re-asked on invalid input),
 * non-interactive runs print actionable instructions once per request so the
 * turn never stalls silently. Surfaces differ only in how a line is asked.
 */
export function watchTerminalConsents(
  consents: DeviceConsentSurface,
  agentName: string,
  askLine: ConsentAskLine,
): { stop(): void } {
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  return watchDeviceConsents(consents, {
    present: (consent, signal) => {
      if (!tty) {
        console.log(`\n${WARN('PC access requested')} (${consent.method} on ${consent.deviceLabel}: ${consent.command || 'command'}).`);
        console.log(MUTED(`  Approve or deny from the Proteus app, or run: proteus chat ${agentName}`));
        return Promise.resolve(null);
      }
      return promptConsentDecision(consent, askLine, signal);
    },
    note: (kind, message) => {
      console.log(kind === 'error' ? `${ERR('error')} ${message}` : DIM(`  ${message}`));
    },
  });
}

/**
 * Headless (CI) consent watcher for `proteus exec`: never prompts. Every
 * pending device consent is denied immediately — fail closed — with
 * actionable pre-authorization instructions, and the run is flagged through
 * `onDenied` so it exits nonzero. Pre-authorized ("always") devices never
 * raise a consent, so they are unaffected.
 */
export function watchHeadlessConsents(
  consents: DeviceConsentSurface,
  agentName: string,
  opts: { json: boolean; onDenied(): void },
): { stop(): void } {
  const instructions = `Pre-authorize with "always allow" via proteus chat ${agentName} or the Proteus app, then re-run.`;
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
          message: `PC access denied (headless run). ${instructions}`,
        })}\n`);
      } else {
        console.error(`\n${WARN('PC access denied (headless run)')} ${consent.method} on ${consent.deviceLabel}: ${consent.command || '(command)'}`);
        console.error(MUTED(`  ${instructions}`));
      }
      return Promise.resolve('deny');
    },
    note: (kind, message) => {
      // The consent_denied line already reports the outcome; only real
      // failures of the deny round-trip are worth surfacing.
      if (kind === 'error') console.error(`${ERR('error')} ${message}`);
    },
  });
}

async function promptConsentDecision(
  consent: PendingDeviceConsent,
  askLine: ConsentAskLine,
  signal: AbortSignal,
): Promise<DeviceConsentDecision | 'cancelled'> {
  console.log(`\n${WARN('PC access request')} from this agent:`);
  console.log(`  ${DIM('Device:')}  ${consent.deviceLabel}`);
  console.log(`  ${DIM('Method:')}  ${consent.method}`);
  console.log(`  ${DIM('Command:')} ${consent.command || '(command)'}`);
  while (!signal.aborted) {
    const answer = await askLine(`${DIM('[y] allow once · [a] always allow · [n] deny ›')} `, signal);
    if (signal.aborted) return 'cancelled';
    if (answer === null) return 'deny'; // EOF — stdin is gone
    const normalized = answer.trim().toLowerCase();
    if (normalized === 'y' || normalized === 'yes' || normalized === 'o') return 'once';
    if (normalized === 'a' || normalized === 'always') return 'always';
    if (normalized === 'n' || normalized === 'no') return 'deny';
    console.log(DIM('  Please answer y, a, or n.'));
  }
  return 'cancelled';
}
