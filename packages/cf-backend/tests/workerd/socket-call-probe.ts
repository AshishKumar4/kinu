import { Agent, callable, getCurrentAgent } from 'agents';
import { Effect } from 'effect';
import { attemptInItsWords, createRecordingLogger, KinuError, setDiagnosticsSink, settle, type Logger, type RecordedLog } from '@kinu.run/core/obs';
import { reportSocketCallFailures } from '../../src/activation-gate';

/** The refusal ironwood-cairn-6dbcb8de's owner met on 2026-09-29, whose Workers log line held only a stack. */
export const PROBE_REFUSAL = 'Stop the turn that is running before you revert the conversation.';

/** A real SDK subject whose socket calls report their failures as the product's objects do. */
export class SocketCallProbeAgent extends Agent<Cloudflare.Env> {
  private readonly log = createRecordingLogger();
  /** Suites share an isolate, so the sink hears every object in it; whether each line came from this one. */
  private readonly ours: boolean[] = [];
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
    const sink: Logger = {
      event: (name, fields) => {
        this.ours.push(getCurrentAgent().agent === this);
        this.log.event(name, fields);
      },
      failure: (name, error, fields) => {
        this.ours.push(getCurrentAgent().agent === this);
        this.log.failure(name, error, fields);
      },
    };

    this.restore ??= setDiagnosticsSink(sink);
  }

  async logged(): Promise<RecordedLog[]> {
    this.restore?.();
    this.restore = null;

    return this.log.emitted.filter((_, at) => this.ours[at]);
  }
}

reportSocketCallFailures(SocketCallProbeAgent, Agent);
