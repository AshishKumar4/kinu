/**
 * Node-side `eval` builder, run in-process via `new Function`. `require` and `process` are the
 * hosted sandbox's `kinu-node.js`, so a program's files and cwd are its workspace, never the machine.
 */

import { KINU_NODE_MODULE_SOURCE, requireBuild, type ToolSurfaceNarrowing } from '@kinu.run/core';
import type {
  CodemodeProvider,
  CodemodeSurface,
  JsonValue,
} from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import {
  CRAFTED_TOOL_NAMESPACE,
  decodeJsonValue, explainSandboxError, programProviders,
  renderCodemodeDescription, programDeclarations, describeProgramSource, codemodeInputSchema,
  withCraftedToolDeclarations, craftedFailureFunctions, renderCraftedDefinitions,
  codemodeFunction, withCodemodeProgram, execContext, readDeviceRequestChannel, shownConsoleValue, createToolArguments, nestedMembers,
} from '@kinu.run/core';
import { tool, type ToolSet } from 'ai';
import { programBody } from './executor';
import * as v from 'valibot';

interface NodeExecuteToolFactoryDeps {
  /** The program's namespaces, as `actorNamespaces` builds them. */
  namespaces?: readonly CodemodeProvider[];
  /** The role's reach, over every namespace bound, as cf's factory takes it. */
  reach: ToolSurfaceNarrowing;
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

/** `eval` over a surface, reaching what `deps.reach` allows; a confined builder passes the reach it is handed. */
export function createNodeCodemodeToolFactory(deps: NodeExecuteToolFactoryDeps): (surface: CodemodeSurface) => ToolSet[string] {
  return (surface) => {
    const providers = deps.reach.narrowProviders(deps.namespaces ?? []);
    const describe = describeProgramSource(programDeclarations(providers));

    return withCraftedToolDeclarations(tool({
      // Every namespace is listed, and `describe` answers its declarations, or the model gets callables it was never told about.
      description: renderCodemodeDescription(providers, 'local'),
      inputSchema: codemodeInputSchema(),
      execute: (args, options) => withCodemodeProgram(async () => {
        requireBuild('Native JavaScript execution without a constrained runtime');
        // Capture console: under `kinu exec --json` stdout is the event stream.
        // Returned as `logs`, the CF codemode sandbox contract.
        const logs: string[] = [];

        const capture: Console['log'] = (...values) => {
          logs.push(values.map((value) => shownConsoleValue({ value })).join(' '));
        };

        const sandboxConsole = { log: capture, info: capture, warn: capture, error: capture, debug: capture, trace: capture, dir: capture };

        try {
          const signal = options.abortSignal;
          const context = signal ? { signal } : undefined;
          const toolBindings: Record<string, CodemodeExecute> = {};
          // Read per call so a tool crafted a step ago is callable now; each body is defined in the program below.
          const crafted = surface.craftedTools();
          // `requireBuild` above refused Plan, so the program reaches what Build does.
          const reached = programProviders({ surface, namespaces: deps.namespaces ?? [], reach: deps.reach, mode: 'build', signal });
          const tools = reached.find((p) => p.name === CRAFTED_TOOL_NAMESPACE)?.tools ?? {};

          // A crafted name shadows the rest, as in the CF prelude.
          for (const [name, entry] of Object.entries({ ...tools, ...craftedFailureFunctions(crafted) })) {
            toolBindings[name] = codemodeFunction(CRAFTED_TOOL_NAMESPACE, name, entry.execute);
          }

          const providerBindings: Record<string, Record<string, CodemodeExecute | Record<string, CodemodeExecute>>> = {};

          for (const p of reached.filter((reachedProvider) => reachedProvider.name !== CRAFTED_TOOL_NAMESPACE)) {
            const nsp: Record<string, CodemodeExecute> = {};

            for (const [toolName, t] of Object.entries(p.tools)) {
              // An operation namespace reads the program's signal and shell context from its scope; its arguments are the program's own.
              const call = (toolArgs: unknown[]) => (p.declarations === undefined ? [...toolArgs, context] : toolArgs);

              nsp[toolName] = codemodeFunction(p.name, toolName, (...toolArgs) => t.execute(...call(toolArgs)));
            }

            // `workspace.createTool` takes the function itself, sent as its source, as in the CF sandbox.
            const create = nsp['createTool'];

            if (p.name === 'workspace' && create !== undefined) nsp['createTool'] = (...toolArgs) => create(...createToolArguments(toolArgs));

            // A member group (`fs.read`) is an object of its members, as in the CF sandbox.
            providerBindings[p.name] = nestedMembers(nsp);
          }

          const workspace = providerBindings['workspace'] ?? {};
          const node = await loadKinuNode();
          node.bindSlates(workspace);

          // Fixed names excluded: a duplicate `new Function` parameter crashes.
          const extraNamespaces = Object.keys(providerBindings).filter(n => !FIXED_NAMESPACES.includes(n));
          const argNames = [...FIXED_NAMESPACES, ...extraNamespaces];

          const argValues: unknown[] = [
            workspace, toolBindings, sandboxConsole,
            node.createRequire({ workspace, builtins: node.builtins, cwd: surface.cwd }),
            node.createProcess(surface.cwd), node,
            ...extraNamespaces.map(n => providerBindings[n]),
          ];

          const fn = new Function(...argNames, programBody(args.code, `${describe}\n${renderCraftedDefinitions(crafted)}`));

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
          const message = explainSandboxError(renderThrownChain({ cause: error }));
          throw new Error(logs.length > 0 ? message + '\nConsole output:\n' + logs.join('\n') : message, { cause: error });
        }
      }, options.abortSignal, execContext({ signal: options.abortSignal, channel: readDeviceRequestChannel({ toolOptions: options }) })),
    }), () => surface.craftedTools().map(({ name, description }) => ({ name, description })));
  };
}

