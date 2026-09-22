/**
 * What you type at workspace creation is its mission, not an opening user turn: replaying it as a prompt got a reply
 * treating a standing brief as a task. Source-level wiring assertions: no DOM harness, and the defect is a nav payload.
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

  test("the creation surface asks for the mission in the workspace's own voice", () => {
    const copy = source("src/hooks/use-create-workspace.ts");
    expect(copy).toContain('MISSION_LABEL = "Mission"');
    expect(copy).toContain('MISSION_PLACEHOLDER = "What would you like help with?"');

    const ui = source("src/pages/HomePage.tsx");
    expect(ui).toContain("What do you wanna work on?");
    expect(ui).toContain("MISSION_LABEL");
    expect(ui).toContain("MISSION_PLACEHOLDER");
    expect(ui).not.toContain("MISSION_HELP");
    expect(ui).not.toContain("first turn");
    expect(() => source("src/components/CreateWorkspaceModal.tsx")).toThrow("ENOENT");
  });

  test("a workspace before its first turn shows the mission as a brief", () => {
    const page = source("src/pages/WorkspacePage.tsx");

    expect(page).toContain("<EmptyConversation mission={as?.purpose ?? \"\"} />");
    // The generic seeded mission describes Kinu, not the workspace; showing it as a brief would be noise.
    expect(page).toContain("isPlaceholderMission(mission) ? null : mission.trim()");
  });
});
