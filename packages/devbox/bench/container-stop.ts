export async function stopContainer(ports: {
  readonly stop: () => Promise<void>;
  readonly running: () => boolean;
  readonly wait: () => Promise<void>;
}): Promise<void> {
  await ports.stop();

  while (ports.running()) await ports.wait();
}
