#!/usr/bin/env bun
/**
 * Fetch the captured API payload from the DO via RPC, analyze it,
 * and dump to /tmp/kinu-payload.json for curl replay testing.
 */

const BASE_URL = process.argv[2] ?? "http://0.0.0.0:5173";
const AGENT_NAME = process.argv[3] ?? "";

if (!AGENT_NAME) {
  console.error("Usage: bun scripts/fetch-payload.ts <base-url> <agent-name>");
  process.exit(1);
}

function wsUrl(): string {
  return BASE_URL.replace(/^http/, "ws") + `/agents/orchestrator-agent/${AGENT_NAME}`;
}

async function main() {
  console.log(`Connecting to ${wsUrl()}...`);

  const ws = new WebSocket(wsUrl());
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Connect timeout")), 10000);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === "cf_agent_chat_messages") { clearTimeout(timer); resolve(); }
    });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WS error")); });
  });
  await ready;
  console.log("Connected. Calling getCapturedPayload()...");

  const result = await new Promise<any>((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => reject(new Error("RPC timeout")), 10000);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === "rpc" && msg.id === id) {
        clearTimeout(timer);
        if (msg.success) resolve(msg.result); else reject(new Error(msg.error));
      }
    });
    ws.send(JSON.stringify({ type: "rpc", id, method: "getCapturedPayload", args: [] }));
  });

  ws.close();

  if (result.error) {
    console.error("Error:", result.error);
    process.exit(1);
  }

  // Write full body to file
  const { writeFileSync } = await import("fs");
  writeFileSync("/tmp/kinu-payload.json", result.fullBody);
  console.log("\nPayload dumped to /tmp/kinu-payload.json");

  // Analyze
  const parsed = JSON.parse(result.fullBody);
  const sysMsg = parsed.messages?.find((m: any) => m.role === "system");
  const userMsgs = parsed.messages?.filter((m: any) => m.role === "user") ?? [];
  const assistantMsgs = parsed.messages?.filter((m: any) => m.role === "assistant") ?? [];

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Payload Analysis                                            ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`Total size:        ${result.sizeBytes} bytes (${(result.sizeBytes / 1024).toFixed(1)} KB)`);
  console.log(`Approx tokens:     ~${result.approxTokens}`);
  console.log(`Model:             ${result.model}`);
  console.log(`Stream:            ${result.stream}`);
  console.log(`\nBreakdown:`);
  console.log(`  System prompt:   ${result.systemPromptChars} chars (${(result.systemPromptChars / 4).toFixed(0)} tokens)`);
  console.log(`  Tool schemas:    ${result.toolCount} tools, ${result.toolSchemaChars} chars (${(result.toolSchemaChars / 4).toFixed(0)} tokens)`);
  console.log(`  Messages:        ${result.messageCount} messages, ${result.messageChars} chars`);
  console.log(`    - system:      1 (${sysMsg?.content?.length ?? 0} chars)`);
  console.log(`    - user:        ${userMsgs.length}`);
  console.log(`    - assistant:   ${assistantMsgs.length}`);

  // Show tool names
  if (parsed.tools?.length) {
    console.log(`\n  Tool names:`);
    for (const t of parsed.tools) {
      const name = t.function?.name ?? t.name ?? "?";
      const descLen = (t.function?.description ?? t.description ?? "").length;
      console.log(`    - ${name} (desc: ${descLen} chars)`);
    }
  }

  // Show first 200 chars of system prompt
  if (sysMsg?.content) {
    console.log(`\n  System prompt (first 300 chars):`);
    console.log(`    ${sysMsg.content.slice(0, 300).replace(/\n/g, "\n    ")}...`);
  }

  console.log(`\nTo replay directly (bypasses gateway cache with unique suffix):`);
  console.log(`  Add a unique string to the user message in /tmp/kinu-payload.json`);
  console.log(`  Then: curl -sN --max-time 120 -X POST "${result.url}" \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -H "Authorization: $AI_GATEWAY_AUTH" \\`);
  console.log(`    -d @/tmp/kinu-payload.json -w '\\nTTFB: %{time_starttransfer}s\\n'`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
