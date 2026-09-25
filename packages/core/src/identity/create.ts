import type { AgentRuntime } from '../types/agent-runtime';
import type { RawSqlExec, SqlExecutor, Storage } from '../types/primitives';
import type { LLMProviderConfig } from '../llm';
import { initAllTables } from './schema';
import { seedSoul, UNTITLED_WORKSPACE_NAME } from './soul';
import {
  createInlineCraftStore, createInlineExecutor, createInlineMemory,
  createInlineSchedule, createInlineWorkspace, wrapDatabase, type AgentDatabase,
} from './inline-primitives';
import { INITIAL_SCAFFOLD_SOURCE } from '../scaffold/bootstrap';
import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';
import { createVercelAILLM } from '../llm';
import { unpricedLedgerSink } from '../events/model-call-event';
import { initRunEventTables, RunEventRecorder } from '../events/recorder';
import { buildRuntime } from '../runtime-builder';
import { initWorkspaceBaselineTable, resetWorkspaceBaseline } from '../read-models/workspace-diff';
import type { WorkspaceBundle } from '../vfs/nimbus-workspace';
import type { ActorHandle } from './actor-handle';
import { initWorkspaceActorTable, WorkspaceActorDirectory } from './workspace-actors';

export { wrapDatabase, type AgentDatabase } from './inline-primitives';

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
  const memory = createInlineMemory(db, vfs);
  const craftStore = createInlineCraftStore(db);
  const executor = createInlineExecutor();
  initRunEventTables(execRaw);

  // A birth-time call is the new workspace's spend, unpriced: nothing is resolved yet.
  const llm = createVercelAILLM(components.llm, {
    source: 'reflection', report: unpricedLedgerSink(new RunEventRecorder(sql, actor)),
  });

  const schedule = createInlineSchedule(sql, actor);

  return buildRuntime({
    actor,
    workspaceIsMachine: false,
    sql, execRaw, transactionSync, vfs, llm, executor, schedule, shell: workspace.shell,
    memory, craftStore,
    // Birth-only runtime: a fake exploration result would be indistinguishable from a real one,
    // so fail loudly; running surfaces use createCLIRuntime's real spawner.
    spawnBranch: () => {
      throw new Error(
        'createWorkspace\'s birth runtime does not implement spawnBranch — it is for creating a '
        + 'workspace, not for running one. Open the workspace with openWorkspaceCLI (which builds '
        + 'createCLIRuntime) to get a real branch spawner. Returning a stub result here would be '
        + 'indistinguishable from a real exploration to every consumer.',
      );
    },
    abortBranch: async () => {},
  });
}

/** Create a workspace and return its default agent's runtime; seeds are written through the agent's VFS. */
export async function createWorkspace(
  db: AgentDatabase, config: WorkspaceBirthConfig,
): Promise<AgentRuntime> {
  const { sql, execRaw, transactionSync } = wrapDatabase(db);

  const { workspace, actor } = transactionSync(() => {
    initAllTables(execRaw, sql);
    initWorkspaceBaselineTable(execRaw);
    const bundle = createInlineWorkspace(db);

    const workspaceId = nanoid();
    void sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${workspaceId}, ${config.name}, ${nowMs()})`;
    initWorkspaceActorTable(execRaw);

    return { workspace: bundle, actor: new WorkspaceActorDirectory(sql, { workspaceId, ownerUserId: '' }).createMain({ name: config.name }) };
  });

  const titled = config.title?.trim();
  const heading = titled === undefined || titled === '' ? UNTITLED_WORKSPACE_NAME : titled;

  await seedSoul(workspace.vfs, sql, { name: heading, mission: config.purpose });

  await workspace.vfs.mkdir('scaffold', { recursive: true });
  // The versioned source is authoritative; agent.js is its rebuildable view.
  const scaffoldSource = config.scaffold ?? INITIAL_SCAFFOLD_SOURCE;
  await workspace.vfs.writeFile('scaffold/agent.js.v0', scaffoldSource);
  void sql`INSERT OR IGNORE INTO scaffold_versions (actor_id, version, written_at, rationale)
    VALUES (${actor.actorId}, 0, ${nowMs()}, ${'initial bootstrap'})`;
  await workspace.vfs.writeFile('scaffold/agent.js', scaffoldSource);

  await workspace.vfs.mkdir('memory', { recursive: true });
  await workspace.vfs.writeFile('memory/MEMORY.md', `# ${heading}\n\nCreated: ${new Date().toISOString()}\n`);

  const runtime = buildComponents({ db, sql, execRaw, transactionSync, workspace, actor, llm: config.llm });

  await resetWorkspaceBaseline(runtime);

  return runtime;
}
