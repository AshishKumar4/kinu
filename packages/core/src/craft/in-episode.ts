// In-episode evidence for crafted tools: a raise marks the tool broken with its error, a clean return clears it.
// Execution-grounded evidence says "it ran", never "it was right": it never ranks a tool (craft/preference.ts).

import type { SqlExecutor } from '../types/primitives';
import { BUILTIN_TOOL_NAMES } from '../tools/registry';
import { isMcpToolKey } from '../tools/mcp-naming';
import { clearCraftBroken, markCraftBroken, rankByPreference } from './preference';
import { renderThrownChain, tolerate } from '../obs/index';
import { parseJsonValue, type JsonValue } from '../utils/json';
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

/** Also emitted by core/src/execution/codemode-node-shim.ts `defineCrafted`; keep the format in sync. */
export function craftFailureMarker(name: string): string {
  return `[crafted:${name}]`;
}

export function craftInvocationError(name: string, cause: Error | string): Error {
  const message = renderThrownChain({ cause: cause });

  return new Error(`${craftFailureMarker(name)} ${message}`, { cause });
}

/** Blame only stamped tools; a block failing on its own code blames nobody. */
export function craftFailureBlame(failure: string, invoked: readonly string[]): string[] {
  return invoked.filter((name) => failure.includes(craftFailureMarker(name)));
}

/** Every string a result holds, at any depth. */
function textsOf(value: JsonValue): string[] {
  if (typeof value === 'string') return [value];

  if (value === null || typeof value !== 'object') return [];

  return (Array.isArray(value) ? value : Object.values(value)).flatMap((inner) => (inner === undefined ? [] : textsOf(inner)));
}

/** What `name`'s raise said, after its stamp: read from the result's own strings, which hold the error as it was thrown. */
function raisedError(failure: string, name: string): string {
  const marker = craftFailureMarker(name);
  const parsed = tolerate(() => parseJsonValue(failure), 'malformed-input');
  const stamped = (parsed === undefined ? [failure] : textsOf(parsed)).find((text) => text.includes(marker)) ?? failure;

  return (stamped.slice(stamped.indexOf(marker) + marker.length).split('\n', 1)[0] ?? '').trim();
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
 * One settled `eval` call, recorded on `ledger`. `before` is the callable set as the call was dispatched, `result` what it
 * closed with (its output, or its error), `failed` whether it threw. Null when it neither created nor called a crafted
 * tool.
 */
export function observeCraftCall(ledger: CraftLedger, call: {
  readonly code: string; readonly before: ReadonlySet<string>; readonly result: string; readonly failed: boolean;
}): CraftCall | null {
  const known = ledger.names();
  // The set can also grow from the turn-outcome review (evolution/engine.ts); only attribute asked-for creation.
  const created = craftCreatesTool(call.code) ? known.filter((name) => !call.before.has(name)) : [];
  const invoked = craftInvocationSites(call.code, known);

  if (created.length === 0 && invoked.length === 0) return null;
  // The stamp is the evidence, not the call's own verdict: a failure the program caught and returned still names it.
  const raised = craftFailureBlame(call.result, invoked);
  // A tool cannot certify itself in the call that created it.
  const returned = call.failed ? [] : invoked.filter((name) => call.before.has(name) && !raised.includes(name));

  for (const name of raised) ledger.broke(name, raisedError(call.result, name));
  ledger.repaired(returned);

  return { created, invoked, raised, returned };
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
