// A poll with two exits: the condition, and the clock.
export async function waitFor(what: string, check: () => boolean, next: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await next();
  }
}
