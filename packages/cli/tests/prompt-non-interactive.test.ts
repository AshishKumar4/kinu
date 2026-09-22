/**
 * Regression tests for the installer sign-in freeze: any CLI surface that
 * wants interactive input must either reach a real terminal (/dev/tty) or
 * print instructions and exit — never block on a piped stdin.
 *
 * The CLI is spawned detached (its own session, no controlling terminal),
 * so /dev/tty is unopenable even when the test runner itself has a TTY.
 */
import { scratchDir } from '../../test-utils/src/scratch';
import { spawn } from "node:child_process";

import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { tolerate } from "@kinu.run/core/obs";
import { present } from '@kinu.run/test-utils';

const repoRoot = resolve(__dirname, "../../..");

const cliBin = join(repoRoot, "packages/cli/bin/cli.ts");

function tempHome(): string {
  const dir = scratchDir("prompt-test");

  return dir;
}

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runDetachedCli(args: string[], home: string, timeoutMs = 20_000): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cliBin, ...args], {
      // The CLI records its cwd as the agent file plane, so a spawn must never sit in the developer repo.
      cwd: tempHome(),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, KINU_HOME: home },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.end();

    const timer = setTimeout(() => {
      tolerate(() => process.kill(-present(child.pid, "the child process id"), "SIGKILL"), "esrch");
      resolvePromise({ exitCode: null, stdout, stderr, timedOut: true });
    }, timeoutMs);

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, stdout, stderr, timedOut: false });
    });
  });
}

describe("setup without any terminal", () => {
  test("account-only setup prints sign-in instructions and exits 0 instead of hanging", async () => {
    const result = await runDetachedCli(
      ["setup", "--account-only", "--origin", "https://kinu.example.com"],
      tempHome(),
    );

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Not signed in to Kinu");
    expect(result.stdout).toContain("kinu auth --origin https://kinu.example.com");
  });

  test("full setup prints provider instructions and exits 0 instead of prompting", async () => {
    const result = await runDetachedCli(
      ["setup", "--origin", "https://kinu.example.com"],
      tempHome(),
    );

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("needs an interactive terminal");
    expect(result.stdout).toContain("kinu provider connect");
  });
});

describe("TUI without a terminal", () => {
  test("requireInteractiveTerminal refuses with instructions when stdin is not a TTY", async () => {
    const { requireInteractiveTerminal } = await import("../src/prompt");
    const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });

    try {
      expect(() => requireInteractiveTerminal()).toThrow(/interactive terminal/);
    } finally {
      if (stdinDesc) Object.defineProperty(process.stdin, "isTTY", stdinDesc);
      else Reflect.deleteProperty(process.stdin, "isTTY");
    }
  });
});
