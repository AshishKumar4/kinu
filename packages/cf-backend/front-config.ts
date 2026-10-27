/**
 * The front Worker's deploy config (src/front.ts), derived whole from the main Worker's for one environment: the app
 * host's routes, every var of the main Worker's, its analytics and observability, the main Worker's objects bound under
 * their own names, and the main Worker itself. The front declares nothing of its own, so the two cannot drift, and it
 * holds no secret.
 */
import type { Unstable_Config } from 'wrangler';
import { FRONT_OBJECTS, MAIN_SERVICE_BINDING, frontWorkerName } from '../core/src/deploy/front';

/** The front's build: its bundle and the config `wrangler deploy -c` publishes, beside the main Worker's `dist/kinu`. */
export const FRONT_DIRECTORY = 'dist/front';

export const FRONT_ENTRY = 'src/front.ts';

type Route = NonNullable<Unstable_Config['routes']>[number];

function appHost(main: Pick<Unstable_Config, 'name' | 'vars'>): string {
  const origin = main.vars['CLI_PUBLIC_ORIGIN'];

  if (typeof origin !== 'string' || !URL.canParse(origin)) throw new Error(`the ${main.name ?? 'main'} Worker's config names no CLI_PUBLIC_ORIGIN, so its front has no host`);

  return new URL(origin).hostname;
}

/** A route on the app's own host is the front's; the main Worker keeps the preview and mail hosts' wildcards. */
function onAppHost(route: Route, host: string): boolean {
  return (typeof route === 'string' ? route : route.pattern).split('/')[0] === host;
}

/** The main Worker's routes once its front holds the app's host. */
export function mainRoutes<R extends Route>(main: Pick<Unstable_Config, 'name' | 'vars'> & { readonly routes?: readonly R[] }): R[] {
  const host = appHost(main);

  return (main.routes ?? []).filter((route) => !onAppHost(route, host));
}

export function frontConfig(main: Unstable_Config) {
  const name = main.name;

  if (name === undefined) throw new Error('the main Worker\'s config has no name, so its front has nothing to bind');
  const host = appHost(main);
  const routes = (main.routes ?? []).filter((route) => onAppHost(route, host));

  if (!routes.some((route) => typeof route !== 'string' && 'custom_domain' in route && route.custom_domain === true)) {
    throw new Error(`${name} serves ${host} on no custom domain, so its front would have no certificate`);
  }

  return {
    name: frontWorkerName(name),
    ...(main.account_id !== undefined && { account_id: main.account_id }),
    main: 'index.js',
    no_bundle: true,
    rules: [{ type: 'ESModule', globs: ['**/*.js'] }],
    upload_source_maps: true,
    workers_dev: false,
    compatibility_date: main.compatibility_date,
    compatibility_flags: main.compatibility_flags,
    routes,
    vars: main.vars,
    // Every request reaches the front before the asset router, as the main Worker's do (release-config.test.ts A5).
    ...(main.assets !== undefined && { assets: { ...main.assets, directory: '../client' } }),
    durable_objects: {
      bindings: main.durable_objects.bindings
        .filter((binding) => FRONT_OBJECTS.some((object) => object === binding.name))
        .map((binding) => ({ ...binding, script_name: name })),
    },
    services: [{ binding: MAIN_SERVICE_BINDING, service: name }],
    analytics_engine_datasets: main.analytics_engine_datasets,
    version_metadata: { binding: 'CF_VERSION_METADATA' },
    observability: main.observability,
  };
}
