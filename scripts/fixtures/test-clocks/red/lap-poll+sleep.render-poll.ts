// A render poll: a frame, a check, a sleep, forty times.
export async function frameHolding(renderOnce: () => Promise<void>, capture: () => string, expected: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await renderOnce();

    if (capture().includes(expected)) break;
    await Bun.sleep(1);
  }

  return capture();
}
