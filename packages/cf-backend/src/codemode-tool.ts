/**
 * The `eval` codemode tool, shared by every CF actor with a runtime. Crafted tools are re-read
 * from the surface on every call, so a tool saved mid-turn is callable on the next program.
 */

import * as v from 'valibot';
import { createCodeTool } from "@cloudflare/codemode/ai";
import { type Tool, type ToolSet } from 'ai';
import { execCallArgs, readDeviceRequestChannel, type CodemodeSurface, type DeviceRequestChannel, type ExecutorProviderSurface } from "@kinu.run/core";
import { renderCodemodeDescription, programDeclarations, describeProgramSource, nativeToolFunctions, toolsNamespace, CRAFTED_TOOL_NAMESPACE, type CodemodeProvider, type WorkMode, currentWorkMode, permitInPlan, toolsInWorkMode, providersInWorkMode, withCraftedToolDeclarations, codemodeInputSchema, withCodemodeProgram, craftedFailureFunctions, codemodeFunction, JsonValueSchema, type JsonObject, type JsonValue, type ToolSurfaceNarrowing } from "@kinu.run/core";
import { KinuError } from '@kinu.run/core/obs';
import {
  KinuSandboxExecutor, renderToolsPrelude, type ProgramLaunch,
} from "./codemode-sandbox";

/** One actor's program launcher; what each program reaches is its call's `CodemodeScope`. */
export interface CodemodeFactoryOptions {
  launch: (online: boolean) => ProgramLaunch;
  workspace: string;
  onExecutorUsed?: (name: string) => void;
}

/** What one call's programs reach. */
export interface CodemodeScope {
  /** The actor's namespaces (`actorNamespaces`), built per program with each executor wrapped as given. */
  readonly namespaces: (executor: (provider: ExecutorProviderSurface) => ExecutorProviderSurface) => CodemodeProvider[];
  /** Which namespaces the turn's role or allowed tools reach: none is bound past it. */
  readonly reach: ToolSurfaceNarrowing;
  /** Asked before each member a program reaches runs, by namespace and member; it throws to refuse. */
  readonly nested?: (namespace: string, member: string) => void;
}

export interface CodemodeFactory {
  toolFor(surface: CodemodeSurface, scope: CodemodeScope): Tool;
  callTool(surface: CodemodeSurface, name: string, input: JsonObject, scope: CodemodeScope): Promise<JsonValue | undefined>;
}

/** `provider` with each member asking `nested` before it runs. */
function guarded(provider: CodemodeProvider, nested: (namespace: string, member: string) => void): CodemodeProvider {
  return {
    ...provider,
    tools: Object.fromEntries(Object.entries(provider.tools).map(([member, entry]) => [member, {
      ...entry,
      execute: async (...args: Parameters<typeof entry.execute>) => {
        nested(provider.name, member);

        return await entry.execute(...args);
      },
    }])),
  };
}

export function createCodemodeToolFactory(options: CodemodeFactoryOptions): CodemodeFactory {
  // The running program's channel, read per provider call: a detach changes the owning job mid-program.
  let deviceRequests: DeviceRequestChannel | undefined;

  // Each executor as this factory's programs call it: `exec` carries the running program's device-request channel.
  const programExecutor = (p: ExecutorProviderSurface): ExecutorProviderSurface => {
    const wrapped: typeof p.tools = {};

    for (const [name, entry] of Object.entries(p.tools)) {
      // Only `exec` mints a durable device-request identity, and it reads context from the second positional arg.
      const carriesOwnership = name === 'exec' && p.positionalArgs === true;
      wrapped[name] = {
        ...entry,
        execute: async (...args) => {
          const result = await entry.execute(...(carriesOwnership ? execCallArgs(args, { channel: deviceRequests }) : args));

          options.onExecutorUsed?.(p.name);

          return result;
        },
      };
    }

    return { ...p, tools: wrapped };
  };

  return {
    async callTool(surface, name, input, scope) {
      const call = codemodeFunction(CRAFTED_TOOL_NAMESPACE, name, async () => {
        // A slate's call runs no program, so there is no eval to stop it with; `native` carries its Plan check.
        const functions = nativeToolFunctions(surface.native, undefined);
        const entry = Object.hasOwn(functions, name) ? functions[name] : undefined;

        if (entry !== undefined) {
          if (!scope.reach.allowsTool(name)) throw new KinuError('denied', `${name} is not within this actor's reach right now`);

          return entry.execute(input);
        }

        if (name === 'eval' || (!scope.reach.allowsTool(name) && !scope.reach.allowsNamespace(CRAFTED_TOOL_NAMESPACE))) {
          throw new KinuError('denied', `${name} is not within this actor's reach right now`);
        }

        if (!surface.craftedTools().some((tool) => tool.name === name)) {
          throw new KinuError('missing', `tools has no member ${name}`);
        }

        const execute = this.toolFor(surface, scope).execute;

        if (execute === undefined) throw new KinuError('unavailable', 'The codemode executor is not callable');

        const result = v.parse(v.object({ result: v.optional(JsonValueSchema) }), await execute({
          code: `return await tools[${JSON.stringify(name)}](${JSON.stringify(input)});`,
        }, { toolCallId: `slate-${crypto.randomUUID()}`, messages: [], context: undefined }));

        return result.result;
      });

      return call(input);
    },
    toolFor(surface, scope) {
      const reach = (tools: ToolSet): ToolSet => Object.fromEntries(Object.entries(tools).filter(([name]) => scope.reach.allowsTool(name)));

      const reachable = reach(surface.native);

      // Built per call with the call's signal: createCodeTool runs its executor without the tool call's options,
      // so a program's tool calls are stopped with its eval only through what this closure binds.
      const build = (mode: WorkMode, signal: AbortSignal | undefined): Tool => {
        // No prelude here: createCodeTool drops every one; the per-call executor below restores them. A native name
        // shadows an external one.
        const toolsProvider = toolsNamespace({ ...toolsInWorkMode(mode, reach(surface.external())), ...reachable }, signal);

        const providers = scope.namespaces(programExecutor);
        const reached = [...scope.reach.narrowProviders([toolsProvider]), ...providersInWorkMode(mode, scope.reach.narrowProviders(providers))];
        const { nested } = scope;
        const bound = nested === undefined ? reached : reached.map((provider) => guarded(provider, nested));
        const executor = new KinuSandboxExecutor(options.launch(mode !== 'plan'), describeProgramSource(programDeclarations(bound)));

        const built = createCodeTool({
          // Composed here: the vendor's `{{types}}` replace reads `$` as a pattern.
          description: renderCodemodeDescription(bound),
          tools: bound,
          executor: {
            // Crafted set and prelude are read as the program starts.
            execute: (code, resolved) => {
              const crafted = surface.craftedTools();
              const failures = Object.fromEntries(Object.entries(craftedFailureFunctions(crafted)).map(([name, entry]) => [name, entry.execute]));

              const live = Array.isArray(resolved)
                ? resolved.map((provider) => {
                  if (provider.name === CRAFTED_TOOL_NAMESPACE) {
                    return { name: provider.name, fns: { ...provider.fns, ...failures }, prelude: renderToolsPrelude(crafted, { workspace: options.workspace, cwd: surface.cwd }) };
                  }

                  const prelude = bound.find((declared) => declared.name === provider.name)?.prelude;

                  return prelude === undefined ? provider : { ...provider, prelude };
                })
                : resolved;

              return executor.execute(code, live);
            },
          },
        });

        // Core's input schema: codemode's label says "async arrow function", but the normalizer takes a script body.
        return { ...built, inputSchema: codemodeInputSchema() };
      };

      return withCraftedToolDeclarations(permitInPlan({
        ...build('build', undefined),
        execute: (input, context) => {
          const execute = build(currentWorkMode() === 'plan' ? 'plan' : 'build', context.abortSignal).execute;

          if (execute === undefined) throw new Error('Codemode executor is not callable');
          const channel = readDeviceRequestChannel({ toolOptions: context });

          return withCodemodeProgram(async () => {
            const outer = deviceRequests;

            if (channel !== undefined) deviceRequests = channel;

            try {
              return v.parse(v.object({ result: v.optional(v.unknown()), logs: v.optional(v.array(v.string())) }), await execute(input, context));
            } finally {
              deviceRequests = outer;
            }
          }, context.abortSignal);
        },
      }), surface.craftedTools);
    },
  };
}
