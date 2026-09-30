export function processResult(work: Promise<{ stdout: string; stderr: string; exitCode: number }>, pid: number, kill?: (signal: number) => void): ExecProcess {
  const encoder = new TextEncoder();
  const completed = Promise.withResolvers<{ stdout: string; stderr: string; exitCode: number }>();
  void work.then(completed.resolve, completed.reject);

  const channel = (key: 'stdout' | 'stderr') => new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const result = await completed.promise;
        controller.enqueue(encoder.encode(result[key]));
        controller.close();
      } catch (error) { controller.error(error); }
    },
  });

  return {
    pid, isPty: false, stdin: null, stdout: channel('stdout'), stderr: channel('stderr'),
    get exitCode() { return completed.promise.then(result => result.exitCode); },
    kill(signal = 15) { kill?.(signal); completed.resolve({ stdout: '', stderr: '', exitCode: 128 + signal }); },
    resize() { throw new Error('this process has no PTY'); },
    async output() {
      const result = await completed.promise;

      return { stdout: encoder.encode(result.stdout).buffer, stderr: encoder.encode(result.stderr).buffer, exitCode: result.exitCode };
    },
  };
}
