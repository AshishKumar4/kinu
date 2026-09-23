/**
 * Does a durable Nimbus application answer its own URL after its hosting object is aborted?
 * Everything below `handleNimbusPreviewHostRequest` is production code; the probe adds only the
 * trigger and the observation.
 */
import { Agent, getAgentByName, type AgentContext } from 'agents';
import { WorkerEntrypoint } from 'cloudflare:workers';
import * as v from 'valibot';
import { newWebSocketRpcSession } from 'capnweb';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { ORCHESTRATOR_RPC_SURFACE, sealRpcSurface } from '../../src/rpc-surface';
import { handleNimbusPreviewHostRequest } from '../../src/nimbus-route';
import { WORKSPACE_TERMINAL_PATH, WorkspaceTerminalOutputSchema, createDefaultWebSearchProvider, toolsInWorkMode } from '@kinu.run/core';
import { listPortReservations } from '@nimbus-sh/worker/port-capability';
import { ROOT_SLATE_CALLER } from '../../src/slates/bindings';
import { renderThrownChain } from '@kinu.run/core/obs';
import { ownerCaller } from '@kinu.run/core';
import { workspaceOwner } from '../../src/workspace-owner-rpc';
import { createCodemodeToolFactory } from '../../src/codemode-tool';
import { codemodeEgress } from '../../src/codemode-egress';
import type { JsonValue } from '@kinu.run/core';
import type {
  DurabilityReservation,
  PreviewAnswer,
  RemovedSlate,
  RpcAnswer,
  ServedSlate,
} from './slate-durability-shapes';

// Re-exported under production names so the auxiliary worker binds the classes themselves: a
// probe that retargets the class measures its own fixture (as in slate-actor-probe.ts).
export { UserDO } from '../../src/user/user-do';

// A build-mode resident refuses to boot without a `globalOutbound`: `CodemodeEgress` is that
// loopback.
export { SlateBinding } from '../../src/slates/bindings';

export class CodemodeEgress extends WorkerEntrypoint {
  override async fetch(): Promise<Response> { return new Response('network allowed'); }
}

type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

export class ObservedOrchestrator extends ProductionOrchestrator {
  constructor(ctx: AgentContext, env: ProbeEnv) {
    super(ctx, env);
    Reflect.deleteProperty(this, 'portReservations');
    Reflect.deleteProperty(this, 'runProgram');
    sealRpcSurface(this, [...ORCHESTRATOR_RPC_SURFACE, 'portReservations', 'runProgram']);
  }

  async portReservations(): Promise<DurabilityReservation[]> {
    const reservations = await listPortReservations(this.ctx);

    return [...reservations.entries()].map(([port, reservation]) => ({
      port,
      owner: reservation.owner,
      capability: reservation.capability,
    }));
  }

  /** One program through this workspace's production `eval` tool, in Build mode; its answer as JSON. */
  async runProgram(code: string): Promise<string> {
    const factory = createCodemodeToolFactory({
      loader: this.env.LOADER, egress: codemodeEgress(), rt: this.rt, sql: this.rt.storage.sql,
      workspace: this.name, webSearch: createDefaultWebSearchProvider({ fetch }),
    });

    const execute = toolsInWorkMode('build', { eval: factory.toolFor({}) }).eval?.execute;

    if (execute === undefined) throw new Error('No callable eval tool');

    return JSON.stringify(await execute({ code }, { toolCallId: 'slate-program', messages: [] }) ?? null);
  }
}

export { ObservedOrchestrator as OrchestratorAgent };

// Exported as `src/server.ts` does: the hosted runtime refuses a worker whose `ctx.exports` lacks
// it.
export { SupervisorRPC } from '@nimbus-sh/worker/workspace-host';

/** `slateAs` is absent on purpose: `Rpc.Result` over its recursive `JsonValue` is TS2589; the probe
 *  reaches it through `workspaceOwner()`, as production's actor does. */
type SlateTarget = Pick<Fetcher, 'fetch'> & Pick<ProductionOrchestrator,
  'claimOwner' | 'writeExecutorFileChunk' | 'executeInExecutor'> & Pick<ObservedOrchestrator, 'portReservations' | 'runProgram'>;

/** `ObservedOrchestrator` is installed under the `OrchestratorAgent` name, so every stub carries
 *  the fixture read. */
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

/** Every call names the workspace, so nothing the test holds pins this object across
 *  `abortAllDurableObjects()`. */
export class SlateDurabilityProbeRoot extends Agent<ProbeRootEnv> {
  private workspaceTarget(workspace: string): Promise<SlateTarget> {
    return getAgentByName<ProbeEnv, ObservedOrchestrator>(this.env.OrchestratorAgent, workspace);
  }

  /** The production workspace-create sequence, as two-turn-probe's `claimQueueWorkspace`
   *  performs it. */
  private async claimWorkspace(target: SlateTarget, workspace: string, owner: string): Promise<void> {
    const caller = await ownerCaller(this.env);
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(owner));

    await userDO.registerWorkspace(caller, workspace, 'Durability Probe');
    const claim = await target.claimOwner(owner);

    await userDO.ensureWorkspaceCapability(workspace, claim.capabilityHash);
  }

  async openWorkspace(workspace: string, owner: string): Promise<void> {
    await this.claimWorkspace(await this.workspaceTarget(workspace), workspace, owner);
  }

  /** A single offset-0 final chunk (re)starts and completes the transfer in one call. */
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

  /** Authors a whiteboard slate whose class stores strokes, then runs `program` through the workspace's `eval`. */
  async programOnWhiteboard(input: { workspace: string; owner: string; program: string }): Promise<string> {
    const target = await this.workspaceTarget(input.workspace);

    await this.claimWorkspace(target, input.workspace, input.owner);
    const root = '/home/user/slates/whiteboard';

    await this.writeSlateFile(target, `${root}/package.json`, JSON.stringify({ main: 'server.ts', slate: { title: 'Whiteboard' } }));
    await this.writeSlateFile(target, `${root}/server.ts`, [
      'import { SlateObject } from "kinu:slate";',
      'export class Slate extends SlateObject {',
      '  async addStroke(stroke) {',
      '    const strokes = (await this.storage.get("strokes")) ?? [];',
      '    strokes.push(stroke);',
      '    await this.storage.put("strokes", strokes);',
      '    return { count: strokes.length };',
      '  }',
      '  async strokes() { return (await this.storage.get("strokes")) ?? []; }',
      '}',
    ].join('\n'));

    return target.runProgram(input.program);
  }

  async portReservations(workspace: string): Promise<DurabilityReservation[]> {
    return (await this.workspaceTarget(workspace)).portReservations();
  }

  /** A `null` answer is the edge declining the hostname, a fixture fault, so it throws. */
  async drivePreview(url: string): Promise<PreviewAnswer> {
    const response = await handleNimbusPreviewHostRequest(new Request(url), this.env);

    if (response === null) throw new Error(`the preview edge declined ${url}`);

    return { status: response.status, body: await response.text() };
  }

  /** Uses the WebSocket arm: a 101 cannot cross the RPC boundary the plain drive uses. */
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

  async removeSlate(workspace: string, id: string): Promise<RemovedSlate> {
    const removed = await workspaceOwner(this.env, workspace).slateAs(ROOT_SLATE_CALLER, { op: 'remove', id });

    if (!removed.ok) return { ok: false, reason: removed.reason, error: removed.error };
    const value = v.parse(RemovedValueSchema, removed.value);

    return { ok: value.removed, port: value.port };
  }

  async runInWorkspace(workspace: string, command: string): Promise<{ exitCode: number; stdout: string }> {
    const target = await this.workspaceTarget(workspace);
    const answer = await target.executeInExecutor('workspace', command);

    if ('error' in answer) return { exitCode: 1, stdout: answer.error };

    return { exitCode: answer.exitCode, stdout: `${answer.stdout}${answer.stderr}` };
  }

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

  async readWorkspaceFile(workspace: string, path: string): Promise<string | null> {
    const target = await this.workspaceTarget(workspace);
    const answer = await target.executeInExecutor('workspace', `cat ${path}`);

    if ('error' in answer || answer.exitCode !== 0) return null;

    return answer.stdout;
  }
}
