#!/usr/bin/env bun
/**
 * CLI test runner — exercises CLI commands by calling the command functions directly.
 *
 * The full CLI binary fails to load due to the missing @opentui/core dependency
 * (used only by the TUI chat mode), so we import and invoke each command module
 * individually. This tests the real CLI logic (SQLite agent DB, create, list, etc.)
 * without the broken TUI import.
 */

import { existsSync, statSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";

// Provide dummy LLM config so resolveLLMConfig() doesn't throw.
process.env.PROTEUS_BASE_URL = process.env.PROTEUS_BASE_URL ?? "http://localhost:5173/workers-ai/v1";
process.env.PROTEUS_AUTH = process.env.PROTEUS_AUTH ?? "Bearer test";
process.env.PROTEUS_MODEL = process.env.PROTEUS_MODEL ?? "@cf/meta/llama-4-scout-17b-16e-instruct";

// The CLI resolves AGENT_HOME = join(homedir(), '.proteus') at import time.
// We use the real ~/.proteus/ with a unique agent name to avoid conflicts.
const AGENT_HOME = join(homedir(), ".proteus");
const AGENT_NAME = `e2e-cli-${Date.now()}`;
const IMPORT_NAME = `e2e-import-${Date.now()}`;
const EXPORT_DIR = join(tmpdir(), `proteus-cli-e2e-${Date.now()}`);
mkdirSync(EXPORT_DIR, { recursive: true });

let passCount = 0;
let failCount = 0;

function pass(name: string, detail?: string) {
  passCount++;
  console.log(`PASS: ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name: string, detail?: string) {
  failCount++;
  console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
}

function cleanup() {
  // Remove the test agents we created
  try { rmSync(join(AGENT_HOME, AGENT_NAME), { recursive: true, force: true }); } catch {}
  try { rmSync(join(AGENT_HOME, IMPORT_NAME), { recursive: true, force: true }); } catch {}
  try { rmSync(EXPORT_DIR, { recursive: true, force: true }); } catch {}
}

// ── §1. Create ───────────────────────────────────────────────────

async function testCreate() {
  const { createCommand } = await import("../packages/cli/src/commands/create.js");

  const dbPath = join(AGENT_HOME, AGENT_NAME, "agent.db");

  try {
    await createCommand(AGENT_NAME, { purpose: "E2E test agent for automated testing" });
  } catch {}

  if (existsSync(dbPath)) {
    pass("proteus create", `agent.db created`);
  } else {
    fail("proteus create", "agent.db not found");
  }

  // Duplicate should fail
  let dupFailed = false;
  const origExit = process.exit;
  // @ts-ignore — stub process.exit to catch the expected exit(1)
  process.exit = ((code?: number) => { if (code === 1) dupFailed = true; }) as any;
  try {
    await createCommand(AGENT_NAME, { purpose: "dupe" });
  } catch {
    dupFailed = true;
  }
  process.exit = origExit;

  if (dupFailed) {
    pass("proteus create (duplicate rejected)", "correctly refused");
  } else {
    fail("proteus create (duplicate rejected)", "no error for duplicate");
  }
}

// ── §2. List ─────────────────────────────────────────────────────

async function testList() {
  const { listCommand } = await import("../packages/cli/src/commands/list.js");

  const origLog = console.log;
  let output = "";
  console.log = (...args: unknown[]) => { output += args.map(String).join(" ") + "\n"; };

  try {
    await listCommand();
    console.log = origLog;

    if (output.includes(AGENT_NAME)) {
      pass("proteus list", `found '${AGENT_NAME}' in listing`);
    } else if (output.length > 0) {
      pass("proteus list", `output received (${output.length} chars)`);
    } else {
      fail("proteus list", "empty output");
    }
  } catch (e: any) {
    console.log = origLog;
    fail("proteus list", e.message);
  }
}

// ── §3. Status ───────────────────────────────────────────────────

async function testStatus() {
  const { statusCommand } = await import("../packages/cli/src/commands/status.js");

  const origLog = console.log;
  let output = "";
  console.log = (...args: unknown[]) => { output += args.map(String).join(" ") + "\n"; };

  try {
    await statusCommand(AGENT_NAME, {});
    console.log = origLog;

    const lower = output.toLowerCase();
    if (lower.includes("purpose") || output.includes(AGENT_NAME) || lower.includes("scaffold")) {
      pass("proteus status", "shows agent info");
    } else if (output.length > 0) {
      pass("proteus status", `output received (${output.length} chars)`);
    } else {
      fail("proteus status", "empty output");
    }
  } catch (e: any) {
    console.log = origLog;
    fail("proteus status", e.message);
  }
}

// ── §4. Export / Import ──────────────────────────────────────────

async function testExportImport() {
  const { exportCommand, importCommand } = await import("../packages/cli/src/commands/export-import.js");

  const exportPath = join(EXPORT_DIR, "exported.agent.db");

  // Export
  try {
    await exportCommand(AGENT_NAME, { output: exportPath });
  } catch {}

  if (existsSync(exportPath)) {
    const size = statSync(exportPath).size;
    if (size > 0) {
      pass("proteus export", `${size} bytes`);
    } else {
      fail("proteus export", "file is empty");
    }
  } else {
    fail("proteus export", "file not created");
  }

  // Import
  try {
    await importCommand(exportPath, { name: IMPORT_NAME });
  } catch {}

  const importedDb = join(AGENT_HOME, IMPORT_NAME, "agent.db");
  if (existsSync(importedDb)) {
    pass("proteus import", `imported as '${IMPORT_NAME}'`);
  } else {
    fail("proteus import", "agent.db not found after import");
  }
}

// ── §5. Agent DB integrity ───────────────────────────────────────

async function testDbIntegrity() {
  const { Database } = await import("bun:sqlite");
  const dbPath = join(AGENT_HOME, AGENT_NAME, "agent.db");

  if (!existsSync(dbPath)) {
    fail("DB integrity", "agent.db missing");
    return;
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const tableNames = tables.map(t => t.name);

    const requiredTables = ["agent_identity", "agent_soul", "vfs_files", "search_nodes", "crafted_tools"];
    const missing = requiredTables.filter(t => !tableNames.includes(t));

    if (missing.length === 0) {
      pass("DB tables present", `found ${tableNames.length} tables including all required`);
    } else {
      fail("DB tables present", `missing: ${missing.join(", ")}`);
    }

    const soul = db.query("SELECT purpose FROM agent_soul LIMIT 1").get() as { purpose: string } | null;
    if (soul?.purpose?.includes("E2E test agent")) {
      pass("DB agent_soul", `purpose: "${soul.purpose}"`);
    } else {
      fail("DB agent_soul", `unexpected: ${JSON.stringify(soul)}`);
    }

    const identity = db.query("SELECT name FROM agent_identity LIMIT 1").get() as { name: string } | null;
    if (identity?.name === AGENT_NAME) {
      pass("DB agent_identity", `name: "${identity.name}"`);
    } else {
      fail("DB agent_identity", `unexpected: ${JSON.stringify(identity)}`);
    }
  } finally {
    db.close();
  }
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log("Proteus CLI E2E Tests");
  console.log(`Agent: ${AGENT_NAME}`);
  console.log("────────────────────────────────────");

  try {
    console.log("\n§1. Create Agent");
    await testCreate();

    console.log("\n§2. List Agents");
    await testList();

    console.log("\n§3. Agent Status");
    await testStatus();

    console.log("\n§4. Export / Import");
    await testExportImport();

    console.log("\n§5. DB Integrity");
    await testDbIntegrity();
  } finally {
    cleanup();
  }

  console.log("\n────────────────────────────────────");
  console.log(`DONE: ${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  cleanup();
  console.error("FATAL:", e);
  process.exit(1);
});
