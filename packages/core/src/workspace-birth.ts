import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
import type { AgentRuntime } from './types/agent-runtime';
import type { Executor, RawSqlExec, SqlExecutor, Storage } from './types/primitives';
import type { LLMProviderConfig } from './llm';
import { initAllTables } from './state/workspace-schema';
import { seedSoul, UNTITLED_WORKSPACE_NAME } from './identity/soul';
import {
  createInlineCraftStore,
  createInlineWorkspace, wrapDatabase, type AgentDatabase,
} from './identity/inline-primitives';
import { MemoryStore } from '@kinu.run/agent-utils/memory';
import { adaptMemory } from './memory/vector-sync';
import { bootstrapScaffold } from './scaffold/bootstrap';
import { nanoid } from './utils/nanoid';
import { nowMs } from './utils/date';
import { createVercelAILLM } from './llm';
import { unpricedLedgerSink } from './events/model-call-event';
import { initRunEventTables, RunEventRecorder } from './events/recorder';
import { buildRuntime } from './runtime-builder';
import { createSqlFiber } from './execution/fiber';
import type { WorkspaceBundle } from './vfs/nimbus-workspace';
import { writeWorkspaceSoul } from './vfs/workspace-planes';
import { cloudPlanes } from './vfs/resolve';
import { WORKSPACE_ROOT } from './vfs/workspace-path';
import type { ActorHandle } from './identity/actor-handle';
import { initWorkspaceActorTable, WorkspaceActorDirectory } from './identity/workspace-actors';
import { SCHEMA_GENESIS_STAMP } from './identity/schema-stamp';

export interface WorkspaceBirthConfig {
  /** The address slug (`workspaceSlug`), held by `workspace_identity.name` for life. */
  name: string;
  /** The human name heading SOUL.md and MEMORY.md; never the slug. Set later by `planWorkspaceTitle` if absent. */
  title?: string;
  purpose: string;
  llm: LLMProviderConfig;
  scaffold?: string;
}

interface WorkspaceComponents {
  readonly db: AgentDatabase;
  readonly sql: SqlExecutor;
  readonly execRaw: RawSqlExec;
  readonly transactionSync: Storage['transactionSync'];
  readonly workspace: WorkspaceBundle;
  readonly actor: ActorHandle;
  readonly llm: LLMProviderConfig;
}

function buildComponents(components: WorkspaceComponents) {
  const { db, sql, execRaw, transactionSync, workspace, actor } = components;
  const vfs = workspace.vfs;
  const memoryStore = new MemoryStore(vfs, sql);
  memoryStore.ensureSchema();
  const memory = adaptMemory(memoryStore, vfs);
  const craftStore = createInlineCraftStore(db);
  // Birth runs no program, so it holds no JavaScript runner of its own.
  const executor: Executor = { languages: ['javascript'], execute: async () => ({ result: undefined, error: 'a workspace being born runs no programs' }) };
  initRunEventTables(execRaw);

  // A birth-time call is the new workspace's spend, unpriced: nothing is resolved yet.
  const llm = createVercelAILLM(components.llm, {
    source: 'reflection', report: unpricedLedgerSink(new RunEventRecorder(sql, actor)),
  });

  const schedule = { after: async (_ms: number, fn: () => Promise<void>) => { await fn(); }, cron: async () => {}, fiber: createSqlFiber(sql, actor) };

  return buildRuntime({
    actor,
    planes: cloudPlanes(WORKSPACE_ROOT),
    // Birth runs no agent tool.
    sql, execRaw, transactionSync, vfs, toolFiles: vfs, llm, executor, schedule, shell: workspace.shell,
    memory, craftStore,
  });
}

/** Create a workspace and return its default agent's runtime; seeds are written through the agent's VFS. */
export async function createWorkspace(
  db: AgentDatabase, config: WorkspaceBirthConfig,
): Promise<AgentRuntime> {
  const { sql, execRaw, transactionSync } = wrapDatabase(db);

  const { workspace, actor } = transactionSync(() => {
    initAllTables(execRaw, sql);
    execRaw(`PRAGMA user_version = ${String(SCHEMA_GENESIS_STAMP)}`);
    const bundle = createInlineWorkspace(db);

    const workspaceId = nanoid();
    void sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${workspaceId}, ${config.name}, ${nowMs()})`;
    initWorkspaceActorTable(execRaw);

    return { workspace: bundle, actor: new WorkspaceActorDirectory(sql, { workspaceId, ownerUserId: '' }).createMain({ name: config.name }) };
  });

  const titled = config.title?.trim();
  const heading = titled === undefined || titled === '' ? UNTITLED_WORKSPACE_NAME : titled;

  await seedSoul({ name: heading, mission: config.purpose }, (content) => writeWorkspaceSoul(workspace, content));

  await workspace.vfs.mkdir('memory', { recursive: true });
  await writeText(workspace.vfs, 'memory/MEMORY.md', `# ${heading}\n\nCreated: ${new Date().toISOString()}\n`);
  const rt = buildComponents({ db, sql, execRaw, transactionSync, workspace, actor, llm: config.llm });

  // The loop's versioned source, its pointer and its live view, through the one writer every reopen heals with.
  await bootstrapScaffold(rt, config.scaffold);

  return rt;
}
