/**
 * The attacks of `lean/Kinu/Sharing/Attacks.lean`, driven end to end against a built room: real rooms, sockets, grants,
 * sealed bindings and confined runs, and the people's MCP servers faked at the one seam the room crosses to reach
 * them, their own account's `userMcp_toolDescriptors` and `userMcp_callTool`. Every tool call reaching an account is
 * logged, so each attack is judged by what reached whose account, and what each person was shown.
 */
import * as v from 'valibot';
import { RoomServerFrameSchema, type JsonObject, type JsonValue, type RoomView, type SlateSurfaceValue, type UserCaller } from '@kinu.run/core';
import type { SlateAiRoute } from '@kinu.run/core/slates';
import { roomHandle, roomObjectName } from '@kinu.run/core/slates';
import { UserDO as ProductionUserDO } from '../../src/user/user-do';
import type { McpToolCall, McpToolSurface } from '../../src/user/mcp-servers';
import { ROOM_PERSON_HEADER, type SlateRoom } from '../../src/slates/room';
import { accountIdFor } from '../../src/auth/store';

/** One tool of a person's MCP server; a GitHub preset's is the preset, and a tool that is not read-only is an effect. */
interface FakeTool {
  readonly server: string;
  readonly name: string;
  readonly readOnly?: true;
  readonly preset?: 'github';
}

/** What reached an account: whose, which tool, with what. */
export interface ReachedCall {
  readonly account: string;
  readonly tool: string;
  readonly args: JsonObject;
}

/** One isolate holds every object of this probe, so the fakes and their log are module state. */
const personas = new Map<string, { readonly email: string; readonly tools: readonly FakeTool[] }>();

const reached: ReachedCall[] = [];

export const GITHUB: readonly FakeTool[] = [
  { server: 'GitHub', name: 'list_pull_requests', readOnly: true, preset: 'github' },
  { server: 'GitHub', name: 'search_repositories', readOnly: true, preset: 'github' },
];

export const MAIL: readonly FakeTool[] = [{ server: 'Mail', name: 'send' }];

export const OPS: readonly FakeTool[] = [{ server: 'Ops', name: 'deploy' }];

/**
 * A person's account serves these tools, as their own MCP servers would: the account their email names, and the one
 * their workspace reaches them by when it is not that (a probe workspace's owner is addressed by its own name).
 */
export async function persona(env: Parameters<typeof accountIdFor>[0], email: string, tools: readonly FakeTool[], account?: string): Promise<void> {
  personas.set(await accountIdFor(env, email), { email, tools });

  if (account !== undefined) personas.set(account, { email, tools });
}

export function reachedCalls(): readonly ReachedCall[] {
  return [...reached];
}

/** What a repository holds: `secret` is private to whoever reads it. */
function answer(tool: string, args: JsonObject): JsonValue {
  if (tool === 'list_pull_requests') return [{ title: `pull request of ${JSON.stringify(args.owner)}/${JSON.stringify(args.repo)}`, secret: args.repo === 'secret' ? 'the-secret' : null }];

  if (tool === 'search_repositories') return { items: [{ full_name: typeof args.query === 'string' ? args.query.replace(/^repo:/u, '') : '' }] };

  return { done: true };
}

/** The production account object, its MCP servers faked for the people a test names; everyone else's are real. */
export class UserDO extends ProductionUserDO {
  override async userMcp_toolDescriptors(caller: UserCaller): Promise<McpToolSurface> {
    const faked = personas.get(this.name);

    if (faked === undefined) return await super.userMcp_toolDescriptors(caller);
    const hold = descriptorReads.get(faked.email);

    if (hold !== undefined) {
      descriptorReads.delete(faked.email);
      hold.reached.resolve(undefined);
      await hold.release.promise;
    }

    return {
      unavailable: [],
      descriptors: faked.tools.map((tool) => ({
        serverId: `${tool.server}-${this.name}`, serverName: tool.server, name: tool.name, toolKey: `${tool.server}__${tool.name}`,
        ...(tool.readOnly && { readOnly: true as const }), ...(tool.preset !== undefined && { presetId: tool.preset }),
      })),
    };
  }

  /** A faked person's own AI: the call is logged against their account, and answered as their model would. */
  override async slateAi(caller: UserCaller, request: { readonly workspace: string; readonly route: SlateAiRoute }): Promise<SlateSurfaceValue> {
    const faked = personas.get(this.name);

    if (faked === undefined) return await super.slateAi(caller, request);
    reached.push({ account: faked.email, tool: 'ai.run', args: { prompt: request.route.prompt } });

    return { text: `${faked.email}'s own model`, model: 'fake/own', tier: 'fast', usage: {} };
  }

  override async userMcp_callTool(caller: UserCaller, call: McpToolCall): Promise<string> {
    const faked = personas.get(this.name);

    if (faked === undefined) return await super.userMcp_callTool(caller, call);
    reached.push({ account: faked.email, tool: call.name, args: call.args });

    return JSON.stringify(answer(call.name, call.args));
  }
}

/** A person's next read of their own connections, held until the test lets it go. */
const descriptorReads = new Map<string, { readonly reached: ReturnType<typeof Promise.withResolvers<undefined>>; readonly release: ReturnType<typeof Promise.withResolvers<undefined>> }>();

/**
 * Holds `email`'s next read of their connections. A room reads them as it draws a part that asks that person for one,
 * on every broadcast: one held there is the seam between a run's admission and its worker's creation, so a test can put
 * an editor's publish between them, deterministically.
 */
export function holdNextConnectionsRead(email: string) {
  const hold = { reached: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>() };

  descriptorReads.set(email, hold);

  return { reached: hold.reached.promise, release: () => { hold.release.resolve(undefined); } };
}

/** A person's socket on a room: their calls answered in turn, and the latest view the room pushed them. */
export interface PersonSocket {
  call(body: JsonValue): Promise<JsonValue>;
  /** How many views the room has pushed so far: `view` after it waits for a later one. */
  mark(): number;
  /** The latest view pushed after the `since`-th that `holds`, or the next such; the test's deadline bounds the wait. */
  view(holds: (view: RoomView) => boolean, since?: number): Promise<RoomView>;
  close(): void;
}

export async function personSocket(env: { SLATE_ROOM: DurableObjectNamespace<SlateRoom> }, at: { workspace: string; slate: string }, email: string): Promise<PersonSocket> {
  const room = env.SLATE_ROOM.get(env.SLATE_ROOM.idFromName(roomObjectName(at.workspace, roomHandle(at.workspace, at.slate))));

  const upgraded = await room.fetch('https://room.internal/socket', {
    headers: { upgrade: 'websocket', [ROOM_PERSON_HEADER]: JSON.stringify({ email, name: email }) },
  });

  const socket = upgraded.webSocket;

  if (socket === null) throw new Error(`the room answered ${email} ${String(upgraded.status)}, not a socket`);
  socket.accept();
  const answers = new Map<number, (frame: JsonValue) => void>();
  let latest: RoomView | null = null;
  let pushed = 0;
  const waiting = new Set<() => void>();

  socket.addEventListener('message', (event) => {
    const raw: JsonValue = JSON.parse(String(event.data));
    const frame = v.parse(RoomServerFrameSchema, raw);

    if ('view' in frame) {
      latest = frame.view;
      pushed += 1;

      for (const wake of waiting) wake();
    } else if ('id' in frame) {
      answers.get(frame.id)?.(raw);
    }
  });
  let next = 0;

  return {
    call: async (body) => {
      const answered = Promise.withResolvers<JsonValue>();
      const id = next++;

      answers.set(id, answered.resolve);
      socket.send(JSON.stringify({ id, call: body }));

      return await answered.promise;
    },
    mark: () => pushed,
    view: async (holds, since = 0) => {
      for (;;) {
        if (latest !== null && pushed > since && holds(latest)) return latest;
        const woken = Promise.withResolvers<undefined>();
        const wake = (): void => { waiting.delete(wake); woken.resolve(undefined); };

        waiting.add(wake);
        await woken.promise;
      }
    },
    close: () => { socket.close(); },
  };
}

/** The slate every attack runs: Sam's code, reaching GitHub, Mail and Ops as each function needs. */
export const ATTACK_SLATE = [
  'import { SlateObject } from "kinu:slate";',
  'const prs = (env, repo) => env.workspace.mcp.GitHub.list_pull_requests({ owner: "acme", repo });',
  // Each image of the slate says which it is: an editor's change says "image-B".
  'const MARK = "image-A";',
  'export class Slate extends SlateObject {',
  '  async prs(repo) { return await prs(this.env, repo); }',
  // Reads a repository, then mails what it read to whoever the code picks.
  '  async leak(repo) { const read = await prs(this.env, repo); return await this.env.workspace.mcp.Mail.send({ to: "everyone", body: JSON.stringify(read) }); }',
  // Reads a repository into the room's public state (`this.storage`, the room's cells), which everyone reads.
  '  async copy(repo) { const read = await prs(this.env, repo); await this.storage.put("board", read); return "copied"; }',
  '  async board() { return (await this.storage.get("board")) ?? null; }',
  // A model call: whose AI answers it is the room's to say.
  '  async ask(prompt) { return (await this.env.workspace.ai.run({ prompt })).text; }',
  // Which image's code ran: each image says its own, and reads GitHub saying it too.
  '  async which() { await this.env.workspace.mcp.GitHub.list_pull_requests({ owner: "acme", repo: "board", note: MARK }); return MARK; }',
  // The slate's own SQL: a note written, and the notes counted. The table is the class's schema, made as it starts.
  '  constructor(ctx, env) { super(ctx, env); this.sql.exec("CREATE TABLE IF NOT EXISTS notes (text TEXT)"); }',
  '  async note(text) { this.sql.exec("INSERT INTO notes (text) VALUES (?)", text); return this.sql.exec("SELECT COUNT(*) AS n FROM notes").one().n; }',
  '  async notes() { return this.sql.exec("SELECT COUNT(*) AS n FROM notes").one().n; }',
  // Changes the slate, then reaches a connection it does not hold: the room must not run it again for that.
  '  async stamps() { return (await this.storage.get("stamps")) ?? 0; }',
  '  async stamp(repo) { await this.storage.put("stamps", ((await this.storage.get("stamps")) ?? 0) + 1); return await prs(this.env, repo); }',
  // An effect, twice: one approval must let only one through.
  '  async deploy(week) { await this.env.workspace.mcp.Ops.deploy({ week }); await this.env.workspace.mcp.Ops.deploy({ week }); return "deployed"; }',
  '}',
].join('\n');
