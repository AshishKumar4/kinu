import { runToExit } from '@kinu.run/test-utils';
import { scratchDir } from '../../test-utils/src/scratch';
import { readFileSync, rmSync, writeFileSync } from "node:fs";

import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKERS_AI_MODEL_ID, JsonObjectSchema, parseJsonValue,
  type JsonObject, type JsonValue,
} from "@kinu.run/core";
import { Database } from "bun:sqlite";
import { createCLIRuntime } from '@kinu.run/cli-backend';
import {
  readWorkspaceDisplayName, readWorkspaceIdentityId,
} from "../src/config";
import * as v from 'valibot';

describe("CLI config safety", () => {
  test("validates local agent names", async () => {
    // agentDir joins the home directory, so a name that could escape it must fail here.
    const out = await runNameChecks();
    expect(out.slice(0, 2).map((r) => r.ok)).toEqual([true, true]);
    expect(out.slice(2, 5).map((r) => r.error)).toEqual([
      expect.stringContaining("Agent name must"),
      expect.stringContaining("Agent name must"),
      expect.stringContaining("Agent name must"),
    ]);
  });

  test("validates aliases as executable names", async () => {
    // upsertAgentConfig refuses a bad or reserved alias before it reaches the config file.
    const out = await runNameChecks();
    expect(out.slice(5, 7).map((r) => r.ok)).toEqual([true, true]);
    expect(out.slice(7, 9).map((r) => r.error)).toEqual([
      expect.stringContaining("Alias must"),
      expect.stringContaining("Alias must"),
    ]);
    expect(out[9].error).toContain("reserved");
  });

  test("honors KINU_HOME before falling back to the OS home", async () => {
    const home = scratchDir("cli-home");
    const kinuHome = scratchDir("cli-config");

    const script = "import { AGENT_HOME } from './packages/cli/src/config.ts'; console.log(AGENT_HOME);";

    const proc = await runToExit([process.execPath, "-e", script], {
      cwd: resolve(__dirname, "../../.."),
      env: {
        ...process.env,
        HOME: home,
        KINU_HOME: kinuHome,
      },
    });

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.trim()).toBe(resolve(kinuHome));
  });

  test("requireAuthConfig enforces token expiry", async () => {
    const expired = await runRequireAuth(new Date(Date.now() - 60_000).toISOString());
    expect(expired.stdout).toContain("session has expired");

    const valid = await runRequireAuth(new Date(Date.now() + 60_000).toISOString());
    expect(valid.stdout.trim()).toBe("ok");
  });

  test("KINU_TOKEN env wins over the stored session, even an expired one", async () => {
    const ciToken = `pta_${"0".repeat(32)}_${"a".repeat(44)}`;
    const result = await runRequireAuth(new Date(Date.now() - 60_000).toISOString(), ciToken);
    expect(result.stdout.trim()).toBe(`ok ${ciToken}`);
  });

  test("one invalid field is reported, not replaced by defaults that would read as a first run", async () => {
    expect(await runInvalidFieldLoad()).toContain('is not a valid Kinu config');
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
  test("derives the worker AI proxy endpoint with the platform default model", async () => {
    const out = await runResolveLLM({ origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN });
    expect(out).toEqual({
      name: "workers-ai",
      baseURL: `${CLOUD_ORIGIN}/api/user/ai/v1`,
      headers: { Authorization: `Bearer ${CLOUD_TOKEN}` },
      model: DEFAULT_WORKERS_AI_MODEL_ID,
    });
  });

  test("honors a configured workers-ai model; non-workers-ai specs keep the default endpoint model", async () => {
    const pinned = await runResolveLLM({ origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN }, { defaultModel: "workers-ai/@cf/meta/llama-4" });
    expect(pinned).toMatchObject({ name: "workers-ai", model: "@cf/meta/llama-4" });

    const partner = await runResolveLLM({ origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN }, { defaultModel: "workers-ai/minimax/m3" });
    expect(partner).toMatchObject({ name: "workers-ai", model: "minimax/m3" });

    const gateway = await runResolveLLM({ origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN }, { defaultModel: "my-gateway/openai/gpt-4.1" });
    expect(gateway).toMatchObject({ name: "workers-ai", model: DEFAULT_WORKERS_AI_MODEL_ID });
  });

  test("signed-in Cloudflare AI remains the default when unrelated BYO keys exist", async () => {
    const out = await runResolveLLM({
      origin: CLOUD_ORIGIN,
      accessToken: CLOUD_TOKEN,
      providers: { openai: { apiKey: "sk-test" } },
    });

    expect(out).toMatchObject({ name: "workers-ai", model: DEFAULT_WORKERS_AI_MODEL_ID });
  });

  // Item 11.2: with every BYO credential and no chosen model, the native Workers AI model still wins.
  test("no chosen model lands on the native default however many BYO credentials are stored", async () => {
    const out = await runResolveLLM({
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
  test("a local openai-compatible endpoint cannot answer for a native spec", async () => {
    const compat = { default: { baseURL: "http://localhost:11434/v1", apiKey: "local" } };

    for (const model of [
      `workers-ai/${DEFAULT_WORKERS_AI_MODEL_ID}`,
      DEFAULT_WORKERS_AI_MODEL_ID,
      "my-gateway/openai/gpt-4.1",
    ]) {
      const out = await runResolveLLM({
        origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN, providers: { openaiCompat: compat },
      }, { defaultModel: model });

      expect(out).toMatchObject({ name: "workers-ai", baseURL: `${CLOUD_ORIGIN}/api/user/ai/v1` });
    }

    const local = await runResolveLLM({
      origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN, providers: { openaiCompat: compat },
    }, { defaultModel: "openai-compat/gpt-oss:20b" });

    expect(local).toMatchObject({ name: "openai-compat", baseURL: "http://localhost:11434/v1", model: "gpt-oss:20b" });
  });

  test("a default tier on a BYO provider overrides the signed-in proxy", async () => {
    const out = await runResolveLLM({
      origin: CLOUD_ORIGIN,
      accessToken: CLOUD_TOKEN,
      providers: { openai: { apiKey: "sk-test" } },
    }, { defaultModel: "openai/gpt-5.5" });

    expect(out).toMatchObject({ name: "openai", model: "gpt-5.5" });
  });

  test("an explicit direct endpoint keeps precedence over the signed-in proxy", async () => {
    const out = await runResolveLLM(
      { origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN },
      { env: { KINU_BASE_URL: "https://gateway.example/v1", KINU_AUTH: "Bearer direct" } },
    );

    expect(out).toMatchObject({ name: "openai-compat", baseURL: "https://gateway.example/v1" });
  });

});

describe("resolveLLMConfig — registry-only providers", () => {
  const registryOnly = [
    {
      name: "a claude-subscription spec resolves without any other provider",
      spec: "claude/claude-opus-4-7", provider: "claude", model: "claude-opus-4-7",
    },
    {
      name: "an opencode spec resolves through its bridge marker",
      spec: "opencode/openai/gpt-5.6-sol", provider: "opencode", model: "openai/gpt-5.6-sol",
    },
  ];

  for (const registry of registryOnly) {
    test(registry.name, async () => {
      const out = await runResolveLLM({}, { env: { KINU_MODEL: registry.spec } });
      expect(out).toEqual({ name: registry.provider, baseURL: "", headers: {}, model: registry.model });
    });
  }

  test("nothing configured — signed out or expired — resolves to null", async () => {
    expect(await runResolveLLM({})).toBeNull();

    const expired = await runResolveLLM({
      origin: CLOUD_ORIGIN,
      accessToken: CLOUD_TOKEN,
      tokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(expired).toBeNull();
  });

  test("requireLLMConfig still names the fixes when an endpoint is mandatory", async () => {
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

    const proc = await runToExit([process.execPath, "-e", script], {
      cwd: resolve(__dirname, "../../.."),
      env,
    });

    expect(proc.exitCode).toBe(0);
    expect(parseJsonValue(proc.stdout)).toMatchObject({
      error: expect.stringContaining("claude"),
    });
  });
});

/** resolveLLMConfig in a clean subprocess (config.ts binds KINU_HOME at import); `defaultModel` is the default tier's. */
async function runResolveLLM(
  config: JsonObject,
  { env: extraEnv = {}, defaultModel }: { env?: Record<string, string>; defaultModel?: string } = {},
): Promise<JsonValue> {
  const kinuHome = scratchDir("cli-llm");
  writeFileSync(join(kinuHome, "config.json"), JSON.stringify(config), { mode: 0o600 });

  const script = `
    import { resolveLLMConfig } from './packages/cli/src/config.ts';
    try { console.log(JSON.stringify(resolveLLMConfig(${JSON.stringify(defaultModel === undefined ? {} : { defaultModel })}))); }
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

  const proc = await runToExit([process.execPath, "-e", script], {
    cwd: resolve(__dirname, "../../.."),
    env,
  });

  expect(proc.exitCode).toBe(0);

  return parseJsonValue(proc.stdout);
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

  return runToExit([process.execPath, "-e", script], {
    cwd: resolve(__dirname, "../../.."),
    env,
  });
}

interface NameCheck {
  ok: boolean;
  error: string | null;
}

async function runNameChecks(): Promise<NameCheck[]> {
  const kinuHome = scratchDir("cli-names");

  const script = `
    import { agentDir, upsertAgentConfig } from './packages/cli/src/config.ts';
    const results = [];
    const check = async (fn) => {
      try { await fn(); results.push({ ok: true, error: null }); }
      catch (error) { results.push({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    };
    await check(() => agentDir("jarvis"));
    await check(() => agentDir("build-agent_2"));
    await check(() => agentDir("../outside"));
    await check(() => agentDir("bad/name"));
    await check(() => agentDir(".hidden"));
    const withAlias = (alias) => () => upsertAgentConfig({ name: "jarvis", mode: "local", alias });
    await check(withAlias("jarvis"));
    await check(withAlias("jarvis-2"));
    await check(withAlias("../outside"));
    await check(withAlias("bad/name"));
    await check(withAlias("kinu"));
    console.log(JSON.stringify(results));
  `;

  const proc = await runToExit([process.execPath, "-e", script], {
    cwd: resolve(__dirname, "../../.."),
    env: { ...process.env, KINU_HOME: kinuHome },
  });

  expect(proc.exitCode).toBe(0);

  return JSON.parse(proc.stdout);
}

/** Loads a config.json whose one field has the wrong type; answers the rejection. */
async function runInvalidFieldLoad(): Promise<string> {
  const kinuHome = scratchDir("cli-invalid-field");
  writeFileSync(join(kinuHome, "config.json"), JSON.stringify({ updateCheck: "sometimes" }), { mode: 0o600 });

  const script = `
    import { loadConfigFile } from './packages/cli/src/config.ts';
    try { loadConfigFile(); console.log('loaded'); } catch (error) { console.log(error instanceof Error ? error.message : String(error)); }
  `;

  const proc = await runToExit([process.execPath, "-e", script], {
    cwd: resolve(__dirname, "../../.."),
    env: { ...process.env, KINU_HOME: kinuHome },
  });

  expect(proc.exitCode).toBe(0);

  return proc.stdout;
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
