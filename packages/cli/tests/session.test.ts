import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createCliSession,
  defaultConversationIdForCliOptions,
  listCliSessions,
  readCliSessionTranscript,
  resolveRequestedSession,
  transcriptMessages,
} from "../src/session";
import { renderSessionBrowser, selectSession } from "../src/tui/session-browser";
import { SessionRecorder } from "../src/session-recorder";
import type { AgentClientEvent } from "../src/agent-client";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempSessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "proteus-session-"));
  tempDirs.push(dir);
  return dir;
}

describe("CLI sessions", () => {
  test("records the durable conversation id separately from the transcript id", () => {
    const sessionDir = tempSessionDir();
    const conversationId = defaultConversationIdForCliOptions()!;
    const session = createCliSession("jarvis", { sessionDir, conversationId });
    session.append("user", { text: "hello" });
    session.append("assistant", { text: "hi" });

    const [info] = listCliSessions("jarvis", { sessionDir });
    expect(info?.id).toBe(session.id);
    expect(info?.conversationId).toBe(conversationId);

    const resumed = createCliSession("jarvis", { sessionDir, session: session.id });
    expect(resumed.id).toBe(session.id);
    expect(resumed.conversationId).toBe(conversationId);
  });

  test("hydrates recorded turns into TUI messages", () => {
    const sessionDir = tempSessionDir();
    const session = createCliSession("jarvis", { sessionDir, conversationId: "default" });
    session.append("user", { text: "build it" });
    session.append("tool_call", { toolName: "workspace.writeFile", args: { path: "a.ts" } });
    session.append("tool_result", { toolName: "workspace.writeFile", result: "ok" });
    session.append("assistant", { text: "done" });

    const transcript = readCliSessionTranscript("jarvis", session.id, { sessionDir });
    const messages = transcriptMessages(transcript.entries);

    expect(messages.map((message) => message.role)).toEqual(["user", "tool_call", "tool_result", "assistant"]);
    expect(messages.at(-1)?.content).toBe("done");
  });

  test("recorder persists text and tool calls in chronological order", () => {
    const sessionDir = tempSessionDir();
    const session = createCliSession("jarvis", { sessionDir, conversationId: "default" });
    const recorder = new SessionRecorder("local");
    const turnText = "first text second text third text";
    // A turn that streams: text → tool → text → tool → text.
    const events: AgentClientEvent[] = [
      { type: "turn-start", kind: "user", text: "go" },
      { type: "text-delta", delta: "first text " },
      { type: "tool-call", toolName: "read_file", toolCallId: "tc-1", args: { path: "a.ts" } },
      { type: "tool-result", toolName: "read_file", toolCallId: "tc-1", result: "contents", success: true },
      { type: "text-delta", delta: "second text " },
      { type: "tool-call", toolName: "write_file", toolCallId: "tc-2", args: { path: "b.ts" } },
      { type: "tool-result", toolName: "write_file", toolCallId: "tc-2", result: "ok", success: true },
      { type: "text-delta", delta: "third text" },
      { type: "turn-end", turn: { text: turnText, toolCalls: [], steps: 2, durationMs: 1, hadError: false } },
    ];
    for (const event of events) recorder.record(session, event);

    const transcript = readCliSessionTranscript("jarvis", session.id, { sessionDir });
    const messages = transcriptMessages(transcript.entries);

    // Text segments land at their true positions, NOT regrouped after the tools.
    expect(messages.map((m) => m.role)).toEqual([
      "assistant", "tool_call", "tool_result",
      "assistant", "tool_call", "tool_result",
      "assistant",
    ]);
    expect(messages.filter((m) => m.role === "assistant").map((m) => m.content))
      .toEqual(["first text", "second text", "third text"]);
    expect(messages.filter((m) => m.role === "tool_call").map((m) => m.toolName))
      .toEqual(["read_file", "write_file"]);
  });

  test("recorder falls back to turn.text when no deltas streamed", () => {
    const sessionDir = tempSessionDir();
    const session = createCliSession("jarvis", { sessionDir, conversationId: "default" });
    const recorder = new SessionRecorder("local");
    // The backend synthesized text without streaming deltas (ended on a tool).
    for (const event of [
      { type: "turn-start", kind: "user", text: "go" },
      { type: "tool-call", toolName: "search", toolCallId: "tc-1", args: {} },
      { type: "tool-result", toolName: "search", toolCallId: "tc-1", result: "hit", success: true },
      { type: "turn-end", turn: { text: "synthesized answer", toolCalls: [], steps: 1, durationMs: 1, hadError: false } },
    ] satisfies AgentClientEvent[]) recorder.record(session, event);

    const transcript = readCliSessionTranscript("jarvis", session.id, { sessionDir });
    const messages = transcriptMessages(transcript.entries);
    expect(messages.map((m) => m.role)).toEqual(["tool_call", "tool_result", "assistant"]);
    expect(messages.at(-1)?.content).toBe("synthesized answer");
  });

  test("skips malformed session headers when listing", () => {
    const sessionDir = tempSessionDir();
    const agentDir = join(sessionDir, "jarvis");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "bad.jsonl"), `${JSON.stringify({ type: "session", version: 1 })}\n`);

    expect(listCliSessions("jarvis", { sessionDir })).toEqual([]);
  });

  test("rejects ambiguous session prefixes", () => {
    const sessionDir = tempSessionDir();
    const agentDir = join(sessionDir, "jarvis");
    mkdirSync(agentDir, { recursive: true });
    writeSession(agentDir, "abc111", "conv-a");
    writeSession(agentDir, "abc222", "conv-b");

    expect(() => resolveRequestedSession("jarvis", { sessionDir, session: "abc" })).toThrow("ambiguous");
  });

  test("renders and selects sessions without choosing ambiguous prefixes", () => {
    const sessionDir = tempSessionDir();
    const agentDir = join(sessionDir, "jarvis");
    mkdirSync(agentDir, { recursive: true });
    writeSession(agentDir, "abc111", "conv-a");
    writeSession(agentDir, "abc222", "conv-b");
    const sessions = listCliSessions("jarvis", { sessionDir });

    expect(renderSessionBrowser("resume", sessions)).toContain("Type a number or session id to resume");
    expect(selectSession(sessions, "1")?.info.id).toBe(sessions[0]?.id);
    expect(selectSession(sessions, "abc111")?.info.id).toBe("abc111");
    expect(selectSession(sessions, "abc")).toBeNull();
  });
});

function writeSession(agentDir: string, id: string, conversationId: string): void {
  writeFileSync(join(agentDir, `${id}.jsonl`), `${JSON.stringify({
    type: "session",
    version: 1,
    id,
    agent: "jarvis",
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
    conversationId,
  })}\n`);
}
