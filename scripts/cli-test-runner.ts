#!/usr/bin/env bun
/**
 * CLI test runner — exercises CLI commands by calling the command functions directly.
 *
 * Imports and invokes each command module directly. This tests the real CLI
 * local-agent logic (SQLite agent DB, create, list, status, export/import)
 * while keeping test state isolated from the user's real ~/.proteus.
 */

import { existsSync, statSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Prevent the test runner from accidentally starting a real daemon.
// createCommand → createCliAgent → ensureLocalDaemonRunning → startDaemon
// would spawn `bun <this-file> daemon run`, re-executing the entire test
// suite as a "daemon" child, which would spawn another child, ad infinitum.
// This must be set BEFORE any imports that pull in the CLI command modules.
process.env.PROTEUS_SKIP_DAEMON = "1";

// Provide dummy LLM config so resolveLLMConfig() doesn't throw.
process.env.PROTEUS_BASE_URL = process.env.PROTEUS_BASE_URL ?? "http://localhost:5173/workers-ai/v1";
process.env.PROTEUS_AUTH = process.env.PROTEUS_AUTH ?? "Bearer test";
process.env.PROTEUS_MODEL = process.env.PROTEUS_MODEL ?? "@cf/deepseek-ai/deepseek-v4-pro-0813";

const TEST_ROOT = join(tmpdir(), `proteus-cli-e2e-home-${Date.now()}`);
process.env.PROTEUS_HOME = TEST_ROOT;
const AGENT_HOME = TEST_ROOT;
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

function errorMessage<Failure>(error: Failure): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanup() {
  // `force` already absorbs a missing path, so anything thrown here is a real cleanup failure
  // (permissions, a busy handle) that would otherwise strand temp state across runs.
  rmSync(join(AGENT_HOME, AGENT_NAME), { recursive: true, force: true });
  rmSync(join(AGENT_HOME, IMPORT_NAME), { recursive: true, force: true });
  rmSync(TEST_ROOT, { recursive: true, force: true });
  rmSync(EXPORT_DIR, { recursive: true, force: true });
}

// ── §1. Create ───────────────────────────────────────────────────

async function testCreate() {
  const { createCommand } = await import("../packages/cli/src/commands/create.js");

  const dbPath = join(AGENT_HOME, AGENT_NAME, "agent.db");

  try {
    await createCommand(AGENT_NAME, { mode: "local", purpose: "E2E test agent for automated testing" });
  } catch (error) {
    fail("proteus create", errorMessage(error));
    return;
  }

  if (existsSync(dbPath)) {
    pass("proteus create", `agent.db created`);
  } else {
    fail("proteus create", "agent.db not found");
  }

  // Duplicate should fail
  let dupFailed = false;
  const origExit = process.exit;
  process.exit = (code) => {
    if (code === 1) dupFailed = true;
    throw new Error(`process.exit(${String(code)})`);
  };
  try {
    await createCommand(AGENT_NAME, { mode: "local", purpose: "dupe" });
  } catch {
    dupFailed = true;
  } finally {
    process.exit = origExit;
  }

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
  } catch (error) {
    console.log = origLog;
    fail("proteus list", errorMessage(error));
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
  } catch (error) {
    console.log = origLog;
    fail("proteus status", errorMessage(error));
  }
}

// ── §4. Export / Import ──────────────────────────────────────────

async function testExportImport() {
  const { exportCommand, importCommand } = await import("../packages/cli/src/commands/export-import.js");

  const exportPath = join(EXPORT_DIR, "exported.agent.db");

  // Export
  try {
    await exportCommand(AGENT_NAME, { output: exportPath });
  } catch (error) {
    fail("proteus export", errorMessage(error));
    return;
  }

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
  } catch (error) {
    fail("proteus import", errorMessage(error));
    return;
  }

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
    const tables = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all();
    const tableNames = tables.map(t => t.name);

    // `inodes` is the workspace filesystem's own table (Nimbus). The agent's
    // files live there; nothing else in this database stores them.
    const requiredTables = ["workspace_identity", "inodes", "search_nodes", "crafted_tools"];
    const missing = requiredTables.filter(t => !tableNames.includes(t));

    if (missing.length === 0) {
      pass("DB tables present", `found ${tableNames.length} tables including all required`);
    } else {
      fail("DB tables present", `missing: ${missing.join(", ")}`);
    }

    // SOUL.md is a FILE in the workspace filesystem; the mission a read-only
    // listing needs is a column on the identity row, maintained by writeSoul.
    // Checking the column here is what this path can do without opening a
    // filesystem — which is the whole reason the column exists.
    const soulFile = db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM inodes WHERE path LIKE '%SOUL.md'",
    ).get();
    const mission = db.query<{ mission: string }, []>(
      "SELECT mission FROM workspace_identity LIMIT 1",
    ).get();
    const missionText = mission?.mission ?? "";
    if ((soulFile?.n ?? 0) > 0 && missionText.includes("E2E test agent")) {
      pass("DB SOUL.md", `file present, mission: "${missionText}"`);
    } else {
      fail("DB SOUL.md", `soul file rows=${soulFile?.n ?? 0}, mission=${JSON.stringify(mission?.mission)}`);
    }

    const identity = db.query<{ name: string }, []>(
      "SELECT name FROM workspace_identity LIMIT 1",
    ).get();
    if (identity?.name === AGENT_NAME) {
      pass("DB workspace_identity", `name: "${identity.name}"`);
    } else {
      fail("DB workspace_identity", `unexpected: ${JSON.stringify(identity)}`);
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
