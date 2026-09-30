import { Agent, callable } from 'agents';
import { Effect } from 'effect';
import { attemptInItsWords, createRecordingLogger, KinuError, setDiagnosticsSink, settle, type RecordedLog } from '@kinu.run/core/obs';
import { reportSocketCallFailures } from '../../src/activation-gate';

/** The refusal ironwood-cairn-6dbcb8de's owner met on 2026-09-29, whose Workers log line held only a stack. */
export const PROBE_REFUSAL = 'Stop the turn that is running before you revert the conversation.';

/** A real SDK subject whose socket calls report their failures as the product's objects do. */
export class SocketCallProbeAgent extends Agent<Cloudflare.Env> {
  private readonly log = createRecordingLogger();
  private restore: (() => void) | null = null;

  @callable() async refuse(): Promise<string> {
    throw new KinuError('denied', PROBE_REFUSAL);
  }

  @callable() async answer(): Promise<string> {
    return 'answered';
  }

  /** The same member called in the object, outside any socket call; the refusal comes back as its words. */
  async refuseWithoutASocket(): Promise<string> {
    return settle(attemptInItsWords('unavailable', () => this.refuse()).pipe(
      Effect.match({ onFailure: (failure) => failure.message, onSuccess: (answer) => answer }),
    ));
  }

  async record(): Promise<void> {
    this.restore ??= setDiagnosticsSink(this.log);
  }

  async logged(): Promise<RecordedLog[]> {
    this.restore?.();
    this.restore = null;

    return [...this.log.emitted];
  }
}

reportSocketCallFailures(SocketCallProbeAgent, Agent);
