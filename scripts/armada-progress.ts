/** The line armada writes once it has made the job; a whole line only, so an id cut between two chunks is never read. */
const JOB = /^job (\S+)\r?\n/mu;

/** What an `armada map` writes to stderr: progress, passed through as it arrives, its first line `job <id>` once the
 *  job is made, which `named` hears then, not only once the map ends. */
export async function drainArmadaProgress(stderr: ReadableStream<Uint8Array>, named?: (job: string) => void): Promise<{ readonly said: string; readonly job: string | undefined }> {
  const decoder = new TextDecoder();
  let said = '';
  let job: string | undefined;

  for await (const chunk of stderr) {
    const text = decoder.decode(chunk, { stream: true });

    said += text;
    process.stderr.write(text);

    if (job === undefined) {
      job = JOB.exec(said)?.[1];

      if (job !== undefined) named?.(job);
    }
  }

  said += decoder.decode();

  return { said, job: job ?? JOB.exec(`${said}\n`)?.[1] };
}
