/**
 * POC: call Workers AI through Cloudflare's AI Gateway REST API instead of
 * the env.AI binding.
 *
 * Required:
 *   CLOUDFLARE_ACCOUNT_ID=<account id to charge>
 *   CLOUDFLARE_API_TOKEN=<api token or OAuth access token with AI access>
 *
 * Optional:
 *   CLOUDFLARE_AI_GATEWAY_ID=default
 *   CLOUDFLARE_AI_MODEL=@cf/deepseek-ai/deepseek-v4-pro-0813
 *
 * Run:
 *   bun packages/cf-backend/scripts/workers-ai-rest-poc.ts
 */

import {
  DEFAULT_WORKERS_AI_MODEL_ID,
  isJsonObject,
  parseJsonValue,
  type JsonValue,
} from '@proteus/core';

const accountId = cleanEnv("CLOUDFLARE_ACCOUNT_ID");
const token = cleanEnv("CLOUDFLARE_API_TOKEN")
  ?? cleanEnv("CLOUDFLARE_OAUTH_ACCESS_TOKEN")
  ?? cleanEnv("AI_GATEWAY_AUTH")?.replace(/^Bearer\s+/i, "");
const gatewayId = cleanEnv("CLOUDFLARE_AI_GATEWAY_ID") ?? "default";
const model = cleanEnv("CLOUDFLARE_AI_MODEL") ?? DEFAULT_WORKERS_AI_MODEL_ID;

if (!accountId || !token) {
  console.error([
    "Missing required environment.",
    "",
    "Set:",
    "  CLOUDFLARE_ACCOUNT_ID=<account id to charge>",
    "  CLOUDFLARE_API_TOKEN=<api token or OAuth access token with AI access>",
    "",
    "No request was sent.",
  ].join("\n"));
  process.exit(2);
}

const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${token}`,
    "cf-aig-gateway-id": gatewayId,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model,
    messages: [
      {
        role: "user",
        content: "Reply with exactly: Proteus Workers AI REST POC OK",
      },
    ],
    max_tokens: 32,
  }),
});

const text = await response.text();
let body: JsonValue = text;
try {
  body = parseJsonValue(text);
} catch {
  // Keep raw body.
}

console.log(JSON.stringify({
  ok: response.ok,
  status: response.status,
  accountId,
  gatewayId,
  model,
  cfRay: response.headers.get("cf-ray"),
  result: summarize(body),
}, null, 2));

if (!response.ok) process.exit(1);

function cleanEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function summarize(value: JsonValue): JsonValue {
  if (!isJsonObject(value)) return value;
  const choices = Array.isArray(value.choices) ? value.choices : [];
  const first = choices[0];
  const firstObject = first !== undefined && isJsonObject(first) ? first : null;
  const message = firstObject?.message;
  const messageObject = message !== undefined && isJsonObject(message) ? message : null;
  return {
    id: value.id ?? null,
    object: value.object ?? null,
    created: value.created ?? null,
    usage: value.usage ?? null,
    content: messageObject?.content ?? firstObject?.text ?? null,
    errors: value.errors ?? null,
    messages: value.messages ?? null,
  };
}
