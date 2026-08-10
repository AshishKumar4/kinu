/**
 * Regression tests for the installer raw-mode freeze: prompts must leave the
 * terminal in canonical mode (kernel echo + line editing + live Ctrl+C) while
 * a question is pending. The old readline-based prompts flipped the TTY into
 * raw mode (ECHO/ISIG off) and then starved on macOS, where kqueue cannot
 * poll /dev/tty — frozen question, no echo, dead Ctrl+C.
 *
 * The harness reproduces the exact `curl | bash` installer topology: the CLI
 * process runs in its own session with a PTY as controlling terminal and
 * stdin on a pipe, so prompts must reach the terminal through /dev/tty.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

const python = Bun.which("python3");
const promptModule = resolve(__dirname, "../src/prompt.ts");

const fixtures = mkdtempSync(join(tmpdir(), "proteus-pty-test-"));
afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

const HARNESS = `
import json, os, pty, sys, time, fcntl, termios, signal, select

mode, want, cmd = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3:]
master, slave = pty.openpty()
pid = os.fork()
if pid == 0:
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    r, w = os.pipe()  # stdin = pipe, like the unread remainder of curl | bash
    os.dup2(r, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(master)
    os.execvp(cmd[0], cmd)
os.close(slave)

def drain(seconds):
    out = b""
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([master], [], [], 0.2)
        if ready:
            try:
                chunk = os.read(master, 4096)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
    return out

def lflags():
    flag = termios.tcgetattr(master)[3]
    return {
        "icanon": bool(flag & termios.ICANON),
        "echo": bool(flag & termios.ECHO),
        "isig": bool(flag & termios.ISIG),
    }

def wait_for_prompt(deadline=15.0):
    out = b""
    end = time.time() + deadline
    while time.time() < end and b"\\xe2\\x80\\xba" not in out:  # the prompt's \\u203a marker
        out += drain(0.3)
    return out

output = wait_for_prompt()
# The prompt TEXT reaching the pty and the CLI's tcsetattr taking effect are
# two separate events with no ordering between them, so sampling the flags the
# instant the marker appears is a race — it caught the terminal mid-transition
# and reported the state the CLI was about to leave. Settle on the expected
# state instead, bounded: a CLI that never gets there still reports what it
# actually did, and the assertions are unchanged.
def settle(want, deadline=5.0):
    end = time.time() + deadline
    seen = lflags()
    while time.time() < end and any(seen[k] != v for k, v in want.items()):
        output_ignored = drain(0.1)
        seen = lflags()
    return seen

pending = settle(want)
if mode == "ctrlc":
    os.write(master, b"\\x03")
else:
    os.write(master, mode.encode() + b"\\n")
output += drain(2.0)

exited = False
for _ in range(40):
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        exited = True
        break
    time.sleep(0.25)
if not exited:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    status = -1

print(json.dumps({
    "output": output.decode(errors="replace"),
    "pending": pending,
    "post": lflags(),
    "exited": exited,
    "signaled": exited and os.WIFSIGNALED(status),
    "termsig": os.WTERMSIG(status) if exited and os.WIFSIGNALED(status) else None,
    "exitcode": os.WEXITSTATUS(status) if exited and os.WIFEXITED(status) else None,
}))
`;

interface HarnessResult {
  output: string;
  pending: { icanon: boolean; echo: boolean; isig: boolean };
  post: { icanon: boolean; echo: boolean; isig: boolean };
  exited: boolean;
  signaled: boolean;
  termsig: number | null;
  exitcode: number | null;
}

/** `expectPending` is the settle target only — it decides when the harness
 *  stops waiting for the terminal to reach a steady state, never what is
 *  asserted. The test still asserts the observed flags itself, so a CLI that
 *  never reaches that state reports what it really did and fails. */
function runInPty(
  mode: string,
  driverSource: string,
  expectPending: Partial<{ icanon: boolean; echo: boolean; isig: boolean }>,
): HarnessResult {
  const harnessPath = join(fixtures, "harness.py");
  writeFileSync(harnessPath, HARNESS);
  const driverPath = join(fixtures, `driver-${Bun.hash(driverSource).toString(16)}.ts`);
  writeFileSync(driverPath, driverSource);
  const run = spawnSync(python!, [harnessPath, mode, JSON.stringify(expectPending), process.execPath, driverPath], {
    encoding: "utf8",
    timeout: 40_000,
  });
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout.trim().split("\n").at(-1)!) as HarnessResult;
}

const CONFIRM_DRIVER = `
import { confirm } from ${JSON.stringify(promptModule)};
const v = await confirm('Sign in and attach Cloudflare Workers AI permissions now?', true);
console.log('ANSWER=' + v);
process.exit(0);
`;

const SECRET_DRIVER = `
import { askSecret } from ${JSON.stringify(promptModule)};
const v = await askSecret('API key');
console.log('SECRET=' + JSON.stringify(v));
process.exit(0);
`;

describe.if(Boolean(python))("prompts under the installer PTY topology (stdin pipe, /dev/tty terminal)", () => {
  test("pending confirm stays canonical: kernel echo, line editing, live Ctrl+C", () => {
    const result = runInPty("y", CONFIRM_DRIVER, { icanon: true, echo: true, isig: true });
    expect(result.pending).toEqual({ icanon: true, echo: true, isig: true });
    expect(result.output).toContain("y"); // kernel echoed the keypress
    expect(result.output).toContain("ANSWER=true");
    expect(result.exited).toBe(true);
    expect(result.exitcode).toBe(0);
    expect(result.post).toEqual({ icanon: true, echo: true, isig: true });
  }, 45_000);

  test("Ctrl+C interrupts a pending confirm and leaves the terminal sane", () => {
    const result = runInPty("ctrlc", CONFIRM_DRIVER, { isig: true });
    expect(result.pending.isig).toBe(true);
    expect(result.exited).toBe(true);
    expect(result.signaled).toBe(true);
    expect(result.termsig).toBe(2); // SIGINT
    expect(result.post).toEqual({ icanon: true, echo: true, isig: true });
  }, 45_000);

  test("askSecret hides input but keeps Ctrl+C live, and restores echo", () => {
    const result = runInPty("s3cr3t", SECRET_DRIVER, { icanon: true, echo: false, isig: true });
    expect(result.pending).toEqual({ icanon: true, echo: false, isig: true });
    expect(result.output.split("SECRET=")[0]).not.toContain("s3cr3t"); // typing never echoed
    expect(result.output).toContain('SECRET="s3cr3t"');
    expect(result.exitcode).toBe(0);
    expect(result.post).toEqual({ icanon: true, echo: true, isig: true });
  }, 45_000);

  test("Ctrl+C during askSecret kills the CLI and restores echo via the sh trap", () => {
    const result = runInPty("ctrlc", SECRET_DRIVER, { echo: false });
    expect(result.pending.echo).toBe(false);
    expect(result.exited).toBe(true);
    expect(result.signaled).toBe(true);
    expect(result.termsig).toBe(2);
    expect(result.post).toEqual({ icanon: true, echo: true, isig: true });
  }, 45_000);
});
