import { writeText, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
import type { AgentRuntime } from './types/agent-runtime';
import type { Executor, LLM, RawSqlExec, SqlExecutor, Storage } from './types/primitives';
import { initAllTables } from './state/workspace-schema';
import { seedSoul, SOUL_PATH, UNTITLED_WORKSPACE_NAME } from './identity/soul';
import { createInlineCraftStore, wrapDatabase, type AgentDatabase } from './identity/inline-primitives';
import { MemoryStore } from '@kinu.run/agent-utils/memory';
import { adaptMemory } from './memory/vector-sync';
import { MEMORY_PATH } from './memory/note';
import { bootstrapScaffold } from './scaffold/bootstrap';
import { nowMs } from './utils/date';
import { KinuError } from './obs/index';
import { initRunEventTables } from './events/recorder';
import { buildRuntime } from './runtime-builder';
import { createSqlFiber } from './execution/fiber';
import { cloudPlanes } from './vfs/resolve';
import { WORKSPACE_ROOT } from './vfs/workspace-path';
import type { ActorHandle } from './identity/actor-handle';
import { bearWorkspaceIdentity, initWorkspaceActorTable } from './identity/workspace-actors';
import { stampSchemaGenesis } from './identity/schema-stamp';

export interface WorkspaceBirthConfig {
  /** The address slug (`workspaceSlug`), held by `workspace_identity.name` for life. */
  name: string;
  /** The human name heading SOUL.md and MEMORY.md; never the slug. Set later by `planWorkspaceTitle` if absent. */
  title?: string;
  purpose: string;
  /** Main's home, where the seeds land as files: SOUL.md, the first memory note and the scaffold. */
  home: VFS & Required<Pick<VFS, 'readRange'>>;
}

interface WorkspaceComponents {
  readonly db: AgentDatabase;
  readonly sql: SqlExecutor;
  readonly execRaw: RawSqlExec;
  readonly transactionSync: Storage['transactionSync'];
  readonly home: WorkspaceBirthConfig['home'];
  readonly actor: ActorHandle;
}

/** The model of a workspace being born: none. Birth calls no model, so it holds no endpoint; the runtime the workspace
 *  opens with routes every call. A call is refused as the LLM contract fails, by its promise. */
function bornWithoutModel(): LLM {
  const refused = (): Promise<never> => Promise.reject(new KinuError('unsupported', 'a workspace being born calls no model'));

  return {
    complete: refused,
  };
}

function buildComponents(components: WorkspaceComponents) {
  const { db, sql, execRaw, transactionSync, home, actor } = components;
  const memoryStore = new MemoryStore(home, sql, transactionSync);
  memoryStore.ensureSchema();
  const memory = adaptMemory(memoryStore, home);
  const craftStore = createInlineCraftStore(db);
  // Birth runs no program, so it holds no JavaScript runner of its own.
  const executor: Executor = { languages: ['javascript'], execute: async () => ({ result: undefined, error: 'a workspace being born runs no programs' }) };
  initRunEventTables(execRaw);

  const llm = bornWithoutModel();

  const schedule = { after: async (_ms: number, fn: () => Promise<void>) => { await fn(); }, cron: async () => {}, fiber: createSqlFiber(sql, actor) };

  return buildRuntime({
    actor,
    planes: cloudPlanes(WORKSPACE_ROOT),
    // Birth runs no agent tool and no shell.
    sql, execRaw, transactionSync, vfs: home, toolFiles: home, agentStateVfs: home, llm, executor, schedule,
    memory, craftStore,
  });
}

/** Create a workspace and return its default agent's runtime; its seeds are files written through `config.home`. */
export async function createWorkspace(
  db: AgentDatabase, config: WorkspaceBirthConfig,
): Promise<AgentRuntime> {
  const { sql, execRaw, transactionSync } = wrapDatabase(db);
  const { home } = config;

  const actor = transactionSync(() => {
    initAllTables(execRaw, sql);
    stampSchemaGenesis(execRaw);
    initWorkspaceActorTable(execRaw);

    return bearWorkspaceIdentity(sql, { name: config.name, createdAt: nowMs() });
  });

  const titled = config.title?.trim();
  const heading = titled === undefined || titled === '' ? UNTITLED_WORKSPACE_NAME : titled;

  await seedSoul({ name: heading, mission: config.purpose }, (soul) => writeText(home, SOUL_PATH, soul));

  await home.mkdir('memory', { recursive: true });
  await writeText(home, MEMORY_PATH, `# ${heading}\n\nCreated: ${new Date().toISOString()}\n`);
  const rt = buildComponents({ db, sql, execRaw, transactionSync, home, actor });

  // The loop's versioned source and its pointer, through the one writer every reopen heals with.
  await bootstrapScaffold(rt);

  return rt;
}
