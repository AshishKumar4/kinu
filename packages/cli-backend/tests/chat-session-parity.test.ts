import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { runParityScenario } from './chat-session-parity';

describe('ChatSession steering and recovery', () => {
  test('steering preserves conversation ancestry and consumes pending sends across restart', async () => {
    const now = await runParityScenario();
    expect(now.landings).toEqual({ landingTwo: 'mid-turn', landingThree: 'cancelled', returned: ['three-steer'], landingFour: 'acknowledged', landingFive: 'turn' });
    const rows = v.parse(v.array(v.object({ id: v.string(), parentId: v.nullable(v.string()), role: v.string(), content: v.string() })), now.afterTwo.actorMessages);
    expect(rows.map(row => row.content)).toEqual(['one', 'answer one', 'two', 'two-steer', 'answer two']);
    expect(rows.map(row => row.parentId)).toEqual([null, ...rows.slice(0, -1).map(row => row.id)]);
    expect(now.beforeRestart.pendingSteers).toHaveLength(2);
    expect(now.beforeRestart.pendingSteerFiles).toMatchObject([{ filename: 'note.txt', mediaType: 'text/plain', url: 'data:text/plain;base64,aGVsbG8=' }]);
    expect(now.end.pendingSteers).toEqual([]);
    expect(now.end.pendingSteerFiles).toEqual([]);
    const failures = now.events.flat().filter(event => v.is(v.object({ type: v.literal('error') }), event));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ message: 'The turn was interrupted before it finished.' });
    const toolResults = now.events.flat().filter(event => v.is(v.object({ type: v.literal('tool-result') }), event));
    expect(toolResults.length).toBeGreaterThan(0);

    for (const result of toolResults) expect(result).toMatchObject({ success: true });
  });

  test('AN INTERRUPTED TURN CONTINUES: the restart re-opens the dead turn where it stopped', async () => {
    // The dead process's turn is re-opened under the same row and re-enters its produced tool call rather than rerunning:
    const now = await runParityScenario();
    const rows = v.parse(v.array(v.object({ id: v.string(), parentId: v.nullable(v.string()), role: v.string(), content: v.string() })), now.end.actorMessages);
    const four = rows.filter((row) => row.role === 'user' && row.content === 'four');
    // …the opening row exists once, not once per process that ran it;
    expect(four).toHaveLength(1);
    // …the steer acknowledged before the death lands under that same row and
    //    the answer under the steer — one chain, one answer;
    const steer = rows.find((row) => row.content === 'four-steer');
    expect(steer?.parentId).toBe(four[0]?.id);
    expect(rows.find((row) => row.role === 'assistant' && row.parentId === steer?.id)?.content).toBe('answer four again');
    // …and the continuation's model call carries the dead process's tool call
    //    with the result the ledger holds, then the steer, and asks for
    //    exactly the remaining call: the tool is not run again and the
    //    process makes one call for the re-opened turn and one for "five".
    const messageSchema = v.looseObject({ role: v.string(), parts: v.optional(v.array(v.looseObject({ type: v.string() }))) });
    const calls = v.parse(v.array(v.array(messageSchema)), now.restartedCalls);

    const opensFour = (message: v.InferOutput<typeof messageSchema>) =>
      message.role === 'user' && message.parts?.some((part) => v.is(v.object({ text: v.literal('four') }), part));

    expect(calls).toHaveLength(2);
    const continuation = calls[0] ?? [];
    const fourAt = continuation.findIndex(opensFour);

    expect(fourAt).toBeGreaterThan(-1);
    expect(continuation[fourAt + 1]).toMatchObject({ role: 'assistant', parts: [{ type: 'tool-call', toolName: 'memory' }] });
    expect(continuation[fourAt + 2]).toMatchObject({ role: 'tool', parts: [{ type: 'tool-result' }] });
    expect(continuation.filter(opensFour)).toHaveLength(1);
  });

  test('a second restart carries each recovered tool exchange only once', async () => {
    const now = await runParityScenario(true);

    const messages = v.parse(v.array(v.object({
      role: v.string(),
      parts: v.optional(v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()) }))),
    })), now.restartedCalls[0]);

    const start = messages.findIndex((message) => message.role === 'user'
      && message.parts?.some((part) => part.text === 'four'));

    expect(start).toBeGreaterThan(-1);
    const parts = messages.slice(start + 1).flatMap((message) => message.parts ?? []);
    expect(parts.filter((part) => part.type === 'tool-call')).toHaveLength(1);
    expect(parts.filter((part) => part.type === 'tool-result')).toHaveLength(1);
  });

});
