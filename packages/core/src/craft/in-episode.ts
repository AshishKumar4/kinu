// In-episode evidence for crafted tools: a raise marks the tool broken with its error, a clean return clears it.
// Execution-grounded evidence says "it ran", never "it was right": it never ranks a tool (craft/preference.ts).

import type { SqlExecutor } from '../types/primitives';
import { BUILTIN_TOOL_NAMES } from '../tools/registry';
import { isMcpToolKey } from '../tools/mcp-naming';
import { clearCraftBroken, markCraftBroken, rankByPreference } from './preference';
import * as v from 'valibot';
import { namespacedCalls, parseCodemodeProgram } from '../safety/evolved-code';

/** Shared by admission and the injection filter so they agree on reserved names. */
export function isReservedCraftToolName(name: string): boolean {
  return BUILTIN_TOOL_NAMES.has(name) || isMcpToolKey(name);
}

const CRAFT_NAMESPACES = ['tools'] as const;

export function craftInvocationSites(code: string, known: readonly string[]): string[] {
  if (known.length === 0) return [];
  const program = parseCodemodeProgram(code);

  if (program === null) return [];
  const calls = namespacedCalls(program, CRAFT_NAMESPACES);

  return known.filter((name) => CRAFT_NAMESPACES.some((namespace) => calls.has(`${namespace}.${name}`)));
}

/** Whether the block itself called `workspace.createTool(` (not inside a string body). */
function craftCreatesTool(code: string): boolean {
  const program = parseCodemodeProgram(code);

  return program !== null && namespacedCalls(program, ['workspace']).has('workspace.createTool');
}

/** Where a program's crafted-tool raises are heard as it runs: the host's census for each crafted tool calls it with
 *  the tool's name and what its body threw (`programSurface`), whether or not the program caught the throw. */
export const CRAFT_RAISED_OPTION = 'kinuCraftRaised';

export type CraftRaised = (name: string, message: string) => void;

const CraftRaisedOptionsSchema = v.object({ [CRAFT_RAISED_OPTION]: v.optional(v.function()) });

/** The census an `eval` call's options carry; absent where nobody observes its crafted tools. */
export function readCraftRaised(input: { toolOptions: unknown }): CraftRaised | undefined {
  const parsed = v.safeParse(CraftRaisedOptionsSchema, input.toolOptions);

  return parsed.success ? parsed.output[CRAFT_RAISED_OPTION] : undefined;
}

/** One `eval` call's crafted-tool evidence, as the isolate that ran it observed it ({@link observeCraftCall}). */
export interface CraftCall {
  /** Tools its program created (`workspace.createTool`) that are callable now. */
  readonly created: readonly string[];
  /** Crafted tools its program called. */
  readonly invoked: readonly string[];
  /** Of `invoked`, those its result names as failing: each is marked broken with its error. */
  readonly raised: readonly string[];
  /** Of `invoked`, those callable before it ran that returned clean: each is cleared. */
  readonly returned: readonly string[];
}

/**
 * One settled `eval` call, recorded on `ledger`. `before` is the callable set as the call was dispatched, `raised` what
 * each crafted tool's body threw as it ran, `failed` whether the call threw. Null when it neither created nor called a
 * crafted tool.
 */
export function observeCraftCall(ledger: CraftLedger, call: {
  readonly code: string; readonly before: ReadonlySet<string>; readonly raised: ReadonlyMap<string, string>; readonly failed: boolean;
}): CraftCall | null {
  const known = ledger.names();
  // The set can also grow from the turn-outcome review (evolution/engine.ts); only attribute asked-for creation.
  const created = craftCreatesTool(call.code) ? known.filter((name) => !call.before.has(name)) : [];
  const invoked = craftInvocationSites(call.code, known);

  if (created.length === 0 && invoked.length === 0) return null;

  const raised = invoked.flatMap((name) => {
    const error = call.raised.get(name);

    return error === undefined ? [] : [{ name, error }];
  });

  const raisedNames = raised.map(({ name }) => name);
  // A tool cannot certify itself in the call that created it.
  const returned = call.failed ? [] : invoked.filter((name) => call.before.has(name) && !raisedNames.includes(name));

  for (const { name, error } of raised) ledger.broke(name, error);
  ledger.repaired(returned);

  return { created, invoked, raised: raisedNames, returned };
}

export interface CraftLedger {
  /** The tools a turn is offered (what the sandboxes bind), read fresh each call. */
  names(): readonly string[];
  broke(name: string, error: string): void;
  repaired(names: readonly string[]): void;
}

export interface CraftLedgerDeps {
  craftStore: { list(): ReadonlyArray<{ name: string }> };
  sql: SqlExecutor;
}

export function createCraftLedger(deps: CraftLedgerDeps): CraftLedger {
  return {
    names() {
      // Same offering policy the sandboxes use, so the callable set cannot drift.
      return rankByPreference(deps.sql, deps.craftStore.list()).map((t) => t.name);
    },
    broke(name, error) { markCraftBroken(deps.sql, name, error); },
    repaired(names) { clearCraftBroken(deps.sql, names); },
  };
}
