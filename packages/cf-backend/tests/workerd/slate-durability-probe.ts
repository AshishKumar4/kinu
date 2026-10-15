/**
 * Does a durable Nimbus application answer its own URL after its hosting object is aborted?
 * Everything below `handleNimbusPreviewHostRequest` is production code; the probe adds only the
 * trigger and the observation, and for the keep-alive its isolate's clock.
 */
import { Agent, getAgentByName, type AgentContext } from 'agents';
import * as v from 'valibot';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { ORCHESTRATOR_RPC_SURFACE } from '../../src/rpc-surface';
import { sealRpcSurface } from '@nimbus-sh/fabric/sealed.js';
import { WORKSPACE_TERMINAL_PATH, WorkspaceTerminalOutputSchema, buildBuiltinTools, codemodeSurface, createDefaultWebSearchProvider, toolsInWorkMode } from '@kinu.run/core';
import { narrowToolSurface } from '@kinu.run/core';
import { listPortReservations } from '@nimbus-sh/worker/port-capability';
import { cookieForTicket, frameTicket, roomHandle, roomObjectName, ROOT_SLATE_CALLER } from '@kinu.run/core/slates';
import { handleSlateRoomHostRequest } from '../../src/slates/room-routes';
import { sealedPart } from '../../src/slates/room-parts';
import { ROOM_PERSON_HEADER, type SlateRoom } from '../../src/slates/room';
import { GALLERY_OBJECT } from '../../src/gallery/gallery-do';
import { pictureKey, picturePrefix } from '../../src/slates/pictures';
import { renderThrownChain } from '@kinu.run/core/obs';
import { ownerCaller } from '@kinu.run/core';
import { workspaceOwner } from '../../src/workspace-owner-rpc';
import { createCodemodeToolFactory } from '../../src/codemode-tool';
import { BROWSER_PRELUDE } from '../../src/browser-prelude';
import { actorNamespaces, SURFACE_POLICY } from '@kinu.run/core';
import { codemodeLauncher } from '../../src/codemode-sandbox';
import { SharedSlateFilesSchema, type JsonValue, type SlateCallResult } from '@kinu.run/core';
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

// The production `CodemodeEgress` (through `export *` above): a slate's shared server fetches through the real policy,
// over this worker's fake far side (vitest.config.ts `egressFake`).

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
    Reflect.deleteProperty(this, 'wakeOnce');
    sealRpcSurface(this, [
      ...ORCHESTRATOR_RPC_SURFACE, 'portReservations', 'runProgram', 'forgetActivation', 'pendingNimbusTasks', 'executorRows', 'runShell', 'previewTabs',
      'failingSlates', 'wakeOnce',
    ]);
  }

  /** The platform's alarm delivery, which runs whichever of Nimbus's tasks are due. */
  async wakeOnce(): Promise<void> {
    await this.alarm();
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
      launch: (online) => codemodeLauncher({ kinuNode: true, egress: online ? { workspace: null, actor: null, asOwner: true } : null }), workspace: this.name,
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
    Reflect.set(this, '_slateHosting', undefined);
  }
}

export { ObservedOrchestrator as OrchestratorAgent };

// Exported as `src/server.ts` does: the hosted runtime refuses a worker whose `ctx.exports` lacks
// it.




/** `slateAs` is absent on purpose: `Rpc.Result` over its recursive `JsonValue` is TS2589; the probe
 *  reaches it through `workspaceOwner()`, as production's actor does. */
type SlateTarget = Pick<Fetcher, 'fetch'> & Pick<ProductionOrchestrator,
  'claimOwner' | 'writeExecutorFileChunk' | 'executeInExecutor'> & Pick<ObservedOrchestrator,
  'portReservations' | 'runProgram' | 'forgetActivation' | 'pendingNimbusTasks' | 'executorRows' | 'runShell' | 'previewTabs' | 'failingSlates'
  | 'wakeOnce'>;

/** `ObservedOrchestrator` is installed under the `OrchestratorAgent` name, so every stub carries
 *  the fixture read. */
interface ProbeRootEnv extends Omit<ProbeEnv, 'OrchestratorAgent'> {
  readonly OrchestratorAgent: DurableObjectNamespace<ObservedOrchestrator>;
}

const PreviewValueSchema = v.object({ url: v.string() });

/** The end of a shell prompt: its OSC 133;B semantic mark (FinalTerm), which the runtime shell writes after each. */
const PROMPT_END_MARK = '\u001b]133;B\u0007';

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


const LILT_GOOD = 'export default function App() { return <p data-words>lilt-good</p>; }';

/** Two elements side by side with no parent: the compile error the owner's Lilt hit. */
const LILT_BROKEN = 'export default function App() {\n  return <p>lilt</p>\n  <p>broken</p>;\n}';

const LILT_FIXED = 'export default function App() { return <><p data-words>lilt-fixed</p></>; }';

/** A slate's preview before and after a repair of what it imports (`builds`, or why not), and what it says after. */
interface SlateRepairSeen {
  readonly before: string;
  readonly after: string;
  readonly says: string;
}

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
/** Fetches what it is asked to; `confined` reads the owner's workspace first, so the room runs it confined. */
const EGRESS_SLATE = [
  'import { SlateObject } from "kinu:slate";',
  'async function fetched(target, redirect) {',
  '  try {',
  '    const response = await fetch(target, { redirect });',
  '    return { status: response.status, location: response.headers.get("location"), body: await response.text() };',
  '  } catch (cause) { return { error: String(cause) }; }',
  '}',
  'export class Slate extends SlateObject {',
  '  async shared(target, redirect) { return fetched(target, redirect); }',
  '  async confined(target, redirect) {',
  '    await this.env.workspace.readFile("/slates/network/package.json");',
  '    return fetched(target, redirect);',
  '  }',
  '}',
].join('\n');

/**
 * Keeps what each run was given in its module scope, and reads the workspace through its env: the owner's own code, so
 * its first call grants that read and every call runs confined. A stub sealed for another run is refused by the room, so
 * a read that answers came through this run's own.
 */
const ISOLATED_SLATE = [
  'import { SlateObject } from "kinu:slate";',
  'const seen = [];',
  'export class Slate extends SlateObject {',
  '  async probe(tag) {',
  '    seen.push(tag);',
  '    const read = await this.env.workspace.readFile("/slates/isolated/package.json");',
  '    return { seen: [...seen], read: typeof read };',
  '  }',
  '}',
].join('\n');

/** A page's call answered through its room: a value, a part, or a refusal (`room.ts`). */
const PageCallAnswer = v.union([
  v.object({ ok: v.literal(true), value: v.union([v.object({ value: v.unknown() }), v.object({ part: v.unknown() })]) }),
  v.object({ ok: v.literal(false), error: v.string() }),
]);

/** The host-only cookie a slate's host reads (`passes.ts`). */
const ROOM_COOKIE = '__Host-kinu_room';

/** A probe account's email, as its room names it. */
function probeEmail(owner: string): string {
  return `${owner}@probe.local`;
}

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
    // Every slate runs in its room, which names its owner by email.
    await userDO.ensureProfile(caller, probeEmail(owner));
    this.ctx.storage.kv.put(`owner:${workspace}`, probeEmail(owner));
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

    return { url: v.parse(PreviewValueSchema, preview.value).url };
  }

  /** The agent changes what a served slate's page says, reading its server first as an agent must; the next call builds it. */
  async rebuildSlate(input: { workspace: string; id: string; body: string }): Promise<void> {
    const path = `/slates/${input.id}/server.ts`;

    await (await this.workspaceTarget(input.workspace)).runProgram([
      `const source = await workspace.readFile(${JSON.stringify(path)});`,
      `await workspace.writeFile(${JSON.stringify(path)}, source.replace(/new Response\\(.*\\)/u, ${JSON.stringify(`new Response(${JSON.stringify(input.body)})`)}));`,
      'return null;',
    ].join('\n'));
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
   * A slate whose methods fetch: from its shared server as they are, and from a confined run once a call has read the
   * owner's workspace. Each answer is what the slate's own fetch saw.
   */
  async egressSlate(input: { workspace: string; owner: string; calls: readonly { method: 'shared' | 'confined'; target: string; redirect?: RequestRedirect }[] }): Promise<string[]> {
    const target = await this.workspaceTarget(input.workspace);

    await this.claimWorkspace(target, input.workspace, input.owner);
    await this.writeSlateFile(target, '/slates/network/package.json', JSON.stringify({ main: 'server.ts', slate: { title: 'Network' } }));
    await this.writeSlateFile(target, '/slates/network/server.ts', EGRESS_SLATE);
    const owned = workspaceOwner(this.env, input.workspace);
    const answers: string[] = [];

    for (const call of input.calls) {
      const answered = await owned.slateAs(ROOT_SLATE_CALLER, { op: 'call', id: 'network', method: call.method, args: [call.target, call.redirect ?? 'follow'] });

      answers.push(JSON.stringify(answered.ok ? answered.value : { error: answered.error }));
    }

    return answers;
  }

  /**
   * Confined runs of one function, by one person, holding one grant: two in turn, then two at once, each with its own
   * argument. What each saw of the module's state, and whether its read through its own stub answered.
   */
  async isolatedRuns(input: { workspace: string; owner: string }): Promise<string[]> {
    const target = await this.workspaceTarget(input.workspace);

    await this.claimWorkspace(target, input.workspace, input.owner);
    await this.writeSlateFile(target, '/slates/isolated/package.json', JSON.stringify({ main: 'server.ts', slate: { title: 'Isolated' } }));
    await this.writeSlateFile(target, '/slates/isolated/server.ts', ISOLATED_SLATE);
    const owned = workspaceOwner(this.env, input.workspace);

    const probe = async (tag: string): Promise<string> => {
      const answered = await owned.slateAs(ROOT_SLATE_CALLER, { op: 'call', id: 'isolated', method: 'probe', args: [tag] });

      return JSON.stringify(answered.ok ? answered.value : { error: answered.error });
    };

    const consecutive = [await probe('first'), await probe('second')];

    return [...consecutive, ...await Promise.all([probe('third'), probe('fourth')])];
  }

  /** A part's sealed content, as the app's origin serves it: its headers and its body. */
  async sealed(value: JsonValue | null): Promise<{ csp: string | null; type: string | null; body: string }> {
    const response = await sealedPart(value);

    return { csp: response.headers.get('content-security-policy'), type: response.headers.get('content-type'), body: await response.text() };
  }

  /** A Plan caller's call of a slate method: refused before anything runs. */
  async planCall(input: { workspace: string; owner: string }): Promise<{ ok: boolean; reason: string | null }> {
    const target = await this.workspaceTarget(input.workspace);

    await this.claimWorkspace(target, input.workspace, input.owner);
    const answered = await workspaceOwner(this.env, input.workspace).slateAs({ ...ROOT_SLATE_CALLER, workMode: 'plan' }, { op: 'call', id: 'network', method: 'shared' });

    return { ok: answered.ok, reason: answered.ok ? null : answered.reason };
  }

  /** The owner's program makes the crafted tool `helper`, then runs it through the `runner` slate's class. */
  async craftedToolInSlate(input: { workspace: string; owner: string }): Promise<{ owner: string; reached: string[] }> {
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

    return { owner, reached };
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
    const client = shown === null ? null : await this.drivePreview(shown.url, '/__kinu/client.js');

    return {
      wrote, preview: shown === null ? `refused: ${preview.ok ? '' : preview.error}` : shown.broken ?? 'builds',
      serves: client === null ? null : ['lilt-good', 'lilt-fixed'].find((word) => client.body.includes(word)) ?? 'neither',
      told: [...await target.failingSlates()],
    };
  }

  /**
   * A slate whose class imports a workspace file outside its own tree, `/home/main/word.ts`: writes that file to say
   * `word`, through the workspace as the agent writes, then asks the running slate what it says.
   */
  async slateImport(input: { workspace: string; owner: string; word: string; first: boolean }): Promise<string> {
    const target = await this.workspaceTarget(input.workspace);

    if (input.first) {
      await this.claimWorkspace(target, input.workspace, input.owner);
      await this.writeSlateFile(target, '/slates/imports/package.json', JSON.stringify({ main: 'server.ts', slate: { title: 'Imports' } }));
      await this.writeSlateFile(target, '/slates/imports/server.ts', [
        'import { SlateObject } from "kinu:slate";',
        'import { word } from "/home/main/word.ts";',
        'export class Slate extends SlateObject {',
        '  async word() { return word; }',
        '}',
      ].join('\n'));
    }

    await target.runProgram([
      'const path = "/home/main/word.ts";',
      'if (await workspace.exists(path)) await workspace.readFile(path);',
      `return await workspace.writeFile(path, ${JSON.stringify(`export const word = ${JSON.stringify(input.word)};\n`)});`,
    ].join('\n'));

    const called = await workspaceOwner(this.env, input.workspace).slateAs(ROOT_SLATE_CALLER, { op: 'call', id: 'imports', method: 'word' });

    return called.ok ? v.parse(v.string(), called.value) : `refused: ${called.error}`;
  }

  /**
   * A slate whose class imports `wordpkg` through `/home/main/user.ts`: the package's package.json `exports` names
   * `entry`, one of two files that each export a different word. Answers the word the running slate says.
   */
  async slateExports(input: { workspace: string; owner: string; entry: 'a.js' | 'b.js'; first: boolean }): Promise<string> {
    const target = await this.workspaceTarget(input.workspace);
    const pkg = '/home/main/node_modules/wordpkg';

    const write = (path: string, text: string) => target.runProgram([
      `const path = ${JSON.stringify(path)};`,
      'if (await workspace.exists(path)) await workspace.readFile(path);',
      `return await workspace.writeFile(path, ${JSON.stringify(text)});`,
    ].join('\n'));

    if (input.first) {
      await this.claimWorkspace(target, input.workspace, input.owner);
      await write(`${pkg}/a.js`, 'export const word = "alpha";\n');
      await write(`${pkg}/b.js`, 'export const word = "beta";\n');
      await write('/home/main/user.ts', 'export { word } from "wordpkg";\n');
      await this.writeSlateFile(target, '/slates/exports/package.json', JSON.stringify({ main: 'server.ts', slate: { title: 'Exports' } }));
      await this.writeSlateFile(target, '/slates/exports/server.ts', [
        'import { SlateObject } from "kinu:slate";',
        'import { word } from "/home/main/user.ts";',
        'export class Slate extends SlateObject {',
        '  async word() { return word; }',
        '}',
      ].join('\n'));
    }

    await write(`${pkg}/package.json`, JSON.stringify({ name: 'wordpkg', type: 'module', exports: `./${input.entry}` }));
    const called = await workspaceOwner(this.env, input.workspace).slateAs(ROOT_SLATE_CALLER, { op: 'call', id: 'exports', method: 'word' });

    return called.ok ? v.parse(v.string(), called.value) : `refused: ${called.error}`;
  }

  /**
   * A slate whose class imports `imports`, which `setup`, a shell command, leaves unbuildable, and `repair`, another,
   * mends. Answers the preview after each, and what the slate says.
   */
  async slateRepair(input: { workspace: string; owner: string; id: string; imports: string; setup: string; repair: string }): Promise<SlateRepairSeen> {
    const target = await this.workspaceTarget(input.workspace);
    const owned = workspaceOwner(this.env, input.workspace);

    const previewed = async () => {
      const preview = await owned.slateAs(ROOT_SLATE_CALLER, { op: 'preview', id: input.id });

      return preview.ok ? 'builds' : preview.reason;
    };

    const shell = async (command: string) => {
      const ran = await this.runInWorkspace(input.workspace, command);

      if (ran.exitCode !== 0) throw new Error(`${command}: exit ${String(ran.exitCode)}: ${ran.stdout}`);
    };

    await this.claimWorkspace(target, input.workspace, input.owner);
    await this.writeSlateFile(target, `/slates/${input.id}/package.json`, JSON.stringify({ main: 'server.ts', slate: { title: input.id } }));
    await this.writeSlateFile(target, `/slates/${input.id}/server.ts`, [
      'import { SlateObject } from "kinu:slate";',
      `import { word } from ${JSON.stringify(input.imports)};`,
      'export class Slate extends SlateObject {',
      '  async word() { return word; }',
      '}',
    ].join('\n'));
    await shell(input.setup);
    const before = await previewed();

    await shell(input.repair);
    const after = await previewed();
    const called = await owned.slateAs(ROOT_SLATE_CALLER, { op: 'call', id: input.id, method: 'word' });

    return { before, after, says: called.ok ? v.parse(v.string(), called.value) : `refused: ${called.error}` };
  }



  async pendingNimbusTasks(workspace: string): Promise<{ tasks: Array<{ id: string; time: number }>; alarm: number | null }> {
    return (await this.workspaceTarget(workspace)).pendingNimbusTasks();
  }

  async executorOutputs(workspace: string): Promise<Array<{ stdout: string; stdout_len: number }>> {
    return (await this.workspaceTarget(workspace)).executorRows();
  }

  /** The room a frame address names, `/api/rooms/<workspace>/<slate>/frame`. */
  private roomOf(url: string) {
    const [, , , workspace = '', slate = ''] = new URL(url).pathname.split('/').map((part) => decodeURIComponent(part));
    const owner = this.ctx.storage.kv.get(`owner:${workspace}`);

    return {
      workspace, slate, owner: typeof owner === 'string' ? owner : null,
      stub: this.env.SLATE_ROOM.get(this.env.SLATE_ROOM.idFromName(roomObjectName(workspace, roomHandle(workspace, slate)))),
    };
  }

  /** `email` entering the slate's own host as the app's frame route sends them: their ticket, then the host's cookie. */
  private async enter(url: string, email: string | null): Promise<{ readonly host: string; readonly cookie: string } | { readonly refused: number }> {
    const entered = await this.roomOf(url).stub.ticketFor(email === null ? null : { email, name: email }, null);

    if (entered === null) return { refused: email === null ? 401 : 403 };
    const exchange = await handleSlateRoomHostRequest(new Request(entered), this.env);
    const cookie = exchange?.headers.get('set-cookie')?.split(';')[0];

    if (cookie === undefined) throw new Error(`the slate's host set no cookie for ${entered}`);

    return { host: new URL(entered).origin, cookie };
  }

  /** The owner's page, or `path` on the slate's own host, as the owner's frame shows it. */
  async drivePreview(url: string, path = '/'): Promise<PreviewAnswer> {
    const entered = await this.enter(url, this.roomOf(url).owner);

    if ('refused' in entered) return { status: entered.refused, body: '' };
    const response = await handleSlateRoomHostRequest(new Request(`${entered.host}${path}`, { headers: { cookie: entered.cookie } }), this.env);

    if (response === null) throw new Error(`the slate's host declined ${entered.host}`);

    return { status: response.status, body: await response.text() };
  }

  /** Someone who holds the slate's host and nothing else: no ticket, no cookie. */
  async visitPreview(url: string, headers: Record<string, string>): Promise<PreviewAnswer & { location: string | null }> {
    const entered = await this.enter(url, this.roomOf(url).owner);

    if ('refused' in entered) throw new Error(`the owner could not enter ${url}`);
    const response = await handleSlateRoomHostRequest(new Request(`${entered.host}/`, { headers }), this.env);

    if (response === null) throw new Error(`the slate's host declined ${entered.host}`);

    return { status: response.status, body: await response.text(), location: response.headers.get('location') };
  }

  /** `userId`'s account opening the slate's frame: the room says whether they may, and their page if so. */
  async visitPreviewAs(url: string, userId: string): Promise<PreviewAnswer & { entry: number }> {
    const entered = await this.enter(url, probeEmail(userId));

    if ('refused' in entered) return { entry: entered.refused, status: entered.refused, body: '' };
    const page = await handleSlateRoomHostRequest(new Request(`${entered.host}/`, { headers: { cookie: entered.cookie } }), this.env);

    if (page === null) throw new Error(`the slate's host declined ${entered.host}`);

    return { entry: 303, status: page.status, body: await page.text() };
  }

  /** A well-signed cookie naming `userId` as a member, as if they once were: the room asks again and finds no such session. */
  async visitPreviewWithCookieOf(url: string, userId: string): Promise<PreviewAnswer> {
    const owner = await this.enter(url, this.roomOf(url).owner);

    if ('refused' in owner) throw new Error(`the owner could not enter ${url}`);
    const { workspace, slate } = this.roomOf(url);
    const room = { workspace, handle: roomHandle(workspace, slate) };
    const ticket = await frameTicket(this.env, room, { email: probeEmail(userId), access: { kind: 'member', gen: 0 } });
    const cookie = ticket === null ? null : await cookieForTicket(this.env, room, ticket);

    if (cookie === null) throw new Error('no cookie could be signed');
    const response = await handleSlateRoomHostRequest(new Request(`${owner.host}/`, { headers: { cookie: `${ROOM_COOKIE}=${cookie}` } }), this.env);

    if (response === null) throw new Error(`the slate's host declined ${owner.host}`);

    return { status: response.status, body: await response.text() };
  }

  /** The owner's page calling the slate's `method` through its room, as `slate.method(...args)` on the page does. */
  async rpcPreview(url: string, method: string, args: JsonValue[] = []): Promise<RpcAnswer> {
    const entered = await this.enter(url, this.roomOf(url).owner);

    if ('refused' in entered) return { ok: false, error: `refused ${String(entered.refused)}` };

    const response = await handleSlateRoomHostRequest(new Request(`${entered.host}/__kinu/call`, {
      method: 'POST', headers: { cookie: entered.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ method, args }),
    }), this.env);

    const answer = v.parse(PageCallAnswer, await response?.json());

    if (!answer.ok) return { ok: false, error: answer.error };

    return 'value' in answer.value ? { ok: true, value: JSON.stringify(answer.value.value) } : { ok: false, error: 'answered a part' };
  }



  async wakeOnce(workspace: string): Promise<void> {
    await (await this.workspaceTarget(workspace)).wakeOnce();
  }

  async removeSlate(workspace: string, id: string): Promise<RemovedSlate> {
    const removed = await workspaceOwner(this.env, workspace).slateAs(ROOT_SLATE_CALLER, { op: 'remove', id });

    if (!removed.ok) return { ok: false, reason: removed.reason, error: removed.error };
    const value = v.parse(RemovedValueSchema, removed.value);

    return { ok: value.removed, port: value.port };
  }

  /** A slate that was never built, whose room its owner opened anyway (the frame route makes it): its link on. */
  async draftRoom(workspace: string, id: string): Promise<boolean> {
    const target = await this.workspaceTarget(workspace);

    await this.writeSlateFile(target, `/slates/${id}/package.json`, JSON.stringify({ main: 'server.ts', slate: { title: id } }));
    const made = await workspaceOwner(this.env, workspace).ensureSlateRoom(id);

    if (!made.ok) throw new Error(`room refused: ${made.reason}: ${made.error}`);
    const room = this.env.SLATE_ROOM.get(this.env.SLATE_ROOM.idFromName(roomObjectName(workspace, made.value.handle)));

    return await room.exists();
  }

  /**
   * The owner, over the room's own socket, turns the link on, lists the slate, adds someone and removes them: whether the
   * link the Gallery listed before the removal, and the one it lists after, still let a visitor in.
   */
  async rekeyedListing(workspace: string, id: string): Promise<{ moved: boolean; before: boolean; after: boolean }> {
    const { room, call, close } = await this.ownerSocket(workspace, id);
    const gallery = this.env.GALLERY.get(this.env.GALLERY.idFromName(GALLERY_OBJECT));
    const listed = async (): Promise<string | null> => (await gallery.slate(workspace, id, null))?.listing.url ?? null;

    await call({ op: 'setAudience', audience: 'anyone' });
    await call({ op: 'list', line: 'A probe slate', category: 'fun' });
    const before = await listed();

    await call({ op: 'invite', email: 'gone@probe.local', role: 'use' });
    await call({ op: 'remove', email: 'gone@probe.local' });
    const after = await listed();
    const opens = async (url: string | null): Promise<boolean> => url !== null && await room.ticketFor(null, new URL(url, 'https://app.test').searchParams.get('k')) !== null;

    close();

    return { moved: before !== after, before: await opens(before), after: await opens(after) };
  }

  /**
   * The owner of `workspace` adds the owner of `editorWorkspace` to edit slate `id`, and the editor's own workspace reads
   * and changes it through the room: what each step answered, and the page and author after the edit.
   */
  async editorEdits(input: { workspace: string; id: string; editorWorkspace: string; editor: string; server: string }): Promise<{
    before: string; files: string[]; edited: string; page: string | null; author: string | null; afterRemoval: string;
  }> {
    const target = await this.workspaceTarget(input.editorWorkspace);

    await this.claimWorkspace(target, input.editorWorkspace, input.editor);
    const email = probeEmail(input.editor);
    const editor = workspaceOwner(this.env, input.editorWorkspace);
    const shared = { workspace: input.workspace, slate: input.id };
    const said = (answer: SlateCallResult): string => (answer.ok ? 'ok' : answer.reason);
    const before = said(await editor.slateAs(ROOT_SLATE_CALLER, { op: 'sharedEdit', ...shared, files: { 'server.ts': input.server } }));
    const { room, call, close } = await this.ownerSocket(input.workspace, input.id);

    await call({ op: 'invite', email, role: 'edit' });
    const read = await editor.slateAs(ROOT_SLATE_CALLER, { op: 'sharedFiles', ...shared });
    const files = read.ok ? v.parse(SharedSlateFilesSchema, read.value).files.map((file) => file.path) : [];
    const edited = said(await editor.slateAs(ROOT_SLATE_CALLER, { op: 'sharedEdit', ...shared, files: { 'server.ts': input.server } }));
    const ticket = await room.ticketFor({ email: this.ctx.storage.kv.get<string>(`owner:${input.workspace}`) ?? '', name: 'owner' }, null);
    const page = ticket === null ? null : await this.pageAt(ticket);
    const author = await room.author();

    await call({ op: 'remove', email });
    const afterRemoval = said(await editor.slateAs(ROOT_SLATE_CALLER, { op: 'sharedEdit', ...shared, files: { 'server.ts': input.server } }));

    close();

    return { before, files, edited, page, author, afterRemoval };
  }

  /** A page of the slate's own host, entered with `entry`, as the owner's frame opens it. */
  private async pageAt(entry: string): Promise<string | null> {
    const exchange = await handleSlateRoomHostRequest(new Request(entry), this.env);
    const cookie = exchange?.headers.get('set-cookie')?.split(';')[0];

    if (cookie === undefined) return null;
    const page = await handleSlateRoomHostRequest(new Request(`${new URL(entry).origin}/`, { headers: { cookie } }), this.env);

    return page === null ? null : await page.text();
  }

  /** The room's own socket, as its owner holds it: each call answered in turn. */
  private async ownerSocket(workspace: string, id: string): Promise<{
    room: DurableObjectStub<SlateRoom>; call: (body: JsonValue) => Promise<void>; close: () => void;
  }> {
    const room = this.env.SLATE_ROOM.get(this.env.SLATE_ROOM.idFromName(roomObjectName(workspace, roomHandle(workspace, id))));
    const owner = this.ctx.storage.kv.get<string>(`owner:${workspace}`) ?? '';

    const upgraded = await room.fetch('https://room.internal/socket', {
      headers: { upgrade: 'websocket', [ROOM_PERSON_HEADER]: JSON.stringify({ email: owner, name: owner }) },
    });

    const socket = upgraded.webSocket;

    if (socket === null) throw new Error(`the room answered ${String(upgraded.status)}, not a socket`);
    socket.accept();
    const answers = new Map<number, () => void>();

    socket.addEventListener('message', (event) => {
      const frame = v.parse(v.object({ id: v.optional(v.number()) }), JSON.parse(String(event.data)));

      if (frame.id !== undefined) answers.get(frame.id)?.();
    });
    let next = 0;

    const call = async (body: JsonValue): Promise<void> => {
      const answered = Promise.withResolvers<undefined>();
      const callId = next++;

      answers.set(callId, () => { answered.resolve(undefined); });
      socket.send(JSON.stringify({ id: callId, call: body }));
      await answered.promise;
    };

    return { room, call, close: () => { socket.close(); } };
  }

  /** Whether `id`'s room still holds anything of the slate's. */
  async roomExists(workspace: string, id: string): Promise<boolean> {
    return await this.env.SLATE_ROOM.get(this.env.SLATE_ROOM.idFromName(roomObjectName(workspace, roomHandle(workspace, id)))).exists();
  }

  /** The owner's deletion of the whole workspace, as their account's roster runs it. */
  async deleteWorkspace(workspace: string, owner: string): Promise<void> {
    await this.env.UserDO.get(this.env.UserDO.idFromName(owner)).removeWorkspace(await ownerCaller(this.env), workspace, owner);
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

  /**
   * Types `line` on a fresh terminal socket and reads until `token` is printed and a prompt follows it (its OSC 133;B
   * end mark), so the shell has settled before the socket goes.
   */
  async typeToPrompt(workspace: string, line: string, token: string): Promise<string> {
    const socket = await this.terminalSocket(workspace);
    let output = '';

    const settled = new Promise<void>((resolve) => {
      socket.addEventListener('message', (event) => {
        const parsed = v.safeParse(WorkspaceTerminalOutputSchema, JSON.parse(String(event.data)));

        if (parsed.success && parsed.output.type === 'output') output += parsed.output.data;

        const at = output.indexOf(token);

        if (at >= 0 && output.indexOf(PROMPT_END_MARK, at) >= 0) resolve();
      });
    });

    try {
      socket.send(JSON.stringify({ type: 'input', data: `${line}\r` }));
      await settled;

      return output;
    } finally {
      socket.close(1000, 'typed');
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
