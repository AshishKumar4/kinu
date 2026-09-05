/**
 * Node-side `execute_tools` builder — the CLI's answer to the CF backend's
 * codemode-backed tool. Handed to `buildActorTools` as `executeTools`, it
 * gives the CLI a working `execute_tools` without a workerd loader.
 *
 * The returned tool's execute compiles the LLM's code via `new Function()`
 * and runs it in-process with the execution router's provider namespaces
 * (`workspace.*` from the always-registered inline executor, plus any
 * extras) and the ONE callable namespace core declares
 * (tools/sandbox-contract.ts): `tools.<name>` for every native tool of the
 * finished surface and for every crafted tool. The declaration the model
 * reads lists both, rendered from the same surface.
 *
 * The crafted set is resolved per execute (surface.craftedTools()), so a
 * tool crafted mid-turn is callable on the next call rather than at the next
 * toolset rebuild; its declaration catches up at the next turn, when the
 * session rebuilds its surface.
 *
 * Node/Bun only — V8 codegen is permitted there. This module is NEVER
 * imported by the CF backend, keeping `new Function` outside the
 * Durable Object isolate.
 */

import type {
  CodemodeProvider,
  CraftedToolSet,
  ExecuteToolsBuilder,
  ExecutorProvider,
  JsonValue,
} from '@kinu.run/core';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';
import {
  CRAFTED_TOOL_NAMESPACE,
  decodeJsonValue, explainNativeToolReferenceError, nativeToolFunctions,
  renderExecuteToolsDescription, renderToolsDeclaration,
} from '@kinu.run/core';
import { tool, jsonSchema } from 'ai';
import { addImplicitReturn } from './executor';
import * as v from 'valibot';

export interface NodeExecuteToolFactoryDeps {
  extraProviders?: CodemodeProvider[];
}

/** The sandbox parameters this factory always binds, in order: the workspace
 *  namespace, the tool record under its one callable name, and the capturing
 *  console. A provider may not take any of them. */
const FIXED_NAMESPACES: readonly string[] = [
  'workspace', CRAFTED_TOOL_NAMESPACE, 'console',
];
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
 * Build the CLI's `execute_tools` builder. Pass as `executeTools` to
 * `buildActorTools`, or call it with a finished confined surface (heads).
 */
export function createNodeExecuteToolFactory(deps: NodeExecuteToolFactoryDeps = {}): ExecuteToolsBuilder {
  return (surface) => {
    const providers: CodemodeProvider[] = [
      ...surface.providers.map(adaptExecutorProvider),
      ...(deps.extraProviders ?? []),
    ];
    // Native tools dispatch to the finished surface; the crafted set is read
    // per call below, and a crafted name shadows a native one the way the CF
    // prelude's own definitions do.
    const nativeBindings = nativeToolFunctions(surface.native);
    const toolsDeclaration = renderToolsDeclaration(
      surface.native,
      Object.entries(surface.craftedTools()).map(([name, entry]) => ({ name, description: entry.description })),
    );

    return tool({
      // The one description, composed in core (registry.
      // renderExecuteToolsDescription) so this builder really is the CF
      // codemode tool on a different runtime rather than a different tool. The
      // namespace declarations are the point: each provider carries its own
      // `types`, and this path used to collect them in adaptExecutorProvider
      // and never read one, so the model was told nothing about `memory.*`,
      // `tasks.*`, `agents.*`, `web.*` or `llm.*` while being handed all of
      // them as callables.
      description: renderExecuteToolsDescription(
        [
          toolsDeclaration,
          ...providers.map((provider) => provider.types).filter((types) => !!types),
        ].join('\n\n'),
        'local',
      ),
      inputSchema: jsonSchema<{ code: string }>({
        type: 'object',
        properties: { code: { type: 'string', description: 'JavaScript code to execute' } },
        required: ['code'],
      }),
      execute: async (args, options) => {
        // `console` is shadowed by a capturing stand-in: this builder runs the
        // model's code in-process, so a real console.* would write straight to
        // the CLI's stdout — which, under `kinu exec --json`, IS the event
        // stream. Capture the output and return it as `logs` (the CF codemode
        // sandbox's contract), so the model gets what it printed and the stream
        // stays clean. Declared out here so the catch below can return partial
        // output produced before a throw.
        const logs: string[] = [];
        const pendingCalls: Promise<void>[] = [];
        const capture: Console['log'] = (...values) => {
          logs.push(values.map((value) => formatLogArg({ value })).join(' '));
        };
        const sandboxConsole = { log: capture, info: capture, warn: capture, error: capture, debug: capture, trace: capture, dir: capture };
        try {
          const signal = readAbortSignal({ options });
          const context = signal ? { signal } : undefined;
          const toolBindings: Record<string, CodemodeExecute | CraftedExecute> = {};
          for (const [name, entry] of Object.entries(nativeBindings)) {
            toolBindings[name] = (...toolArgs: unknown[]) => containRejection(() => entry.execute(...toolArgs), pendingCalls);
          }
          // Resolved here, not at construction: the CraftStore is read for
          // THIS call, so a tool the model crafted a step ago is callable now.
          for (const [name, entry] of Object.entries(surface.craftedTools())) {
            toolBindings[name] = (arg: JsonValue) => containRejection(() => entry.execute(arg), pendingCalls);
          }
          const providerBindings: Record<string, Record<string, CodemodeExecute>> = {};
          for (const p of providers) {
            const nsp: Record<string, CodemodeExecute> = {};
            for (const [toolName, t] of Object.entries(p.tools)) {
              nsp[toolName] = (...toolArgs) => containRejection(
                () => t.execute(...toolArgs, context),
                pendingCalls,
              );
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
            workspace, toolBindings, sandboxConsole,
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
            error: explainNativeToolReferenceError(renderThrownChain({ cause: error })),
          };
          if (logs.length > 0) payload.logs = logs;
          return payload;
        } finally {
          await Promise.allSettled(pendingCalls);
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
 * Every binding the sandbox exposes, kept inside the executing tool's completion
 * boundary.
 *
 * The code inside `execute_tools` is written by the model, and its most common
 * slip is a missing `await`. A floated call that then rejects — a VFS ENOENT,
 * a shell failure — must not surface as an unhandled rejection after the tool
 * returned. The execute call therefore owns an observer for every binding until
 * all of them settle. It records a failure to stderr rather than the captured
 * `logs`: the model may already have continued after its omitted `await`, and a
 * write that never landed must not read like one that did.
 *
 * The original call is still returned. Code that does await sees its real
 * rejection, while the observer makes an omitted await safe and lets the
 * enclosing execute action wait for the actual work rather than detach it.
 */
function containRejection<T>(run: () => Promise<T>, pendingCalls: Promise<void>[]): Promise<T> {
  let call: Promise<T>;
  try {
    call = run();
  } catch (cause) {
    call = Promise.reject(cause);
  }
  pendingCalls.push((async () => {
    try {
      await call;
    } catch (cause) {
      diagnostics.failure(
        'executor.unawaited_call_rejected',
        toKinuError({ doing: 'running a tool call the model left unawaited', cause, otherwise: 'io' }),
      );
    }
  })());
  return call;
}

/** One console argument → its captured-log string, matching how console
 *  renders it: strings verbatim, everything else JSON (so the model reads the
 *  object it printed, not "[object Object]"). */
function formatLogArg(input: { value: unknown }): string {
  const text = v.safeParse(v.string(), input.value);
  if (text.success) return text.output;
  try { return JSON.stringify(input.value) ?? String(input.value); }
  catch (error) {
    // Clamp precedent: String() on a cyclic value is "[object Object]" — nothing carried — so the reason takes its place.
    return `unserializable tool input: ${renderThrownChain({ cause: error })}`;
  }
}

function readAbortSignal(input: { options: unknown }): AbortSignal | undefined {
  const parsed = v.safeParse(abortOptionsSchema, input.options);
  return parsed.success ? parsed.output.abortSignal : undefined;
}
