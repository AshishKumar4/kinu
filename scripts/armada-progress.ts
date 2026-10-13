/** What an `armada map` writes to stderr: progress, passed through as it arrives, then a `job <id>` footer. */
export async function drainArmadaProgress(stderr: ReadableStream<Uint8Array>): Promise<{ readonly said: string; readonly job: string | undefined }> {
  const decoder = new TextDecoder();
  let said = '';

  for await (const chunk of stderr) {
    const text = decoder.decode(chunk, { stream: true });

    said += text;
    process.stderr.write(text);
  }

  said += decoder.decode();

  return { said, job: /^job (\S+)$/mu.exec(said)?.[1] };
}
