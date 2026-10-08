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
import { WORKSPACE_TERMINAL_PATH, WorkspaceTerminalOutputSchema, buildBuiltinTools, codemodeSurface, createDefaultWebSearchProvider, toolsInWorkMode } from '@kinu.run/core';
import { narrowToolSurface } from '@kinu.run/core';
import { listPortReservations } from '@nimbus-sh/worker/port-capability';
import { ROOT_SLATE_CALLER } from '../../src/slates/bindings';
import { pictureKey, picturePrefix } from '../../src/slates/pictures';
import { renderThrownChain } from '@kinu.run/core/obs';
import { ownerCaller } from '@kinu.run/core';
import { workspaceOwner } from '../../src/workspace-owner-rpc';
import { createCodemodeToolFactory } from '../../src/codemode-tool';
import { BROWSER_PRELUDE } from '../../src/browser-prelude';
import { actorNamespaces, SURFACE_POLICY } from '@kinu.run/core';
import { codemodeLauncher } from '../../src/codemode-sandbox';
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
export * from '../../src/server';

// A build-mode resident refuses to boot without a `globalOutbound`: `CodemodeEgress` is that
// loopback.


export class CodemodeEgress extends WorkerEntrypoint {
  override async fetch(): Promise<Response> { return new Response('network allowed'); }
}

type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

export class ObservedOrchestrator extends ProductionOrchestrator {
  constructor(ctx: AgentContext, env: ProbeEnv) {
    super(ctx, env);
    // The production constructor already sealed these subclass methods away as own properties.
    Reflect.deleteProperty(this, 'portReservations');
    Reflect.deleteProperty(this, 'runProgram');
    Reflect.deleteProperty(this, 'forgetActivation');
    Reflect.deleteProperty(this, 'pendingNimbusTasks');
    Reflect.deleteProperty(this, 'executorRows');
    Reflect.deleteProperty(this, 'runShell');
    Reflect.deleteProperty(this, 'previewTabs');
    Reflect.deleteProperty(this, 'failingSlates');
    sealRpcSurface(this, [
      ...ORCHESTRATOR_RPC_SURFACE, 'portReservations', 'runProgram', 'forgetActivation', 'pendingNimbusTasks', 'executorRows', 'runShell', 'previewTabs',
      'failingSlates',
    ]);
  }

  /** What the agent's next model step is told of slates that do not build. */
  async failingSlates(): Promise<string[]> {
    return [...this.extraDynamicContext().failingSlates?.() ?? []];
  }

  /** What the work surface's strip is drawn from: the workspace's listed preview ports, and the slates with their ports. */
  async previewTabs(): Promise<{ ports: { port: number; name: string | null }[]; slates: { id: string; title: string; port: number | null }[] }> {
    const listed = await this.getExposedPorts('workspace');
    const slates = await this.slate({ op: 'list' });

    if (!slates.ok) throw new Error(`slate list refused: ${slates.reason}: ${slates.error}`);

    return {
      ports: listed.ports.map((port) => ({ port: port.port, name: port.name ?? null })),
      slates: v.parse(v.object({ slates: v.array(v.object({ id: v.string(), title: v.string(), port: v.optional(v.number()) })) }), slates.value)
        .slates.map((slate) => ({ id: slate.id, title: slate.title, port: slate.port ?? null })),
    };
  }

  async portReservations(): Promise<DurabilityReservation[]> {
    const reservations = await listPortReservations(this.ctx);

    return [...reservations.entries()].map(([port, reservation]) => ({
      port,
      owner: reservation.owner,
      capability: reservation.capability,
    }));
  }

  /** The workspace executor's terminal rows, as a reload reads them. */
  async executorRows(): Promise<Array<{ stdout: string; stdout_len: number }>> {
    return (await this.getExecutorOutput('workspace')).map(({ stdout, stdout_len }) => ({ stdout, stdout_len }));
  }

  /** Nimbus's pending tasks as this object's Lifecycle holds them, and the alarm that wakes the next. */
  async pendingNimbusTasks(): Promise<{ tasks: Array<{ id: string; time: number }>; alarm: number | null }> {
    const tasks = this.ctx.storage.sql.exec<{ id: string; time: number }>(
      "SELECT id, time FROM cf_agents_jobs WHERE capability = 'nimbus-tasks' ORDER BY time",
    ).toArray();

    return { tasks, alarm: await this.ctx.storage.getAlarm() };
  }

  /** One program through this workspace's production `eval` tool, in Build mode; its answer as JSON. */
  async runProgram(code: string): Promise<string> {
    const factory = createCodemodeToolFactory({
      launch: (online) => codemodeLauncher({ kinuNode: true, egress: online ? { workspace: null, actor: null } : null }), workspace: this.name,
    });

    const unreached = (): never => { throw new Error('this probe reaches no memory, files or tasks'); };

    const eval_ = factory.toolFor(codemodeSurface(this.rt, {}), {
      reach: narrowToolSurface(undefined),
      // As a confined copy's programs run: state, tables, web and executors, with no memory, files or tasks to reach.
      namespaces: (executor) => actorNamespaces({
        executors: () => this.rt.executionRouter?.getProviders() ?? [],
        web: {
          search: createDefaultWebSearchProvider({ fetch, browser: { missing: 'this probe reaches no Browser Run' } }), files: this.rt.storage,
          browser: { sessions: { open: async () => { throw new Error('this probe opens no browser'); }, list: async () => [], close: async () => {} }, prelude: BROWSER_PRELUDE },
        },
        memory: unreached, files: unreached, tasks: unreached,
        db: this.stores.appData, programState: this.rt.actor.programState, agents: null, self: null,
      }, SURFACE_POLICY.confined, { executor }),
    });

    const execute = toolsInWorkMode('build', { eval: eval_ }).eval?.execute;

    if (execute === undefined) throw new Error('No callable eval tool');

    return JSON.stringify(await execute({ code }, { toolCallId: 'slate-program', messages: [], context: undefined }) ?? null);
  }

  /** One call of this workspace's production `shell` tool, as a turn makes it; the answer the model reads. */
  async runShell(args: { command: string; cwd?: string; name?: string }): Promise<string> {
    const conversations = { search: async () => [], scroll: async () => null, browse: async () => [] };
    const execute = buildBuiltinTools({ rt: this.rt, conversations }).shell?.execute;

    if (execute === undefined) throw new Error('No callable shell tool');

    // A failed command throws, and a turn hands the model its message: that is its answer too.
    try {
      return JSON.stringify(await execute(args, { toolCallId: 'probe-shell', messages: [], context: undefined }) ?? null);
    } catch (error) {
      return JSON.stringify(renderThrownChain({ cause: error }));
    }
  }

  /**
   * What the next activation starts from when the platform evicts this one but keeps its facets: a new
   * `ctx` over the same storage and facets, so state kept per activation (Nimbus keys its own on `ctx`)
   * starts empty, and the hosted workspace and slate host built again, while `ctx.facets` still holds
   * the running application. Neither is destroyed, since destroying would end the facets, which is not
   * what the platform does.
   */
  forgetActivation(): void {
    const ended = this.ctx;

    this.ctx = new Proxy(ended, {
      get: (target, key: keyof typeof ended) => {
        const value = target[key];

        return value instanceof Function ? value.bind(target) : value;
      },
    });
    Reflect.set(this, '_workspace', undefined);
    Reflect.set(this, '_slates', undefined);
  }
}

export { ObservedOrchestrator as OrchestratorAgent };

// Exported as `src/server.ts` does: the hosted runtime refuses a worker whose `ctx.exports` lacks
// it.




/** `slateAs` is absent on purpose: `Rpc.Result` over its recursive `JsonValue` is TS2589; the probe
 *  reaches it through `workspaceOwner()`, as production's actor does. */
type SlateTarget = Pick<Fetcher, 'fetch'> & Pick<ProductionOrchestrator,
  'claimOwner' | 'writeExecutorFileChunk' | 'executeInExecutor' | 'routeSlateShare'> & Pick<ObservedOrchestrator,
  'portReservations' | 'runProgram' | 'forgetActivation' | 'pendingNimbusTasks' | 'executorRows' | 'runShell' | 'previewTabs' | 'failingSlates'>;

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

/**
 * A crafted tool that lists its runner's browsers, writes who ran it, and reads the file back. A member it holds none
 * of throws; a refused one answers its refusal as the value, as every member does for a program to branch on.
 */
const HELPER = [
  'async (input) => {',
  '  let browsers = null;',
  '  try { browsers = await web.browsers({}); } catch {}',
  '  const wrote = await workspace.writeFile("ran-by.txt", input.who);',
  '  return { browsers, wrote, read: await workspace.readFile("ran-by.txt") };',
  '}',
].join('\n');

/** A slate whose class runs the crafted tool: as its `run` method for a program, as its page for a visitor. */
const RUNNER = [
  'import { SlateObject } from "kinu:slate";',
  'export class Slate extends SlateObject {',
  '  async run(who) { return await this.env.workspace.tools.helper({ who }); }',
  '  async fetch() { return Response.json(await this.env.workspace.tools.helper({ who: "viewer" })); }',
  '}',
].join('\n');

const SharedValueSchema = v.object({ share: v.object({ handle: v.string() }) });

const LILT_GOOD = 'export default function App() { return <p data-words>lilt-good</p>; }';

/** Two elements side by side with no parent: the compile error the owner's Lilt hit. */
const LILT_BROKEN = 'export default function App() {\n  return <p>lilt</p>\n  <p>broken</p>;\n}';

const LILT_FIXED = 'export default function App() { return <><p data-words>lilt-fixed</p></>; }';

/** One step of the build flow, as the agent and the user each see it. */
interface SlateBuildSeen {
  readonly wrote: string | null;
  readonly preview: string;
  readonly serves: string | null;
  readonly told: string[];
}

const GraphValueSchema = v.object({
  namespaces: v.array(v.object({ namespace: v.string(), members: v.array(v.object({ member: v.string(), impact: v.string() })) })),
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
    const root = `/slates/${input.id}`;

    await this.writeSlateFile(target, `${root}/package.json`, JSON.stringify({
      main: 'server.ts',
      slate: input.preferredPort === undefined ? { title: input.id } : { title: input.id, port: input.preferredPort },
    }));
    await this.writeSlateFile(target, `${root}/server.ts`, [
      'import { SlateObject } from "kinu:slate";',
      // One token per evaluation of this module: a restarted application answers with a new one.
      'let evaluation;',
      'export class Slate extends SlateObject {',
      '  async ping() {',
      '    this.sql.exec("CREATE TABLE IF NOT EXISTS probe (n INTEGER NOT NULL)");',
      '    this.sql.exec("INSERT INTO probe (n) VALUES (1)");',
      '    const rows = this.sql.exec("SELECT count(*) AS n FROM probe").toArray()[0].n;',
      '    return { rows };',
      '  }',
      '  async evaluation() { evaluation ??= crypto.randomUUID(); return evaluation; }',
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
    const root = '/slates/whiteboard';

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

  /**
   * The owner's program makes the crafted tool `helper`, then runs it through the `runner` slate's class; the slate is
   * shared granting the tool alone, and a consented viewer opens its page, which runs the tool too.
   */
  async craftedToolUnderShare(input: { workspace: string; owner: string }): Promise<{ owner: string; reached: string[]; viewer: string }> {
    const target = await this.workspaceTarget(input.workspace);

    await this.claimWorkspace(target, input.workspace, input.owner);
    await target.runProgram(`await workspace.createTool("helper", "Lists browsers and writes who ran it", ${JSON.stringify(HELPER)}); return null;`);
    await this.writeSlateFile(target, '/slates/runner/package.json', JSON.stringify({ main: 'server.ts', slate: { title: 'Runner' } }));
    await this.writeSlateFile(target, '/slates/runner/server.ts', RUNNER);
    const owner = await target.runProgram('return await workspace.slates.runner.run("owner");');
    const owned = workspaceOwner(this.env, input.workspace);
    const graph = await owned.slateAs(ROOT_SLATE_CALLER, { op: 'graph', id: 'runner' });

    if (!graph.ok) throw new Error(`slate graph refused: ${graph.reason}: ${graph.error}`);

    const reached = v.parse(GraphValueSchema, graph.value).namespaces
      .flatMap((row) => row.members.map((member) => `${row.namespace}.${member.member}:${member.impact}`));

    const shared = await owned.slateAs(ROOT_SLATE_CALLER, {
      op: 'share', id: 'runner', visibility: 'public', approved: [{ slate: 'runner', namespace: 'tools', member: 'helper' }],
    });

    if (!shared.ok) throw new Error(`slate share refused: ${shared.reason}: ${shared.error}`);
    const { handle } = v.parse(SharedValueSchema, shared.value).share;
    const page = await target.routeSlateShare(handle, { userId: null, source: 'probe-viewer', consented: true }, new Request('https://share.invalid/'), '/');

    return { owner, reached, viewer: await page.text() };
  }

  async previewTabs(workspace: string): Promise<{ ports: { port: number; name: string | null }[]; slates: { id: string; title: string; port: number | null }[] }> {
    return (await this.workspaceTarget(workspace)).previewTabs();
  }

  /**
   * The agent writes the `lilt` slate through its own `workspace.writeFile`, reading each file first as an agent must:
   * `client.tsx` that builds, then one that does not. `phase` names which: `good`, `broken`, then `fixed`; each answers
   * the write's own answer, what the preview says, what its client bundle serves, and what the next step is told.
   */
  async slateBuild(input: { workspace: string; owner: string; phase: 'good' | 'broken' | 'served' | 'fixed' }): Promise<SlateBuildSeen> {
    const target = await this.workspaceTarget(input.workspace);

    if (input.phase === 'good') {
      await this.claimWorkspace(target, input.workspace, input.owner);
      await target.runProgram(`return await workspace.writeFile("/slates/lilt/package.json", ${JSON.stringify(JSON.stringify({ browser: 'client.tsx', slate: { title: 'Lilt' } }))});`);
    }

    const source = { good: LILT_GOOD, broken: LILT_BROKEN, fixed: LILT_FIXED, served: null }[input.phase];

    const wrote = source === null ? null : await target.runProgram([
      'const path = "/slates/lilt/client.tsx";',
      'if (await workspace.exists(path)) await workspace.readFile(path);',
      `return await workspace.writeFile(path, ${JSON.stringify(source)});`,
    ].join('\n'));

    const preview = await workspaceOwner(this.env, input.workspace).slateAs(ROOT_SLATE_CALLER, { op: 'preview', id: 'lilt' });
    const shown = preview.ok ? v.parse(v.object({ url: v.string(), broken: v.optional(v.string()) }), preview.value) : null;
    const client = shown === null ? null : await this.drivePreview(new URL('/__kinu/client.js', shown.url).href);

    return {
      wrote, preview: shown === null ? `refused: ${preview.ok ? '' : preview.error}` : shown.broken ?? 'builds',
      serves: client === null ? null : ['lilt-good', 'lilt-fixed'].find((word) => client.body.includes(word)) ?? 'neither',
      told: [...await target.failingSlates()],
    };
  }

  async portReservations(workspace: string): Promise<DurabilityReservation[]> {
    return (await this.workspaceTarget(workspace)).portReservations();
  }

  async forgetActivation(workspace: string): Promise<void> {
    await (await this.workspaceTarget(workspace)).forgetActivation();
  }

  async pendingNimbusTasks(workspace: string): Promise<{ tasks: Array<{ id: string; time: number }>; alarm: number | null }> {
    return (await this.workspaceTarget(workspace)).pendingNimbusTasks();
  }

  async executorOutputs(workspace: string): Promise<Array<{ stdout: string; stdout_len: number }>> {
    return (await this.workspaceTarget(workspace)).executorRows();
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

  /** A stand-in for the picture a capture stores. */
  async putPicture(workspace: string, slate: string, digest: string): Promise<void> {
    await this.env.SLATE_PICTURES?.put(pictureKey(workspace, slate, digest), new Uint8Array([1]), { httpMetadata: { contentType: 'image/webp' } });
  }

  async pictureKeys(workspace: string): Promise<string[]> {
    return (await this.env.SLATE_PICTURES?.list({ prefix: picturePrefix(workspace) }))?.objects.map((object) => object.key) ?? [];
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

  /** A pane attaching after another left: what it is shown before its terminal says it is ready. */
  async reattachTerminal(workspace: string): Promise<{ frames: string[]; output: string }> {
    const socket = await this.terminalSocket(workspace);
    const frames: string[] = [];
    let output = '';

    const ready = new Promise<void>((resolve) => {
      socket.addEventListener('message', (event) => {
        const parsed = v.safeParse(WorkspaceTerminalOutputSchema, JSON.parse(String(event.data)));

        frames.push(parsed.success ? parsed.output.type : 'other');

        if (parsed.success && parsed.output.type === 'output') output += parsed.output.data;

        if (parsed.success && parsed.output.type === 'ready') resolve();
      });
    });

    try {
      await ready;

      return { frames, output };
    } finally {
      socket.close(1000, 'reattach read');
    }
  }

  /** Sends `frame` on a fresh terminal socket and answers how the workspace closed it. */
  async refusedTerminalFrame(workspace: string, frame: string): Promise<{ code: number; reason: string }> {
    const socket = await this.terminalSocket(workspace);

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.addEventListener('close', (event) => { resolve({ code: event.code, reason: event.reason }); });
    });

    socket.send(frame);

    return await closed;
  }

  private async terminalSocket(workspace: string): Promise<WebSocket> {
    const target = await this.workspaceTarget(workspace);

    const response = await target.fetch(new Request(`https://workspace.invalid${WORKSPACE_TERMINAL_PATH}`, {
      headers: { Upgrade: 'websocket' },
    }));

    const socket = response.webSocket;

    if (socket === null || socket === undefined) throw new Error(`upgrade refused: ${response.status} ${await response.text()}`);
    socket.accept();

    return socket;
  }

  /** Each call of the workspace's `shell` tool in order, as the model read its answer. */
  async shellCalls(workspace: string, owner: string, calls: Array<{ command: string; cwd?: string; name?: string }>): Promise<string[]> {
    const target = await this.workspaceTarget(workspace);
    const answers: string[] = [];

    await this.claimWorkspace(target, workspace, owner);

    for (const call of calls) answers.push(await target.runShell(call));

    return answers;
  }

  async readWorkspaceFile(workspace: string, path: string): Promise<string | null> {
    const target = await this.workspaceTarget(workspace);
    const answer = await target.executeInExecutor('workspace', `cat ${path}`);

    if ('error' in answer || answer.exitCode !== 0) return null;

    return answer.stdout;
  }
}
