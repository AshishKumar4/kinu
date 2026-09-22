/**
 * In-episode craft clock: every settled `eval` call is read for tools it created and crafted tools
 * it called, from the runtime's own record. Scoring semantics live in craft/in-episode.ts.
 * The write is one synchronous update with no await, so retirement takes effect mid-episode.
 */

import type { ToolResultContext } from '../extension';
import * as v from 'valibot';
import type { CraftCycleRecord } from '../events/types';
import type { CraftLedger } from '../craft/in-episode';
import {
  CRAFT_INVOCATION_QUALITY, craftCreatesTool, craftFailureBlame, craftInvocationSites,
} from '../craft/in-episode';
import { isFailingToolResult } from './turn-steering';
import { isBackgroundOutcomeText } from '../jobs/threshold';
import type { BuiltinToolName } from '../tools/registry';

const CODEMODE_TOOL: BuiltinToolName = 'eval';

/** Crafted tools run inside `eval`, never as tool-call names, so this scan is the only source of usage. */
export interface CraftUsageSink {
  noteCraftedToolUse(names: readonly string[]): void;
}

export class CraftCycle {
  /** Callable set as of the last settlement. Not a dispatch-time snapshot: the call hook is not
   *  ordered against execution, so it can already contain what the call created. */
  private seen: ReadonlySet<string> = new Set();
  private readonly crafted = new Set<string>();
  private readonly invokedNames = new Set<string>();
  private readonly reused = new Set<string>();
  private readonly dropped = new Set<string>();
  private returned = 0;
  private raised = 0;
  /** With auto-evolution off a turn records no craft score. */
  private enabled = false;

  constructor(
    private readonly ledger: CraftLedger,
    private readonly usage: CraftUsageSink,
  ) {}

  reset(enabled: boolean): void {
    this.crafted.clear();
    this.invokedNames.clear();
    this.reused.clear();
    this.dropped.clear();
    this.returned = 0;
    this.raised = 0;
    this.enabled = enabled;
    this.seen = new Set(enabled ? this.ledger.names() : []);
  }

  /** Background handles and refusals (jobs/threshold.ts) are not scored; the set still rolls forward. */
  onToolResult(ctx: ToolResultContext): void {
    if (!this.enabled || ctx.toolName !== CODEMODE_TOOL) return;

    const known = this.ledger.names();
    const before = this.seen;
    this.seen = new Set(known);

    if (isBackgroundOutcomeText(ctx.result)) return;
    const submitted = ctx.args.code;
    const parsedCode = v.safeParse(v.string(), submitted);
    const code = parsedCode.success ? parsedCode.output : '';

    // The set can also grow from the turn-outcome review (evolution/engine.ts); only attribute asked-for creation.
    if (craftCreatesTool(code)) {
      for (const name of known) if (!before.has(name)) this.crafted.add(name);
    }

    const sites = craftInvocationSites(code, known);

    if (sites.length === 0) return;

    for (const name of sites) this.invokedNames.add(name);
    this.usage.noteCraftedToolUse(sites);

    // The stamp is the evidence, not the call's own verdict.
    const blamed = craftFailureBlame(ctx.result, sites);
    this.raised += blamed.length;
    this.record(blamed, CRAFT_INVOCATION_QUALITY.raised);

    if (isFailingToolResult(ctx)) return;

    // A tool cannot certify itself in the call that created it (craft/in-episode.ts, property 2).
    const earned = sites.filter((name) => before.has(name) && !blamed.includes(name));

    for (const name of earned) if (this.crafted.has(name)) this.reused.add(name);
    this.returned += earned.length;
    this.record(earned, CRAFT_INVOCATION_QUALITY.returned);
  }

  private record(names: readonly string[], quality: number): void {
    if (names.length === 0) return;

    for (const name of this.ledger.observe(names, quality)) this.dropped.add(name);
  }

  /** Null when nothing was crafted or called: `turn_end` is the denominator. */
  snapshot(): CraftCycleRecord | null {
    if (this.crafted.size === 0 && this.invokedNames.size === 0) return null;

    return {
      crafted: [...this.crafted],
      invoked: [...this.invokedNames],
      reused: [...this.reused],
      returned: this.returned,
      raised: this.raised,
      dropped: [...this.dropped],
    };
  }
}
