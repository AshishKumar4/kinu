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
} from "../src/session.js";
import { renderSessionBrowser, selectSession } from "../src/tui/session-browser.js";

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
