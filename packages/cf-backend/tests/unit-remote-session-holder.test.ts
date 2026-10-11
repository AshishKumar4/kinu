import { describe, expect, test } from 'bun:test';
import { remoteSessionHolder, type RemoteSession } from './helpers/remote-session-holder';

function session(log: string[], name: string): RemoteSession {
  return { remoteProxyConnectionString: new URL('http://127.0.0.1:1'), dispose: async () => { log.push(`dispose ${name}`); } };
}

/** A holder whose every start succeeds, naming each session by how many have started. */
function counting(log: string[]) {
  let opened = 0;

  return remoteSessionHolder(async () => {
    opened += 1;

    return session(log, `s${String(opened)}`);
  });
}

describe('the remote session lives and ends with the pool', () => {
  test('a start that failed is not kept, so the next request starts again', async () => {
    const log: string[] = [];
    let attempts = 0;

    const holder = remoteSessionHolder(async () => {
      attempts += 1;

      if (attempts === 1) throw new Error('the remote proxy could not start');

      return session(log, `s${String(attempts)}`);
    });

    await expect(holder.current()).rejects.toThrow('could not start');
    expect(await holder.current()).toBeDefined();
    await holder.close();
    expect(log).toEqual(['dispose s2']);
  });

  test('closing disposes the session once, and a request after it does not reopen it', async () => {
    const log: string[] = [];
    const holder = counting(log);

    await holder.current();
    await holder.close();
    await holder.close();
    await expect(holder.current()).rejects.toThrow('closed with its pool');
    expect(log).toEqual(['dispose s1']);
  });

  test('closing while a start is still under way waits for it and disposes what it made', async () => {
    const log: string[] = [];
    const starting = Promise.withResolvers<RemoteSession>();
    const holder = remoteSessionHolder(async () => await starting.promise);
    const request = holder.current();
    const closing = holder.close();

    starting.resolve(session(log, 'late'));
    await request;
    await closing;
    expect(log).toEqual(['dispose late']);
  });

  test('the next pool worker may start the session again', async () => {
    const log: string[] = [];
    const holder = counting(log);

    await holder.current();
    await holder.close();
    holder.reopen();
    await holder.current();
    await holder.close();
    expect(log).toEqual(['dispose s1', 'dispose s2']);
  });
});
