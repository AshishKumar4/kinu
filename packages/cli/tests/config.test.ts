import { runToExit, workspaceDatabase } from '@kinu.run/test-utils';
import { scratchDir } from '../../test-utils/src/scratch';
import { readFileSync, rmSync, writeFileSync } from "node:fs";

import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKERS_AI_MODEL_ID, JsonObjectSchema, OPENROUTER_DEFAULT_MODEL, parseJsonValue,
  type JsonObject, type JsonValue,
} from "@kinu.run/core";
import { createCLIRuntime } from '@kinu.run/cli-backend';
import { readWorkspaceDisplayName } from "../src/config";
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

  // Staging walk, 2026-10-08: `list`, `status` and `run` answered with KINU_TOKEN while `whoami` said "Not authenticated".
  test("kinu whoami answers for KINU_TOKEN, as every other command does", async () => {
    const seen: string[] = [];

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(`${new URL(request.url).pathname} ${request.headers.get("authorization") ?? ""}`);

        return Response.json({ user: { id: "u-ci", email: "ci@example.com" } });
      },
    });

    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env, KINU_HOME: scratchDir("cli-whoami"), KINU_ORIGIN: `http://127.0.0.1:${String(server.port)}`, KINU_TOKEN: "pta_ci", NO_COLOR: "1",
      };

      const proc = await runToExit([process.execPath, "packages/cli/bin/cli.ts", "whoami"], { cwd: resolve(__dirname, "../../.."), env });

      expect({ exitCode: proc.exitCode, seen }).toEqual({ exitCode: 0, seen: ["/api/cli/me Bearer pta_ci"] });
      expect(proc.stdout).toContain("ci@example.com");
    } finally {
      await server.stop(true);
    }
  });

  test("kinu auth lists the account's CLI sessions and revokes one or all of them; a bare revoke or another origin ends none", async () => {
    const hash = "a".repeat(64);
    const seen: string[] = [];

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const { pathname } = new URL(request.url);
        seen.push(`${request.method} ${pathname}`);

        if (request.method === "GET") {
          return Response.json({ sessions: [{ tokenHash: hash, label: "studio", createdAt: 1, expiresAt: 2, lastUsedAt: null }] });
        }

        return Response.json(pathname === "/api/cli/sessions" ? { ok: true, revoked: 2 } : { ok: true });
      },
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env, KINU_HOME: scratchDir("cli-auth-sessions"), KINU_ORIGIN: `http://127.0.0.1:${String(server.port)}`, KINU_TOKEN: "ptc_owner", NO_COLOR: "1",
    };

    const auth = (args: string[]) => runToExit([process.execPath, "packages/cli/bin/cli.ts", "auth", ...args], { cwd: resolve(__dirname, "../../.."), env });

    try {
      const listed = await auth(["sessions"]);
      expect(listed.exitCode, listed.stderr).toBe(0);
      expect(listed.stdout).toContain(hash);

      expect((await auth(["revoke"])).exitCode).not.toBe(0);
      // Another deployment's sessions are not this sign-in's to end: refused, and nothing is sent.
      expect((await auth(["revoke", "--all", "--origin", "http://127.0.0.1:9"])).exitCode).not.toBe(0);
      expect((await auth(["revoke", hash])).exitCode).toBe(0);
      const all = await auth(["revoke", "--all"]);
      expect(all.exitCode, all.stderr).toBe(0);
      expect(seen).toEqual(["GET /api/cli/sessions", `DELETE /api/cli/sessions/${hash}`, "DELETE /api/cli/sessions"]);
    } finally {
      await server.stop(true);
    }
  });

  test("one invalid field is reported, not replaced by defaults that would read as a first run", async () => {
    const kinuHome = scratchDir("cli-invalid-field");
    const configPath = join(kinuHome, "config.json");
    const malformed = JSON.stringify({ updateCheck: "sometimes" });

    const list = () => runToExit([process.execPath, "packages/cli/bin/cli.ts", "list"], {
      cwd: resolve(__dirname, "../../.."),
      env: { ...process.env, KINU_HOME: kinuHome, KINU_TOKEN: "", NO_COLOR: "1" },
    });

    writeFileSync(configPath, malformed, { mode: 0o600 });
    const proc = await list();

    expect(proc.exitCode).not.toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(malformed);

    const valid = JSON.stringify({ updateCheck: false });

    writeFileSync(configPath, valid, { mode: 0o600 });
    expect((await list()).exitCode).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(valid);
  });

  test("a published workspace is readable once its WAL sidecars are gone", () => {
    // The shape `kinu create` leaves: a checkpointed WAL database without `-wal`/`-shm`. SQLite must
    // create the `-shm`, so a readonly open fails with "unable to open database file".
    const dir = scratchDir("cli-wal-read");
    const dbPath = join(dir, "agent.db");
    const db = workspaceDatabase(dbPath, { create: true });
    const rt = createCLIRuntime(db, { llm: null, agentName: 'Smokey', cwd: scratchDir('cli-wal-read-folder') });
    rt.actor.config.setDisplayName('Smokey');
    db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
    db.close();
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });

    expect(readWorkspaceDisplayName(dbPath)).toBe("Smokey");
  });
});

const CLOUD_ORIGIN = "https://kinu.example.com";

const CLOUD_TOKEN = ["ptc_", "0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz"].join("");

describe("resolveModelDefaults — signed out, a provider's key alone", () => {
  // The CLI named its own OpenRouter default beside the one the provider declares; the provider's is the one.
  test("an OpenRouter key with no chosen model lands on OpenRouter's own default", async () => {
    const out = await runResolveLLM({ providers: { openrouter: { apiKey: "or-test" } } });

    expect(out).toEqual({ spec: `openrouter/${OPENROUTER_DEFAULT_MODEL}`, endpoint: null });
  });
});

describe("resolveModelDefaults — signed-in Cloudflare AI", () => {
  test("defaults to the platform's Workers AI model, served through the account", async () => {
    const out = await runResolveLLM({ origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN });
    expect(out).toEqual({ spec: `workers-ai/${DEFAULT_WORKERS_AI_MODEL_ID}`, endpoint: null });
  });

  test("honors a configured workers-ai model; non-workers-ai specs keep the platform default", async () => {
    const pinned = await runResolveLLM({ origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN }, { defaultModel: "workers-ai/@cf/meta/llama-4" });
    expect(pinned).toEqual({ spec: "workers-ai/@cf/meta/llama-4", endpoint: null });

    const partner = await runResolveLLM({ origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN }, { defaultModel: "workers-ai/minimax/m3" });
    expect(partner).toEqual({ spec: "workers-ai/minimax/m3", endpoint: null });

    const gateway = await runResolveLLM({ origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN }, { defaultModel: "my-gateway/openai/gpt-4.1" });
    expect(gateway).toEqual({ spec: `workers-ai/${DEFAULT_WORKERS_AI_MODEL_ID}`, endpoint: null });
  });

  test("signed-in Cloudflare AI remains the default when unrelated BYO keys exist", async () => {
    const out = await runResolveLLM({
      origin: CLOUD_ORIGIN,
      accessToken: CLOUD_TOKEN,
      providers: { openai: { apiKey: "sk-test" } },
    });

    expect(out).toEqual({ spec: `workers-ai/${DEFAULT_WORKERS_AI_MODEL_ID}`, endpoint: null });
  });

  // Item 11.2: with every BYO credential and no chosen model, the native Workers AI model still wins.
  test("no chosen model lands on the native default however many BYO credentials are stored", async () => {
    const out = await runResolveLLM({
      origin: CLOUD_ORIGIN,
      accessToken: CLOUD_TOKEN,
      providers: {
        chatgpt: { accessToken: "chatgpt-token", refreshToken: "chatgpt-refresh" },
        openai: { apiKey: "sk-test" },
        openrouter: { apiKey: "or-test" },
        anthropic: { apiKey: "ant-test" },
        openaiCompat: { default: { baseURL: "http://localhost:11434/v1", apiKey: "local" } },
      },
    });

    expect(out).toEqual({ spec: `workers-ai/${DEFAULT_WORKERS_AI_MODEL_ID}`, endpoint: null });
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

      expect(out).toMatchObject({ spec: expect.stringMatching(/^workers-ai\//u), endpoint: null });
    }

    const local = await runResolveLLM({
      origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN, providers: { openaiCompat: compat },
    }, { defaultModel: "openai-compat/gpt-oss:20b" });

    expect(local).toEqual({ spec: "openai-compat/gpt-oss:20b", endpoint: null });
  });

  test("an openai-compatible endpoint's extraHeaders overrides the API key's Authorization", async () => {
    const sends = async (compat: JsonObject, headers: Record<string, string>) => expect(await runCompatAuth({
      providers: { openaiCompat: { default: { baseURL: "http://localhost:11434/v1", ...compat } } },
    })).toEqual({ baseURL: "http://localhost:11434/v1", headers });

    const base = { Authorization: "Bearer base", "X-Base": "b" };

    await sends({ extraHeaders: base }, base);
    await sends({ apiKey: "k", extraHeaders: { "X-Base": "b" } }, { Authorization: "Bearer k", "X-Base": "b" });
    await sends({ apiKey: "k", extraHeaders: base }, base);
  });

  test("a default tier on a BYO provider overrides the signed-in proxy", async () => {
    const out = await runResolveLLM({
      origin: CLOUD_ORIGIN,
      accessToken: CLOUD_TOKEN,
      providers: { openai: { apiKey: "sk-test" } },
    }, { defaultModel: "openai/gpt-5.5" });

    expect(out).toEqual({ spec: "openai/gpt-5.5", endpoint: null });
  });

  test("an explicit direct endpoint keeps precedence over the signed-in proxy", async () => {
    const out = await runResolveLLM(
      { origin: CLOUD_ORIGIN, accessToken: CLOUD_TOKEN },
      { env: { KINU_BASE_URL: "https://gateway.example/v1", KINU_AUTH: "Bearer direct" } },
    );

    // No model named: the endpoint serves Workers AI's default, so the default is spelled as Workers AI's.
    expect(out).toMatchObject({
      spec: `workers-ai/${DEFAULT_WORKERS_AI_MODEL_ID}`,
      endpoint: { name: "openai-compat", baseURL: "https://gateway.example/v1" },
    });
  });

});

describe("resolveModelDefaults — registry-only providers", () => {
  const registryOnly = [
    {
      name: "a claude-subscription spec resolves without any other provider",
      spec: "claude/claude-opus-4-7",
    },
    {
      name: "an opencode spec resolves without any other provider",
      spec: "opencode/openai/gpt-5.6-sol",
    },
  ];

  for (const registry of registryOnly) {
    test(registry.name, async () => {
      const out = await runResolveLLM({}, { env: { KINU_MODEL: registry.spec } });
      expect(out).toEqual({ spec: registry.spec, endpoint: null });
    });
  }

  test("nothing configured — signed out or expired — names no model", async () => {
    expect(await runResolveLLM({})).toEqual({ spec: null, endpoint: null });

    const expired = await runResolveLLM({
      origin: CLOUD_ORIGIN,
      accessToken: CLOUD_TOKEN,
      tokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(expired).toEqual({ spec: null, endpoint: null });
  });

  test("requireModelDefaults names the fixes when a model is mandatory", async () => {
    const kinuHome = scratchDir("cli-llm-req");
    writeFileSync(join(kinuHome, "config.json"), JSON.stringify({}), { mode: 0o600 });

    const script = `
      import { requireModelDefaults } from './packages/cli/src/config.ts';
      try { console.log(JSON.stringify(requireModelDefaults())); }
      catch (err) { console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) })); }
    `;

    const env: NodeJS.ProcessEnv = { ...process.env, KINU_HOME: kinuHome };

    for (const name of [
      "KINU_TOKEN", "KINU_ORIGIN", "KINU_MODEL", "KINU_BASE_URL", "KINU_AUTH",
      "AI_GATEWAY_BASE_URL", "AI_GATEWAY_AUTH", "AI_GATEWAY_MODEL",
      "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY",
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

/** resolveModelDefaults in a clean subprocess (config.ts binds KINU_HOME at import); `defaultModel` is the default tier's. */
async function runResolveLLM(
  config: JsonObject,
  { env: extraEnv = {}, defaultModel }: { env?: Record<string, string>; defaultModel?: string } = {},
): Promise<JsonValue> {
  return runConfigScript(config, extraEnv, `
    import { resolveModelDefaults } from './packages/cli/src/config.ts';
    try { console.log(JSON.stringify(resolveModelDefaults(${JSON.stringify(defaultModel === undefined ? {} : { defaultModel })}))); }
    catch (err) { console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) })); }
  `);
}

/** How a model call reaches the configured OpenAI-compatible endpoint: the resolver's auth for it. */
function runCompatAuth(config: JsonObject): Promise<JsonValue> {
  return runConfigScript(config, {}, `
    import { createConfiguredLocalModelResolver } from './packages/cli/src/local-model-resolver.ts';
    const auth = await createConfiguredLocalModelResolver().resolver.getAuth('openai-compat.default');
    console.log(JSON.stringify(auth));
  `);
}

/** `script` in a clean subprocess over `config` (config.ts binds KINU_HOME at import), its JSON answer. */
async function runConfigScript(config: JsonObject, extraEnv: Record<string, string>, script: string): Promise<JsonValue> {
  const kinuHome = scratchDir("cli-llm");
  writeFileSync(join(kinuHome, "config.json"), JSON.stringify(config), { mode: 0o600 });

  const env: NodeJS.ProcessEnv = { ...process.env, KINU_HOME: kinuHome, ...extraEnv };

  for (const name of [
    "KINU_TOKEN", "KINU_ORIGIN", "KINU_MODEL", "KINU_BASE_URL", "KINU_AUTH",
    "AI_GATEWAY_BASE_URL", "AI_GATEWAY_AUTH", "AI_GATEWAY_MODEL",
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY",
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
    import { agentDir } from './packages/cli/src/config.ts';
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
    console.log(JSON.stringify(results));
  `;

  const proc = await runToExit([process.execPath, "-e", script], {
    cwd: resolve(__dirname, "../../.."),
    env: { ...process.env, KINU_HOME: kinuHome },
  });

  expect(proc.exitCode).toBe(0);

  return JSON.parse(proc.stdout);
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
