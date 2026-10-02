import { type VFS, writeText } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * What one hot-path operation costs the database, counted rather than timed: every statement the
 * operation runs goes through a metered `SqlStorage`, and the cursors' own `rowsRead` and
 * `rowsWritten`, with the rows the caller took back out of each, are summed by the tables each
 * statement names, beside each table's row count and payload before and after. The subjects are
 * production code over this object's own SQLite: the session store as `createAgentStores` builds
 * it for an actor, driven through the calls `ActorSession` makes for a turn; the Nimbus workspace and
 * its Diffs baseline; and a slate's versions and forks through `SlateFiles`.
 */
import { DurableObject } from 'cloudflare:workers';
import type { ModelMessage } from 'ai';
import { SlateId } from '@agent-core/core/slates';
import { ChangeSetCache, DynamicContextLedger, MAIN_AGENT, WORKSPACE_IDENTITY_DDL, WorkspaceActorDirectory, agentArtifactDirectory, agentHome, composePrepareStep, createAgentStores, getWorkspaceDiff, initActorClaimTables, initAgentConfigTable, initCodemodeStateTable, initWorkspaceActorTable, initWorkspaceSchema, classifyRunEnd, closeTurnRun, nimbusSessionFiles, openTurnRun, resetWorkspaceBaseline, settleWorkspaceSlates, standardMounts, withMountTable, type ActorHandle, type AgentStores, type NimbusSandboxHandle, type SqlExecutor, type SqlValue, type StepContextPlane, type StepPipeline, type WorkspaceBaselines, WORKSPACE_ROOT } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { SlateFiles, WorkspaceSlateContentStore, slateDirectory } from '@kinu.run/core/slates';
import { workspaceBoxFiles } from '@kinu.run/core/workspace';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CredentialedVfs, SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
// The writer `ActorSession` hands a turn's steps to; core keeps it internal.
import { SessionStream } from '../../../../core/src/orchestrator/session-stream';
import { SqlMeter, type OperationCost, type TableChange, type TableCost } from '../sql-meter';

export type { OperationCost } from '../sql-meter';

function addChanges(a: TableChange, b: TableChange): TableChange {
  const tables = new Set([...Object.keys(a), ...Object.keys(b)]);

  return Object.fromEntries([...tables].map((table) => [table, (a[table] ?? 0) + (b[table] ?? 0)]));
}

/** Several operations' costs as one: what the run of them cost together. */
function sumCosts(costs: readonly OperationCost[]): OperationCost {
  const tables: Record<string, TableCost> = {};

  for (const cost of costs) {
    for (const [table, counted] of Object.entries(cost.tables)) {
      const sum = tables[table] ?? { rowsRead: 0, rowsWritten: 0, statements: 0, rowsScanned: 0 };

      tables[table] = {
        rowsRead: sum.rowsRead + counted.rowsRead, rowsWritten: sum.rowsWritten + counted.rowsWritten,
        statements: sum.statements + counted.statements, rowsScanned: sum.rowsScanned + counted.rowsScanned,
      };
    }
  }

  return {
    tables,
    dbBytes: costs.reduce((sum, cost) => sum + cost.dbBytes, 0),
    storedRows: costs.reduce<TableChange>((sum, cost) => addChanges(sum, cost.storedRows), {}),
    storedBytes: costs.reduce<TableChange>((sum, cost) => addChanges(sum, cost.storedBytes), {}),
    requestBytes: null,
  };
}

/** How many versions in a row the slate subject counts: enough that Nimbus's content maintenance,
 *  which reads one page of content ids a write from a cursor that wraps at the end of the store, is
 *  counted across its pages rather than at whichever page one write happened to land on. */
const VERSIONS_COUNTED = 8;

/** A deterministic source file of about 2 KiB, distinct per index and per version. */
function fileText(index: number, version = 0): string {
  const lines: string[] = [];

  for (let line = 0; line < 48; line += 1) {
    lines.push(`export const v${String(index)}_${String(line)} = ${String((index * 7919 + line * 104729 + version * 15485863) % 1000003)};`);
  }

  return `${lines.join('\n')}\n`;
}

/** A hundred files a directory, as a real tree spreads them. */
function filePath(index: number): string {
  return `src/m${String(Math.floor(index / 100))}/f${String(index)}.ts`;
}

const PROGRAM = { kind: 'builtin' as const, version: 0, digest: null, build: null };

/** The two steps of one scripted turn: a file write the model asks for, then its answer. */
function toolCall(turn: number): ModelMessage {
  return { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `call-${String(turn)}`, toolName: 'file', input: { action: 'write', path: `notes/${String(turn)}.md`, content: `note ${String(turn)}` } }] };
}

function toolResult(turn: number): ModelMessage {
  return { role: 'tool', content: [{ type: 'tool-result', toolCallId: `call-${String(turn)}`, toolName: 'file', output: { type: 'json', value: { ok: true, path: `notes/${String(turn)}.md` } } }] };
}

function requestBytes(messages: readonly ModelMessage[] | undefined): number {
  return new TextEncoder().encode(JSON.stringify(messages ?? [])).byteLength;
}

/** The chat step pipeline a turn bound for Anthropic runs (chat.ts `prepareStep`): replayed tool ids
 *  normalized for the destination and cache markers on the tail, both of which copy messages, and a
 *  prune budget. The dynamic block and the step context are the turn's own. */
const PIPELINE = {
  prune: { contextWindow: 200_000, modelOutputLimit: 8_000 },
  destinationProviderId: 'anthropic',
  cache: { strategy: { kind: 'anthropic' as const } },
} satisfies StepPipeline;

/** A woven block, as `ActorSession`'s dynamic snapshot supplies one. */
const DYNAMIC = { recoveries: ['a finding proven by execution'] };

function meteredStorage(real: SqlStorage, meter: SqlMeter): SqlStorage {
  return {
    exec: (query, ...bindings) => meter.exec(query, ...bindings),
    prepare: (query) => real.prepare(query),
    ingest: (query) => real.ingest(query),
    setMaxPageCountForTest: (count) => { real.setMaxPageCountForTest(count); },
    get databaseSize() { return real.databaseSize; },
    Cursor: real.Cursor,
    Statement: real.Statement,
  };
}

export class ComplexityProbeDO extends DurableObject<Cloudflare.Env> {
  private readonly meter = new SqlMeter(this.ctx.storage.sql);

  /** This object's database with every statement through the meter, for the stores under test. */
  private readonly sql: SqlStorage = meteredStorage(this.ctx.storage.sql, this.meter);

  private readonly executor: SqlExecutor = <Row,>(strings: TemplateStringsArray, ...values: SqlValue[]): Row[] =>
    this.sql.exec<Row & Record<string, SqlStorageValue>>(strings.join('?'), ...values).toArray();

  private readonly execRaw = (ddl: string): void => { this.sql.exec(ddl); };

  private opened: Promise<SqliteVFS> | undefined;

  private workspace(): Promise<SqliteVFS> {
    this.opened ??= NimbusWorkspace.create({ sql: this.sql, transactions: { storage: this.ctx.storage } })
      .then((workspace) => {
        // As a workspace boot leaves it: /slates the kernel's, shared with the workspace's agents.
        settleWorkspaceSlates(workspace.vfs.as(CRED_KERNEL), (path) => { workspace.vfs.registerSharedDirectory(path); });

        return workspace.vfs;
      });

    return this.opened;
  }

  /** The workspace box as the orchestrator's file plane opens it; this object runs no processes. */
  private box(): NimbusSandboxHandle {
    return {
      files: workspaceBoxFiles(() => this.workspace()),
      ready: async () => undefined,
      exec: async () => { throw new Error('the complexity probe runs no processes'); },
    };
  }

  /** The agent's file plane, as `createCFRuntime` mounts it (no /pc, no /sandbox here). */
  private agentFiles(): VFS {
    return withMountTable(nimbusSessionFiles(this.box(), { home: WORKSPACE_ROOT }), standardMounts(() => undefined));
  }

  private main(): ActorHandle {
    this.execRaw(WORKSPACE_IDENTITY_DDL);
    initWorkspaceActorTable(this.execRaw);
    initAgentConfigTable(this.execRaw);
    initCodemodeStateTable(this.execRaw);
    initActorClaimTables(this.execRaw);
    const workspaceId = crypto.randomUUID();

    void this.executor`INSERT INTO workspace_identity (id, name) VALUES (${workspaceId}, ${'complexity'})`;

    return new WorkspaceActorDirectory(this.executor, { workspaceId, ownerUserId: '' }).createMain({ name: 'complexity' });
  }

  /** The actor's stores exactly as the orchestrator builds them (actor-agent.ts `stores`). */
  private stores(actor: ActorHandle): AgentStores {
    return createAgentStores(() => this.executor, () => actor, (write) => this.ctx.storage.transactionSync(write), async () => ({
      vfs: nimbusSessionFiles(this.box(), { home: WORKSPACE_ROOT, cred: CRED_SESSION_USER }),
      artifactDirectory: agentArtifactDirectory(agentHome(MAIN_AGENT)),
    }));
  }

  /**
   * One scripted turn through the store calls `ActorSession` makes (actor-session.ts): `openTurnInput`
   * admits and activates the input; `runTurn` admits the materialized context under a claim, runs two
   * requests through {@link PIPELINE} with its dynamic ledger, writes each step's response through a
   * `SessionStream`, settles it, reads the turn's output back, and the claim settles. The model, the
   * tools and the program are not run: the first step is a file call and its result, the second the
   * answer, streamed as `deltas` text deltas the way the model's stream arrives. Returns the bytes of the two requests.
   */
  private async turn(actor: ActorHandle, stores: AgentStores, dynamic: DynamicContextLedger, scripted: { readonly turn: number; readonly deltas: number }): Promise<number> {
    const { turn, deltas } = scripted;
    const turnId = `turn-${String(turn)}`;
    const assertOwner = (): void => { actor.assertCurrent(); };

    const { history, claims } = stores;

    await history.materialize();

    const input = await history.admitInput({ id: turnId, message: { role: 'user', content: `question ${String(turn)}` }, turnId, assertOwner });

    history.activateInput(input, turnId, assertOwner);
    // ChatSession's lastRequestAt, before execute.
    history.requests.lastStep();
    await history.materialize();

    const admitted = await history.materialize();

    const claim = await claims.admit({ runId: `run-${String(turn)}`, turnId, workMode: 'build', program: PROGRAM, context: admitted.selection });

    const stream = new SessionStream(history, turnId, claim.epoch);

    const context: StepContextPlane = {
      base: () => history.stepBase(() => { history.assertEpoch(claim.turnId, claim.epoch); }, claim.turnId, null),
      consume: async ({ stepNumber, messages }) => {
        const consumed = await claims.consume(claim, { index: stepNumber, messages });

        stream.beginRequest(consumed.requestId, stepNumber);
      },
    };

    const pipeline: StepPipeline = { ...PIPELINE, dynamic: { ledger: dynamic, snapshot: () => DYNAMIC }, context };

    const call = toolCall(turn);
    const result = toolResult(turn);
    const words = Array.from({ length: deltas }, (_, index) => `w${String(index)} `);
    const answer: ModelMessage = { role: 'assistant', content: [{ type: 'text', text: words.join('') }] };

    // ActorSession's lastStep at turn open.
    history.requests.lastStep();
    const first = await composePrepareStep(pipeline, { stepNumber: 0, messages: [...admitted.messages], steps: [] });

    await stream.nativeStep([call, result]);

    const second = await composePrepareStep(pipeline, { stepNumber: 1, messages: [], steps: [] });

    await stream.nativePart({ type: 'text-start', id: 'answer' });

    for (const word of words) await stream.nativePart({ type: 'text-delta', id: 'answer', text: word });
    await stream.nativePart({ type: 'text-end', id: 'answer' });
    await stream.nativeStep([call, result, answer]);
    await stream.settle();
    await history.materialize();
    await history.outputForTurn(turnId);
    claims.settle(claim, 'completed');

    return requestBytes(first?.messages) + requestBytes(second?.messages);
  }

  /** Subject: one turn of a session that already holds `history` turns. */
  async sessionTurn(history: number): Promise<OperationCost> {
    const actor = this.main();
    const stores = this.stores(actor);
    const dynamic = new DynamicContextLedger();

    for (let turn = 0; turn < history; turn += 1) await this.turn(actor, stores, dynamic, { turn, deltas: 1 });

    return await this.meter.measure(async () => await this.turn(actor, stores, dynamic, { turn: history, deltas: 1 }));
  }

  /** Subject: a 500-delta turn after twenty answers of `deltas` deltas each (D23's cost, counted, not timed). */
  async turnAfterLongAnswers(deltas: number): Promise<OperationCost> {
    const actor = this.main();
    const stores = this.stores(actor);
    const dynamic = new DynamicContextLedger();

    for (let turn = 0; turn < 20; turn += 1) await this.turn(actor, stores, dynamic, { turn, deltas });

    // Stores built afresh, as after an eviction: past answers are read from their rows, not from memory.
    const woken = this.stores(actor);

    return await this.meter.measure(async () => await this.turn(actor, woken, dynamic, { turn: 20, deltas: 500 }));
  }

  /** Subject: an activation's question "is a turn open, and which", after `runs` finished turns and one open one. */
  async openTurnLookup(runs: number): Promise<OperationCost> {
    initWorkspaceSchema({ execRaw: this.execRaw, sql: this.executor, exec: this.sql, transactionSync: (write) => this.ctx.storage.transactionSync(write) });
    const actor = this.main();
    const { eventRecorder } = this.stores(actor);

    const open = (index: number): void => {
      openTurnRun(eventRecorder, `run-${String(index)}`, {
        agentId: actor.actorId, causedBy: 'chat', userMessage: `question ${String(index)}`, turnIndex: index,
        turn: { turnId: `turn-${String(index)}`, messageId: `answer-${String(index)}`, kind: 'user', text: `question ${String(index)}` },
      });
    };

    for (let index = 0; index < runs; index += 1) {
      open(index);
      closeTurnRun(eventRecorder, `run-${String(index)}`, { turnIndex: index, ...classifyRunEnd({ completed: true, interrupted: false }) });
    }

    open(runs);

    return await this.meter.measure(async () => {
      if (eventRecorder.openTurn()?.runId !== `run-${String(runs)}`) throw new Error('the open turn was not found');

      return null;
    });
  }

  /** The store the orchestrator's Diffs read, as the session user. */
  private async baselines(): Promise<WorkspaceBaselines> {
    return { store: await this.workspace(), cred: CRED_SESSION_USER };
  }

  /** Subject: one Diffs read of a workspace of `files` files with one edited since its baseline. */
  async diffRead(files: number): Promise<OperationCost> {
    const actor = this.main();
    const vfs = this.agentFiles();
    const baselines = await this.baselines();

    for (let index = 0; index < files; index += 1) await writeText(vfs, filePath(index), fileText(index));

    await resetWorkspaceBaseline({ actor }, baselines);
    const edited = Math.floor(files / 2);

    await writeText(vfs, filePath(edited), fileText(edited, 1));

    return await this.meter.measure(async () => {
      const diff = await getWorkspaceDiff({ actor }, baselines);

      if (diff.files.length !== 1) throw new Error(`the Diffs read saw ${String(diff.files.length)} changed files, not the 1 edited`);

      return null;
    });
  }

  /**
   * The Changes poll with nothing changed since the last one, as the orchestrator serves it: its change-set held by a
   * `ChangeSetCache` the workspace's file events keep, after one edit's read has refreshed it.
   */
  async diffPoll(files: number): Promise<OperationCost> {
    const actor = this.main();
    const vfs = this.agentFiles();
    // No page listens here: the subject is the read, not the frame.
    const changes = new ChangeSetCache(() => {});

    (await this.workspace()).events.on((batch) => changes.touched(batch.flatMap((event) => (event.oldPath === undefined ? [event.path] : [event.path, event.oldPath]))));
    const baselines = await this.baselines();

    for (let index = 0; index < files; index += 1) await writeText(vfs, filePath(index), fileText(index));

    await resetWorkspaceBaseline({ actor }, baselines);
    changes.moved();
    await writeText(vfs, filePath(Math.floor(files / 2)), fileText(Math.floor(files / 2), 1));
    const first = await changes.read(() => getWorkspaceDiff({ actor }, baselines));

    return await this.meter.measure(async () => {
      const again = await changes.read(() => getWorkspaceDiff({ actor }, baselines));

      if (again.files.length !== 1 || first.files.length !== 1) throw new Error(`the poll saw ${String(again.files.length)} changed files, not the 1 edited`);

      return null;
    });
  }

  /** The slate file plane as the slate host builds it, over the workspace schema the orchestrator creates. */
  private async slates(): Promise<{ readonly files: SlateFiles; readonly tree: CredentialedVfs }> {
    const vfs = await this.workspace();
    const tree = vfs.as(CRED_SESSION_USER);

    initWorkspaceSchema({
      execRaw: this.execRaw, sql: this.executor, exec: this.sql,
      transactionSync: (write) => this.ctx.storage.transactionSync(write),
    });
    const files = new SlateFiles(tree, new WorkspaceSlateContentStore(vfs.as(CRED_KERNEL)), this.sql, (body) => vfs.withTransaction(body));

    return { files, tree };
  }

  private writeSlate(tree: CredentialedVfs, root: string, files: number, version: (index: number) => number): void {
    for (let index = 0; index < files; index += 1) {
      const path = `${root}/${filePath(index)}`;

      tree.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
      tree.writeFile(path, new TextEncoder().encode(fileText(index, version(index))));
    }
  }

  /** One slate transaction; RPC carries no `cause`, so a rollback is rethrown with its whole chain. */
  private inTransaction<Result>(files: SlateFiles, body: () => Result): Result {
    try {
      return files.transaction(body);
    } catch (cause) {
      throw new Error(renderThrownChain({ cause }), { cause });
    }
  }

  /** Subject: the next {@link VERSIONS_COUNTED} versions of a 16-file slate that already has `versions`
   *  versions, one file changed before each. The edits are the agent's, and go uncounted. */
  async slateVersion(versions: number): Promise<OperationCost> {
    const { files, tree } = await this.slates();
    const id = new SlateId('s1');
    const root = slateDirectory(id);

    this.writeSlate(tree, root, 16, () => 0);

    for (let version = 1; version <= versions; version += 1) {
      this.writeSlate(tree, root, 1, () => version);
      this.inTransaction(files, () => files.capture(id));
    }

    const counted: OperationCost[] = [];

    for (let next = 1; next <= VERSIONS_COUNTED; next += 1) {
      this.writeSlate(tree, root, 1, () => versions + next);
      counted.push(await this.meter.measure(async () => {
        this.inTransaction(files, () => files.capture(id));

        return null;
      }));
    }

    return sumCosts(counted);
  }

  /** Subject: a fork (a restore into a new slate) of one version of a `size`-file slate. */
  async slateFork(size: number): Promise<OperationCost> {
    const { files, tree } = await this.slates();
    const source = new SlateId('s1');

    this.writeSlate(tree, slateDirectory(source), size, () => 0);
    const version = this.inTransaction(files, () => files.capture(source));

    return await this.meter.measure(async () => {
      this.inTransaction(files, () => files.restore(new SlateId('s2'), version));

      return null;
    });
  }
}
