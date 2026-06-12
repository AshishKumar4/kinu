import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_WORKERS_AI_MODEL_ID } from "@proteus/core";
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

  test("PROTEUS_TOKEN env wins over the stored session, even an expired one", () => {
    const ciToken = `pta_${"0".repeat(32)}_${"a".repeat(44)}`;
    const result = runRequireAuth(new Date(Date.now() - 60_000).toISOString(), ciToken);
    expect(result.stdout.toString().trim()).toBe(`ok ${ciToken}`);
  });
});

const CLOUD_ORIGIN = "https://proteus.example.com";
const CLOUD_TOKEN = "ptc_0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz";

describe("resolveLLMConfig — signed-in Cloudflare AI (no BYO keys)", () => {
  test("derives the worker AI proxy endpoint with the platform default model", () => {
    const out = runResolveLLM({ origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN });
    expect(out).toEqual({
      name: "workers-ai",
      baseURL: `${CLOUD_ORIGIN}/api/user/ai/v1`,
      headers: { Authorization: `Bearer ${CLOUD_TOKEN}` },
      model: DEFAULT_WORKERS_AI_MODEL_ID,
    });
  });

  test("honors a configured workers-ai model; non-workers-ai specs keep the default endpoint model", () => {
    const pinned = runResolveLLM({ origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN, model: "workers-ai/@cf/meta/llama-4" });
    expect(pinned).toMatchObject({ name: "workers-ai", model: "@cf/meta/llama-4" });

    const gateway = runResolveLLM({ origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN, model: "my-gateway/openai/gpt-4.1" });
    expect(gateway).toMatchObject({ name: "workers-ai", model: DEFAULT_WORKERS_AI_MODEL_ID });
  });

  test("BYO provider keys keep precedence over the signed-in proxy", () => {
    const out = runResolveLLM({
      origin: CLOUD_ORIGIN,
      accessToken: CLOUD_TOKEN,
      providers: { openai: { apiKey: "sk-test" } },
    });
    expect(out).toMatchObject({ name: "openai" });
  });

  test("an explicit direct endpoint keeps precedence over the signed-in proxy", () => {
    const out = runResolveLLM(
      { origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN },
      { PROTEUS_BASE_URL: "https://gateway.example/v1", PROTEUS_AUTH: "Bearer direct" },
    );
    expect(out).toMatchObject({ name: "openai-compat", baseURL: "https://gateway.example/v1" });
  });

  test("signed out (or expired) with nothing configured points at proteus auth", () => {
    const signedOut = runResolveLLM({});
    expect(signedOut).toMatchObject({ error: expect.stringContaining("proteus auth") });

    const expired = runResolveLLM({
      origin: CLOUD_ORIGIN,
      accessToken: CLOUD_TOKEN,
      tokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(expired).toMatchObject({ error: expect.stringContaining("proteus auth") });
  });
});

/** Runs resolveLLMConfig in a clean subprocess (config.ts binds PROTEUS_HOME at
 *  import) with the provider/cloud env scrubbed, returning the config or
 *  { error } as JSON. */
function runResolveLLM(config: Record<string, unknown>, extraEnv: Record<string, string> = {}): unknown {
  const proteusHome = mkdtempSync(join(tmpdir(), "proteus-cli-llm-"));
  tempDirs.push(proteusHome);
  writeFileSync(join(proteusHome, "config.json"), JSON.stringify(config), { mode: 0o600 });
  const script = `
    import { resolveLLMConfig } from './packages/cli/src/config.ts';
    try { console.log(JSON.stringify(resolveLLMConfig())); }
    catch (err) { console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) })); }
  `;
  const env: Record<string, string | undefined> = { ...process.env, PROTEUS_HOME: proteusHome, ...extraEnv };
  for (const name of [
    "PROTEUS_TOKEN", "PROTEUS_ORIGIN", "PROTEUS_MODEL", "PROTEUS_BASE_URL", "PROTEUS_AUTH",
    "AI_GATEWAY_BASE_URL", "AI_GATEWAY_AUTH", "AI_GATEWAY_MODEL",
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "CODEX_ACCESS_TOKEN",
  ]) {
    if (!(name in extraEnv)) delete env[name];
  }
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: resolve(__dirname, "../../.."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode).toBe(0);
  return JSON.parse(proc.stdout.toString());
}

function runRequireAuth(tokenExpiresAt: string, envToken?: string) {
  const proteusHome = mkdtempSync(join(tmpdir(), "proteus-cli-auth-"));
  tempDirs.push(proteusHome);
  writeFileSync(
    join(proteusHome, "config.json"),
    JSON.stringify({ accessToken: "ptc_test", tokenExpiresAt }),
    { mode: 0o600 },
  );
  const script = `
    import { requireAuthConfig } from './packages/cli/src/config.ts';
    try { const auth = requireAuthConfig(); console.log(process.env.PROTEUS_TOKEN ? 'ok ' + auth.token : 'ok'); }
    catch (err) { console.log(err instanceof Error ? err.message : String(err)); }
  `;
  const env: Record<string, string | undefined> = { ...process.env, PROTEUS_HOME: proteusHome };
  if (envToken) env.PROTEUS_TOKEN = envToken;
  else delete env.PROTEUS_TOKEN;
  return Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: resolve(__dirname, "../../.."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}
