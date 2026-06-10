import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { validateAliasName, validateAgentName } from "../src/config.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CLI config safety", () => {
  test("validates local agent names", () => {
    expect(() => validateAgentName("jarvis")).not.toThrow();
    expect(() => validateAgentName("build-agent_2")).not.toThrow();
    expect(() => validateAgentName("../outside")).toThrow("Agent name must");
    expect(() => validateAgentName("bad/name")).toThrow("Agent name must");
    expect(() => validateAgentName(".hidden")).toThrow("Agent name must");
  });

  test("validates aliases as executable names", () => {
    expect(() => validateAliasName("jarvis")).not.toThrow();
    expect(() => validateAliasName("jarvis-2")).not.toThrow();
    expect(() => validateAliasName("../outside")).toThrow("Alias must");
    expect(() => validateAliasName("bad/name")).toThrow("Alias must");
    expect(() => validateAliasName("proteus")).toThrow("reserved");
  });

  test("honors PROTEUS_HOME before falling back to the OS home", () => {
    const home = mkdtempSync(join(tmpdir(), "proteus-cli-home-"));
    const proteusHome = mkdtempSync(join(tmpdir(), "proteus-cli-config-"));
    tempDirs.push(home, proteusHome);

    const script = "import { AGENT_HOME } from './packages/cli/src/config.ts'; console.log(AGENT_HOME);";
    const proc = Bun.spawnSync({
      cmd: [process.execPath, "-e", script],
      cwd: resolve(__dirname, "../../.."),
      env: {
        ...process.env,
        HOME: home,
        PROTEUS_HOME: proteusHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString().trim()).toBe(resolve(proteusHome));
  });

  test("requireAuthConfig enforces token expiry", () => {
    const expired = runRequireAuth(new Date(Date.now() - 60_000).toISOString());
    expect(expired.stdout.toString()).toContain("session has expired");

    const valid = runRequireAuth(new Date(Date.now() + 60_000).toISOString());
    expect(valid.stdout.toString().trim()).toBe("ok");
  });
});

function runRequireAuth(tokenExpiresAt: string) {
  const proteusHome = mkdtempSync(join(tmpdir(), "proteus-cli-auth-"));
  tempDirs.push(proteusHome);
  writeFileSync(
    join(proteusHome, "config.json"),
    JSON.stringify({ accessToken: "ptc_test", tokenExpiresAt }),
    { mode: 0o600 },
  );
  const script = `
    import { requireAuthConfig } from './packages/cli/src/config.ts';
    try { requireAuthConfig(); console.log('ok'); }
    catch (err) { console.log(err instanceof Error ? err.message : String(err)); }
  `;
  return Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: resolve(__dirname, "../../.."),
    env: { ...process.env, PROTEUS_HOME: proteusHome },
    stdout: "pipe",
    stderr: "pipe",
  });
}
