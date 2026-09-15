// A box in its boot window answers every operation route with the refusal
// `isRearmableStartupRefusal` reads, and nothing ran. Run `20260914234711`
// recorded eight decisive segments, one witness setup exec and one fault-cut
// witness write as failures on exactly that reply. The rule that asks again
// lives in one place, `askWhileStarting`, and both `execInBox` and
// `writeFileInBox` go through it; this fixture is red on a tree where either
// route returns the first refusal as the operation's outcome.
import { afterAll, describe, expect, test } from 'bun:test';
import { askWhileStarting, execInBox, writeFileInBox, type Fixture } from './bench-devbox-strategies';

const ASK_AGAIN = 'this devbox is not ready: no restoration has run for this container yet. A startup is armed, so ask again.';

const TERMINAL = 'this devbox has no attached work directory: overlay refused. That recovery class is terminal: call attachNow() to attempt the attach again.';

/** A fixture Worker whose box refuses the first `refusals` asks per route. */
function bootWindowBox(refusals: number, refusal = ASK_AGAIN) {
  const asks: Record<string, number> = {};

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      const route = new URL(request.url).pathname;
      asks[route] = (asks[route] ?? 0) + 1;

      if ((asks[route] ?? 0) <= refusals) return Response.json({ ok: false, error: refusal, ms: 6_000 });

      return Response.json(route === '/exec' ? { ok: true, exitCode: 0, stdout: 'ran', stderr: '', ms: 12 } : { ok: true });
    },
  });

  const fixture: Fixture = { origin: `http://127.0.0.1:${String(server.port)}`, token: 'test-token' };

  return { fixture, asks, stop: () => server.stop(true) };
}

const stops: (() => void)[] = [];

afterAll(() => { for (const stop of stops) stop(); });

describe('an operation asked in the boot window is asked again', () => {
  test('exec returns the answer the box gives once it has started, not its first refusal', async () => {
    const box = bootWindowBox(2);
    stops.push(box.stop);

    const reply = await execInBox(box.fixture, 'box', 'true');

    expect(reply).toMatchObject({ ok: true, exitCode: 0, stdout: 'ran' });
    expect(box.asks['/exec']).toBe(3);
  });

  test('a write is asked again and a refused write throws instead of passing as written', async () => {
    const box = bootWindowBox(1);
    stops.push(box.stop);

    await writeFileInBox(box.fixture, 'box', '/workspace/witness.txt', 'bytes');
    expect(box.asks['/write']).toBe(2);

    const terminal = bootWindowBox(1, TERMINAL);
    stops.push(terminal.stop);

    await expect(writeFileInBox(terminal.fixture, 'box', '/workspace/witness.txt', 'bytes'))
      .rejects.toThrow('write /workspace/witness.txt was refused: this devbox has no attached work directory');
    expect(terminal.asks['/write']).toBe(1);
  });

  test('a terminal refusal is the answer on the first ask', async () => {
    const box = bootWindowBox(5, TERMINAL);
    stops.push(box.stop);

    const reply = await execInBox(box.fixture, 'box', 'true');

    expect(reply).toMatchObject({ ok: false, error: TERMINAL });
    expect(box.asks['/exec']).toBe(1);
  });

  test('past the startup ceiling the last refusal stands, in the box\'s own words', async () => {
    let asked = 0;

    const reply = await askWhileStarting('probe', async () => {
      asked += 1;

      return { ok: false, error: ASK_AGAIN };
    }, 0);

    expect(reply).toEqual({ ok: false, error: ASK_AGAIN });
    expect(asked).toBe(1);
  });
});
