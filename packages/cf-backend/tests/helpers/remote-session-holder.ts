/** What the native harness needs of a Wrangler remote proxy session. */
export interface RemoteSession {
  readonly remoteProxyConnectionString: URL;
  dispose(): Promise<void>;
}

/**
 * One lazily started session, tied to the pool's lifetime: a start that fails is not kept, so the next request starts
 * again; closing disposes what started and refuses further requests until the next pool worker starts, so teardown never
 * reopens the session it is ending.
 */
export function remoteSessionHolder(open: () => Promise<RemoteSession>) {
  let started: Promise<RemoteSession> | undefined;
  let accepting = true;

  return {
    async current(): Promise<RemoteSession> {
      if (!accepting) throw new Error('The remote Workers AI session was closed with its pool.');

      const attempt = started ?? open();

      started = attempt;
      attempt.catch(() => { if (started === attempt) started = undefined; });

      return await attempt;
    },

    /** Safe to call while a request is starting the session: it waits for that start, then disposes it. */
    async close(): Promise<void> {
      accepting = false;
      const closing = started;

      started = undefined;

      if (closing === undefined) return;
      const [outcome] = await Promise.allSettled([closing]);

      if (outcome.status === 'fulfilled') await outcome.value.dispose();
    },

    /** The next pool worker is starting: the session may be started again. */
    reopen(): void {
      accepting = true;
    },
  };
}
