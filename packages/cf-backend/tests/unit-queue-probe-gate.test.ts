import { expect, test } from 'bun:test';
import { probeOutbound } from './workerd/http-model-fake';

async function control(path: string, body?: { from: number; logo?: boolean }): Promise<Response> {
  return await probeOutbound(new Request(`http://probe-control.invalid${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body !== undefined && { body: JSON.stringify(body) }),
  }));
}

async function model(stream: boolean, content: string): Promise<Response> {
  return await probeOutbound(new Request('http://fake-models.invalid/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ model: 'probe-queue', stream, messages: [{ role: 'user', content }] }),
  }));
}

for (const from of [1, 2]) {
  test(`the queue fixture's arrival is streamed model call ${from}, independent of a concurrent logo call`, async () => {
    await probeOutbound(new Request('http://probe-control.invalid/reset', { method: 'POST' }));
    await control('/queue/hold', { from });
    const pending: Promise<Response>[] = [];

    try {
      if (from === 2) await model(true, 'The completed first step.');
      pending.push(model(false, 'Design the logo of a Kinu workspace.'));
      pending.push(model(true, 'The turn the fixture intends to park.'));
      const arrived: unknown = await (await control('/queue/arrived')).json();

      expect(arrived).toEqual({ ok: true, model: 'probe-queue', stream: true });
    } finally {
      await probeOutbound(new Request('http://probe-control.invalid/queue/release', { method: 'POST' }));
      await Promise.all(pending);
      await probeOutbound(new Request('http://probe-control.invalid/reset', { method: 'POST' }));
    }
  });
}

test('the explicit logo gate lets the streamed turn proceed and parks only its logo', async () => {
  await probeOutbound(new Request('http://probe-control.invalid/reset', { method: 'POST' }));
  await control('/queue/hold', { from: 1, logo: true });
  await model(true, 'The streamed turn must remain unblocked.');

  const logo = model(false, 'Design the logo of a Kinu workspace.');

  try {
    const arrived: unknown = await (await control('/queue/arrived')).json();

    expect(arrived).toEqual({ ok: true, model: 'probe-queue', stream: false });
  } finally {
    await probeOutbound(new Request('http://probe-control.invalid/queue/release', { method: 'POST' }));
    await logo;
    await probeOutbound(new Request('http://probe-control.invalid/reset', { method: 'POST' }));
  }
});
