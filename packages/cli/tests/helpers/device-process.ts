import { readFileSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { toKinuError, tolerate } from '@kinu.run/core/obs';

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
  const waiting = new Set<{ text: string; resolve: () => void; reject: (cause: Error) => void }>();
  let output = '';
  let ended = false;
  let failure: unknown;

  const observed = (): string => normalise(output);

  const changed = (): void => {
    const text = observed();

    for (const read of waiting) {
      if (text.includes(read.text)) {
        waiting.delete(read);
        read.resolve();
      } else if (ended) {
        waiting.delete(read);
        read.reject(new Error(`stdout ended before ${JSON.stringify(read.text)} in:\n${output}`, { cause: failure }));
      }
    }
  };

  const drained = (async () => {
    try {
      for await (const chunk of stdout) {
        output += decoder.decode(chunk, { stream: true });
        changed();
      }

      output += decoder.decode();
    } catch (cause) {
      failure = cause;
      throw cause;
    } finally {
      ended = true;
      changed();
    }
  })();

  return {
    drained,
    output: observed,
    waitFor: (text) => {
      if (observed().includes(text)) return Promise.resolve();

      if (ended) return Promise.reject(new Error(`stdout ended before ${JSON.stringify(text)} in:\n${output}`, { cause: failure }));

      return new Promise<void>((resolve, reject) => { waiting.add({ text, resolve, reject }); });
    },
  };
}
