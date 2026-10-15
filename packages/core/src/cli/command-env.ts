/**
 * The environment an unsandboxed command on the user's machine inherits, one policy for the CLI's shell and the device
 * daemon's: the process's own, less the credentials and settings Kinu reads from it, and less what a dotenv file put
 * into it at launch. Each process reads and parses the files itself; this decides from what they hold.
 */
import { RELEASE_SIGNING_PUBLIC_KEY_ENV } from '../http/release-message';

/** The provider keys the CLI reads from its environment, over a key in its config. */
export const PROVIDER_KEY_ENV = {
  openaiApiKey: 'OPENAI_API_KEY',
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  openrouterApiKey: 'OPENROUTER_API_KEY',
} as const;

/** The Kinu session and an endpoint's auth, as the CLI reads them from its environment. */
export const SESSION_CREDENTIAL_ENV = { token: 'KINU_TOKEN', auth: 'KINU_AUTH', gatewayAuth: 'AI_GATEWAY_AUTH' } as const;

/** The daemon an updated daemon replaces, named to it as it starts. */
export const DAEMON_PREDECESSOR_ENV = 'KINU_DAEMON_PREDECESSOR';

/** What no command inherits, whatever its value. */
const WITHHELD_COMMAND_ENV: ReadonlySet<string> = new Set([
  ...Object.values(PROVIDER_KEY_ENV), ...Object.values(SESSION_CREDENTIAL_ENV), RELEASE_SIGNING_PUBLIC_KEY_ENV, DAEMON_PREDECESSOR_ENV,
]);

/**
 * The dotenv files a process loaded from its working directory at launch, in Bun's order for `NODE_ENV`
 * (bun.sh/docs/runtime/env: development when it is unset or empty, `.env.local` skipped under test), and wrangler's
 * `.dev.vars`.
 */
export function launchDotenvFiles(nodeEnv: string | undefined): readonly string[] {
  const mode = nodeEnv === undefined || nodeEnv === '' ? 'development' : nodeEnv;

  return ['.env', `.env.${mode}`, ...(mode === 'test' ? [] : ['.env.local']), `.env.${mode}.local`, '.dev.vars'];
}

/** Every value the launch's dotenv files gave each name, whichever file came last. */
export type LaunchDotenv = ReadonlyMap<string, ReadonlySet<string>>;

/** The files `launchDotenvFiles` names, each as its parser read it. */
export function launchDotenv(files: readonly Readonly<Record<string, string | undefined>>[]): LaunchDotenv {
  const supplied = new Map<string, Set<string>>();

  for (const file of files) {
    for (const [name, value] of Object.entries(file)) if (value !== undefined) supplied.set(name, (supplied.get(name) ?? new Set()).add(value));
  }

  return supplied;
}

/** Whether `value` under `name` is one a dotenv file supplied: the project's secret, not the owner's shell. */
export function fromDotenv(dotenv: LaunchDotenv, name: string, value: string): boolean {
  return dotenv.get(name)?.has(value) === true;
}

/** An unsandboxed command's environment: `source` as the owner's shell would give it, less what Kinu reads from it and
 *  what a launch dotenv file supplied. */
export function unsandboxedCommandEnvironment(source: Readonly<Record<string, string | undefined>>, dotenv: LaunchDotenv): Record<string, string> {
  return Object.fromEntries(Object.entries(source).flatMap(([name, value]) => (
    value === undefined || WITHHELD_COMMAND_ENV.has(name) || fromDotenv(dotenv, name, value) ? [] : [[name, value] as const])));
}
