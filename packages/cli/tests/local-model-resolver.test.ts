// createConfiguredLocalModelResolver — the CLI's composition of config.ts +
// the cli-backend registry. Signed in with zero BYO keys, a local agent must
// list the worker's model menu and run inference through /api/user/ai/v1 with
// the CLI bearer and the per-agent affinity pin (signed-in-equals-working).
// Runs in a subprocess because config.ts binds PROTEUS_HOME at import; the
// fake worker lives in this process and records what reaches the wire.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_WORKERS_AI_MODEL_SPEC } from "@proteus/core";

const CLOUD_TOKEN = "ptc_0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createConfiguredLocalModelResolver — signed in, no BYO keys", () => {
  test("lists the worker menu and runs a turn through the AI proxy with bearer + affinity", async () => {
    const requests: Array<{ path: string; auth: string | null; affinity: string | null; model?: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const entry = {
          path,
          auth: request.headers.get("authorization"),
          affinity: request.headers.get("x-session-affinity"),
        };
        if (path === "/api/cli/models") {
          requests.push(entry);
          return Response.json({
            models: [
              {
                spec: DEFAULT_WORKERS_AI_MODEL_SPEC, label: "Kimi K2.6", provider: "workers-ai",
                capabilities: ["tools", "streaming"], contextWindow: 262144,
              },
              { spec: "my-gateway/openai/gpt-4.1", label: "GPT-4.1", provider: "my-gateway", contextWindow: 1047576 },
            ],
            failures: [],
          });
        }
        if (path === "/api/user/ai/v1/chat/completions") {
          const body = await request.json() as { model?: unknown };
          requests.push({ ...entry, model: body.model });
          return Response.json({
            id: "chatcmpl-1", object: "chat.completion", created: 0, model: String(body.model),
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        }
        return new Response("unexpected", { status: 500 });
      },
    });

    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const proteusHome = mkdtempSync(join(tmpdir(), "proteus-cli-resolver-"));
      tempDirs.push(proteusHome);
      writeFileSync(join(proteusHome, "config.json"), JSON.stringify({ origin, accessToken: CLOUD_TOKEN }), { mode: 0o600 });

      const script = `
        import { generateText } from 'ai';
        import { createConfiguredLocalModelResolver } from './packages/cli/src/local-model-resolver.ts';
        const { llmConfig, resolver } = createConfiguredLocalModelResolver({ agentName: 'jarvis' });
        const providers = await resolver.listProviders();
        const { models } = await resolver.listModels();
        const turn = await generateText({ model: resolver.resolveModel(null), prompt: 'ping' });
        console.log(JSON.stringify({
          llmName: llmConfig.name,
          defaultSpec: resolver.normalizeSpecSync(null),
          providers: providers.filter((p) => ['workers-ai', 'my-gateway'].includes(p.id))
            .map((p) => ({ id: p.id, available: p.available })),
          gatewayContextWindow: models.find((m) => m.provider === 'my-gateway')?.contextWindow,
          text: turn.text,
        }));
      `;
      const env: Record<string, string | undefined> = { ...process.env, PROTEUS_HOME: proteusHome };
      for (const name of [
        "PROTEUS_TOKEN", "PROTEUS_ORIGIN", "PROTEUS_MODEL", "PROTEUS_BASE_URL", "PROTEUS_AUTH",
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

      expect(proc.stderr.toString()).toBe("");
      expect(proc.exitCode).toBe(0);
      expect(JSON.parse(proc.stdout.toString())).toEqual({
        llmName: "workers-ai",
        defaultSpec: DEFAULT_WORKERS_AI_MODEL_SPEC,
        providers: [
          { id: "workers-ai", available: true },
          { id: "my-gateway", available: true },
        ],
        gatewayContextWindow: 1047576,
        text: "ok",
      });

      const completion = requests.find((r) => r.path === "/api/user/ai/v1/chat/completions");
      expect(completion).toMatchObject({
        auth: `Bearer ${CLOUD_TOKEN}`,
        affinity: "proteus-jarvis",
        model: "@cf/moonshotai/kimi-k2.6",
      });
      for (const request of requests) expect(request.auth).toBe(`Bearer ${CLOUD_TOKEN}`);
    } finally {
      server.stop(true);
    }
  });
});
