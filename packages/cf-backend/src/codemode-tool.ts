import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * The `eval` codemode tool, shared by every CF actor with a runtime. Crafted tools are re-read
 * from the surface on every call, so a tool saved mid-turn is callable on the next program.
 */

import * as v from 'valibot';
import { createCodeTool } from "@cloudflare/codemode/ai";
import { type Tool } from 'ai';
import { readDeviceRequestChannel, type ActorHandle, type AgentsToolDeps, type CodemodeSurface, type DeviceRequestChannel, type ExecutionRouter } from "@kinu.run/core";
import { createAgentsCodemodeProvider, createWebCodemodeProvider, createStateCodemodeProvider, renderCodemodeDescription, nativeToolFunctions, CRAFTED_TOOL_NAMESPACE, type BrowserSessions, type WebSearchProvider, type CodemodeProvider, type WorkMode, currentWorkMode, permitInPlan, toolsInWorkMode, providersInWorkMode, withCraftedToolDeclarations, codemodeInputSchema, withCodemodeProgram, craftedFailureFunctions, codemodeFunction, JsonValueSchema, type JsonObject, type JsonValue, type ToolSurfaceNarrowing } from "@kinu.run/core";
import { KinuError } from '@kinu.run/core/obs';
import {
  KinuSandboxExecutor, renderToolsPrelude, type ProgramLaunch,
} from "./codemode-sandbox";
import { BROWSER_PRELUDE } from './browser-prelude';

export interface CodemodeFactoryOptions {
  launch: (online: boolean) => ProgramLaunch;
  rt: { actor: ActorHandle; executionRouter?: Pick<ExecutionRouter, 'getProviders'>; storage: { vfs: VFS; home: string } };
  workspace: string;
  webSearch: WebSearchProvider;
  /** The actor's Chrome sessions, which `web.connectBrowser` in its programs reaches. */
  browserSessions: BrowserSessions;
  /** Read per call so a re-bound model lands without a rebuild; omitted (heads) keeps `agents.*` out. */
  agents?: () => AgentsToolDeps;
  extraProviders?: () => CodemodeProvider[];
  onExecutorUsed?: (name: string) => void;
  reach?: ToolSurfaceNarrowing;
}

function withDeviceOwnership(args: unknown[], channel: DeviceRequestChannel | undefined): unknown[] {
  if (!channel) return args;
  const context = args[1];
  // An unpredicted context shape wins over ownership reporting.
  const parsedContext = v.safeParse(v.looseObject({}), context);

  if (context !== undefined && !parsedContext.success) return args;

  const ownership = {
    onDeviceRequest: (requestId: string) => { channel.report(requestId); },
    deviceRequestOwner: () => channel.owningJobId,
  };

  const merged = parsedContext.success ? { ...parsedContext.output, ...ownership } : ownership;

  return [args[0], merged, ...args.slice(2)];
}

export interface CodemodeFactory {
  toolFor(surface: CodemodeSurface): Tool;
  callTool(surface: CodemodeSurface, name: string, input: JsonObject): Promise<JsonValue | undefined>;
}

export function createCodemodeToolFactory(options: CodemodeFactoryOptions): CodemodeFactory {
  const { rt, webSearch } = options;
  // The running program's channel, read per provider call: a detach changes the owning job mid-program.
  let deviceRequests: DeviceRequestChannel | undefined;
  const stateProvider = createStateCodemodeProvider(rt.actor.programState);
  const agentsProvider = options.agents ? createAgentsCodemodeProvider(options.agents) : null;

  const webProvider = createWebCodemodeProvider({
    provider: webSearch, files: rt.storage, sessions: { sessions: options.browserSessions }, prelude: { source: BROWSER_PRELUDE },
  });

  const executorProviders = (rt.executionRouter?.getProviders() ?? []).map((p) => {
    const wrapped: typeof p.tools = {};

    for (const [name, entry] of Object.entries(p.tools)) {
      // Only `exec` mints a durable device-request identity, and it reads context from the second positional arg.
      const carriesOwnership = name === 'exec' && p.positionalArgs === true;
      wrapped[name] = {
        ...entry,
        execute: async (...args) => {
          const result = await entry.execute(...(carriesOwnership ? withDeviceOwnership(args, deviceRequests) : args));

          options.onExecutorUsed?.(p.name);

          return result;
        },
      };
    }

    return { name: p.name, tools: wrapped, types: p.types, positionalArgs: p.positionalArgs };
  });

  return {
    async callTool(surface, name, input) {
      const call = codemodeFunction(CRAFTED_TOOL_NAMESPACE, name, async () => {
        const functions = nativeToolFunctions(toolsInWorkMode(currentWorkMode(), surface.native));
        const entry = Object.hasOwn(functions, name) ? functions[name] : undefined;

        if (entry !== undefined) {
          if (options.reach !== undefined && !options.reach.allowsTool(name)) throw new KinuError('denied', `${name} is not within this actor's reach right now`);

          return entry.execute(input);
        }

        if (name === 'eval' || (options.reach !== undefined && !options.reach.allowsTool(name) && !options.reach.allowsNamespace(CRAFTED_TOOL_NAMESPACE))) {
          throw new KinuError('denied', `${name} is not within this actor's reach right now`);
        }

        if (!surface.craftedTools().some((tool) => tool.name === name)) {
          throw new KinuError('missing', `tools has no member ${name}`);
        }

        const execute = this.toolFor(surface).execute;

        if (execute === undefined) throw new KinuError('unavailable', 'The codemode executor is not callable');

        const result = v.parse(v.object({ result: v.optional(JsonValueSchema) }), await execute({
          code: `return await tools[${JSON.stringify(name)}](${JSON.stringify(input)});`,
        }, { toolCallId: `slate-${crypto.randomUUID()}`, messages: [] }));

        return result.result;
      });

      return call(input);
    },
    toolFor(surface) {
      const reachable = options.reach === undefined ? surface.native
        : Object.fromEntries(Object.entries(surface.native).filter(([name]) => options.reach?.allowsTool(name)));

      const build = (mode: WorkMode): Tool => {
        const executor = new KinuSandboxExecutor(options.launch(mode !== 'plan'));

        // No prelude here: createCodeTool drops every one; the per-call executor below restores them.
        const toolsProvider: CodemodeProvider = {
          name: CRAFTED_TOOL_NAMESPACE,
          tools: nativeToolFunctions(toolsInWorkMode(mode, reachable)),
          // Declared by schemas
          types: '',
          positionalArgs: true,
        };

        const providers: CodemodeProvider[] = [toolsProvider, stateProvider];

        if (agentsProvider) providers.push(agentsProvider);

        if (options.extraProviders) providers.push(...options.extraProviders());
        providers.push(webProvider, ...executorProviders);
        const bound = providersInWorkMode(mode, options.reach?.narrowProviders(providers) ?? providers);

        const built = createCodeTool({
          // Composed here: the vendor's `{{types}}` replace reads `$` as a pattern.
          description: renderCodemodeDescription(bound.map((provider) => provider.types)),
          tools: bound,
          executor: {
            // Per call: crafted set and prelude are rebuilt; native fns were frozen at build time.
            execute: (code, resolved) => {
              const crafted = surface.craftedTools();
              const failures = Object.fromEntries(Object.entries(craftedFailureFunctions(crafted)).map(([name, entry]) => [name, entry.execute]));

              const live = Array.isArray(resolved)
                ? resolved.map((provider) => {
                  if (provider.name === CRAFTED_TOOL_NAMESPACE) {
                    return { name: provider.name, fns: { ...provider.fns, ...failures }, prelude: renderToolsPrelude(crafted, { workspace: options.workspace }) };
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

      const unrestricted = build('build');
      let planning: Tool | undefined;

      return withCraftedToolDeclarations(permitInPlan({
        ...unrestricted,
        execute: (input, context) => {
          const selected = currentWorkMode() === 'plan' ? (planning ??= build('plan')) : unrestricted;
          const execute = selected.execute;

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
          });
        },
      }), surface.craftedTools);
    },
  };
}
