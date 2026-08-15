/**
 * The in-episode craft loop — Voyager mode, on the step clock.
 *
 * Every other evolution clock in this repo is conversational: the next user
 * message grades a turn, five turns close a window, twenty-five close a
 * lifetime. One long agentic episode is ONE turn, so inside it nothing evolves
 * — the agent can craft a tool mid-turn and no machinery ever asks whether the
 * tool was any good. This is the clock that ticks there.
 *
 * What this file owns is the TRIGGER and the bookkeeping: every `execute_tools`
 * call, at the moment it settles, read as a creation diff of the callable set
 * plus the call sites in the submitted code — both from the runtime's
 * own record, never from anything the model asserts. What an observation is
 * WORTH, and why a signal the agent provokes is not a signal the agent writes,
 * is craft/in-episode.ts.
 *
 * The write is one synchronous SQL update as the call settles: no model call,
 * no await, no turn boundary, no cadence. That is what makes retirement
 * in-episode — a tool that keeps raising falls under the injection floor and
 * both backends, which re-read the store per execute, stop binding it.
 *
 * The turn's `craft_cycle` run event is the durable trail: whether in-episode
 * crafting fired at all, whether the crafted tool was then reached for again,
 * and whether that reach worked.
 */

import type { ToolResultContext } from '../extension.js';
import * as v from 'valibot';
import type { CraftCycleRecord } from '../events/types.js';
import type { CraftLedger } from '../craft/in-episode.js';
import {
  CRAFT_INVOCATION_QUALITY, craftCreatesTool, craftFailureBlame, craftInvocationSites,
} from '../craft/in-episode.js';
import { isFailingToolResult } from './turn-steering.js';
import { isBackgroundOutcomeText } from '../jobs/threshold.js';
import type { BuiltinToolName } from '../tools/registry.js';

/** The one tool crafted tools are reachable from. */
const EXECUTE_TOOLS: BuiltinToolName = 'execute_tools';

/**
 * Where this clock publishes which crafted tools the turn used — the
 * TurnAccumulator in production.
 *
 * The call-site scan below is the only thing in the system that can see it.
 * Crafted tools are codemode-only, reached from inside an `execute_tools`
 * block, so a crafted tool never appears as a tool-call name — and a consumer
 * that infers the answer from the turn's tool-call list instead ("every name
 * that is not built in") selects MCP and extension tools and nothing else.
 * Both consumers that used to do exactly that — the turn's craft EMA and the
 * durable turn↔craft usage row behind the thumbs re-score — now read the
 * accumulator, so there is one definition.
 */
export interface CraftUsageSink {
  noteCraftedToolUse(names: readonly string[]): void;
}

export class CraftCycle {
  /**
   * The callable set as of the last settled call — the turn's own set at turn
   * start.
   *
   * This, and NOT a snapshot taken when the call was dispatched, is what
   * "existed before this call" means. The call hook is not ordered against the
   * tool's execution: the CLI seam fires it when the consumer reads the SDK's
   * `tool-call` chunk, by which time the tool may already have run, so a
   * snapshot taken there can already contain what the call was about to
   * create. Rolling the set forward at each SETTLEMENT is ordered by
   * construction — a settled call's effects are, by definition, done.
   */
  private seen: ReadonlySet<string> = new Set();
  private readonly crafted = new Set<string>();
  private readonly invokedNames = new Set<string>();
  private readonly reused = new Set<string>();
  private readonly dropped = new Set<string>();
  private returned = 0;
  private raised = 0;
  /** Decided once per turn: a run with auto-evolution off records no evolution
   *  state at all, and a craft score is evolution state. */
  private enabled = false;

  constructor(
    private readonly ledger: CraftLedger,
    private readonly usage: CraftUsageSink,
  ) {}

  /** Clear for a new turn, and decide whether this turn observes anything. */
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

  /**
   * A call settled: roll the callable set forward, then read what it created,
   * what it called, and how it went.
   *
   * The result carries the call's own `args`, so the code being graded is the
   * code that ran — no pairing against the dispatch hook, and therefore no
   * ambiguity when the model issues several `execute_tools` calls in one step.
   *
   * A result that is a background HANDLE is not a result — the work crossed the
   * detach threshold and is still running (jobs/threshold.ts), and its refusal
   * form means the work was cancelled. Neither says anything about a crafted
   * tool, and scoring them would credit exactly the long-running calls this
   * feature exists for with a success they have not earned. The callable set is
   * still rolled forward: whatever the call already wrote, it wrote.
   */
  onToolResult(ctx: ToolResultContext): void {
    if (!this.enabled || ctx.toolName !== EXECUTE_TOOLS) return;

    const known = this.ledger.names();
    const before = this.seen;
    this.seen = new Set(known);
    if (isBackgroundOutcomeText(ctx.result)) return;
    const submitted = ctx.args.code;
    const parsedCode = v.safeParse(v.string(), submitted);
    const code = parsedCode.success ? parsedCode.output : '';

    // Creation is attributed only to a call that asked for it — the callable
    // set can also grow from the detached turn-outcome review's own extraction
    // (evolution/engine.ts), and reporting that as the agent crafting a tool
    // mid-episode would inflate the number this record exists to make honest.
    if (craftCreatesTool(code)) {
      for (const name of known) if (!before.has(name)) this.crafted.add(name);
    }

    const sites = craftInvocationSites(code, known);
    if (sites.length === 0) return;
    for (const name of sites) this.invokedNames.add(name);
    this.usage.noteCraftedToolUse(sites);

    // The stamp is the evidence, not the call's own verdict: a crafted tool
    // that raised has raised whether or not the model caught it, and whether or
    // not the failure text survived the seam's length bound intact.
    const blamed = craftFailureBlame(ctx.result, sites);
    this.raised += blamed.length;
    this.record(blamed, CRAFT_INVOCATION_QUALITY.raised);
    if (isFailingToolResult(ctx)) return;

    // Positive credit only for tools that already existed when the call
    // started: a tool cannot certify itself in the same breath that created it
    // (craft/in-episode.ts, property 2).
    const earned = sites.filter((name) => before.has(name) && !blamed.includes(name));
    for (const name of earned) if (this.crafted.has(name)) this.reused.add(name);
    this.returned += earned.length;
    this.record(earned, CRAFT_INVOCATION_QUALITY.returned);
  }

  private record(names: readonly string[], quality: number): void {
    if (names.length === 0) return;
    for (const name of this.ledger.observe(names, quality)) this.dropped.add(name);
  }

  /** The turn's in-episode craft record, or null when nothing was crafted and
   *  no crafted tool was called — `turn_end` is the denominator, so a turn
   *  that did neither writes no row. */
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
