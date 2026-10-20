import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tolerate } from '@kinu.run/core/obs';
import { AwaitedList } from '@kinu.run/test-utils';

/**
 * What `read` finds in `file`, read again on each turn of the event loop: never a file-change event, which Bun's
 * fs.watch dropped 90 times in 300 under load (2026-10-20), hanging the wait. Ends when the content is there, or, once
 * `exited` settles, with one last read after every write the process made.
 */
async function observeFile<T>(file: string, read: (text: string) => T | undefined, exited?: Promise<unknown>): Promise<T> {
  let ended = false;
  const end = (): void => { ended = true; };

  exited?.then(end, end);

  for (;;) {
    const wasEnded = ended;
    const found = read(tolerate(() => readFileSync(file, 'utf8'), 'enoent') ?? '');

    if (found !== undefined) return found;

    if (wasEnded) throw new Error(`the process exited before the expected content reached ${file}`);

    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

export function waitForDaemonPid(home: string): Promise<number> {
  return observeFile(join(home, 'pc-agent.pid'), (text) => {
    const pid = Number(text.trim());

    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  });
}

export async function waitForFileText(file: string, text: string, exited: Promise<unknown>): Promise<void> {
  await observeFile(file, (content) => content.includes(text) ? true : undefined, exited);
}

export interface ProcessOutput {
  drained: Promise<void>;
  output: () => string;
  waitFor: (text: string) => Promise<void>;
}

export function readProcessOutput(stdout: ReadableStream<Uint8Array>, normalise: (text: string) => string = (text) => text): ProcessOutput {
  const decoder = new TextDecoder();
  const chunks = new AwaitedList<string>();
  const output = (): string => normalise(chunks.items.join(''));

  const drained = (async () => {
    for await (const chunk of stdout) chunks.push(decoder.decode(chunk, { stream: true }));

    const tail = decoder.decode();

    if (tail !== '') chunks.push(tail);
  })();

  return {
    drained,
    output,
    waitFor: (text) => Promise.race([
      chunks.until(() => output().includes(text)),
      drained.then(() => {
        if (!output().includes(text)) throw new Error(`stdout ended before ${JSON.stringify(text)} in:\n${output()}`);
      }),
    ]),
  };
}
