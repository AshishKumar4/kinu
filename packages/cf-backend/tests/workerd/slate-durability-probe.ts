/**
 * The slate-durability probe — the REAL preview edge and the REAL
 * OrchestratorAgent, driven so the test file can ask the one question this
 * lane exists to answer: does a durable Nimbus application answer its own URL
 * after the object that hosted it is aborted?
 *
 * THE SEAM. `handleNimbusPreviewHostRequest` (nimbus-route.ts) is the
 * production edge: it parses `<port36>-<handle>-<token>-<workspace>` off the
 * hostname, verifies the v4 signature, resolves the workspace's
 * OrchestratorAgent stub and hands it `routeWorkspacePreview`. Everything
 * below that edge — `routePreview`'s durable re-drive, the reserved port and
 * capability, the retained facet — is production code; the probe contributes
 * only the trigger (this root's methods) and the observation window
 * (`portReservations` on the bound class).
 *
 * THE ORCHESTRATOR. The durableObjects table binds `OrchestratorAgent` to the
 * ObservedOrchestrator subclass below — the two-turn-probe mechanism: same
 * production class, same seal, plus one fixture read re-admitted to the
 * surface. `listPortReservations` is the Nimbus-owned scan of the object's own
 * storage, so the row the test compares across `abortAllDurableObjects()` is
 * the record the URL was minted from, not a shadow the fixture keeps.
 *
 * THE SLATE FILES. `/home/user/slates/<id>/{package.json,server.ts}` are
 * written through `writeExecutorFileChunk('workspace', …)` — the upload route
 * the browser itself uses — because the workspace executor's file plane is
 * the same VFS the slate host reads and its writes feed `filesChanged`, which
 * is how the host knows the tree moved.
 */
import { Agent, getAgentByName, type AgentContext } from 'agents';
import { WorkerEntrypoint } from 'cloudflare:workers';
import * as v from 'valibot';
import { newWebSocketRpcSession } from 'capnweb';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { ORCHESTRATOR_RPC_SURFACE, sealRpcSurface } from '../../src/rpc-surface';
import { handleNimbusPreviewHostRequest } from '../../src/nimbus-route';
import { WORKSPACE_TERMINAL_PATH, WorkspaceTerminalOutputSchema } from '@kinu.run/core';
import { listPortReservations } from '@nimbus-sh/worker/port-capability';
import { ROOT_SLATE_CALLER } from '../../src/slates/bindings';
import { renderThrownChain } from '@kinu.run/core/obs';
import { ownerCaller } from '@kinu.run/core';
import { workspaceOwner } from '../../src/workspace-owner-rpc';
import type { JsonValue } from '@kinu.run/core';
import type {
  DurabilityReservation,
  PreviewAnswer,
  RemovedSlate,
  RpcAnswer,
  ServedSlate,
} from './slate-durability-shapes';

// Re-exported under their production names so the auxiliary worker's
// durableObjects bind the classes themselves — the same mechanism
// slate-actor-probe.ts uses, for the same reason: a probe that retargets the
// class measures its own fixture, not the shipped surface.
export { UserDO } from '../../src/user/user-do';

// The authored slate's bindings enter the guest env through
// `exports.SlateBinding`, and a build-mode resident refuses to boot without a
// `globalOutbound` — `exports.CodemodeEgress` is that loopback, here exactly
// as in production.
export { SlateBinding } from '../../src/slates/bindings';

/** The deterministic network boundary: no authored fetch runs in this probe,
 *  so a fixed answer is the honest one. */
export class CodemodeEgress extends WorkerEntrypoint {
  override async fetch(): Promise<Response> { return new Response('network allowed'); }
}

type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

/** The reservation record the preview URL was minted from, read off the
 *  object's own durable storage by Nimbus's own scan. */
export class ObservedOrchestrator extends ProductionOrchestrator {
  constructor(ctx: AgentContext, env: ProbeEnv) {
    super(ctx, env);
    Reflect.deleteProperty(this, 'portReservations');
    sealRpcSurface(this, [...ORCHESTRATOR_RPC_SURFACE, 'portReservations']);
  }

  async portReservations(): Promise<DurabilityReservation[]> {
    const reservations = await listPortReservations(this.ctx);

    return [...reservations.entries()].map(([port, reservation]) => ({
      port,
      owner: reservation.owner,
      capability: reservation.capability,
    }));
  }
}

export { ObservedOrchestrator as OrchestratorAgent };

// The composed supervisor entrypoint, exported exactly as `src/server.ts`
// exports it: the hosted runtime refuses to compose over a worker whose
// `ctx.exports` carries none, and every facet reaches its host through it.
export { SupervisorRPC } from '@nimbus-sh/worker/workspace-host';

/** Every call the probe makes on the workspace object's own stub.
 *  `slateAs` is absent on purpose: its `SlateCallResult` carries the recursive
 *  `JsonValue`, and mapping `Rpc.Result` over it is the TS2589 that
 *  `workspace-owner-rpc.ts` exists to avoid — the probe reaches that operation
 *  through `workspaceOwner()`, the same port production's actor uses. */
type SlateTarget = Pick<Fetcher, 'fetch'> & Pick<ProductionOrchestrator,
  'claimOwner' | 'writeExecutorFileChunk' | 'executeInExecutor'> & Pick<ObservedOrchestrator, 'portReservations'>;

/** The probe worker's own bindings. `durableObjects` installs
 *  `ObservedOrchestrator` under the `OrchestratorAgent` name (the re-export
 *  above), which the production `Env` declares by its base class, so every
 *  stub the namespace returns carries the fixture read. */
interface ProbeRootEnv extends Omit<ProbeEnv, 'OrchestratorAgent'> {
  readonly OrchestratorAgent: DurableObjectNamespace<ObservedOrchestrator>;
}

const PreviewValueSchema = v.object({ url: v.string(), port: v.number() });

type TerminalDrive =
  | { ok: true; frames: string[]; output: string }
  | { ok: false; error: string };

const RemovedValueSchema = v.object({
  id: v.string(), removed: v.boolean(), port: v.nullable(v.number()),
});

/**
 * The probe root: it owns no identity row and answers only the fixture
 * methods the tests drive. Every call names the workspace, so
 * `abortAllDurableObjects()` between calls is exactly what it measures —
 * nothing the test holds is pinned by this object.
 */
export class SlateDurabilityProbeRoot extends Agent<ProbeRootEnv> {
  private workspaceTarget(workspace: string): Promise<SlateTarget> {
    return getAgentByName<ProbeEnv, ObservedOrchestrator>(this.env.OrchestratorAgent, workspace);
  }

  /** The production workspace-create sequence, exactly as
   *  two-turn-probe's `claimQueueWorkspace` performs it: the owner registers
   *  the name, the workspace claims its owner, and the UserDO mints the
   *  capability token the workspace's privileged reads present. */
  private async claimWorkspace(target: SlateTarget, workspace: string, owner: string): Promise<void> {
    const caller = await ownerCaller(this.env);
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(owner));

    await userDO.registerWorkspace(caller, workspace, 'Durability Probe');
    const claim = await target.claimOwner(owner);

    await userDO.ensureWorkspaceCapability(workspace, claim.capabilityHash);
  }

  /** A claimed workspace and nothing else, for a suite whose subject is the
   *  shell rather than a slate. */
  async openWorkspace(workspace: string, owner: string): Promise<void> {
    await this.claimWorkspace(await this.workspaceTarget(workspace), workspace, owner);
  }

  /** One authored file onto the workspace's file plane, through the upload
   *  chunk route: a single offset-0 final chunk, which (re)starts and
   *  completes the transfer in one call. */
  private async writeSlateFile(target: SlateTarget, path: string, content: string): Promise<void> {
    const written = await target.writeExecutorFileChunk({
      executorId: 'workspace',
      path,
      transferId: crypto.randomUUID(),
      offset: 0,
      chunk: new TextEncoder().encode(content),
      final: true,
    });

    if ('ok' in written) return;

    throw new Error(`writeExecutorFileChunk ${path}: ${'error' in written ? written.error : `revision ${String(written.revision)} conflict`}`);
  }

  /** Claim the workspace, land the authored tree, and preview the slate:
   *  the URL the durable reservation minted plus the reservation rows the
   *  object held at that instant. */
  async serveSlate(input: {
    workspace: string; owner: string; id: string; body: string; preferredPort?: number;
  }): Promise<ServedSlate> {
    const target = await this.workspaceTarget(input.workspace);

    await this.claimWorkspace(target, input.workspace, input.owner);
    const root = `/home/user/slates/${input.id}`;

    await this.writeSlateFile(target, `${root}/package.json`, JSON.stringify({
      main: 'server.ts',
      slate: input.preferredPort === undefined ? { title: input.id } : { title: input.id, port: input.preferredPort },
    }));
    await this.writeSlateFile(target, `${root}/server.ts`, [
      'import { SlateObject } from "kinu:slate";',
      'export class Slate extends SlateObject {',
      '  async ping() {',
      '    this.sql.exec("CREATE TABLE IF NOT EXISTS probe (n INTEGER NOT NULL)");',
      '    this.sql.exec("INSERT INTO probe (n) VALUES (1)");',
      '    const rows = this.sql.exec("SELECT count(*) AS n FROM probe").toArray()[0].n;',
      '    return { rows };',
      '  }',
      `  async fetch() { return new Response(${JSON.stringify(input.body)}); }`,
      '}',
    ].join('\n'));

    const preview = await workspaceOwner(this.env, input.workspace).slateAs(ROOT_SLATE_CALLER, { op: 'preview', id: input.id });

    if (!preview.ok) throw new Error(`slate preview refused: ${preview.reason}: ${preview.error}`);
    const value = v.parse(PreviewValueSchema, preview.value);

    // The capability the URL's handle was cut from, read off the same stored
    // reservation the post-abort assertion compares.
    const held = (await target.portReservations()).find((row) => row.owner === input.id);

    if (held === undefined) throw new Error(`no port reservation for ${input.id}`);

    if (held.capability === null) throw new Error(`the reservation for ${input.id} holds no capability`);

    return {
      url: value.url,
      port: value.port,
      capability: held.capability,
      reservations: await target.portReservations(),
    };
  }

  /** Every stored port reservation on the named workspace object — the rows
   *  the test compares across `abortAllDurableObjects()`. */
  async portReservations(workspace: string): Promise<DurabilityReservation[]> {
    return (await this.workspaceTarget(workspace)).portReservations();
  }

  /** One request through the real preview edge: signed hostname, capability
   *  handle check, durable re-drive, capability routing. A `null` answer is
   *  the edge declining the hostname — a fixture fault, never a slate's
   *  answer — so it throws rather than reporting a status. */
  async drivePreview(url: string): Promise<PreviewAnswer> {
    const response = await handleNimbusPreviewHostRequest(new Request(url), this.env);

    if (response === null) throw new Error(`the preview edge declined ${url}`);

    return { status: response.status, body: await response.text() };
  }

  /** One authored method over the durable URL's `/__rpc`: the WebSocket arm
   *  of the same preview route, since a 101 cannot cross the RPC boundary the
   *  plain drive uses. The socket lives and dies inside this call. */
  async rpcPreview(url: string, method: string, args: JsonValue[] = []): Promise<RpcAnswer> {
    const endpoint = new URL(url);
    endpoint.pathname = '/__rpc';

    const response = await handleNimbusPreviewHostRequest(
      new Request(endpoint.toString(), { headers: { Upgrade: 'websocket' } }), this.env);

    if (response === null) throw new Error(`the preview edge declined ${endpoint.toString()}`);

    const socket = response.webSocket;

    if (socket === null || socket === undefined) {
      return { ok: false, error: `upgrade refused: ${response.status} ${await response.text()}` };
    }

    socket.accept();
    const stub = newWebSocketRpcSession<Record<string, (...input: JsonValue[]) => Promise<JsonValue>>>(socket);

    try {
      const raw = await stub[method](...args);

      return { ok: true, value: v.is(v.string(), raw) ? raw : JSON.stringify(raw) };
    } catch (cause) {
      return { ok: false, error: renderThrownChain({ cause }) };
    } finally {
      socket.close();
    }
  }

  /** The root removing a slate, through the same operation the owner's
   *  browser sends. */
  async removeSlate(workspace: string, id: string): Promise<RemovedSlate> {
    const removed = await workspaceOwner(this.env, workspace).slateAs(ROOT_SLATE_CALLER, { op: 'remove', id });

    if (!removed.ok) return { ok: false, reason: removed.reason, error: removed.error };
    const value = v.parse(RemovedValueSchema, removed.value);

    return { ok: value.removed, port: value.port };
  }

  /** One command through the workspace executor, the way the `shell` tool
   *  reaches it: a process left running beside a served slate. */
  async runInWorkspace(workspace: string, command: string): Promise<{ exitCode: number; stdout: string }> {
    const target = await this.workspaceTarget(workspace);
    const answer = await target.executeInExecutor('workspace', command);

    if ('error' in answer) return { exitCode: 1, stdout: answer.error };

    return { exitCode: answer.exitCode, stdout: `${answer.stdout}${answer.stderr}` };
  }

  /**
   * The workspace's shell over the socket the terminal route forwards: one
   * upgrade into the workspace object, a resize, one typed line, and the
   * frames back until the shell has echoed `until`. The socket lives and
   * dies inside this call, like `rpcPreview`'s.
   */
  async driveTerminal(workspace: string, line: string, until: string): Promise<TerminalDrive> {
    const target = await this.workspaceTarget(workspace);

    const response = await target.fetch(new Request(`https://workspace.invalid${WORKSPACE_TERMINAL_PATH}`, {
      headers: { Upgrade: 'websocket' },
    }));

    const socket = response.webSocket;

    if (socket === null || socket === undefined) {
      return { ok: false, error: `upgrade refused: ${response.status} ${await response.text()}` };
    }

    socket.accept();
    const frames: string[] = [];
    let output = '';

    const echoed = new Promise<void>((resolve) => {
      socket.addEventListener('message', (event) => {
        const parsed = v.safeParse(WorkspaceTerminalOutputSchema, JSON.parse(String(event.data)));

        if (!parsed.success) {
          frames.push('other');

          return;
        }

        frames.push(parsed.output.type);

        if (parsed.output.type === 'output') output += parsed.output.data;

        if (output.includes(until)) resolve();
      });
    });

    try {
      socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
      socket.send(JSON.stringify({ type: 'input', data: `${line}\r` }));
      await echoed;

      return { ok: true, frames, output };
    } finally {
      socket.close(1000, 'drive complete');
    }
  }

  /** A file of the workspace as its user reads it, or null when absent. */
  async readWorkspaceFile(workspace: string, path: string): Promise<string | null> {
    const target = await this.workspaceTarget(workspace);
    const answer = await target.executeInExecutor('workspace', `cat ${path}`);

    if ('error' in answer || answer.exitCode !== 0) return null;

    return answer.stdout;
  }
}
