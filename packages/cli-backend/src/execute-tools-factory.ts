/**
 * Node-side createExecuteTool factory — the CLI's answer to the CF backend's
 * codemode-backed `execute_tools`. Passed as deps.createExecuteTool to
 * buildBuiltinTools, it gives the CLI a working `execute_tools` without a
 * workerd loader.
 *
 * The returned tool's execute compiles the LLM's code via `new Function()`
 * and runs it in-process with the execution router's provider namespaces
 * (`workspace.*` from the always-registered inline executor, plus any
 * extras) and the crafted-tool executes bound under BOTH `codemode` and
 * `tools` — the two names the CF sandbox answers to, so code written against
 * `workspace.createTool`'s documented contract runs the same on either
 * backend. The crafted set is resolved per execute (opts.craftedTools()), so a
 * tool crafted mid-turn is callable on the next call rather than at the next
 * model change.
 *
 * Node/Bun only — V8 codegen is permitted there. This module is NEVER
 * imported by the CF backend, keeping `new Function` outside the
 * Durable Object isolate.
 */

import type {
  CodemodeProvider,
  CreateExecuteToolFactory,
  CraftedToolSet,
  ExecutorProvider,
  JsonValue,
} from '@proteus/core';
import { decodeJsonValue, explainNativeToolReferenceError, renderExecuteToolsDescription } from '@proteus/core';
import { tool, jsonSchema } from 'ai';
import { addImplicitReturn } from './executor.js';
import * as v from 'valibot';

export interface NodeExecuteToolFactoryDeps {
  extraProviders?: CodemodeProvider[];
}

/** The sandbox parameters this factory always binds, in order: the workspace
 *  namespace, the crafted-tool record under both of its names (CF's in-sandbox
 *  `tools` literal and the `codemode.<name>` dispatcher name), and the
 *  capturing console. A provider may not take any of them. */
const FIXED_NAMESPACES: readonly string[] = ['workspace', 'codemode', 'tools', 'console'];
const abortOptionsSchema = v.object({ abortSignal: v.optional(v.instance(AbortSignal)) });

type CodemodeExecute = CodemodeProvider['tools'][string]['execute'];
type CraftedExecute = CraftedToolSet[string]['execute'];
interface ExecuteSuccess {
  result: JsonValue;
  logs?: string[];
}
interface ExecuteFailure {
  result: undefined;
  error: string;
  logs?: string[];
}
/**
 * Build a createExecuteTool-compatible factory. Pass as deps.createExecuteTool
 * to buildBuiltinTools; pass a sentinel truthy value as deps.codemodeLoader
 * so the factory branch is entered (the loader itself is not used here).
 */
export function createNodeExecuteToolFactory(deps: NodeExecuteToolFactoryDeps = {}): CreateExecuteToolFactory {
  return (opts) => {
    const providers: CodemodeProvider[] = [
      ...opts.providers.map(adaptExecutorProvider),
      ...(deps.extraProviders ?? []),
    ];

    return tool({
      // The one description, composed in core (registry.
      // renderExecuteToolsDescription) so this factory really is the CF
      // codemode tool on a different runtime rather than a different tool. The
      // namespace declarations are the point: each provider carries its own
      // `types`, and this path used to collect them in adaptExecutorProvider
      // and never read one, so the model was told nothing about `memory.*`,
      // `tasks.*`, `agents.*`, `web.*` or `llm.*` while being handed all of
      // them as callables.
      description: renderExecuteToolsDescription(
        providers.map((provider) => provider.types).filter((types) => !!types).join('\n\n'),
      ),
      inputSchema: jsonSchema<{ code: string }>({
        type: 'object',
        properties: { code: { type: 'string', description: 'JavaScript code to execute' } },
        required: ['code'],
      }),
      execute: async (args, options) => {
        // `console` is shadowed by a capturing stand-in: this factory runs the
        // model's code in-process, so a real console.* would write straight to
        // the CLI's stdout — which, under `proteus exec --json`, IS the event
        // stream. Capture the output and return it as `logs` (the CF codemode
        // sandbox's contract), so the model gets what it printed and the stream
        // stays clean. Declared out here so the catch below can return partial
        // output produced before a throw.
        const logs: string[] = [];
        const capture: Console['log'] = (...values) => {
          logs.push(values.map((value) => formatLogArg({ value })).join(' '));
        };
        const sandboxConsole = { log: capture, info: capture, warn: capture, error: capture, debug: capture, trace: capture, dir: capture };
        try {
          const signal = readAbortSignal({ options });
          const context = signal ? { signal } : undefined;
          // Resolved here, not at construction: the CraftStore is read for
          // THIS call, so a tool the model crafted a step ago is callable now.
          const craftedBindings: Record<string, CraftedExecute> = {};
          for (const [name, entry] of Object.entries(opts.craftedTools())) {
            craftedBindings[name] = (arg) => containRejection(() => entry.execute(arg));
          }
          const providerBindings: Record<string, Record<string, CodemodeExecute>> = {};
          for (const p of providers) {
            const nsp: Record<string, CodemodeExecute> = {};
            for (const [toolName, t] of Object.entries(p.tools)) {
              nsp[toolName] = (...toolArgs) => containRejection(() => t.execute(...toolArgs, context));
            }
            providerBindings[p.name] = nsp;
          }
          // The `workspace` namespace comes from the execution router's inline
          // executor, always registered by createCLIRuntime.
          const workspace = providerBindings['workspace'] ?? {};

          // Build the arg names / values for the sandboxed function so every
          // registered provider namespace is accessible by name. The fixed
          // names are excluded from the provider list so a namespace can never
          // duplicate one of them (a `new Function` duplicate-parameter crash).
          const extraNamespaces = Object.keys(providerBindings).filter(n => !FIXED_NAMESPACES.includes(n));
          const argNames = [...FIXED_NAMESPACES, ...extraNamespaces];
          const argValues: object[] = [
            workspace, craftedBindings, craftedBindings, sandboxConsole,
            ...extraNamespaces.map(n => providerBindings[n]),
          ];

          // Implicit return (parity with the subprocess executor and the CF
          // codemode sandbox): a trailing bare expression becomes the tool
          // result, so `x = compute(); x` returns `x` instead of undefined.
          const fn = new Function(
            ...argNames,
            `return (async () => {\n${addImplicitReturn(args.code)}\n})()`,
          );
          const rawResult = await fn(...argValues);
          const payload: ExecuteSuccess = {
            result: rawResult === undefined
              ? '(no return value)'
              : decodeJsonValue({ value: rawResult }),
          };
          if (logs.length > 0) payload.logs = logs;
          return payload;
        } catch (error) {
          // A bare `run(...)` etc. inside the model's code throws a plain V8
          // ReferenceError here (no dispatcher involved — `run` was simply
          // never one of the bound argNames above); rewrite that one shape
          // into an actionable correction, same as the CF codemode sandbox.
          const payload: ExecuteFailure = {
            result: undefined,
            error: explainNativeToolReferenceError(errorMessage({ error })),
          };
          if (logs.length > 0) payload.logs = logs;
          return payload;
        }
      },
    });
  };
}

function adaptExecutorProvider(
  provider: Pick<ExecutorProvider, 'name' | 'tools' | 'types' | 'positionalArgs'>,
): CodemodeProvider {
  const tools: CodemodeProvider['tools'] = {};
  for (const [name, tool] of Object.entries(provider.tools)) {
    tools[name] = {
      description: tool.description,
      execute: async (...args) => {
        const result = await tool.execute(...args);
        return result === undefined ? undefined : decodeJsonValue({ value: result });
      },
    };
  }
  return {
    name: provider.name,
    tools,
    types: provider.types,
    positionalArgs: provider.positionalArgs,
  };
}

/**
 * Every binding the sandbox exposes, made safe to float.
 *
 * The code inside `execute_tools` is written by the model, and its most common
 * slip is a missing `await`. A floated call that then rejects — a VFS ENOENT,
 * a shell failure — has no handler anywhere, so it surfaced as an
 * `unhandledRejection` and Bun killed the CLI mid-turn: a solvable benchmark
 * task died at tool call #13 that way. Attaching a sink to the call marks it
 * handled at the source, which costs nothing and changes nothing for code that
 * DOES await — that await still sees the real rejection, and the tool's own
 * try/catch still turns it into a returned error.
 *
 * The sink RECORDS rather than discards, because the un-awaited case is the
 * whole reason it exists: the model was told its code ran, and a write that
 * never landed reads exactly like one that did. It goes to stderr, not to the
 * captured `logs` — a floated call settles after the tool has already returned
 * its payload, so there is nothing left to attach it to.
 */
function containRejection<T>(run: () => Promise<T>): Promise<T> {
  let call: Promise<T>;
  try { call = run(); }
  catch (error) { call = Promise.reject(error); }
  void call.catch((error) => {
    console.warn(`[proteus] execute_tools: an unawaited call rejected: ${errorMessage({ error })}`);
  });
  return call;
}

/** One console argument → its captured-log string, matching how console
 *  renders it: strings verbatim, everything else JSON (so the model reads the
 *  object it printed, not "[object Object]"). */
function formatLogArg(input: { value: unknown }): string {
  const text = v.safeParse(v.string(), input.value);
  if (text.success) return text.output;
  try { return JSON.stringify(input.value) ?? String(input.value); }
  catch { return String(input.value); }
}

function readAbortSignal(input: { options: unknown }): AbortSignal | undefined {
  const parsed = v.safeParse(abortOptionsSchema, input.options);
  return parsed.success ? parsed.output.abortSignal : undefined;
}

function errorMessage(input: { error: unknown }): string {
  return input.error instanceof Error ? input.error.message : String(input.error);
}
