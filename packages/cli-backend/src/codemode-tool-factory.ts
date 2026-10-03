/**
 * Node-side `eval` builder, run in-process via `new Function`. `require` and `process` are the
 * hosted sandbox's `kinu-node.js`, so a program's files and cwd are its workspace, never the machine.
 */

import { KINU_NODE_MODULE_SOURCE, requireBuild, WORKSPACE_ROOT } from '@kinu.run/core';
import type {
  CodemodeProvider,
  CodemodeBuilder,
  ExecutorProvider,
  JsonValue,
} from '@kinu.run/core';
import { stringifyOr } from '@kinu.run/core';
import { Cause, Effect } from 'effect';
import { renderThrownChain, settle } from '@kinu.run/core/obs';
import {
  CRAFTED_TOOL_NAMESPACE,
  decodeJsonValue, explainSandboxError, nativeToolFunctions,
  renderCodemodeDescription, codemodeInputSchema,
  withCraftedToolDeclarations, craftedFailureFunctions, renderCraftedDefinitions,
  codemodeFunction, withCodemodeProgram, currentWorkMode, toolsInWorkMode,
} from '@kinu.run/core';
import { tool } from 'ai';
import { normalizeCode } from '@cloudflare/codemode/normalize';
import * as v from 'valibot';

interface NodeExecuteToolFactoryDeps {
  extraProviders?: CodemodeProvider[];
}

/** Always-bound sandbox parameters; a provider may not take them. `__kinu` defines the crafted tools. */
const FIXED_NAMESPACES: readonly string[] = [
  'workspace', CRAFTED_TOOL_NAMESPACE, 'console', 'require', 'process', '__kinu',
];

const KinuNodeSchema = v.object({
  createRequire: v.function(), createProcess: v.function(), bindSlates: v.function(), loadBuiltins: v.function(), defineCrafted: v.function(),
});

const BuiltinsSchema = v.object({ loaded: v.looseObject({}) });

type KinuNode = v.InferOutput<typeof KinuNodeSchema> & { readonly builtins: v.InferOutput<typeof BuiltinsSchema>['loaded'] };

let kinuNode: Promise<KinuNode> | undefined;

/** A data URL: the module exists only as the source the hosted sandbox loads. */
function loadKinuNode(): Promise<KinuNode> {
  kinuNode ??= (async () => {
    const node = v.parse(KinuNodeSchema, await import(`data:text/javascript;base64,${Buffer.from(KINU_NODE_MODULE_SOURCE).toString('base64')}`));

    return { ...node, builtins: v.parse(BuiltinsSchema, await node.loadBuiltins()).loaded };
  })();

  return kinuNode;
}

type CodemodeExecute = CodemodeProvider['tools'][string]['execute'];

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

        return settle(Effect.catchCause(Effect.gen(function* () {
          const signal = options.abortSignal;
          const context = signal ? { signal } : undefined;
          const toolBindings: Record<string, CodemodeExecute> = {};
          // Read per call so a tool crafted a step ago is callable now; each body is defined in the program below.
          const crafted = surface.craftedTools();

          const external = nativeToolFunctions(toolsInWorkMode(currentWorkMode(), surface.external()));

          for (const [name, entry] of Object.entries({ ...external, ...nativeBindings, ...craftedFailureFunctions(crafted) })) {
            toolBindings[name] = codemodeFunction(CRAFTED_TOOL_NAMESPACE, name, entry.execute);
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
          const node = yield* Effect.promise(() => loadKinuNode());
          node.bindSlates(workspace);

          // Fixed names excluded: a duplicate `new Function` parameter crashes.
          const extraNamespaces = Object.keys(providerBindings).filter(n => !FIXED_NAMESPACES.includes(n));
          const argNames = [...FIXED_NAMESPACES, ...extraNamespaces];

          const argValues: unknown[] = [
            workspace, toolBindings, sandboxConsole,
            node.createRequire({ workspace, builtins: node.builtins, cwd: WORKSPACE_ROOT }),
            node.createProcess(WORKSPACE_ROOT), node,
            ...extraNamespaces.map(n => providerBindings[n]),
          ];

          const fn = new Function(
            ...argNames,
            `${renderCraftedDefinitions(crafted)}\nreturn (\n${normalizeCode(args.code)}\n)()`,
          );

          const rawResult: unknown = yield* Effect.promise(async () => fn(...argValues));

          const payload: ExecuteSuccess = {
            result: rawResult === undefined
              ? '(no return value)'
              : decodeJsonValue({ value: rawResult }),
          };

          if (logs.length > 0) payload.logs = logs;

          return payload;
        }), (failed) => {
          const error = Cause.squash(failed);
          // A bare native-tool call throws a plain ReferenceError; rewrite it into a correction.
          const message = explainSandboxError(renderThrownChain({ cause: error }));

          return Effect.die(new Error(logs.length > 0 ? message + '\nConsole output:\n' + logs.join('\n') : message, { cause: error }));
        }));
      }),
    }), () => surface.craftedTools().map(({ name, description }) => ({ name, description })));
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

  return stringifyOr(input, (reason) => `unserializable tool input: ${reason}`) ?? String(input.value);
}
