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
 *   CLOUDFLARE_AI_MODEL=@cf/moonshotai/kimi-k2.6
 *
 * Run:
 *   bun packages/cf-backend/scripts/workers-ai-rest-poc.ts
 */

const accountId = cleanEnv("CLOUDFLARE_ACCOUNT_ID");
const token = cleanEnv("CLOUDFLARE_API_TOKEN")
  ?? cleanEnv("CLOUDFLARE_OAUTH_ACCESS_TOKEN")
  ?? cleanEnv("AI_GATEWAY_AUTH")?.replace(/^Bearer\s+/i, "");
const gatewayId = cleanEnv("CLOUDFLARE_AI_GATEWAY_ID") ?? "default";
const model = cleanEnv("CLOUDFLARE_AI_MODEL") ?? "@cf/moonshotai/kimi-k2.6";

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
let body: unknown = text;
try {
  body = JSON.parse(text);
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

function summarize(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  return {
    id: obj.id,
    object: obj.object,
    created: obj.created,
    usage: obj.usage,
    content: message?.content ?? first?.text ?? null,
    errors: obj.errors,
    messages: obj.messages,
  };
}
