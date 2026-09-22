/**
 * Providers and the MCP server roster each render from one panel, so settings and the setup modal cannot drift.
 * Source assertions (no DOM harness): counts `<Component` render sites across src/.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const SRC = join(import.meta.dir, "..", "src");

const source = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

function renderers(component: string): string[] {
  const openTag = `<${component}`;
  const found: string[] = [];

  for (const entry of readdirSync(SRC, { recursive: true })) {
    const file = String(entry);

    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;

    if (source(`src/${file}`).includes(openTag)) found.push(`src/${file}`);
  }

  return found.sort();
}

describe("account panels are shared, not copied", () => {
  test("the settings page carries no provider form code after the move", () => {
    const settings = source("src/pages/UserSettingsPage.tsx");

    expect(settings).not.toContain("Combobox");
    expect(settings).not.toContain("startCodexFlow");
    expect(settings).toContain("ProvidersPanel");
  });

  test("each panel has exactly its render sites: a host surface, the modal, the wizard's providers step", () => {
    expect(renderers("ProvidersPanel")).toEqual([
      "src/components/account/AccountPanelModal.tsx",
      "src/pages/UserSettingsPage.tsx",
      "src/pages/WelcomePage.tsx",
    ]);
    expect(renderers("McpServersPanel")).toEqual([
      "src/components/account/AccountPanelModal.tsx",
      "src/pages/UserMcpPage.tsx",
    ]);
    expect(renderers("CliInstallCard")).toEqual([
      "src/components/account/AccountPanelModal.tsx",
      "src/pages/UserSettingsPage.tsx",
    ]);
    expect(renderers("SetupCard")).toEqual(["src/pages/HomePage.tsx"]);
  });

  test("the MCP page and settings page delegate to the panels", () => {
    expect(source("src/pages/UserMcpPage.tsx")).toContain("<McpServersPanel />");
    expect(source("src/pages/UserSettingsPage.tsx")).toContain("<CliInstallCard />");
    expect(source("src/pages/HomePage.tsx")).toContain("<SetupCard");
  });
});
