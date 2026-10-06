import { describe, expect, test } from 'bun:test';

import { readSources } from './sources';
import { declaredRpcs, findUnreachable, findUnreadChannels, invokedNames, keyOf } from './reachability';

/** One DO with one public RPC. Every case below varies only what the second
 *  file does with the name `listDeferredApprovals`. */
const AGENT = `
export class OrchestratorAgent {
  @callable()
  async listDeferredApprovals(): Promise<string[]> {
    return this.deferrals.list();
  }

  private async internal(): Promise<void> {
    await this.listDeferredApprovals();
  }
}
`;

const KEY = 'agent.ts#OrchestratorAgent.listDeferredApprovals';

function scan(consumer: string): string[] {
  return findUnreachable(new Map([['agent.ts', AGENT], ['consumer.tsx', consumer]])).unreachable.map(keyOf);
}

describe('reachability gate', () => {
  test('a @callable nothing invokes is reported', () => {
    expect(scan('export const Panel = () => null;')).toEqual([KEY]);
  });

  test("the declaring file's own `this.method()` is not a caller", () => {
    // AGENT calls it from `internal()`. If self-reference counted, nothing here
    // would ever be reportable and the gate would pass on an empty repo.
    expect(scan('')).toEqual([KEY]);
  });

  test('the declaring file installing it into an object literal IS a caller', () => {
    // Not self-reference: the object is handed out, and the consumer calls the
    // member under the PROPERTY's name. `recordHeadStep` shipped this shape and
    // was reported "no caller anywhere" while running on every head step -
    // installed as `ExplorationHostSeams.recordStep`, consumed as `reportStep`.
    const installer = `
export class OrchestratorAgent {
  @callable()
  async listDeferredApprovals(): Promise<string[]> { return []; }

  private seams() {
    return { review: () => this.listDeferredApprovals() };
  }
}
`;

    const found = findUnreachable(new Map([['agent.ts', installer]])).unreachable.map(keyOf);
    expect(found).toEqual([]);
  });

  test('a string literal in argument position is a caller', () => {
    expect(scan(`const load = () => rpc('listDeferredApprovals', []);`)).toEqual([]);
  });

  test('a property-access call on a stub is a caller', () => {
    expect(scan('const load = (stub) => stub.listDeferredApprovals();')).toEqual([]);
  });

  // ── The discriminator ────────────────────────────────────────────────
  // Each of these is how one of the seven real dead RPCs looked reachable to
  // `git grep`. If the gate is ever rewritten to match text, every one of these
  // flips to "reachable" and the gate silently stops working.

  test('a property key in a policy table is not a caller', () => {
    expect(scan(`export const AGENT_RPC_ACCESS = { listDeferredApprovals: 'interactive' };`))
      .toEqual([KEY]);
  });

  test('an array element in an allowlist is not a caller', () => {
    expect(scan(`export const SURFACE = ['listDeferredApprovals', 'getMctsTree'];`))
      .toEqual([KEY]);
  });

  test('a comment explaining the method is not a caller', () => {
    expect(scan('// listDeferredApprovals is the RPC the approvals tab reads.\nexport const x = 1;'))
      .toEqual([KEY]);
  });

  test('an import of a same-named core function is not a caller', () => {
    expect(scan(`import { listDeferredApprovals } from '@kinu.run/core';\nexport const x = 1;`))
      .toEqual([KEY]);
  });

  test('a type-only reference is not a caller', () => {
    expect(scan('type Surface = { listDeferredApprovals(): void };\nexport const x = 1;'))
      .toEqual([KEY]);
  });

  // ── Test-only reach, reported with its reason ────────────────────────

  test('an RPC only its own test invokes is reported, and says so', () => {
    const found = findUnreachable(
      new Map([['agent.ts', AGENT]]),
      new Map([['agent.test.ts', `test('x', () => agent.listDeferredApprovals());`]]),
    );

    expect(found.unreachable.map(keyOf)).toEqual([KEY]);
    expect(found.unreachable[0].testCallers).toEqual(['agent.test.ts']);
  });

  // ── The parser's own health ──────────────────────────────────────────

  test('the decorator is matched on the decorator, not on the text @callable', () => {
    const commentedOut = AGENT.replace('@callable()', '// @callable() — withdrawn');
    expect(declaredRpcs('agent.ts', commentedOut)).toEqual([]);
    expect(declaredRpcs('agent.ts', AGENT).map((r) => r.method)).toEqual(['listDeferredApprovals']);
  });

  test('invokedNames separates invocation from mention', () => {
    const names = invokedNames('x.ts', `
      const table = { mentioned: 1 };
      const list = ['listed'];
      rpc('argument');
      stub.accessed();
      handlers['indexed']();
      // commented()
    `);

    // `rpc` itself is a bare identifier callee and is NOT recorded: an RPC is
    // always reached through an object, and counting free calls would let a
    // same-named core function stand in for a caller of the method.
    expect([...names].sort()).toEqual(['accessed', 'argument', 'indexed']);
  });
});

describe('a broadcast channel nothing reads', () => {
  const PRODUCER = `export class Agent { tick() { this.broadcast(JSON.stringify({ type: 'ghost_channel', parts: [{ type: 'text' }] })); } }`;

  const unread = (consumer: string): string[] => findUnreadChannels(new Map([['agent.ts', PRODUCER], ['client.tsx', consumer]]))
    .unread.map((channel) => channel.name);

  test('is reported, and a frame\'s nested part is no channel of its own', () => {
    const scanned = findUnreadChannels(new Map([['agent.ts', PRODUCER]]));

    expect(scanned.channels.map((channel) => channel.name)).toEqual(['ghost_channel']);
    expect(scanned.unread.map((channel) => channel.name)).toEqual(['ghost_channel']);
  });

  test.each([
    ['a type declaring it', `interface Frame { type: 'ghost_channel'; }`],
    ['SQL naming it', `const ddl = 'CREATE TABLE ghost_channel (id TEXT)';`],
    ['a second producer', `export function relay(agent) { agent.broadcast({ type: 'ghost_channel' }); }`],
  ])('is still unread beside %s', (_label, consumer) => {
    expect(unread(consumer)).toEqual(['ghost_channel']);
  });

  test.each([
    ['a comparison', `if (msg.type === 'ghost_channel') show(msg);`],
    ['a comparison written the other way', `export const read = (msg) => { if ('ghost_channel' !== msg.type) return; show(msg); };`],
    ['a case label', `switch (msg.type) { case 'ghost_channel': show(msg); }`],
  ])('is read by %s in another file', (_label, consumer) => {
    expect(unread(consumer)).toEqual([]);
  });

  test('is not read by its producer comparing it', () => {
    const producer = `${PRODUCER}\nexport const own = (msg) => msg.type === 'ghost_channel';`;

    expect(findUnreadChannels(new Map([['agent.ts', producer]])).unread.map((channel) => channel.name)).toEqual(['ghost_channel']);
  });

  test('finds an optional broadcast call without depending on call punctuation', () => {
    const producer = `export const notify = (agent) => agent.broadcast?.({ type: 'optional_channel' });`;

    expect(findUnreadChannels(new Map([['agent.ts', producer]])).unread.map((channel) => channel.name)).toEqual(['optional_channel']);
  });

  test('the chat hook\'s registration reads the SDK\'s own chat frame', () => {
    const sdk = `export class Agent { send() { this.broadcast(JSON.stringify({ type: 'cf_agent_chat_messages' })); } }`;
    const unreadBeside = (consumer: string): number => findUnreadChannels(new Map([['agent.ts', sdk], ['client.tsx', consumer]])).unread.length;

    expect([unreadBeside('const chat = useAgentChat({ agent, onError });'), unreadBeside('const chat = useOtherHook({ agent });')]).toEqual([0, 1]);
  });
});

/** Removing real consumers must leave the shipped producers unreachable. */
describe('reachability gate, against the real tree', () => {
  const SOURCES = readSources();
  const ORCHESTRATOR = 'packages/cf-backend/src/orchestrator.ts';

  /** RPC → the one UI file that invokes it, verified live below. */
  const WIRES = {
    previewScaffoldLive: 'packages/cf-backend/src/components/surfaces/ScaffoldLineage.tsx',
    listTurnFeedback: 'packages/cf-backend/src/pages/WorkspacePage.tsx',
  } satisfies Record<string, string>;

  test('cutting the socket hook every workspace frame reaches leaves its channels unread', () => {
    const hook = ['packages/cf-backend/src/hooks/use-kinu.ts', 'packages/cf-backend/src/hooks/socket-frames.ts'];
    expect(findUnreadChannels(SOURCES).unread).toEqual([]);

    const cut = new Map(SOURCES);

    for (const file of hook) cut.delete(file);

    expect(findUnreadChannels(cut).unread.map((channel) => channel.name)).toContain('signal_card');
  });

  test.each(Object.entries(WIRES))('cutting %s\u2019s only caller makes it unreachable', (rpc, wire) => {
    const key = `${ORCHESTRATOR}#OrchestratorAgent.${rpc}`;
    expect(findUnreachable(SOURCES).unreachable.map(keyOf)).not.toContain(key);

    const cut = new Map(SOURCES);
    cut.delete(wire);
    expect(findUnreachable(cut).unreachable.map(keyOf)).toContain(key);
  });
});
