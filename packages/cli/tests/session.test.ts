import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createCliSession,
  findTranscriptPath,
  listCliSessions,
  readCliSessionTranscript,
  transcriptMessages,
} from "../src/session";
import { SessionRecorder } from "../src/session-recorder";
import type { AgentClientEvent } from "../src/agent-client";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempTranscriptDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kinu-transcripts-"));
  tempDirs.push(dir);
  return dir;
}

describe("CLI transcripts", () => {
  test("records the durable conversation id separately from the transcript id", () => {
    const dir = tempTranscriptDir();
    const conversationId = "default";
    const session = createCliSession("jarvis", { transcriptDir: dir, conversationId });
    session.append("user", { text: "hello" });
    session.append("assistant", { text: "hi" });

    // A later process records a NEW artifact under the SAME conversation id:
    // transcripts are diagnostics, never conversations to reopen.
    const next = createCliSession("jarvis", { transcriptDir: dir, conversationId });
    expect(next.id).not.toBe(session.id);
    expect(next.conversationId).toBe(conversationId);

    const infos = listCliSessions("jarvis", { transcriptDir: dir });
    expect(infos.map((info) => info.id).sort()).toEqual([session.id, next.id].sort());
    expect(infos.every((info) => info.conversationId === conversationId)).toBe(true);
  });

  test("noTranscript records nothing on disk", () => {
    const dir = tempTranscriptDir();
    const session = createCliSession("jarvis", { transcriptDir: dir, noTranscript: true });
    expect(session.mode).toBe("none");
    expect(session.append("user", { text: "hello" })).toBeNull();

    expect(listCliSessions("jarvis", { transcriptDir: dir })).toEqual([]);
    expect(findTranscriptPath("jarvis", session.id, { transcriptDir: dir })).toBeNull();
  });

  test("hydrates recorded turns into TUI messages", () => {
    const dir = tempTranscriptDir();
    const session = createCliSession("jarvis", { transcriptDir: dir, conversationId: "default" });
    session.append("user", { text: "build it" });
    session.append("tool_call", { toolName: "workspace.writeFile", args: { path: "a.ts" } });
    session.append("tool_result", { toolName: "workspace.writeFile", result: "ok" });
    session.append("assistant", { text: "done" });

    const transcript = readCliSessionTranscript("jarvis", session.id, { transcriptDir: dir });
    const messages = transcriptMessages(transcript.entries);

    expect(messages.map((message) => message.role)).toEqual(["user", "tool_call", "tool_result", "assistant"]);
    expect(messages.at(-1)?.content).toBe("done");
  });

  test("recorder persists text and tool calls in chronological order", () => {
    const dir = tempTranscriptDir();
    const session = createCliSession("jarvis", { transcriptDir: dir, conversationId: "default" });
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
      { type: "tool-result", toolName: "write_file", toolCallId: "tc-2", result: "failed", success: false },
      { type: "text-delta", delta: "third text" },
      { type: "turn-end", turn: { text: turnText, toolCalls: [], steps: 2, durationMs: 1, hadError: false } },
    ];
    for (const event of events) recorder.record(session, event);

    const transcript = readCliSessionTranscript("jarvis", session.id, { transcriptDir: dir });
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
    expect(messages.filter((m) => m.role === "tool_result").map((m) => m.success))
      .toEqual([true, false]);
  });

  test("recorder falls back to turn.text when no deltas streamed", () => {
    const dir = tempTranscriptDir();
    const session = createCliSession("jarvis", { transcriptDir: dir, conversationId: "default" });
    const recorder = new SessionRecorder("local");
    // The backend synthesized text without streaming deltas (ended on a tool).
    for (const event of [
      { type: "turn-start", kind: "user", text: "go" },
      { type: "tool-call", toolName: "search", toolCallId: "tc-1", args: {} },
      { type: "tool-result", toolName: "search", toolCallId: "tc-1", result: "hit", success: true },
      { type: "turn-end", turn: { text: "synthesized answer", toolCalls: [], steps: 1, durationMs: 1, hadError: false } },
    ] satisfies AgentClientEvent[]) recorder.record(session, event);

    const transcript = readCliSessionTranscript("jarvis", session.id, { transcriptDir: dir });
    const messages = transcriptMessages(transcript.entries);
    expect(messages.map((m) => m.role)).toEqual(["tool_call", "tool_result", "assistant"]);
    expect(messages.at(-1)?.content).toBe("synthesized answer");
  });

  test("skips malformed headers when listing and locating", () => {
    const dir = tempTranscriptDir();
    const agentDir = join(dir, "jarvis");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "bad.jsonl"), `${JSON.stringify({ type: "session", version: 1 })}\n`);

    expect(listCliSessions("jarvis", { transcriptDir: dir })).toEqual([]);
    expect(findTranscriptPath("jarvis", "bad", { transcriptDir: dir })).toBe(agentDir + "/bad.jsonl");
  });

  test("locates one transcript by exact id or path, never by selection", () => {
    const dir = tempTranscriptDir();
    const agentDir = join(dir, "jarvis");
    mkdirSync(agentDir, { recursive: true });
    writeSession(agentDir, "20260101T000000-abc111", "conv-a");

    const byId = findTranscriptPath("jarvis", "20260101T000000-abc111", { transcriptDir: dir });
    expect(byId).toBe(join(agentDir, "20260101T000000-abc111.jsonl"));
    if (byId === null) throw new Error("expected the seeded transcript path");
    expect(findTranscriptPath("jarvis", byId, { transcriptDir: dir })).toBe(byId);
    expect(findTranscriptPath("jarvis", "missing-id", { transcriptDir: dir })).toBeNull();
    // No prefix matching: a diagnostic lookup either names the artifact or fails.
    expect(findTranscriptPath("jarvis", "20260101", { transcriptDir: dir })).toBeNull();
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
