/**
 * Node-side `eval` builder — the CLI's answer to the CF backend's
 * codemode-backed tool. Handed to `buildActorTools` as `codemode`, it
 * gives the CLI a working `eval` without a workerd loader.
 *
 * The returned tool's execute compiles the LLM's code via `new Function()`
 * and runs it in-process with the execution router's provider namespaces
 * (`workspace.*` from the always-registered inline executor, plus any
 * extras) and the ONE callable namespace core declares
 * (tools/sandbox-contract.ts): `tools.<name>` for every native tool of the
 * finished surface and for every crafted tool. The declaration the model
 * reads lists natives; the live ledger describes the same crafted resolver.
 *
 * The crafted set is resolved per execute (surface.craftedTools()), so a
 * tool crafted mid-turn is callable and declared at the next step rather
 * than at the next toolset rebuild.
 *
 * Node/Bun only — V8 codegen is permitted there. This module is NEVER
 * imported by the CF backend, keeping `new Function` outside the
 * Durable Object isolate.
 */

import { requireBuild } from '@kinu.run/core';
import type {
  CodemodeProvider,
  CraftedToolSet,
  CodemodeBuilder,
  ExecutorProvider,
  JsonValue,
} from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import {
  CRAFTED_TOOL_NAMESPACE,
  decodeJsonValue, explainNativeToolReferenceError, nativeToolFunctions,
  renderCodemodeDescription, renderToolsDeclaration, codemodeInputSchema,
  withCraftedToolDeclarations,
  codemodeFunction, withCodemodeProgram,
} from '@kinu.run/core';
import { tool } from 'ai';
import { createRequire } from 'node:module';
import { normalizeCode } from '@cloudflare/codemode/normalize';
import * as v from 'valibot';

export interface NodeExecuteToolFactoryDeps {
  extraProviders?: CodemodeProvider[];
}

/** The sandbox parameters this factory always binds, in order: the workspace
 *  namespace, the tool record under its one callable name, the capturing
 *  console, and the machine's own `require`. A provider may not take any of
 *  them. `require` is bound explicitly because a `new Function` body sees no
 *  module scope and Bun defines no `require` global, while the shared
 *  description promises it (SANDBOX_FACTS.local in core's registry). */
const FIXED_NAMESPACES: readonly string[] = [
  'workspace', CRAFTED_TOOL_NAMESPACE, 'console', 'require',
];

const machineRequire = createRequire(import.meta.url);

const abortOptionsSchema = v.object({ abortSignal: v.optional(v.instance(AbortSignal)) });

type CodemodeExecute = CodemodeProvider['tools'][string]['execute'];

type CraftedExecute = CraftedToolSet[string]['execute'];

interface ExecuteSuccess {
  result: JsonValue;
  logs?: string[];
}

/**
 * Build the CLI's `eval` builder. Pass as `codemode` to
 * `buildActorTools`, or call it with a finished confined surface (heads).
 */
export function createNodeCodemodeToolFactory(deps: NodeExecuteToolFactoryDeps = {}): CodemodeBuilder {
  return (surface) => {
    const providers: CodemodeProvider[] = [
      ...surface.providers.map(adaptExecutorProvider),
      ...(deps.extraProviders ?? []),
    ];

    // Native tools dispatch to the finished surface; the crafted set is read
    // per call below, and a crafted name shadows a native one the way the CF
    // prelude's own definitions do.
    const nativeBindings = nativeToolFunctions(surface.native);

    const toolsDeclaration = renderToolsDeclaration(surface.native, []);

    return withCraftedToolDeclarations(tool({
      // The one description, composed in core (registry.
      // renderCodemodeDescription) so this builder really is the CF
      // codemode tool on a different runtime rather than a different tool. The
      // namespace declarations are the point: each provider carries its own
      // `types` and every one of them is read into this description.
      // Collecting them and reading none tells the model nothing about
      // `memory.*`, `tasks.*`, `agents.*`, `web.*` or `llm.*` while handing it
      // all of them as callables.
      description: renderCodemodeDescription(
        [
          toolsDeclaration,
          ...providers.map((provider) => provider.types).filter((types) => !!types),
        ].join('\n\n'),
        'local',
      ),
      inputSchema: codemodeInputSchema(),
      execute: (args, options) => withCodemodeProgram(async () => {
        requireBuild('Native JavaScript execution without a constrained runtime');
        // `console` is shadowed by a capturing stand-in: this builder runs the
        // model's code in-process, so a real console.* would write straight to
        // the CLI's stdout — which, under `kinu exec --json`, IS the event
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
          const toolBindings: Record<string, CodemodeExecute | CraftedExecute> = {};

          for (const [name, entry] of Object.entries(nativeBindings)) {
            toolBindings[name] = codemodeFunction(CRAFTED_TOOL_NAMESPACE, name, entry.execute);
          }

          // Resolved here, not at construction: the CraftStore is read for
          // THIS call, so a tool the model crafted a step ago is callable now.
          for (const [name, entry] of Object.entries(surface.craftedTools())) {
            toolBindings[name] = codemodeFunction(CRAFTED_TOOL_NAMESPACE, name, async (...toolArgs) => entry.execute(decodeJsonValue({ value: toolArgs[0] ?? {} })));
          }

          const providerBindings: Record<string, Record<string, CodemodeExecute>> = {};

          for (const p of providers) {
            const nsp: Record<string, CodemodeExecute> = {};

            for (const [toolName, t] of Object.entries(p.tools)) {
              nsp[toolName] = codemodeFunction(p.name, toolName, (...toolArgs) => t.execute(...toolArgs, context));
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
            workspace, toolBindings, sandboxConsole, machineRequire,
            ...extraNamespaces.map(n => providerBindings[n]),
          ];

          // Invoke codemode's normalized callable once with this local surface.
          const fn = new Function(
            ...argNames,
            `return (\n${normalizeCode(args.code)}\n)()`,
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
          const message = explainNativeToolReferenceError(renderThrownChain({ cause: error }));
          throw new Error(logs.length > 0 ? message + '\nConsole output:\n' + logs.join('\n') : message, { cause: error });
        }
      }),
    }), () => Object.entries(surface.craftedTools()).map(([name, entry]) => ({ name, description: entry.description })));
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
