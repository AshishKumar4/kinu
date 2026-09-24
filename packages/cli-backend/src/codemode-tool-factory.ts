/**
 * Node-side `eval` builder, run in-process via `new Function`. `require` and `process` are the
 * hosted sandbox's `kinu-node.js`, so a program's files and cwd are its workspace, never the machine.
 */

import { KINU_NODE_MODULE_SOURCE, requireBuild, WORKSPACE_ROOT } from '@kinu.run/core';
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
  renderCodemodeDescription, codemodeInputSchema,
  withCraftedToolDeclarations,
  codemodeFunction, withCodemodeProgram,
} from '@kinu.run/core';
import { tool } from 'ai';
import { normalizeCode } from '@cloudflare/codemode/normalize';
import * as v from 'valibot';

export interface NodeExecuteToolFactoryDeps {
  extraProviders?: CodemodeProvider[];
}

/** Always-bound sandbox parameters; a provider may not take them. */
const FIXED_NAMESPACES: readonly string[] = [
  'workspace', CRAFTED_TOOL_NAMESPACE, 'console', 'require', 'process',
];

const KinuNodeSchema = v.object({ createRequire: v.function(), createProcess: v.function(), bindSlates: v.function(), loadBuiltins: v.function() });

const BuiltinsSchema = v.object({ loaded: v.looseObject({}) });

type KinuNode = v.InferOutput<typeof KinuNodeSchema> & { readonly builtins: v.InferOutput<typeof BuiltinsSchema>['loaded'] };

/** A data URL: the module exists only as the source the hosted sandbox loads. */
async function importKinuNode(): Promise<KinuNode> {
  const node = v.parse(KinuNodeSchema, await import(`data:text/javascript;base64,${Buffer.from(KINU_NODE_MODULE_SOURCE).toString('base64')}`));

  return { ...node, builtins: v.parse(BuiltinsSchema, await node.loadBuiltins()).loaded };
}

let kinuNode: Promise<KinuNode> | undefined;

function loadKinuNode(): Promise<KinuNode> {
  kinuNode ??= importKinuNode();

  return kinuNode;
}

const abortOptionsSchema = v.object({ abortSignal: v.optional(v.instance(AbortSignal)) });

type CodemodeExecute = CodemodeProvider['tools'][string]['execute'];

type CraftedExecute = CraftedToolSet[string]['execute'];

interface ExecuteSuccess {
  result: JsonValue;
  logs?: string[];
}

/** Pass as `codemode` to `buildActorTools`, or call with a finished confined surface (heads). */
export function createNodeCodemodeToolFactory(deps: NodeExecuteToolFactoryDeps = {}): CodemodeBuilder {
  return (surface) => {
    const providers: CodemodeProvider[] = [
      ...surface.providers.map(adaptExecutorProvider),
      ...(deps.extraProviders ?? []),
    ];

    // A crafted name shadows a native one, as in the CF prelude.
    const nativeBindings = nativeToolFunctions(surface.native);

    return withCraftedToolDeclarations(tool({
      // Every provider's `types` must be read into the description, or the model
      // gets callables it was never told about.
      description: renderCodemodeDescription(providers.map((provider) => provider.types), 'local'),
      inputSchema: codemodeInputSchema(),
      execute: (args, options) => withCodemodeProgram(async () => {
        requireBuild('Native JavaScript execution without a constrained runtime');
        // Capture console: under `kinu exec --json` stdout is the event stream.
        // Returned as `logs`, the CF codemode sandbox contract.
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

          // Read per call so a tool crafted a step ago is callable now.
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

          const workspace = providerBindings['workspace'] ?? {};
          const node = await loadKinuNode();
          node.bindSlates(workspace);

          // Fixed names excluded: a duplicate `new Function` parameter crashes.
          const extraNamespaces = Object.keys(providerBindings).filter(n => !FIXED_NAMESPACES.includes(n));
          const argNames = [...FIXED_NAMESPACES, ...extraNamespaces];

          const argValues: unknown[] = [
            workspace, toolBindings, sandboxConsole,
            node.createRequire({ workspace, builtins: node.builtins, cwd: WORKSPACE_ROOT }),
            node.createProcess(WORKSPACE_ROOT),
            ...extraNamespaces.map(n => providerBindings[n]),
          ];

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
          // A bare native-tool call throws a plain ReferenceError; rewrite it into a correction.
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

  for (const [name, executorTool] of Object.entries(provider.tools)) {
    tools[name] = {
      description: executorTool.description,
      execute: async (...args) => {
        const result = await executorTool.execute(...args);

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

/** Strings verbatim, everything else JSON, so the model never reads "[object Object]". */
function formatLogArg(input: { value: unknown }): string {
  const text = v.safeParse(v.string(), input.value);

  if (text.success) return text.output;

  try { return JSON.stringify(input.value) ?? String(input.value); }
  catch (error) {
    return `unserializable tool input: ${renderThrownChain({ cause: error })}`;
  }
}

function readAbortSignal(input: { options: unknown }): AbortSignal | undefined {
  const parsed = v.safeParse(abortOptionsSchema, input.options);

  return parsed.success ? parsed.output.abortSignal : undefined;
}
