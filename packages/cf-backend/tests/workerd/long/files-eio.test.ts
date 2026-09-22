/**
 * A file read must not require a shell. The Workers runtime's V8 CSP forbids codegen from strings, so the
 * `node` shim's `new Function` read fails only here, never under `bun test`. The read must return the
 * file's bytes with no command asked to run.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('the Files tab reading a workspace file', () => {
  const open = (name: string) => env.FILES_EIO_PROBE.get(env.FILES_EIO_PROBE.idFromName(name));

  it("reads a byte window without running a command, and the bytes are the file's own", async () => {
    const subject = open('hostname');

    const report = await subject.readRange('/etc/hostname', 0, 32);
    // First, with the exec list in the failure print: a shell read shows the command it tried.
    expect(report.execs).toEqual([]);
    // Asserted on content: a failing shell reader or a wrong window both stay red.
    expect(report.content).toBe('nimbus\n');
  });

  // Not at zero: the replacement must serve the middle of a file, not just an origin prefix.
  it('reads a window that starts past the head of the file', async () => {
    const subject = open('hostname');

    const report = await subject.readRange('/etc/hostname', 2, 3);
    expect(report.error).toBeNull();
    expect(report.execs).toEqual([]);
    expect(report.content).toBe('mbu');
  });
});
