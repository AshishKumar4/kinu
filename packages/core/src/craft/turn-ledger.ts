/**
 * A turn's crafted-tool record: each `eval` call of the turn that created or called a crafted tool, as the isolate that
 * ran it observed it (`observeCraftCall`). Its run's `craft_cycle` row and the use the turn's review scores read it.
 */
import type { CraftCycleRecord } from '../events/types';
import type { CraftCall } from './in-episode';

export class TurnCraftLedger {
  /**
   * Whether the turn's `eval` calls are observed where they run: evolution on, and not Plan. Set as the turn opens; an
   * isolate that runs no `eval` of the turn keeps the calls its tools' answers carry, whatever it says.
   */
  recording: boolean;
  /** By call id, in the order they settled. */
  private readonly calls = new Map<string, CraftCall>();

  constructor(recording = false) {
    this.recording = recording;
  }

  reset(): void {
    this.calls.clear();
    this.recording = false;
  }

  note(callId: string, call: CraftCall): void {
    this.calls.set(callId, call);
  }

  /** What the call `callId` observed, or null. */
  call(callId: string): CraftCall | null {
    return this.calls.get(callId) ?? null;
  }

  /** Every crafted tool the turn called, once each, in the order first called. */
  used(): string[] {
    return [...new Set([...this.calls.values()].flatMap((call) => call.invoked))];
  }

  /** Null when nothing was crafted or called: `turn_end` is the denominator. */
  snapshot(): CraftCycleRecord | null {
    const crafted = new Set<string>();
    const reused = new Set<string>();
    const dropped = new Set<string>();
    let returned = 0;
    let raised = 0;

    for (const call of this.calls.values()) {
      for (const name of call.created) crafted.add(name);

      // The loop closes when a later call reaches for what this turn crafted.
      for (const name of call.returned) if (crafted.has(name)) reused.add(name);

      for (const name of call.dropped) dropped.add(name);
      returned += call.returned.length;
      raised += call.raised.length;
    }

    const invoked = this.used();

    if (crafted.size === 0 && invoked.length === 0) return null;

    return { crafted: [...crafted], invoked, reused: [...reused], returned, raised, dropped: [...dropped] };
  }
}
