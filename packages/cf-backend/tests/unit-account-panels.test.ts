/**
 * The account panels moved out of the pages that used to own them: providers
 * form code out of UserSettingsPage, the server roster out of UserMcpPage.
 * A page that still carried a copy would render two sources of truth — the
 * settings section and the setup modal would drift apart in exactly the way
 * this refactor exists to prevent. Source assertions, because the app has no
 * DOM harness: a component's render sites are its contract, so the test counts
 * `<Component` occurrences across src/ rather than trusting an import string.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const SRC = join(import.meta.dir, "..", "src");

const source = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

/** Every src file that renders the named component. */
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

  test("each panel has exactly its two render sites: a host surface and the modal", () => {
    expect(renderers("ProvidersPanel")).toEqual([
      "src/components/account/AccountPanelModal.tsx",
      "src/pages/UserSettingsPage.tsx",
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
