import { scratchDir } from '../../test-utils/src/scratch';
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { runToExit } from "@kinu.run/test-utils";
import {
  createCliSession,
  listTranscripts,
} from "../src/session";
import { SessionRecorder } from "../src/session-recorder";
import type { AgentClientEvent } from "../src/agent-client";

function tempTranscriptDir(): string {
  const dir = scratchDir("transcripts");

  return dir;
}

const RecordedEntrySchema = v.looseObject({
  type: v.string(),
  text: v.optional(v.string()),
  toolName: v.optional(v.string()),
  success: v.optional(v.boolean()),
});

/** What the recorder wrote, in file order, read from the JSONL artifact itself. */
function recordedEntries(dir: string, id: string): Array<v.InferOutput<typeof RecordedEntrySchema>> {
  const path = listTranscripts("jarvis", { transcriptDir: dir }).find((info) => info.id === id)?.path;

  if (path === undefined) throw new Error(`no transcript ${id}`);

  return readFileSync(path, "utf8").split("\n").filter(Boolean)
    .map((line) => v.parse(RecordedEntrySchema, JSON.parse(line)))
    .filter((entry) => entry.type !== "session");
}

describe("CLI transcripts", () => {
  test("records the durable conversation id separately from the transcript id", () => {
    const dir = tempTranscriptDir();
    const conversationId = "default";
    const session = createCliSession("jarvis", { transcriptDir: dir, conversationId });
    session.append("user", { text: "hello" });
    session.append("assistant", { text: "hi" });

    // Transcripts are diagnostics, never conversations to reopen: a later process records a new artifact.
    const next = createCliSession("jarvis", { transcriptDir: dir, conversationId });
    expect(next.id).not.toBe(session.id);
    expect(next.conversationId).toBe(conversationId);

    const infos = listTranscripts("jarvis", { transcriptDir: dir });
    expect(infos.map((info) => info.id).sort()).toEqual([session.id, next.id].sort());
    expect(infos.every((info) => info.conversationId === conversationId)).toBe(true);
  });

  test("noTranscript records nothing on disk", () => {
    const dir = tempTranscriptDir();
    const session = createCliSession("jarvis", { transcriptDir: dir, noTranscript: true });
    expect(session.mode).toBe("none");
    expect(session.append("user", { text: "hello" })).toBeNull();

    expect(listTranscripts("jarvis", { transcriptDir: dir })).toEqual([]);
  });

  test("recorder persists text and tool calls in chronological order", () => {
    const dir = tempTranscriptDir();
    const session = createCliSession("jarvis", { transcriptDir: dir, conversationId: "default" });
    const recorder = new SessionRecorder("local");
    const turnText = "first text second text third text";

    const events: AgentClientEvent[] = [
      { type: "turn-start", kind: "user", text: "go" },
      { type: "text-delta", delta: "first text " },
      { type: "tool-call", toolName: "read_file", toolCallId: "tc-1", args: { path: "a.ts" } },
      { type: "tool-result", toolName: "read_file", toolCallId: "tc-1", result: "contents", success: true },
      { type: "text-delta", delta: "second text " },
      { type: "tool-call", toolName: "write_file", toolCallId: "tc-2", args: { path: "b.ts" } },
      { type: "tool-result", toolName: "write_file", toolCallId: "tc-2", result: "failed", success: false, reason: null },
      { type: "text-delta", delta: "third text" },
      { type: "turn-end", turn: { text: turnText, toolCalls: [], steps: 2, durationMs: 1, hadError: false } },
    ];

    for (const event of events) recorder.record(session, event);

    const entries = recordedEntries(dir, session.id);

    expect(entries.map((entry) => entry.type)).toEqual([
      "assistant", "tool_call", "tool_result",
      "assistant", "tool_call", "tool_result",
      "assistant",
    ]);
    expect(entries.filter((entry) => entry.type === "assistant").map((entry) => entry.text?.trim()))
      .toEqual(["first text", "second text", "third text"]);
    expect(entries.filter((entry) => entry.type === "tool_call").map((entry) => entry.toolName))
      .toEqual(["read_file", "write_file"]);
    expect(entries.filter((entry) => entry.type === "tool_result").map((entry) => entry.success))
      .toEqual([true, false]);
  });

  test("recorder falls back to turn.text when no deltas streamed", () => {
    const dir = tempTranscriptDir();
    const session = createCliSession("jarvis", { transcriptDir: dir, conversationId: "default" });
    const recorder = new SessionRecorder("local");

    for (const event of [
      { type: "turn-start", kind: "user", text: "go" },
      { type: "tool-call", toolName: "search", toolCallId: "tc-1", args: {} },
      { type: "tool-result", toolName: "search", toolCallId: "tc-1", result: "hit", success: true },
      { type: "turn-end", turn: { text: "synthesized answer", toolCalls: [], steps: 1, durationMs: 1, hadError: false } },
    ] satisfies AgentClientEvent[]) recorder.record(session, event);

    const entries = recordedEntries(dir, session.id);
    expect(entries.map((entry) => entry.type)).toEqual(["tool_call", "tool_result", "assistant"]);
    expect(entries.at(-1)?.text).toBe("synthesized answer");
  });

  test("skips malformed headers when listing", () => {
    const dir = tempTranscriptDir();
    const agentDir = join(dir, "jarvis");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "bad.jsonl"), `${JSON.stringify({ type: "session", version: 1 })}\n`);

    expect(listTranscripts("jarvis", { transcriptDir: dir })).toEqual([]);
  });

  test("kinu debug --transcripts lists a workspace's recorded runs and their files, signed out", async () => {
    const home = scratchDir("debug-transcripts");
    writeFileSync(join(home, "config.json"), JSON.stringify({
      agents: { jarvis: { name: "jarvis", mode: "cloud", cloudName: "jarvis", createdAt: "", updatedAt: "" } },
    }));
    const dir = tempTranscriptDir();
    const session = createCliSession("jarvis", { transcriptDir: dir });
    session.append("user", { text: "why did the build fail" });

    const proc = await runToExit(
      [process.execPath, "packages/cli/bin/cli.ts", "debug", "jarvis", "--transcripts", "--transcript-dir", dir],
      { cwd: resolve(__dirname, "../../.."), env: { ...process.env, KINU_HOME: home, KINU_TOKEN: "", NO_COLOR: "1" } },
    );

    expect(proc.exitCode, proc.stderr).toBe(0);
    const listed = proc.stdout.split("\n").find((line) => line.includes(session.id)) ?? "";
    expect(listed).toContain("why did the build fail");
    expect(listed).toContain(String(session.path));
  });
});
