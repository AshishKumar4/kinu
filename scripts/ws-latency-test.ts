#!/usr/bin/env bun
/**
 * WebSocket latency test — measures the full path through Kinu:
 * WS connect → send message → first chunk received → complete.
 *
 * Connects to the agent's WebSocket the same way the UI does,
 * sends "say hi", and measures every timing milestone.
 *
 * Usage: bun scripts/ws-latency-test.ts [base-url] [agent-name]
 */

import { tolerate } from "../packages/core/src/obs/index";

const BASE_URL = process.argv[2] ?? "http://localhost:5173";
const AGENT_NAME = process.argv[3] ?? "latency-test-agent";
const TIMEOUT_MS = 120_000;

function wsUrl(): string {
  return BASE_URL.replace(/^http/, "ws") + `/agents/orchestrator-agent/${AGENT_NAME}`;
}

function uid(): string {
  return crypto.randomUUID();
}

interface TimingResult {
  connectMs: number;
  historyReceivedMs: number;
  messageSentMs: number;
  firstWsFrameMs: number;
  firstContentChunkMs: number;
  firstThinkingMs: number;
  firstTextMs: number;
  streamDoneMs: number;
  totalChunks: number;
  firstContentPreview: string;
  error?: string;
}

async function measureChatLatency(message: string): Promise<TimingResult> {
  const t0 = performance.now();
  const result: TimingResult = {
    connectMs: -1,
    historyReceivedMs: -1,
    messageSentMs: -1,
    firstWsFrameMs: -1,
    firstContentChunkMs: -1,
    firstThinkingMs: -1,
    firstTextMs: -1,
    streamDoneMs: -1,
    totalChunks: 0,
    firstContentPreview: "",
  };

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      result.error = `Timeout after ${TIMEOUT_MS}ms`;
      resolve(result);
    }, TIMEOUT_MS);

    const ws = new WebSocket(wsUrl());
    let reqId: string;

    ws.addEventListener("open", () => {
      result.connectMs = performance.now() - t0;
    });

    ws.addEventListener("error", () => {
      result.error = "WebSocket error";
      clearTimeout(timer);
      resolve(result);
    });

    ws.addEventListener("close", () => {
      if (result.streamDoneMs < 0) {
        result.error = result.error ?? "WebSocket closed before stream done";
        clearTimeout(timer);
        resolve(result);
      }
    });

    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));

        // Initial history message
        if (msg.type === "cf_agent_chat_messages" && result.historyReceivedMs < 0) {
          result.historyReceivedMs = performance.now() - t0;
          const historyLen = Array.isArray(msg.messages) ? msg.messages.length : 0;
          console.log(`  [${(result.historyReceivedMs).toFixed(0)}ms] History received (${historyLen} messages)`);

          // Now send the chat message
          reqId = uid();
          const userMessage = {
            id: uid(),
            role: "user",
            parts: [{ type: "text", text: message }],
          };
          ws.send(JSON.stringify({
            type: "cf_agent_use_chat_request",
            id: reqId,
            init: {
              method: "POST",
              body: JSON.stringify({ messages: [userMessage] }),
            },
          }));
          result.messageSentMs = performance.now() - t0;
          console.log(`  [${result.messageSentMs.toFixed(0)}ms] Message sent: "${message}"`);
          return;
        }

        // Stream response chunks
        if (msg.type === "cf_agent_use_chat_response" && msg.id === reqId) {
          result.totalChunks++;

          if (result.firstWsFrameMs < 0) {
            result.firstWsFrameMs = performance.now() - t0;
            console.log(`  [${result.firstWsFrameMs.toFixed(0)}ms] First WS response frame`);
          }

          if (msg.done) {
            result.streamDoneMs = performance.now() - t0;
            console.log(`  [${result.streamDoneMs.toFixed(0)}ms] Stream done (${result.totalChunks} chunks)`);
            clearTimeout(timer);
            ws.close();
            resolve(result);
            return;
          }

          if (msg.error) {
            result.error = `Stream error: ${msg.body}`;
            clearTimeout(timer);
            ws.close();
            resolve(result);
            return;
          }

          // A body chunk is JSON when it carries a typed stream event and plain text otherwise.
          if (msg.body) {
            const chunk = tolerate(() => JSON.parse(msg.body), "malformed-input");
            if (chunk !== undefined) {
              if (result.firstContentChunkMs < 0) {
                result.firstContentChunkMs = performance.now() - t0;
                result.firstContentPreview = JSON.stringify(chunk).slice(0, 120);
                console.log(`  [${result.firstContentChunkMs.toFixed(0)}ms] First content chunk: ${result.firstContentPreview}`);
              }

              // Detect reasoning (thinking) chunks
              if (chunk.type === "reasoning" && result.firstThinkingMs < 0) {
                result.firstThinkingMs = performance.now() - t0;
                const reasoningText = chunk.text ?? chunk.textDelta ?? "";
                console.log(`  [${result.firstThinkingMs.toFixed(0)}ms] First THINKING chunk: "${String(reasoningText).slice(0, 60)}"`);
              }

              // Detect text content chunks
              if (chunk.type === "text-delta" && result.firstTextMs < 0) {
                result.firstTextMs = performance.now() - t0;
                console.log(`  [${result.firstTextMs.toFixed(0)}ms] First TEXT chunk: "${(chunk.textDelta ?? "").slice(0, 60)}"`);
              }
            }
          }
        }
      } catch (error) {
        // A frame this handler cannot process makes every remaining milestone meaningless, so the
        // run reports the reason instead of returning -1s that read as "the model never spoke".
        result.error = `Frame handling failed: ${error instanceof Error ? error.message : String(error)}`;
        clearTimeout(timer);
        ws.close();
        resolve(result);
      }
    });
  });
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Kinu WebSocket Latency Test                             ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`Target: ${BASE_URL}`);
  console.log(`Agent:  ${AGENT_NAME}`);
  console.log(`WS URL: ${wsUrl()}\n`);

  const results: Array<{ label: string; result: TimingResult }> = [];

  // Test 1: Simple "say hi" — minimal inference
  console.log("▶ Test 1: Simple message — 'Say hi'");
  const r1 = await measureChatLatency("Say hi");
  results.push({ label: "Simple (say hi)", result: r1 });
  console.log("");

  // Test 2: Slightly more complex — should trigger tool consideration
  console.log("▶ Test 2: Task message — 'List the files in the workspace'");
  const r2 = await measureChatLatency("List the files in the workspace");
  results.push({ label: "Task (list files)", result: r2 });
  console.log("");

  // Summary
  console.log("╔════════════════════════╦════════╦═══════════╦═══════════╦═══════════╦═══════════╦═════════╗");
  console.log("║ Test                   ║Connect ║ 1st Frame ║1st Content║1st Think  ║ 1st Text  ║  Total  ║");
  console.log("╠════════════════════════╬════════╬═══════════╬═══════════╬═══════════╬═══════════╬═════════╣");
  for (const { label, result: r } of results) {
    const pad = (ms: number) => ms < 0 ? "   N/A" : `${(ms / 1000).toFixed(1)}s`.padStart(6);
    const name = label.padEnd(22);
    console.log(`║ ${name} ║${pad(r.connectMs)}  ║ ${pad(r.firstWsFrameMs)}   ║ ${pad(r.firstContentChunkMs)}   ║ ${pad(r.firstThinkingMs)}   ║ ${pad(r.firstTextMs)}   ║${pad(r.streamDoneMs)}   ║`);
    if (r.error) console.log(`║   ERROR: ${r.error.padEnd(68)}║`);
  }
  console.log("╚════════════════════════╩════════╩═══════════╩═══════════╩═══════════╩═══════════╩═════════╝");

  console.log("\nTiming breakdown (from message sent):");
  for (const { label, result: r } of results) {
    if (r.error) { console.log(`  ${label}: ERROR — ${r.error}`); continue; }
    const sent = r.messageSentMs;
    console.log(`  ${label}:`);
    if (r.firstWsFrameMs > 0) console.log(`    SDK overhead (send → first WS frame): ${(r.firstWsFrameMs - sent).toFixed(0)}ms`);
    if (r.firstContentChunkMs > 0) console.log(`    To first content:                     ${(r.firstContentChunkMs - sent).toFixed(0)}ms`);
    if (r.firstThinkingMs > 0) console.log(`    To first thinking token:              ${(r.firstThinkingMs - sent).toFixed(0)}ms`);
    if (r.firstTextMs > 0) console.log(`    To first text token:                  ${(r.firstTextMs - sent).toFixed(0)}ms`);
    if (r.streamDoneMs > 0) console.log(`    To stream complete:                   ${(r.streamDoneMs - sent).toFixed(0)}ms`);
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
