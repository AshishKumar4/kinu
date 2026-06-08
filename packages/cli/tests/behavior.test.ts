import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const tempDirs: string[] = [];
const repoRoot = resolve(__dirname, "../../..");
const cliBin = join(repoRoot, "packages/cli/bin/cli.ts");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runCli(args: string[], opts: { home?: string; stdin?: string } = {}) {
  return Bun.spawnSync({
    cmd: [process.execPath, cliBin, ...args],
    cwd: repoRoot,
    stdin: opts.stdin ? Buffer.from(opts.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...(opts.home ? { PROTEUS_HOME: opts.home } : {}),
    },
  });
}

function writeConfig(home: string, body: unknown) {
  writeFileSync(join(home, "config.json"), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

describe("CLI behavior", () => {
  test("setup with an existing account does not enter the local model wizard by default", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-setup-"));
    tempDirs.push(home);
    writeConfig(home, {
      origin: "https://proteus.example.com",
      accessToken: "ptc_0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz",
      user: { id: "user_123", email: "ashish@example.com" },
    });

    const proc = runCli(["setup"], { home });
    const stdout = proc.stdout.toString();
    const stderr = proc.stderr.toString();

    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Proteus account ready");
    expect(stdout).not.toContain("Local model provider");
    expect(stdout).not.toContain("OpenAI API key");
  });

  test("setup --local-model keeps local provider setup explicit", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-setup-local-"));
    tempDirs.push(home);
    writeConfig(home, {
      origin: "https://proteus.example.com",
      accessToken: "ptc_0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz",
      user: { id: "user_123", email: "ashish@example.com" },
    });

    const proc = runCli(["setup", "--local-model", "--provider", "skip"], { home });
    const stdout = proc.stdout.toString();

    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("Skipped local model setup");
    expect(stdout).toContain("Cloud agents remain ready");
  });

  test("subcommand help reaches the selected command instead of root help", () => {
    const proc = runCli(["run", "--help"]);
    const out = proc.stdout.toString();

    expect(proc.exitCode).toBe(0);
    expect(out).toContain("Usage: proteus run");
    expect(out).toContain("--mode <mode>");
    expect(out).not.toContain("Self-evolving AI agent with MCTS exploration");
  });

  test("no-name chat can select a configured cloud agent", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-chat-"));
    tempDirs.push(home);
    writeConfig(home, {
      origin: "https://proteus.example.com",
      accessToken: "ptc_0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz",
      agents: {
        jarvis: {
          name: "jarvis",
          mode: "cloud",
          cloudName: "jarvis",
          alias: "jarvis",
          purpose: "Cloud agent",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      },
      aliases: { jarvis: "jarvis" },
    });

    const proc = runCli(["chat"], { home, stdin: "/exit\n" });
    const stderr = proc.stderr.toString();

    expect(proc.exitCode).toBe(0);
    expect(stderr).not.toContain("No agents found");
  });
});
