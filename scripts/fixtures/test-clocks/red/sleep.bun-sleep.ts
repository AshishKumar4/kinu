// A real sleep between a cause and the observation of its effect.
export async function afterKick(check: () => boolean): Promise<boolean> {
  await Bun.sleep(50);

  return check();
}
