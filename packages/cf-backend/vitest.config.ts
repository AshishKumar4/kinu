/**
 * The workerd layer: only tests whose assertion is about the platform (DO gates, shutdown, facet
 * storage, DO SQLite features); our code stays in `bun test`. `include`, `bunfig.toml`
 * `pathIgnorePatterns` and `scripts/ladder.test.ts` keep the two sets disjoint and non-empty.
 * Compat date/flags are read from the deployment config. `tests/workerd` is its own tsc project (its
 * `env.d.ts` would merge into production `Env`); tsconfigs carry no comments (`JSON.parse` readers).
 */
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { cloudflareTest, getDurableObjectDesignators } from '@cloudflare/vitest-plugin';
import { buildSync, transform, type BuildOptions } from 'esbuild';
import { buildSlateVendor, slateVendor } from './slate-vendor';
import { configDefaults, defineConfig, type Plugin } from 'vitest/config';
import type { UserConfig } from 'vite';
import { probeOutbound, recordAiRun } from './tests/workerd/http-model-fake';
import { hireOutbound } from './tests/workerd/hire-model-fake';
import { registryOutbound } from './tests/workerd/npm-registry-fake';
import { nimbusAssets } from './tests/helpers/nimbus-assets';
import {
  DEPLOY_FAKE_CHANNEL, DEPLOY_FAKE_CLIENT_ID, DEPLOY_FAKE_RECORD, DEPLOY_FAKE_REFRESH_TOKEN,
  assetsOutbound, deployOutbound,
} from './tests/workerd/deploy-fake';
import type { V4ModuleDefinition } from 'miniflare';
import { builtinModules } from 'node:module';
import { promptText } from './vite-prompt-text';
import { AGENT_BUNDLE_ENTRY, buildAgentBundle, workerCompatibility, writeWhole } from './vite-agent-bundle';
import { readAiRun, workersAiAnswer, workersAiBinding } from './tests/helpers/workers-ai-binding';
import type { Reporter } from 'vitest/reporters';
import * as v from 'valibot';
import { HELD_PROXY_MODEL } from './tests/workerd/ai-proxy-shapes';
import { readMatching } from '../../scripts/sources';
import { workerdRequirements } from '../../scripts/workerd-requirements';
import { workerSourceTriggers } from '../../scripts/worker-test-inputs';

let hireAi: ReturnType<typeof workersAiBinding> | undefined;

function getHireAi(): ReturnType<typeof workersAiBinding> {
  hireAi ??= workersAiBinding(async (request) => workersAiAnswer(await readAiRun(request)));

  return hireAi;
}

let twoTurnAi: ReturnType<typeof workersAiBinding> | undefined;

/** The two-turn probe reads what the binding was asked through `/log`. */
function getTwoTurnAi(): ReturnType<typeof workersAiBinding> {
  twoTurnAi ??= workersAiBinding(async (request) => {
    const run = await readAiRun(request);

    recordAiRun(run);

    return workersAiAnswer(run);
  });

  return twoTurnAi;
}

let surfaceAi: ReturnType<typeof workersAiBinding> | undefined;

function getSurfaceAi(): ReturnType<typeof workersAiBinding> {
  surfaceAi ??= workersAiBinding(async (request) => {
    if (request.headers.get('mf-header-cf-consn-model-id') === HELD_PROXY_MODEL) {
      await probeOutbound(new Request('http://probe-control.invalid/proxy/park', { method: 'POST', signal: request.signal }));

      return Response.json({ response: 'held' });
    }

    return workersAiAnswer(await readAiRun(request));
  });

  return surfaceAi;
}

/**
 * KINU-065: Vite's oxc supports only legacy decorators, which break `@callable()` (they register the
 * prototype, not the method). Decorated modules are transformed with esbuild, as `wrangler deploy` does.
 */
const DECORATED_SOURCE = /^\s*@[A-Za-z_$][\w$]*\s*\(/mu;

function standardDecorators(): Plugin {
  return {
    name: 'kinu:standard-decorators',
    enforce: 'pre',
    async transform(code, id) {
      const path = id.split('?')[0];

      if (!/\.tsx?$/u.test(path) || path.includes('/node_modules/')) return null;

      if (!DECORATED_SOURCE.test(code)) return null;

      const result = await transform(code, {
        loader: path.endsWith('.tsx') ? 'tsx' : 'ts',
        target: 'es2022',
        jsx: 'automatic',
        sourcefile: path,
        sourcemap: true,
        // Standard semantics stated explicitly: the dialects disagree about `target`.
        tsconfigRaw: { compilerOptions: { experimentalDecorators: false, useDefineForClassFields: true } },
      });

      return { code: result.code, map: result.map };
    },
  };
}

// Raw `buildSync` runs no plugins, so `virtual:kinu-slate-vendor` aliases to this materialized module.
const slateVendorModulePath = fileURLToPath(new URL('../../node_modules/.cache/kinu/slate-vendor.js', import.meta.url));

let vendorMaterialized = false;

const probeRuntime = {
  conditions: ['workerd', 'worker', 'browser'], target: 'es2022',
  alias: { 'virtual:kinu-slate-vendor': slateVendorModulePath, ...Object.fromEntries(builtinModules.filter(name => !name.startsWith('node:')).map(name => [name, 'node:' + name])) },
} satisfies BuildOptions;

/** A selected probe keeps its own entry and flags; unused probes perform no build. */
function probeModules(file: string, options: BuildOptions = {}): V4ModuleDefinition[] {
  if (!vendorMaterialized && options.alias?.['virtual:kinu-slate-vendor'] !== undefined) {
    mkdirSync(dirname(slateVendorModulePath), { recursive: true });
    writeWhole(slateVendorModulePath, `export const workerCompatibility = ${JSON.stringify(workerCompatibility)};\nexport default ${JSON.stringify(buildSlateVendor())};\n`);
    vendorMaterialized = true;
  }

  const built = buildSync({
    ...options,
    entryPoints: [fileURLToPath(new URL('./tests/workerd/' + file, import.meta.url))],
    outfile: fileURLToPath(new URL('./tests/workerd/.compiled/' + file.replace(/\.ts$/, '.js'), import.meta.url)),
    bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
    external: ['cloudflare:*', 'node:*'], loader: { '.wasm': 'copy' },
  }).outputFiles;

  return built.sort((left, right) => Number(left.path.endsWith('.wasm')) - Number(right.path.endsWith('.wasm'))).map(output => ({
    type: output.path.endsWith('.wasm') ? 'CompiledWasm' : 'ESModule',
    path: output.path, contents: output.path.endsWith('.wasm') ? output.contents : output.text,
  }));
}

// The agent bundles a probe's workspace loads into its agents' own isolates, served as the asset binding serves them.
const agentBundles = new Map<string, string>();

function agentAssets(entry = AGENT_BUNDLE_ENTRY) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;

    if (path === '/_agent/compatibility.json') return Response.json(workerCompatibility);

    if (path !== '/_agent/modules.json') return new Response('Not found', { status: 404 });

    let bundle = agentBundles.get(entry);

    if (bundle === undefined) {
      bundle = JSON.stringify(buildAgentBundle(entry).modules);
      agentBundles.set(entry, bundle);
    }

    return new Response(bundle, { headers: { 'content-type': 'application/json' } });
  };
}

let forbiddenEgressHits = 0;

/**
 * `https://hold.test` for the attribution probe: holds one workspace's request until another's
 * releases it, answers the release only once the held workspace has logged, and keeps the order.
 */
interface AttributionHold {
  readonly released: PromiseWithResolvers<void>;
  readonly logged: PromiseWithResolvers<void>;
}

interface AttributionLedger {
  readonly order: string[];
  readonly held: Map<string, AttributionHold>;
  logged: number;
  readonly waiters: { readonly count: number; readonly arrived: () => void }[];
}

const attribution: AttributionLedger = { order: [], held: new Map(), logged: 0, waiters: [] };

function attributionHold(name: string): AttributionHold {
  const hold = attribution.held.get(name) ?? { released: Promise.withResolvers<void>(), logged: Promise.withResolvers<void>() };
  attribution.held.set(name, hold);

  return hold;
}

async function attributionOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const [verb = '', first = '', second = ''] = url.pathname.split('/').slice(1);

  if (url.origin !== 'https://hold.test') throw new Error('Unmatched test egress is disabled: ' + request.url);

  switch (verb) {
    case 'returned':
      attribution.order.push(`${first} returned`);

      return new Response('ok');
    case 'hold':
      await attributionHold(first).released.promise;

      return new Response('released');
    case 'release':
      attribution.order.push(`release ${first}`);
      attributionHold(first).released.resolve();
      await attributionHold(first).logged.promise;
      attribution.order.push(`release ${first} answered`);

      return new Response('logged');
    case 'logged':
      attribution.order.push(`${second} logged ${first}`);
      attribution.logged += 1;

      if (first === 'detached') attributionHold(second).logged.resolve();

      for (const waiter of attribution.waiters.filter((entry) => entry.count <= attribution.logged)) {
        attribution.waiters.splice(attribution.waiters.indexOf(waiter), 1);
        waiter.arrived();
      }

      return new Response('ok');
    case 'await': {
      const count = Number(first);

      if (attribution.logged < count) {
        const { promise, resolve } = Promise.withResolvers<void>();
        attribution.waiters.push({ count, arrived: resolve });
        await promise;
      }

      return new Response('ok');
    }

    case 'order':
      return Response.json(attribution.order);
    default:
      throw new Error('Unmatched hold.test path: ' + request.url);
  }
}

type AuxiliaryWorker = NonNullable<NonNullable<Parameters<typeof getDurableObjectDesignators>[0]['miniflare']>['workers']>[number];

const auxiliaryWorkers = new Map<string, () => Promise<AuxiliaryWorker>>([
['hosted-preview-probe', async () => ({ ...workerCompatibility, modules: probeModules('preview-port-probe.ts'), durableObjects: { PREVIEW_PORT_PROBE: { className: 'PreviewPortProbeDO', useSQLite: true } }, })],
['slate-actor-probe', async () => ({ workerLoaders: { LOADER: {} }, ...workerCompatibility, modules: probeModules('slate-actor-probe.ts', probeRuntime), durableObjects: {
          SLATE_ACTOR_ROOT: { className: 'SlateActorProbeRoot', useSQLite: true },
        }, })],
["plan-announce-probe", async () => ({
          // Bound as `OrchestratorAgent` because production `workspaceOwner()` reads that name off `env`.
           ...workerCompatibility, workerLoaders: { LOADER: {} },
          modules: probeModules('plan-announce-probe.ts', { ...probeRuntime, keepNames: true }),
          durableObjects: {
            OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
            UserDO: { className: 'UserDO', useSQLite: true },
            USER_SOCKET_PROBE: { className: 'UserSocketProbeDO', useSQLite: true },
          },
        })],
['slate-egress-probe', async () => ({ ...workerCompatibility, workerLoaders: { LOADER: {} }, modules: probeModules('slate-egress-probe.ts', probeRuntime), serviceBindings: { ASSETS: nimbusAssets }, durableObjects: { SLATE_EGRESS_PROBE: { className: 'SlateEgressProbe', useSQLite: true } },
        // Final transport only: the actual CodemodeEgress policy and resident
        // global fetch run above this mock. No unmatched request reaches a network.
        outboundService: async (request) => {
          const url = new URL(request.url);
        
          if (url.origin === 'http://169.254.169.254') {
            forbiddenEgressHits += 1;
        
            return new Response('forbidden transport reached');
          }
        
          if (url.origin === 'https://example.com') {
            if (url.pathname === '/control') return new Response('public control');
        
            if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/forbidden' } });
        
            if (url.pathname === '/seen') return Response.json({ forbiddenEgressHits });
          }
        
          throw new Error('Unmatched test egress is disabled: ' + request.url);
        }, })],
["two-turn-probe", async () => ({
          // `env.AI` is the installed Workers AI binding, answered by request shape on the Node side.
          ...workerCompatibility,
          workerLoaders: { LOADER: {} },
          modules: probeModules('two-turn-probe.ts', probeRuntime),
          bindings: { DEV_USER_EMAIL: 'probe@local', WORKERS_AI_VIA_BINDING: 'on', CREDENTIAL_ENCRYPTION_KEY: 'dHdvLXR1cm4tcHJvYmUtY3JlZGVudGlhbC1rZXktMzI=' },
          ai: await getTwoTurnAi(),
          // Main's isolate is the shipped facet plus a read of its own SQLite, where its sends, claims and runs are kept.
          serviceBindings: { ASSETS: agentAssets(fileURLToPath(new URL('./tests/workerd/two-turn-probe-agent.ts', import.meta.url))) },
          // Compat HTTP falls back to the
          // global fetch (owned-model-services passes no deps.fetch), which
          // routes to the Node-side fake; unknown hosts throw.
          outboundService: probeOutbound,
          durableObjects: {
            TWO_TURN_PROBE: { className: 'TwoTurnProbeRoot', useSQLite: true },
            OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
            UserDO: { className: 'UserDO', useSQLite: true },
          },
        })],
["hire-probe", async () => ({
          // A real hire: the child's `workers-ai/` tier arrives on the AI binding, the root's
          // `openai-compat` lane on outbound.
          
          compatibilityDate: workerCompatibility.compatibilityDate,
          compatibilityFlags: workerCompatibility.compatibilityFlags,
          workerLoaders: { LOADER: {} },
          modules: probeModules('hire-probe.ts', probeRuntime),
          bindings: { DEV_USER_EMAIL: 'probe@local', WORKERS_AI_VIA_BINDING: 'on', CREDENTIAL_ENCRYPTION_KEY: 'dHdvLXR1cm4tcHJvYmUtY3JlZGVudGlhbC1rZXktMzI=' },
          ai: await getHireAi(),
          serviceBindings: { ASSETS: agentAssets() },
          outboundService: hireOutbound,
          durableObjects: {
            HIRE_PROBE: { className: 'HireProbeRoot', useSQLite: true },
            OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
            UserDO: { className: 'UserDO', useSQLite: true },
          },
        })],
["slate-durability-probe", async () => ({
          // Nimbus port reservations live in workspace storage, so preview URLs survive
          // `abortAllDurableObjects()`.
           ...workerCompatibility, workerLoaders: { LOADER: {} },
          modules: probeModules('slate-durability-probe.ts', probeRuntime),
          // A removed slate takes its picture; with no `BROWSER`, nothing is photographed here.
          r2Buckets: ['SLATE_PICTURES'],
          bindings: {
            PREVIEW_HOST_SUFFIX: 'preview.test',
            DEV_USER_EMAIL: 'probe@local',
            CREDENTIAL_ENCRYPTION_KEY: 'dHdvLXR1cm4tcHJvYmUtY3JlZGVudGlhbC1rZXktMzI=',
          },
          outboundService: registryOutbound,
          // A git network facet imports its bundle from ASSETS, as the deployed Worker serves it.
          serviceBindings: { ASSETS: nimbusAssets },
          durableObjects: {
            SLATE_DURABILITY_PROBE: { className: 'SlateDurabilityProbeRoot', useSQLite: true },
            OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
            UserDO: { className: 'UserDO', useSQLite: true },
          },
        })],
["slate-share-probe", async () => ({
          // `SlateBinding` resolves `env.OrchestratorAgent`, so the probe class is bound under that name too.
           ...workerCompatibility, workerLoaders: { LOADER: {} },
          modules: probeModules('slate-share-probe.ts', probeRuntime),
          // The egress gate's Browser Run: a session answers where its CDP socket would.
          serviceBindings: { ASSETS: nimbusAssets, BROWSER: { name: 'slate-share-probe', entrypoint: 'FakeBrowserRun' } },
          durableObjects: {
            SLATE_SHARE_PROBE: { className: 'SlateShareProbeDO', useSQLite: true },
            OrchestratorAgent: { className: 'SlateShareProbeDO', useSQLite: true },
          },
        })],
['delete-all-probe', async () => ({ ...workerCompatibility, workerLoaders: { LOADER: {} }, modules: probeModules('delete-all-probe.ts'),
        durableObjects: { DELETE_ALL_PROBE: { className: 'DeleteAllProbeDO', useSQLite: true } } })],
['device-user-probe', async () => ({ ...workerCompatibility, workerLoaders: { LOADER: {} }, modules: probeModules('device-user-probe.ts', { ...probeRuntime, keepNames: true }), bindings: { CREDENTIAL_ENCRYPTION_KEY: 'ZGV2aWNlLXVzZXItcHJvYmUtY3JlZGVudGlhbC1rZXk=' },
        // The fake models and their control host, shared with the public surface's drives (files run one at a time).
        outboundService: probeOutbound,
        durableObjects: {
          // The probe is this script's account object, so its workspaces reach it as `env.UserDO`.
          UserDO: { className: 'UserDO', useSQLite: true },
          OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
        }, })],
['account-reset-probe', async () => ({ ...workerCompatibility, workerLoaders: { LOADER: {} }, modules: probeModules('account-reset-probe.ts', { ...probeRuntime, keepNames: true }), bindings: { CREDENTIAL_ENCRYPTION_KEY: 'dHdvLXR1cm4tcHJvYmUtY3JlZGVudGlhbC1rZXktMzI=' },
        // Main's conversation is its own isolate's, loaded from the agent bundle as the deployed Worker serves it.
        serviceBindings: { ASSETS: agentAssets() },
        outboundService: async (request) => {
          throw new Error('Unmatched test egress is disabled: ' + request.url);
        },
        durableObjects: {
          ACCOUNT_RESET_PROBE: { className: 'AccountResetProbeDO', useSQLite: true },
          OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
          UserDO: { className: 'UserDO', useSQLite: true },
        }, })],
["store-reset-probe", async () => ({
          // The probe's `OrchestratorAgent` is the production class plus the one method that plants the old table.
           ...workerCompatibility, workerLoaders: { LOADER: {} },
          modules: probeModules('store-reset-probe.ts', { ...probeRuntime, keepNames: true }),
          bindings: { CREDENTIAL_ENCRYPTION_KEY: 'dHdvLXR1cm4tcHJvYmUtY3JlZGVudGlhbC1rZXktMzI=' },
          // Main's conversation is its own isolate's, loaded from the agent bundle as the deployed Worker serves it.
          serviceBindings: { ASSETS: agentAssets() },
          outboundService: async (request) => {
            throw new Error('Unmatched test egress is disabled: ' + request.url);
          },
          durableObjects: {
            STORE_RESET_PROBE: { className: 'StoreResetProbeRoot', useSQLite: true },
            OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
            UserDO: { className: 'UserDO', useSQLite: true },
          },
        })],
['addressed-name-probe', async () => ({ ...workerCompatibility, workerLoaders: { LOADER: {} }, modules: probeModules('addressed-name-probe.ts', { ...probeRuntime, keepNames: true }), bindings: { CREDENTIAL_ENCRYPTION_KEY: 'YWRkcmVzc2VkLW5hbWUtcHJvYmUtY3JlZC1rZXktMzI=' },
        // Main's conversation is its own isolate's, loaded from the agent bundle as the deployed Worker serves it.
        serviceBindings: { ASSETS: agentAssets() },
        outboundService: async (request) => {
          throw new Error('Unmatched test egress is disabled: ' + request.url);
        },
        durableObjects: {
          ADDRESSED_NAME_PROBE: { className: 'AddressedNameProbeRoot', useSQLite: true },
          OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
          UserDO: { className: 'UserDO', useSQLite: true },
        }, })],
['agent-facet-probe', async () => ({ ...workerCompatibility, workerLoaders: { LOADER: {} }, modules: probeModules('agent-facet-probe.ts', { ...probeRuntime, keepNames: true }), bindings: { WORKERS_AI_VIA_BINDING: 'on', CREDENTIAL_ENCRYPTION_KEY: 'YWdlbnQtZmFjZXQtcHJvYmUtY3JlZGVudGlhbC1rZXk=' },
        ai: await getHireAi(),
        serviceBindings: { ASSETS: agentAssets(fileURLToPath(new URL('./tests/workerd/agent-facet-probe-agent.ts', import.meta.url))) },
        outboundService: hireOutbound,
        durableObjects: {
          AGENT_FACET_PROBE: { className: 'AgentFacetProbeRoot', useSQLite: true },
          OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
          UserDO: { className: 'UserDO', useSQLite: true },
        }, })],
['attribution-probe', async () => ({ ...workerCompatibility, workerLoaders: { LOADER: {} }, modules: probeModules('attribution-probe.ts', { ...probeRuntime, keepNames: true }), bindings: { CREDENTIAL_ENCRYPTION_KEY: 'YXR0cmlidXRpb24tcHJvYmUtY3JlZC1rZXktMzJieXQ=' },
        outboundService: attributionOutbound,
        durableObjects: {
          ATTRIBUTION_PROBE: { className: 'AttributionProbeRoot', useSQLite: true },
          OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
          UserDO: { className: 'UserDO', useSQLite: true },
        }, })],
["public-surface-probe", async () => ({
          // The production Worker entry (`route()`), reached over `PUBLIC_SURFACE`; same
          // `enable_abortsignal_rpc` reason as two-turn-probe.
          
          compatibilityDate: workerCompatibility.compatibilityDate,
          compatibilityFlags: workerCompatibility.compatibilityFlags,
          workerLoaders: { LOADER: {} },
          modules: probeModules('public-surface-probe.ts', { ...probeRuntime, keepNames: true }),
          // `DEV_USER_EMAIL` is the loopback identity; `WORKERS_AI_VIA_BINDING` puts its inference on `AI`.
          bindings: { DEV_USER_EMAIL: 'probe@local', WORKERS_AI_VIA_BINDING: 'on', CREDENTIAL_ENCRYPTION_KEY: 'dHdvLXR1cm4tcHJvYmUtY3JlZGVudGlhbC1rZXktMzI=' },
          // The CLI device sign-in and its rate limits live in AUTH_KV (cli-scoped-socket).
          kvNamespaces: ['AUTH_KV'],
          ai: await getSurfaceAi(),
          serviceBindings: { ASSETS: agentAssets() },
          outboundService: probeOutbound,
          durableObjects: {
            OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
            UserDO: { className: 'UserDO', useSQLite: true },
          },
        })],
["deploy-probe", async () => ({
          // Self-deployment against real DO SQLite; every external host is the Node-side fake, unmatched throws.
           ...workerCompatibility,
          modules: probeModules('deploy-run-probe.ts', { conditions: ['workerd', 'worker', 'browser'], target: 'es2022' }),
          // Root secrets are bound because a self-update's vault reads through to them.
          bindings: {
            CLI_PUBLIC_ORIGIN: DEPLOY_FAKE_CHANNEL,
            KINU_DEPLOYMENT_RECORD: DEPLOY_FAKE_RECORD,
            KINU_SELF_DEPLOY_REFRESH_TOKEN: DEPLOY_FAKE_REFRESH_TOKEN,
            CREDENTIAL_ENCRYPTION_KEY: 'ZGVwbG95LXByb2JlLWNyZWRlbnRpYWwta2V5LTMyYg==',
            WEBHOOK_ROUTE_SECRET: 'ZGVwbG95LXByb2JlLXdlYmhvb2stcm91dGUtc2VjcmV0',
            // Without it the door answers 503 to every leg (the unconfigured deployment).
            CLOUDFLARE_DEPLOY_CLIENT_ID: DEPLOY_FAKE_CLIENT_ID,
          },
          outboundService: deployOutbound,
          serviceBindings: { ASSETS: assetsOutbound },
          durableObjects: {
            DEPLOY_RUN_PROBE: { className: 'DeployRunProbeDO', useSQLite: true },
            // `/api/updates/apply` addresses the run through `env.DeployRunDO`.
            DeployRunDO: { className: 'DeployRunProbeDO', useSQLite: true },
          },
        })]
]);

const runnerOptions = {
        ...workerCompatibility,
        // `useSQLite` mirrors `exports`' `storage: "sqlite"` (wrangler.jsonc); without it `ctx.storage.sql`
        // throws. `LOADER` mirrors `worker_loaders` for the real codemode executor.
        workerLoaders: { LOADER: {} },
        modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
        // The privileged Vitest runner permits eval and would mask the hosted Node refusal.
        
        // A miniflare service binding carries a WebSocket upgrade (measured 2026-09-16), so the chat
        // protocol runs in-pool.
        serviceBindings: {
          // A slate's esbuild facet loads its adapter from ASSETS.
          ASSETS: nimbusAssets,
          PUBLIC_SURFACE: { name: 'public-surface-probe' },
          HIRE_APP: { name: 'hire-probe' },
          // Node-side fake state is shared across workers; these entrypoints reset and read it.
          SURFACE_CONTROL: { name: 'public-surface-probe', entrypoint: 'SurfaceControl' },
          DEPLOY_FAKE: { name: 'deploy-probe', entrypoint: 'DeployFakeControl' },
          UPDATES_PROBE: { name: 'deploy-probe', entrypoint: 'UpdatesProbe' },
          DEPLOY_DOOR_PROBE: { name: 'deploy-probe', entrypoint: 'DeployDoorProbe' },
        },
        durableObjects: {
          RETENTION: { className: 'RetentionDO', useSQLite: true },
          NEIGHBOUR: { className: 'NeighbourDO', useSQLite: true },
          GATED: { className: 'GatedDO', useSQLite: true },
          ALARMED: { className: 'AlarmDO', useSQLite: true },
          CACHE_WARM_PROBE: { className: 'CacheWarmProbeDO', useSQLite: true },
          EVICTION_PROBE: { className: 'EvictionProbeDO', useSQLite: true },
          WITNESS: { className: 'WitnessDO', useSQLite: true },
          SPEND_PROBE: { className: 'SpendProbeDO', useSQLite: true },
          TERMINAL_EFFECT_PROBE: { className: 'TerminalEffectProbeDO', useSQLite: true },
          DB_CAPABILITY_PROBE: { className: 'DbCapabilityProbeDO', useSQLite: true },
          FIBER_RECOVERY_PROBE: { className: 'FiberRecoveryProbeAgent', useSQLite: true },
          SOCKET_CALL_PROBE: { className: 'SocketCallProbeAgent', useSQLite: true },
          FORK_SOURCE: { className: 'ForkSourceProbeDO', useSQLite: true },
          FORK_TARGET: { className: 'ForkTargetProbeDO', useSQLite: true },
          STREAM_LIFECYCLE: { className: 'StreamLifecycleDO', useSQLite: true },
          FILES_EIO_PROBE: { className: 'FilesEioProbeDO', useSQLite: true },
          PARKED_WRITES_PROBE: { className: 'ParkedWritesProbeDO', useSQLite: true },
          COMPLEXITY_PROBE: { className: 'ComplexityProbeDO', useSQLite: true },
          EFFECT_ATOMICITY_PROBE: { className: 'EffectAtomicityProbeDO', useSQLite: true },
          PREVIEW_PORT_PROBE: { className: 'PreviewPortProbeDO', scriptName: 'hosted-preview-probe', useSQLite: true },
          SLATE_PROCESS_PROBE: { className: 'SlateProcessProbeDO', useSQLite: true },
          SLATE_SHARE_PROBE: { className: 'SlateShareProbeDO', scriptName: 'slate-share-probe', useSQLite: true },
          SLATE_ACTOR_ROOT: { className: 'SlateActorProbeRoot', scriptName: 'slate-actor-probe', useSQLite: true },
          PLAN_ANNOUNCE_ROOT: { className: 'OrchestratorAgent', scriptName: 'plan-announce-probe', useSQLite: true },
          USER_SOCKET_PROBE: { className: 'UserSocketProbeDO', scriptName: 'plan-announce-probe', useSQLite: true },
          SLATE_EGRESS_PROBE: { className: 'SlateEgressProbe', scriptName: 'slate-egress-probe', useSQLite: true },
          DEVICE_LEDGER_PROBE: { className: 'DeviceLedgerProbeDO', useSQLite: true },
          DEVICE_OUTPUT_HUB_PROBE: { className: 'DeviceOutputHubProbeDO', useSQLite: true },
          DEVICE_OUTPUT_WORKSPACE_PROBE: { className: 'DeviceOutputWorkspaceProbeDO', useSQLite: true },
          TWO_TURN_PROBE: { className: 'TwoTurnProbeRoot', scriptName: 'two-turn-probe', useSQLite: true },
          HIRE_PROBE: { className: 'HireProbeRoot', scriptName: 'hire-probe', useSQLite: true },
          // The probe's workspace itself, reached as the public route reaches it: an agent's pane is a socket on it.
          HIRE_WORKSPACE: { className: 'OrchestratorAgent', scriptName: 'hire-probe', useSQLite: true },
          SLATE_DURABILITY_PROBE: { className: 'SlateDurabilityProbeRoot', scriptName: 'slate-durability-probe', useSQLite: true },
          DELETE_ALL_PROBE: { className: 'DeleteAllProbeDO', scriptName: 'delete-all-probe', useSQLite: true },
          ACCOUNT_RESET_PROBE: { className: 'AccountResetProbeDO', scriptName: 'account-reset-probe', useSQLite: true },
          DEVICE_USER_PROBE: { className: 'UserDO', scriptName: 'device-user-probe', useSQLite: true },
          STORE_RESET_PROBE: { className: 'StoreResetProbeRoot', scriptName: 'store-reset-probe', useSQLite: true },
          ADDRESSED_NAME_PROBE: { className: 'AddressedNameProbeRoot', scriptName: 'addressed-name-probe', useSQLite: true },
          AGENT_FACET_PROBE: { className: 'AgentFacetProbeRoot', scriptName: 'agent-facet-probe', useSQLite: true },
          ATTRIBUTION_PROBE: { className: 'AttributionProbeRoot', scriptName: 'attribution-probe', useSQLite: true },
          // The shipped root as the product seals it: `public-surface-probe` re-exports `src/server`'s class unchanged.
          SEALED_ORCHESTRATOR: { className: 'OrchestratorAgent', scriptName: 'public-surface-probe', useSQLite: true },
          // The shipped account object, sealed as the product seals it.
          SEALED_USER_DO: { className: 'UserDO', scriptName: 'public-surface-probe', useSQLite: true },
          DEPLOY_RUN_PROBE: { className: 'DeployRunProbeDO', scriptName: 'deploy-probe', useSQLite: true },
        },
      } satisfies NonNullable<Parameters<typeof getDurableObjectDesignators>[0]['miniflare']>;

const WorkerTargetSchema = v.union([
  v.pipe(v.string(), v.transform(name => ({ name }))),
  v.looseObject({ name: v.string() }),
]);

/** Bindings are exactly the runtime's targets, including local service functions. */
function workerdBindingTargets(options: typeof runnerOptions): Map<string, string | undefined> {
  const targets = new Map<string, string | undefined>();

  for (const [name, binding] of getDurableObjectDesignators({ miniflare: options })) targets.set(name, binding.scriptName);

  for (const [name, binding] of Object.entries(options.serviceBindings)) {
    const target = v.safeParse(WorkerTargetSchema, binding);

    targets.set(name, target.success ? target.output.name : undefined);
  }

  for (const name of Object.keys(options.workerLoaders)) targets.set(name, undefined);

  return targets;
}

const projectSources = readMatching(file => file.startsWith('packages/cf-backend/tests/') && /\.[cm]?[jt]sx?$/.test(file) && !file.endsWith('.d.ts'));

const bindingTargets = workerdBindingTargets(runnerOptions);

const requirements = workerdRequirements(projectSources, bindingTargets, new Set(auxiliaryWorkers.keys()), 'packages/cf-backend');

const suiteWorkers = new Map([...requirements].map(([file, workers]) => [fileURLToPath(new URL(file, import.meta.url)), workers]));

let selectedWorkers: AuxiliaryWorker[] = [];

const workerSelection: Reporter = {
  async onTestRunStart(specifications) {
    const selected = new Set<string>();

    for (const specification of specifications) {
      const workers = suiteWorkers.get(specification.moduleId);

      if (workers === undefined) throw new Error(`${specification.moduleId}: workerd suite has no declared Worker requirements`);

      for (const worker of workers) selected.add(worker);
    }

    selectedWorkers = await Promise.all([...selected].map(async name => {
      const build = auxiliaryWorkers.get(name);

      if (build === undefined) throw new Error(`Worker ${name} is not declared`);

      return { name, ...await build() };
    }));
  },
};

const sharedTestOptions = {
    forceRerunTriggers: workerSourceTriggers() ?? configDefaults.forceRerunTriggers,
    // Asserts the pool actually started (adopted from cloudflare-os `test-setup/assert-workerd.ts`).
    setupFiles: ['./tests/workerd/assert-workerd.ts'],
    // Wall-time gate assertions would contend under per-file parallelism.
    fileParallelism: false,
    // Suites with the same auxiliary Worker set share a pool; each still mints its own DO names.
    isolate: false,
    // No per-test clock (`gate:test-clocks` pins `0`): waits end on their condition and the ladder kills
    // hangs. Measured 2026-09-16, a file's first test pays pool boot, past Vitest's default timeout.
    testTimeout: 0,
    hookTimeout: 0,
    // Deliberate probe rejections only; anything else stays fatal. DO-side rejections may reach this
    // hook depending on the pool (measured 2026-09-16: they did not yet), so they are listed anyway.
    onUnhandledError(error) {
      // `AlarmDO.alarm` rethrows so the runtime owns redelivery (worker.ts:503-506).
      if (error.message.includes('alarm-body-failed')) return false;

      // `deploy-lifecycle.test.ts` aborts a DeployRunDO mid-plan on purpose.
      if (error.message.includes('probe: the object died mid-plan')) return false;
    },
} satisfies NonNullable<UserConfig['test']>;

export default defineConfig({
  plugins: [promptText(), slateVendor(), standardDecorators(), {
    name: 'kinu:workerd-bindings',
    configureVitest({ vitest }) {
      vitest.config.reporters.push(workerSelection);
    },
  }, cloudflareTest(() => {
    const selected = new Set(selectedWorkers.map(worker => worker.name));

    return {
      main: './tests/workerd/worker.ts',
      miniflare: {
        ...runnerOptions,
        serviceBindings: Object.fromEntries(Object.entries(runnerOptions.serviceBindings).filter(([name]) => bindingTargets.get(name) === undefined || selected.has(bindingTargets.get(name)))),
        durableObjects: Object.fromEntries(Object.entries(runnerOptions.durableObjects).filter(([name]) => bindingTargets.get(name) === undefined || selected.has(bindingTargets.get(name)))),
        workers: selectedWorkers,
      },
    };
  })],
  test: {
    ...sharedTestOptions,
    include: ['tests/workerd/**/*.test.ts'],
  },
});
