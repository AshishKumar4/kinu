// A subject's own option spelled like a library's is the subject's, not a wait.
interface Box { exec(command: string, options: { readonly timeout: number }): Promise<{ exitCode: number }> }

export async function run(box: Box): Promise<number> {
  const result = await box.exec('bun test', { timeout: 5_000 });

  return result.exitCode;
}
