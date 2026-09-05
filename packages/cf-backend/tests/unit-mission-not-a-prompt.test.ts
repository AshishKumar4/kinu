/**
 * One box, one meaning: what you type when you create a workspace is its
 * MISSION — what the workspace is for — and not the first thing you say to it.
 *
 * It used to be read as both. The mission seeded SOUL.md and titled the
 * workspace AND rode along in navigation state to be replayed as an opening
 * user turn, so a workspace created with "My personal assistant, Jarvis" got a
 * reply that began "This is a very short, ambiguous statement": a standing
 * brief handed over as a task. The second reading is gone; these pin that it
 * cannot come back through the one mission-first creation surface.
 *
 * Wiring assertions over source, the technique unit-agent-naming.test.ts
 * already uses for the same reason: the app has no DOM test harness, and the
 * defect lives in a navigation payload and a copy string rather than in a
 * function anyone can call.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "..");
const source = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("the creation box is a mission, not a first prompt", () => {
  test("creating a workspace navigates into it carrying nothing to send", () => {
    const hook = source("src/hooks/use-create-workspace.ts");

    expect(hook).toContain("navigate(`/workspace/${created.name}`)");
    expect(hook).not.toContain("initialPrompt");
    expect(hook).not.toContain("sendChat");
  });

  test("the workspace page has no path that replays a creation payload as a turn", () => {
    const page = source("src/pages/WorkspacePage.tsx");

    expect(page).not.toContain("initialPrompt");
    expect(page).not.toContain("location.state");
  });

  test("the creation surface says what the box is, and that nothing runs yet", () => {
    const copy = source("src/hooks/use-create-workspace.ts");
    expect(copy).toContain('MISSION_LABEL = "Mission"');
    expect(copy).toContain("A standing brief for the whole workspace.");
    expect(copy).toContain("Nothing runs until the first message.");

    const ui = source("src/pages/HomePage.tsx");
    expect(ui).toContain("MISSION_LABEL");
    expect(ui).toContain("MISSION_PLACEHOLDER");
    expect(ui).toContain("MISSION_HELP");
    expect(ui).not.toContain("first turn");
    expect(() => source("src/components/CreateWorkspaceModal.tsx")).toThrow("ENOENT");
  });

  test("a workspace before its first turn shows the mission as a brief", () => {
    const page = source("src/pages/WorkspacePage.tsx");

    expect(page).toContain("<EmptyConversation mission={as?.purpose ?? \"\"} />");
    // A workspace created without a mission carries the generic seeded one,
    // which describes Kinu rather than the workspace — showing it as a
    // brief would be noise.
    expect(page).toContain("isPlaceholderMission(mission) ? null : mission.trim()");
  });
});
