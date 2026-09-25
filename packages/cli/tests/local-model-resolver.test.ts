// Signed in with zero BYO keys, a local agent lists the worker's models and runs inference through
// /api/user/ai/v1 with the CLI bearer and affinity pin. Subprocess: config.ts binds KINU_HOME at import.
import { scratchDir } from '../../test-utils/src/scratch';
import { writeFileSync } from "node:fs";

import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { DEFAULT_WORKERS_AI_MODEL_ID, DEFAULT_WORKERS_AI_MODEL_SPEC } from "@kinu.run/core";
import { JsonObjectSchema } from '@kinu.run/core';
import * as v from 'valibot';

const CLOUD_TOKEN = ["ptc_", "0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz"].join("");

describe("createConfiguredLocalModelResolver — signed in, no BYO keys", () => {
  test("lists the worker menu and runs a turn through the AI proxy with bearer + affinity", async () => {
    const requests: Array<{ path: string; auth: string | null; affinity: string | null; model?: string }> = [];

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
                spec: DEFAULT_WORKERS_AI_MODEL_SPEC, label: "DeepSeek V4 Pro 0813", provider: "workers-ai",
                capabilities: ["tools", "streaming", "reasoning"], contextWindow: 1048576,
              },
              { spec: "my-gateway/openai/gpt-4.1", label: "GPT-4.1", provider: "my-gateway", contextWindow: 1047576 },
            ],
            failures: [],
          });
        }

        if (path === "/api/user/ai/v1/chat/completions") {
          const body = v.parse(JsonObjectSchema, await request.json());
          const model = v.parse(v.string(), body.model);
          requests.push({ ...entry, model });

          return Response.json({
            id: "chatcmpl-1", object: "chat.completion", created: 0, model,
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        }

        return new Response("unexpected", { status: 500 });
      },
    });

    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const kinuHome = scratchDir("cli-resolver");
      writeFileSync(join(kinuHome, "config.json"), JSON.stringify({ origin, accessToken: CLOUD_TOKEN }), { mode: 0o600 });

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

      const env: NodeJS.ProcessEnv = { ...process.env, KINU_HOME: kinuHome };

      for (const name of [
        "KINU_TOKEN", "KINU_ORIGIN", "KINU_MODEL", "KINU_BASE_URL", "KINU_AUTH",
        "AI_GATEWAY_BASE_URL", "AI_GATEWAY_AUTH", "AI_GATEWAY_MODEL",
        "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "CODEX_ACCESS_TOKEN",
      ]) delete env[name];

      const proc = Bun.spawn({
        cmd: [process.execPath, "-e", script],
        cwd: resolve(__dirname, "../../.."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
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
        affinity: "kinu-jarvis",
        model: DEFAULT_WORKERS_AI_MODEL_ID,
      });

      for (const request of requests) expect(request.auth).toBe(`Bearer ${CLOUD_TOKEN}`);
    } finally {
      await server.stop(true);
    }
  });
});

describe("createConfiguredLocalModelResolver — registry-only providers", () => {
  test("a claude-subscription spec resolves and turns on the stored Claude login with no other provider configured", async () => {
    const kinuHome = scratchDir("cli-resolver-claude");
    const login = { accessToken: "sk-ant-oat01-local", refreshToken: "rt-local", expiresAt: Date.now() + 3_600_000 };
    writeFileSync(join(kinuHome, "config.json"), JSON.stringify({ providers: { claude: login } }), { mode: 0o600 });

    const script = `
      (globalThis).AI_SDK_LOG_WARNINGS = false;
      import { generateText } from 'ai';
      import { createConfiguredLocalModelResolver } from './packages/cli/src/local-model-resolver.ts';

      // Anthropic's side of one turn; every other host answers nothing.
      const sent = [];
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (!url.startsWith('https://api.anthropic.com/')) return new Response('{}');
        sent.push(new Headers(init.headers).get('authorization'));
        return Response.json({
          id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-4-7', stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Hello from the subscription.' }], usage: { input_tokens: 3, output_tokens: 6 },
        });
      };

      const { resolver } = createConfiguredLocalModelResolver({ model: 'claude/claude-opus-4-7' });
      const providers = await resolver.listProviders();
      const claude = providers.find((p) => p.id === 'claude');
      const turn = await generateText({ model: resolver.resolveModel('claude/claude-opus-4-7'), prompt: 'ping' });
      console.log(JSON.stringify({ claudeAvailable: claude?.available === true, turn: turn.text, sent }));
    `;

    const env: NodeJS.ProcessEnv = { ...process.env, KINU_HOME: kinuHome };

    for (const name of [
      "KINU_TOKEN", "KINU_ORIGIN", "KINU_MODEL", "KINU_BASE_URL", "KINU_AUTH",
      "AI_GATEWAY_BASE_URL", "AI_GATEWAY_AUTH", "AI_GATEWAY_MODEL",
      "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "CODEX_ACCESS_TOKEN",
    ]) delete env[name];

    const proc = Bun.spawn({
      cmd: [process.execPath, "-e", script],
      cwd: resolve(__dirname, "../../.."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      claudeAvailable: true,
      turn: "Hello from the subscription.",
      sent: ["Bearer sk-ant-oat01-local"],
    });
  });
});
