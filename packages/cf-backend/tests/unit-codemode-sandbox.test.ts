// The hosted `execute_tools` sandbox: what the prelude defines, how a crafted
// tool is guarded, and what `require()` hands a program.
//
// The shim module is the SOURCE the dynamic Worker loads (codemode-node-shim.ts).
// It is evaluated here for real — written to a file and imported — so these
// tests run the same JavaScript the sandbox runs, against a fake `workspace`
// namespace in place of the host dispatcher.
import { describe, test, expect, mock } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import type { CraftedTool, CraftStore, JsonValue } from "@kinu.run/core";
import { craftFailureMarker, initCraftQualityColumns } from "@kinu.run/core";
import { createTestSql, scratchDir } from "@kinu.run/test-utils";
import { KINU_NODE_MODULE_NAME, KINU_NODE_MODULE_SOURCE } from "../src/codemode-node-shim";

// @cloudflare/codemode (the DWE import) needs the workerd-only module. Spread
// the preload's real boundary stub: `mock.module` is process-wide, so listing
// only this test's imports drops an export a sibling binds and makes its
// result depend on file load order.
const workersModule = await import("cloudflare:workers");
await mock.module("cloudflare:workers", () => ({
  ...workersModule,
  RpcTarget: class {},
  WorkerEntrypoint: class {},
  DurableObject: class {},
}));
const { selectInjectableCraftedTools, renderToolsPrelude } = await import("../src/codemode-sandbox");

const shimDir = scratchDir("shim");
const shimPath = join(shimDir, KINU_NODE_MODULE_NAME);
writeFileSync(shimPath, KINU_NODE_MODULE_SOURCE);
// The one dynamic import in this file: the module under test is a string this
// process wrote a moment ago, so no static specifier can name it.
const shim = await import(shimPath);

function makeCraftStore(tools: Array<{ name: string; code: string; description?: string }>): CraftStore {
  const rows: CraftedTool[] = tools.map((t) => ({
    name: t.name, code: t.code, description: t.description ?? "",
    params: null, scope: "local", createdAt: 0, updatedAt: 0,
  }));
  const unsupported = (): never => { throw new Error("unused CraftStore operation"); };
  return {
    create: unsupported,
    update: unsupported,
    get: () => undefined,
    delete: unsupported,
    list: () => rows,
    search: () => [],
    getAll: () => rows,
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    return new Error(String(error));
  }
  throw new Error("Expected promise to reject");
}

type SandboxMember = (...args: JsonValue[]) => Promise<JsonValue>;

/** The vendor's namespace proxy, as DynamicWorkerExecutor declares it: own
 *  properties win over the host dispatch. Mirrors the vendor source in
 *  `@cloudflare/codemode` (`proxyInits`), minus the RPC crossing. */
function vendorProxy(dispatch: (name: string, args: JsonValue[]) => Promise<JsonValue>) {
  const own: Record<string, SandboxMember> = {};
  return new Proxy(own, {
    get: (target, toolName) => {
      const key = v.safeParse(v.string(), toolName);
      if (!key.success) return undefined;
      const defined = target[key.output];
      if (defined !== undefined) return defined;
      return async (...args: JsonValue[]) => dispatch(key.output, args);
    },
  });
}

describe("selectInjectableCraftedTools — one policy with core", () => {
  test("drops comment-only code and score-retired tools; keeps healthy + unscored", () => {
    const { db, sql } = createTestSql();
    initCraftQualityColumns((ddl: string) => db.exec(ddl), sql);
    const now = Date.now();
    void sql`INSERT INTO crafted_tools (name, score, uses, last_used_at) VALUES ('healthy', 0.9, 4, ${now})`;
    void sql`INSERT INTO crafted_tools (name, score, uses, last_used_at) VALUES ('retired', 0.01, 9, ${now})`;

    const store = makeCraftStore([
      { name: "healthy", code: "async (args) => 1" },
      { name: "retired", code: "async (args) => 2" },
      { name: "unscored", code: "async (args) => 3" },
      { name: "commented_out", code: "// disabled" },
      { name: "empty", code: "   " },
    ]);

    const selected = selectInjectableCraftedTools(store, sql);
    expect(selected.map((t) => t.name)).toEqual(["healthy", "unscored"]);
  });

  test("a broken craft store surfaces its failure rather than an empty selection", () => {
    const { db, sql } = createTestSql();
    initCraftQualityColumns((ddl: string) => db.exec(ddl), sql);
    const store = makeCraftStore([]);
    store.list = () => { throw new Error("not initialized"); };
    expect(() => selectInjectableCraftedTools(store, sql)).toThrow("not initialized");
  });
});

describe("renderToolsPrelude — one guarded definition per crafted tool", () => {
  test("defines require, env and every crafted tool on the tools namespace", () => {
    const prelude = renderToolsPrelude(
      [{ name: "double", code: "async (n) => n * 2", description: "" }],
      { workspace: "hardy-stone-a905df14" },
    );
    expect(prelude).toContain(`await import("./${KINU_NODE_MODULE_NAME}")`);
    expect(prelude).toContain("const require = __kinu.createRequire(");
    expect(prelude).toContain('workspace: "hardy-stone-a905df14"');
    expect(prelude).toContain('"double": __kinu.defineCrafted("double", () => (\nasync (n) => n * 2\n))');
    expect(prelude).toContain("Object.assign(tools, {");
  });

  test("a stored body that does not parse becomes a definition that throws the parse error, and nothing else", () => {
    // The production defect: one `const name = …` body stored verbatim was a
    // SyntaxError for EVERY program in the workspace. Now it is a factory that
    // throws on call, and the parse of the prelude itself stays clean.
    const prelude = renderToolsPrelude(
      [
        { name: "broken", code: "const broken = async () => 1", description: "" },
        { name: "fine", code: "async () => 2", description: "" },
      ],
      { workspace: "w" },
    );
    expect(prelude).toContain('"broken": __kinu.defineCrafted("broken", () => { throw new Error("stored source does not parse:');
    expect(prelude).toContain('"fine": __kinu.defineCrafted("fine", () => (\nasync () => 2\n))');
    // The definitions block parses as JavaScript on its own.
    const block = prelude.slice(prelude.indexOf("Object.assign(tools, {"));
    expect(() => new Function("tools", "__kinu", block)).not.toThrow();
  });
});

describe("defineCrafted — a tool breaks only its own name", () => {
  test("a body that raises is stamped with the tool that raised it", async () => {
    const boom = shim.defineCrafted("boom", () => async () => { throw new Error("inner"); });
    const err = await rejectionOf(boom());
    expect(err.message).toBe(`${craftFailureMarker("boom")} inner`);
    expect(err.cause).toBeInstanceOf(Error);
  });

  test("a body that is not a function reports so on its first call", async () => {
    const notFn = shim.defineCrafted("notFn", () => 42);
    const err = await rejectionOf(notFn());
    expect(err.message).toBe(`${craftFailureMarker("notFn")} is not a function: its stored source evaluates to number`);
  });

  test("a body that throws while being evaluated reports the load failure on call", async () => {
    const dead = shim.defineCrafted("dead", () => { throw new Error("no such helper"); });
    const err = await rejectionOf(dead());
    expect(err.message).toBe(`${craftFailureMarker("dead")} failed to load: no such helper`);
  });

  test("own definitions win over the host dispatch on the vendor's proxy, and siblings see each other", async () => {
    const dispatched: string[] = [];
    const tools = vendorProxy(async (name) => { dispatched.push(name); return `host:${name}`; });
    Object.assign(tools, {
      double: shim.defineCrafted("double", () => async (n: number) => n * 2),
      quad: shim.defineCrafted("quad", () => async (n: number) => Number(await tools.double?.(n)) * 2),
    });
    expect(await tools.quad?.(3)).toBe(12);
    expect(await tools.file?.({ action: "read" })).toBe("host:file");
    expect(dispatched).toEqual(["file"]);
  });
});

describe("createRequire — Node's fs and child_process over the workspace", () => {
  const files = new Map<string, string>([["notes.md", "hello"]]);
  const workspace = {
    readFile: async (path: string) => {
      const text = files.get(path);
      if (text === undefined) throw new Error(`workspace.readFile: ENOENT ${path}`);
      return text;
    },
    writeFile: async (path: string, content: string) => { files.set(path, content); return "ok"; },
    readdir: async (path: string) => {
      if (path !== "/" && path !== ".") throw new Error("ENOTDIR");
      return [...files.keys()];
    },
    exists: async (path: string) => files.has(path),
    exec: async (command: string) => command.startsWith("false")
      ? "Error (exit 1)\n--- stderr ---\nnope"
      : `ran: ${command}`,
  };
  const require = shim.createRequire({ workspace, builtins: { "node:path": { join: (...parts: string[]) => parts.join("/") } } });

  test("fs/promises reads and writes workspace files", async () => {
    const fs = require("fs/promises");
    expect(await fs.readFile("notes.md", "utf8")).toBe("hello");
    await fs.writeFile("out.txt", "written");
    expect(files.get("out.txt")).toBe("written");
    await fs.appendFile("out.txt", "!");
    expect(files.get("out.txt")).toBe("written!");
    expect(await fs.readdir("/")).toEqual(["notes.md", "out.txt"]);
    expect((await fs.stat("notes.md")).isFile()).toBe(true);
    expect((await fs.stat("/")).isDirectory()).toBe(true);
  });

  test("a missing file is an ENOENT error, like Node's", async () => {
    const err = await rejectionOf(require("node:fs/promises").readFile("absent.md", "utf8"));
    expect(err.message).toContain("ENOENT");
  });

  test("the sync fs API names the async form instead of hanging", () => {
    expect(() => require("fs").readFileSync("notes.md")).toThrow('fs.readFileSync is not available in this sandbox: use await require("fs/promises").readFile(...)');
  });

  test("child_process.exec runs through the workspace shell, in promise and callback form", async () => {
    const { exec } = require("child_process");
    expect(await exec("ls -la")).toEqual({ stdout: "ran: ls -la", stderr: "" });
    const failed = await rejectionOf(exec("false"));
    expect(failed.message).toContain("Command failed: false");
    const viaCallback = await new Promise<string>((resolve) => {
      exec("echo hi", (error: Error | null, stdout: string) => resolve(error ? error.message : stdout));
    });
    expect(viaCallback).toBe("ran: echo hi");
  });

  test("Node builtins resolve with or without the node: prefix; anything else names what exists", () => {
    expect(require("path").join("a", "b")).toBe("a/b");
    expect(require("node:path")).toBe(require("path"));
    expect(() => require("left-pad")).toThrow("Cannot find module 'left-pad'");
    expect(require.available).toEqual(["child_process", "fs", "fs/promises", "path"]);
  });
});
