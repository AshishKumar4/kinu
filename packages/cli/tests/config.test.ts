import { scratchDir } from '../../test-utils/src/scratch';
import { readFileSync, rmSync, writeFileSync } from "node:fs";

import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKERS_AI_MODEL_ID, JsonObjectSchema, JsonValueSchema,
  ProfileCatalogEnvelopeSchema, parseJsonValue,
  type JsonObject, type JsonValue,
} from "@kinu.run/core";
import { Database } from "bun:sqlite";
import { createCLIRuntime } from '@kinu.run/cli-backend';
import {
  readWorkspaceDisplayName, readWorkspaceIdentityId,
} from "../src/config";
import * as v from 'valibot';

describe("CLI config safety", () => {
  test("validates local agent names", () => {
    // agentDir joins the home directory, so a name that could escape it must fail here.
    const out = runNameChecks();
    expect(out.slice(0, 2).map((r) => r.ok)).toEqual([true, true]);
    expect(out.slice(2, 5).map((r) => r.error)).toEqual([
      expect.stringContaining("Agent name must"),
      expect.stringContaining("Agent name must"),
      expect.stringContaining("Agent name must"),
    ]);
  });

  test("validates aliases as executable names", () => {
    // upsertAgentConfig refuses a bad or reserved alias before it reaches the config file.
    const out = runNameChecks();
    expect(out.slice(5, 7).map((r) => r.ok)).toEqual([true, true]);
    expect(out.slice(7, 9).map((r) => r.error)).toEqual([
      expect.stringContaining("Alias must"),
      expect.stringContaining("Alias must"),
    ]);
    expect(out[9].error).toContain("reserved");
  });

  test("honors KINU_HOME before falling back to the OS home", () => {
    const home = scratchDir("cli-home");
    const kinuHome = scratchDir("cli-config");

    const script = "import { AGENT_HOME } from './packages/cli/src/config.ts'; console.log(AGENT_HOME);";

    const proc = Bun.spawnSync({
      cmd: [process.execPath, "-e", script],
      cwd: resolve(__dirname, "../../.."),
      env: {
        ...process.env,
        HOME: home,
        KINU_HOME: kinuHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString().trim()).toBe(resolve(kinuHome));
  });

  test("requireAuthConfig enforces token expiry", () => {
    const expired = runRequireAuth(new Date(Date.now() - 60_000).toISOString());
    expect(expired.stdout.toString()).toContain("session has expired");

    const valid = runRequireAuth(new Date(Date.now() + 60_000).toISOString());
    expect(valid.stdout.toString().trim()).toBe("ok");
  });

  test("KINU_TOKEN env wins over the stored session, even an expired one", () => {
    const ciToken = `pta_${"0".repeat(32)}_${"a".repeat(44)}`;
    const result = runRequireAuth(new Date(Date.now() - 60_000).toISOString(), ciToken);
    expect(result.stdout.toString().trim()).toBe(`ok ${ciToken}`);
  });

  test("model and effort selections update the account-wide default tier", () => {
    const out = runPreferenceWrite();
    expect(out.modelResult).toEqual({ kind: "model-set", spec: "openai/gpt-5.5" });
    const profile = v.parse(ProfileCatalogEnvelopeSchema, out.config.localProfile);
    expect(profile.catalog.tiers.default).toEqual({
      model: 'openai/gpt-5.5',
      reasoningEffort: 'high',
    });
    expect(out.effortShow).toMatchObject({
      kind: 'text',
      text: expect.stringContaining('Default-tier reasoning effort: medium'),
    });
    expect(out.effortSet).toEqual({ kind: "effort-set", effort: "high" });
    expect(out.invalid).toMatchObject({ kind: "text", text: expect.stringContaining("Usage") });
    // One invalid field is reported, not replaced by defaults that would read as a first run.
    expect(out.invalidRejection).toContain('is not a valid Kinu config');
  });

  test("a published workspace is readable once its WAL sidecars are gone", () => {
    // The shape `kinu create` leaves: a checkpointed WAL database without `-wal`/`-shm`. SQLite must
    // create the `-shm`, so a readonly open fails with "unable to open database file".
    const dir = scratchDir("cli-wal-read");
    const dbPath = join(dir, "agent.db");
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    const rt = createCLIRuntime(db, { dbPath, llm: null, agentName: 'Smokey' });
    rt.actor.config.setDisplayName('Smokey');
    const identityId = readWorkspaceIdentityId(dbPath);
    db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
    db.close();
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });

    expect(readWorkspaceIdentityId(dbPath)).toBe(identityId);
    expect(readWorkspaceDisplayName(dbPath)).toBe("Smokey");
  });
});

const CLOUD_ORIGIN = "https://kinu.example.com";

const CLOUD_TOKEN = ["ptc_", "0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz"].join("");

describe("resolveLLMConfig — signed-in Cloudflare AI", () => {
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

    const partner = runResolveLLM({ origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN, model: "workers-ai/minimax/m3" });
    expect(partner).toMatchObject({ name: "workers-ai", model: "minimax/m3" });

    const gateway = runResolveLLM({ origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN, model: "my-gateway/openai/gpt-4.1" });
    expect(gateway).toMatchObject({ name: "workers-ai", model: DEFAULT_WORKERS_AI_MODEL_ID });
  });

  test("signed-in Cloudflare AI remains the default when unrelated BYO keys exist", () => {
    const out = runResolveLLM({
      origin: CLOUD_ORIGIN,
      accessToken: CLOUD_TOKEN,
      providers: { openai: { apiKey: "sk-test" } },
    });

    expect(out).toMatchObject({ name: "workers-ai", model: DEFAULT_WORKERS_AI_MODEL_ID });
  });

  // Item 11.2: with every BYO credential and no chosen model, the native Workers AI model still wins.
  test("no chosen model lands on the native default however many BYO credentials are stored", () => {
    const out = runResolveLLM({
      origin: CLOUD_ORIGIN,
      accessToken: CLOUD_TOKEN,
      providers: {
        codex: { accessToken: "codex-token", refreshToken: "codex-refresh" },
        openai: { apiKey: "sk-test" },
        openrouter: { apiKey: "or-test" },
        anthropic: { apiKey: "ant-test" },
        openaiCompat: { default: { baseURL: "http://localhost:11434/v1", apiKey: "local" } },
      },
    });

    expect(out).toEqual({
      name: "workers-ai",
      baseURL: `${CLOUD_ORIGIN}/api/user/ai/v1`,
      headers: { Authorization: `Bearer ${CLOUD_TOKEN}` },
      model: DEFAULT_WORKERS_AI_MODEL_ID,
    });
  });

  // A local Ollama accepts `@cf/deepseek-ai/…` and serves something else, so the local endpoint
  // must never answer for a spec the signed-in account owns.
  test("a local openai-compatible endpoint cannot answer for a native spec", () => {
    const compat = { default: { baseURL: "http://localhost:11434/v1", apiKey: "local" } };

    for (const model of [
      `workers-ai/${DEFAULT_WORKERS_AI_MODEL_ID}`,
      DEFAULT_WORKERS_AI_MODEL_ID,
      "my-gateway/openai/gpt-4.1",
    ]) {
      const out = runResolveLLM({
        origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN, model, providers: { openaiCompat: compat },
      });

      expect(out).toMatchObject({ name: "workers-ai", baseURL: `${CLOUD_ORIGIN}/api/user/ai/v1` });
    }

    const local = runResolveLLM({
      origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN,
      model: "openai-compat/gpt-oss:20b", providers: { openaiCompat: compat },
    });

    expect(local).toMatchObject({ name: "openai-compat", baseURL: "http://localhost:11434/v1", model: "gpt-oss:20b" });
  });

  test("an explicit model selection still overrides the signed-in default", () => {
    const out = runResolveLLM({
      origin: CLOUD_ORIGIN,
      accessToken: CLOUD_TOKEN,
      model: "openai/gpt-5.5",
      providers: { openai: { apiKey: "sk-test" } },
    });

    expect(out).toMatchObject({ name: "openai", model: "gpt-5.5" });
  });

  test("an explicit direct endpoint keeps precedence over the signed-in proxy", () => {
    const out = runResolveLLM(
      { origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN },
      { KINU_BASE_URL: "https://gateway.example/v1", KINU_AUTH: "Bearer direct" },
    );

    expect(out).toMatchObject({ name: "openai-compat", baseURL: "https://gateway.example/v1" });
  });

});

describe("resolveLLMConfig — registry-only providers", () => {
  const registryOnly = [
    {
      name: "a claude-subscription spec resolves without any other provider",
      spec: "claude/claude-sonnet-4-x", provider: "claude", model: "claude-sonnet-4-x",
    },
    {
      name: "an opencode spec resolves through its bridge marker",
      spec: "opencode/openai/gpt-5.6-sol", provider: "opencode", model: "openai/gpt-5.6-sol",
    },
  ];

  for (const registry of registryOnly) {
    test(registry.name, () => {
      const out = runResolveLLM({}, { KINU_MODEL: registry.spec });
      expect(out).toEqual({ name: registry.provider, baseURL: "", headers: {}, model: registry.model });
    });
  }

  test("nothing configured — signed out or expired — resolves to null", () => {
    expect(runResolveLLM({})).toBeNull();

    const expired = runResolveLLM({
      origin: CLOUD_ORIGIN,
      accessToken: CLOUD_TOKEN,
      tokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(expired).toBeNull();
  });

  test("requireLLMConfig still names the fixes when an endpoint is mandatory", () => {
    const kinuHome = scratchDir("cli-llm-req");
    writeFileSync(join(kinuHome, "config.json"), JSON.stringify({}), { mode: 0o600 });

    const script = `
      import { requireLLMConfig } from './packages/cli/src/config.ts';
      try { console.log(JSON.stringify(requireLLMConfig())); }
      catch (err) { console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) })); }
    `;

    const env: NodeJS.ProcessEnv = { ...process.env, KINU_HOME: kinuHome };

    for (const name of [
      "KINU_TOKEN", "KINU_ORIGIN", "KINU_MODEL", "KINU_BASE_URL", "KINU_AUTH",
      "AI_GATEWAY_BASE_URL", "AI_GATEWAY_AUTH", "AI_GATEWAY_MODEL",
      "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "CODEX_ACCESS_TOKEN",
    ]) delete env[name];

    const proc = Bun.spawnSync({
      cmd: [process.execPath, "-e", script],
      cwd: resolve(__dirname, "../../.."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(0);
    expect(parseJsonValue(proc.stdout.toString())).toMatchObject({
      error: expect.stringContaining("claude"),
    });
  });
});

/** resolveLLMConfig in a clean subprocess (config.ts binds KINU_HOME at import). */
function runResolveLLM(config: JsonObject, extraEnv: Record<string, string> = {}): JsonValue {
  const kinuHome = scratchDir("cli-llm");
  writeFileSync(join(kinuHome, "config.json"), JSON.stringify(config), { mode: 0o600 });

  const script = `
    import { resolveLLMConfig } from './packages/cli/src/config.ts';
    try { console.log(JSON.stringify(resolveLLMConfig())); }
    catch (err) { console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) })); }
  `;

  const env: NodeJS.ProcessEnv = { ...process.env, KINU_HOME: kinuHome, ...extraEnv };

  for (const name of [
    "KINU_TOKEN", "KINU_ORIGIN", "KINU_MODEL", "KINU_BASE_URL", "KINU_AUTH",
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

  return parseJsonValue(proc.stdout.toString());
}

function runRequireAuth(tokenExpiresAt: string, envToken?: string) {
  const kinuHome = scratchDir("cli-auth");
  writeFileSync(
    join(kinuHome, "config.json"),
    JSON.stringify({ accessToken: "ptc_test", tokenExpiresAt }),
    { mode: 0o600 },
  );

  const script = `
    import { requireAuthConfig } from './packages/cli/src/config.ts';
    try { const auth = requireAuthConfig(); console.log(process.env.KINU_TOKEN ? 'ok ' + auth.token : 'ok'); }
    catch (err) { console.log(err instanceof Error ? err.message : String(err)); }
  `;

  const env: NodeJS.ProcessEnv = { ...process.env, KINU_HOME: kinuHome };

  if (envToken) env.KINU_TOKEN = envToken;
  else delete env.KINU_TOKEN;

  return Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: resolve(__dirname, "../../.."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

interface NameCheck {
  ok: boolean;
  error: string | null;
}

function runNameChecks(): NameCheck[] {
  const kinuHome = scratchDir("cli-names");

  const script = `
    import { agentDir, upsertAgentConfig } from './packages/cli/src/config.ts';
    const results = [];
    const check = (fn) => {
      try { fn(); results.push({ ok: true, error: null }); }
      catch (error) { results.push({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    };
    check(() => agentDir("jarvis"));
    check(() => agentDir("build-agent_2"));
    check(() => agentDir("../outside"));
    check(() => agentDir("bad/name"));
    check(() => agentDir(".hidden"));
    const withAlias = (alias) => () => upsertAgentConfig({ name: "jarvis", mode: "local", alias });
    check(withAlias("jarvis"));
    check(withAlias("jarvis-2"));
    check(withAlias("../outside"));
    check(withAlias("bad/name"));
    check(withAlias("kinu"));
    console.log(JSON.stringify(results));
  `;

  const proc = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: resolve(__dirname, "../../.."),
    env: { ...process.env, KINU_HOME: kinuHome },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(proc.exitCode).toBe(0);

  return JSON.parse(proc.stdout.toString());
}

interface PreferenceWriteResult {
  modelResult: JsonValue;
  effortShow: JsonValue;
  effortSet: JsonValue;
  invalid: JsonValue;
  config: JsonObject;
  invalidRejection: string | null;
}

const PreferenceWriteResultSchema: v.GenericSchema<PreferenceWriteResult> = v.object({
  modelResult: JsonValueSchema,
  effortShow: JsonValueSchema,
  effortSet: JsonValueSchema,
  invalid: JsonValueSchema,
  config: JsonObjectSchema,
  invalidRejection: v.nullable(v.string()),
});

function runPreferenceWrite(): PreferenceWriteResult {
  const kinuHome = scratchDir("cli-preferences");

  const script = `
    import { writeFileSync } from 'node:fs';
    import { CONFIG_PATH, loadConfigFile } from './packages/cli/src/config.ts';
    import { executeSlashCommand } from './packages/cli/src/slash-commands.ts';
    const client = {};
    const modelResult = await executeSlashCommand(client, '/model openai/gpt-5.5');
    const effortShow = await executeSlashCommand(client, '/effort');
    const effortSet = await executeSlashCommand(client, '/effort high');
    const invalid = await executeSlashCommand(client, '/effort extreme');
    const config = loadConfigFile();
    writeFileSync(CONFIG_PATH, JSON.stringify({ ...config, reasoningEffort: 'extreme' }));
    let invalidRejection: string | null = null;
    try { loadConfigFile(); } catch (error) { invalidRejection = error instanceof Error ? error.message : String(error); }
    console.log(JSON.stringify({ modelResult, effortShow, effortSet, invalid, config, invalidRejection }));
  `;

  const proc = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: resolve(__dirname, "../../.."),
    env: { ...process.env, KINU_HOME: kinuHome },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(proc.exitCode).toBe(0);

  return v.parse(PreferenceWriteResultSchema, JSON.parse(proc.stdout.toString()));
}

// The raw CLI token is the only copy (the server stores a hash), so a failed revoke must keep it.
describe("a logout the server could not be told about", () => {
  const TOKEN = `ptc_${"0".repeat(32)}_abcdefghijklmnopqrstuvwxyz`;

  function logoutHome(origin: string): string {
    const home = scratchDir("logout-home");
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ origin, accessToken: TOKEN, tokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
      { mode: 0o600 },
    );

    return home;
  }

  function storedConfig(home: string): JsonObject {
    return v.parse(JsonObjectSchema, parseJsonValue(readFileSync(join(home, "config.json"), "utf8")));
  }

  async function runLogout(home: string, origin: string) {
    const script = `
      const { logoutCommand } = await import('./packages/cli/src/commands/auth.ts');
      await logoutCommand({ origin: ${JSON.stringify(origin)} });
    `;

    const proc = Bun.spawn({
      cmd: [process.execPath, "-e", script],
      cwd: resolve(__dirname, "../../.."),
      env: { ...process.env, KINU_HOME: home, NO_COLOR: "1", KINU_TOKEN: "" },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    await proc.exited;

    return stdout + stderr;
  }

  test("keeps the only copy of the bearer, records the pending revocation, and clears both on a retry that lands", async () => {
    let reachable = false;

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        if (new URL(request.url).pathname !== "/api/cli/logout") return new Response("no", { status: 404 });

        return reachable
          ? Response.json({ ok: true })
          : new Response('{"error":"the session store is unavailable"}', { status: 503 });
      },
    });

    const origin = `http://127.0.0.1:${server.port}`;
    const home = logoutHome(origin);

    try {
      const refused = await runLogout(home, origin);
      expect(refused).toContain("Not signed out");

      const stranded = storedConfig(home);
      // The token survives: it is the only thing that can still revoke the session.
      expect(stranded.accessToken).toBe(TOKEN);
      expect(stranded.pendingRevocation).toMatchObject({ token: TOKEN, origin });

      reachable = true;
      const landed = await runLogout(home, origin);
      expect(landed).toContain("Signed out");

      const after = storedConfig(home);
      expect(after.accessToken).toBeUndefined();
      expect(after.pendingRevocation).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });
});
