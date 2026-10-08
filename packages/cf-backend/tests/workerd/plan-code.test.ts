import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

it('a declared slate tool binding runs live crafted source through the codemode registry without delegation', async () => {
  const root = env.SLATE_ACTOR_ROOT.get(env.SLATE_ACTOR_ROOT.idFromName('crafted-binding'));
  expect(JSON.parse(await root.craftedSlate())).toEqual({
    first: { ok: true, value: { answer: 42, agent: 'undefined', agents: 'undefined' } },
    second: { ok: true, value: 63 },
    planned: { ok: true, value: 63 },
    declarations: {
      before: [{ name: 'calculate', description: 'Double' }],
      after: [{ name: 'calculate', description: 'Triple' }],
    },
    delta: expect.stringContaining('sandbox status went from `ready on demand` to `active`'),
  });
});

it('hosted Plan analysis reads files and keeps research state without writes or raw network', async () => {
  const root = env.SLATE_ACTOR_ROOT.get(env.SLATE_ACTOR_ROOT.idFromName('plan-analysis'));

  const planned = await root.code('plan', [
    "const text = await workspace.readFile('plan-data.txt');",
    "const write = await workspace.writeFile('plan-data.txt', 'changed');",
    'await state.set("analysis", [3, 1, 2].sort());',
    'let network;',
    'try { await globalThis.fetch("https://network.example.test/"); network = { blocked: false }; }',
    'catch (cause) { if (!(cause instanceof Error)) throw cause; network = { blocked: true, error: cause.message }; }',
    'return { text, write, analysis: await state.get("analysis"), network };',
  ].join('\n'));

  expect(planned.file).toBe('original');
  expect(JSON.parse(planned.answer)).toMatchObject({ result: {
    text: 'original', write: { reason: 'denied' }, analysis: [1, 2, 3], network: { blocked: true },
  } });

  const built = await root.code('build', [
    "await workspace.writeFile('plan-data.txt', 'changed');",
    'return await (await fetch("https://network.example.test/")).text();',
  ].join('\n'));

  expect(built.file).toBe('changed');
  expect(JSON.parse(built.answer)).toMatchObject({ result: 'network allowed' });
});

// 2026-10-05: Stop left an eval's tool calls running on the cloud. The vendor's createCodeTool runs its executor without
// the call's signal, so native calls never saw it, and an MCP call is an RPC to the user's hub, which no signal crosses.
it('a stopped eval settles its held native and MCP calls at once, and the hub is told to cancel the call it holds', async () => {
  const root = env.SLATE_ACTOR_ROOT.get(env.SLATE_ACTOR_ROOT.idFromName('stop-held'));
  const stopped = await root.stopDuringHeldCalls();

  // A stopped call reaches the program as its failure, as a refused one does.
  expect(JSON.parse(stopped.answer)).toMatchObject({ result: {
    native: 'stopped', mcp: { reason: 'cancelled', error: expect.stringContaining('hold was stopped before its MCP server answered') },
  } });
  expect(stopped.called).toHaveLength(1);
  expect(stopped.cancelled).toEqual(stopped.called);
});
