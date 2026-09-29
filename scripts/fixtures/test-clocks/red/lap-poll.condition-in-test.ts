// The condition in the loop's own test, the cap beside it, a read each lap.
const ATTEMPTS = 40;

export async function themeApplied(read: () => Promise<{ mode: string }>, want: string): Promise<string> {
  let applied = await read();

  for (let attempt = 0; attempt < ATTEMPTS && applied.mode !== want; attempt += 1) {
    applied = await read();
  }

  return applied.mode;
}
