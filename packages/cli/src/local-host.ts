/**
 * The one local host composition: the daemon and every frontend (`kinu chat`, `kinu run`, ACP) open their agents
 * through it, so a root has its team, its peers, its relays and its driver lease whichever process holds it.
 */
import type { Database } from 'bun:sqlite';
import type { DriverKind, HostedAgentRef, InvocationSurface } from '@kinu.run/core';
import {
  LocalAgentHost, openWorkspaceCLI, type LocalAgentHostOptions, type LocalHostedAgent,
} from '@kinu.run/cli-backend';
import {
  agentDbPath,
  createOAuthStore,
  listLocalRefsAllProjects,
  loadConfigFile,
  readProviderRevision,
  resolveCloudSession,
  resolveMcpServers,
  resolveProviderCredentials,
} from './config';
import { createConfiguredLocalModelResolver, type LocalModelResolverOptions } from './local-model-resolver';
import { createProfileAuthorityReader } from './profiles';

/** What the process opening a host is. */
export interface LocalHostProcess {
  /** Interactive may take a workspace from a live daemon; the daemon declares itself. */
  readonly driverKind: DriverKind;
  /** How the process was invoked; absent, one that stays. */
  readonly surface?: InvocationSurface;
  /** The agent a frontend was opened for, with its folder and model flags; the daemon serves every agent. */
  readonly root?: LocalModelResolverOptions & { readonly name: string; readonly cwd?: string };
  readonly wakeAt?: (at: number) => void;
}

export function createLocalHost(process: LocalHostProcess): LocalAgentHost {
  const options: LocalAgentHostOptions = {
    roster: listLocalRefsAllProjects,
    dbPath: agentDbPath,
    open: (ref, db, dbPath) => openLocalAgent(ref, db, dbPath, process),
    driverKind: process.driverKind,
    ...(process.surface !== undefined && { surface: process.surface }),
    ...(process.wakeAt !== undefined && { wakeAt: process.wakeAt }),
  };

  return new LocalAgentHost(options);
}

/**
 * One agent as this machine opens it: its model routes and credentials, its MCP servers, and the profile authority and
 * provider revision read live, so a role resolves alike everywhere and a provider connected elsewhere is seen. Only the
 * root a frontend was opened for takes its flags and folder; any other (a peer) works where it was placed.
 */
async function openLocalAgent(ref: HostedAgentRef, db: Database, dbPath: string, process: LocalHostProcess): Promise<LocalHostedAgent> {
  const opened = process.root?.name === ref.name ? process.root : undefined;
  const { defaults, resolver: modelResolver } = createConfiguredLocalModelResolver(opened ?? {});
  const cloud = resolveCloudSession();

  const openConfig = {
    llm: defaults.endpoint,
    defaultSpec: defaults.spec,
    providerCredentials: resolveProviderCredentials,
    oauthStore: createOAuthStore(),
    ...(cloud !== null && { cloud }),
    checkpointKeep: loadConfigFile().checkpointKeep,
    cwd: opened?.cwd ?? ref.cwd,
  };

  const { rt } = await openWorkspaceCLI(db, dbPath, openConfig);

  return {
    rt,
    openConfig,
    modelResolver,
    mcpServers: resolveMcpServers(),
    profileAuthority: createProfileAuthorityReader(),
    providerRevision: readProviderRevision,
    ...(opened !== undefined && process.surface === 'one-shot' && { oneShot: true }),
  };
}
