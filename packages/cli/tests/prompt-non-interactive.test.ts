/**
 * Regression tests for the installer sign-in freeze: any CLI surface that
 * wants interactive input must either reach a real terminal (/dev/tty) or
 * print instructions and exit — never block on a piped stdin.
 *
 * The CLI is spawned detached (its own session, no controlling terminal),
 * so /dev/tty is unopenable even when the test runner itself has a TTY.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { tolerate } from "@kinu/core/obs";

const repoRoot = resolve(__dirname, "../../..");
const cliBin = join(repoRoot, "packages/cli/bin/cli.ts");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "kinu-prompt-test-"));
  tempDirs.push(dir);
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
      cwd: repoRoot,
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
      tolerate(() => process.kill(-child.pid!, "SIGKILL"), "esrch");
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
    expect(result.stdout).toContain("Kinu account was not connected");
    expect(result.stdout).toContain("kinu auth --origin https://kinu.example.com");
  }, 30_000);

  test("full setup prints provider instructions and exits 0 instead of prompting", async () => {
    const result = await runDetachedCli(
      ["setup", "--origin", "https://kinu.example.com"],
      tempHome(),
    );
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no interactive terminal");
    expect(result.stdout).toContain("kinu provider connect");
  }, 30_000);
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
