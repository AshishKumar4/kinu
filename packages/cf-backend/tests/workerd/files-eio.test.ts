/**
 * A file read must not require a shell, executed under the runtime that
 * forbids the shell it used to need.
 *
 * WHY THE WORKERD POOL. The defect is `readNimbusOriginRange`
 * (core/src/execution/nimbus.ts:36-49): it reads the origin session's byte
 * window by running `node -e <one-line CJS reader>` through the box's exec —
 * the `node` COMMAND SHIM compiles that source with `new Function`, and the
 * Workers runtime's V8 CSP forbids codegen from strings. A `bun test` executes
 * `new Function` happily, which is exactly why this shipped with the whole bun
 * suite green; the pool is the only tier that can see it.
 *
 * WHAT THE PROBE DRIVES. The real workspace over the DO's own SQLite, the
 * same file plane the orchestrator's Files tab reads through
 * (`nimbusSessionFiles` over the box's `files`), with `box.exec` recording
 * and refusing: a read that reaches it has already failed the contract. The
 * assertion is therefore not "the read succeeds" but "the read completes with
 * the file's own bytes and no command was asked to run" — so nobody can later
 * re-add a shell read and stay green.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('the Files tab reading a workspace file', () => {
  const open = (name: string) => env.FILES_EIO_PROBE.get(env.FILES_EIO_PROBE.idFromName(name));

  it("reads a byte window without running a command, and the bytes are the file's own", async () => {
    const subject = open('hostname');

    // /etc/hostname is exactly the file the owner opened: seeded by the
    // workspace boot, owned by the session user, and readable through the
    // same plane the tab reads through.
    const report = await subject.readRange('/etc/hostname', 0, 32);
    // Asserted FIRST and with the exec list in the failure print: a shell
    // read shows the command it tried to run, not just its error.
    expect(report.execs).toEqual([]);
    // The boot seeds `${DEFAULT_HOSTNAME}\n`, and the range asked for 32
    // bytes of it. The assert is on CONTENT, not on "some bytes": a shell
    // reader that fails or a plane that answers the wrong window both stay
    // red here.
    expect(report.content).toBe('nimbus\n');
  });

  // A window that does not start at zero, because the prefix reader being
  // replaced was an ORIGIN-prefix reader — the replacement has to serve the
  // middle of a file too, or the fix only covers the first read's shape.
  it('reads a window that starts past the head of the file', async () => {
    const subject = open('hostname');

    const report = await subject.readRange('/etc/hostname', 2, 3);
    expect(report.error).toBeNull();
    expect(report.execs).toEqual([]);
    expect(report.content).toBe('mbu');
  });
});
