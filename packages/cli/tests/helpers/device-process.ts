import { readFileSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { toKinuError, tolerate } from '@kinu.run/core/obs';
import { AwaitedList } from '@kinu.run/test-utils';

function observeFile<T>(file: string, read: (text: string) => T | undefined, exited?: Promise<unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let closed = false;

    const failed = (cause: Error): void => {
      if (closed) return;
      closed = true;
      watcher.close();
      reject(cause);
    };

    const changed = (): void => {
      if (closed) return;

      try {
        const text = tolerate(() => readFileSync(file, 'utf8'), 'enoent');
        const found = read(text ?? '');

        if (found === undefined) return;
        closed = true;
        watcher.close();
        resolve(found);
      } catch (cause) { failed(toKinuError({ doing: 'reading the observed file', cause, otherwise: 'io' })); }
    };

    const watcher = watch(dirname(file), changed);
    watcher.once('error', failed);
    changed();
    exited?.then(() => { changed(); failed(new Error('the process exited before the expected content reached ' + file)); }, failed);
  });
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
