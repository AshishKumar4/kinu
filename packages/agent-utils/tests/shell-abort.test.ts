// The workspace shell honors AbortSignal between commands: an in-flight
// command list stops (exit 130) and later commands never run. The old
// createShell accepted `{ signal }` and silently dropped it.
import { describe, test, expect } from "bun:test";
import { createShell } from "../src/shell";
import { SqliteFS } from "../src/vfs/sqlite";
import type { VFS } from "../src/vfs/types";
import { createTestDb } from "./helpers";

function createWorkspace() {
	const { sql } = createTestDb();
	const fs = new SqliteFS(sql);
	fs.init();
	return fs;
}

describe("workspace shell abort", () => {
	test("pre-aborted signal: nothing runs, exit 130", async () => {
		const fs = createWorkspace();
		await fs.writeFile("a.txt", "A");
		const shell = createShell(fs);

		const controller = new AbortController();
		controller.abort();
		const result = await shell.exec("cat a.txt", { signal: controller.signal });

		expect(result.exitCode).toBe(130);
		expect(result.stderr).toBe("aborted");
		expect(result.stdout).toBe("");
	});

	test("abort mid-list stops the remaining commands", async () => {
		const fs = createWorkspace();
		await fs.writeFile("a.txt", "A");
		await fs.writeFile("b.txt", "B");
		const controller = new AbortController();

		// Wrap the VFS so reading a.txt simulates the user pressing Stop
		// while the first command is running.
		const reads: string[] = [];
		const vfs: VFS = Object.create(fs);
		vfs.readFile = async (path: string, opts?: { encoding?: "utf8" }) => {
			reads.push(path);
			if (path === "a.txt") controller.abort();
			return fs.readFile(path, opts);
		};

		const shell = createShell(vfs);
		const result = await shell.exec("cat a.txt && cat b.txt", { signal: controller.signal });

		expect(result.exitCode).toBe(130);
		expect(result.stderr).toBe("aborted");
		expect(reads).toEqual(["a.txt"]); // second command never executed
	});

	test("abort mid-pipeline stops the next stage and skips the redirect", async () => {
		const fs = createWorkspace();
		await fs.writeFile("a.txt", "needle\nhay");
		const controller = new AbortController();

		const vfs: VFS = Object.create(fs);
		vfs.readFile = async (path: string, opts?: { encoding?: "utf8" }) => {
			if (path === "a.txt") controller.abort();
			return fs.readFile(path, opts);
		};

		const shell = createShell(vfs);
		const result = await shell.exec("cat a.txt | grep needle > out.txt", { signal: controller.signal });

		expect(result.exitCode).toBe(130);
		expect(await fs.exists("out.txt")).toBe(false);
	});

	test("string second argument still means stdin", async () => {
		const fs = createWorkspace();
		const shell = createShell(fs);
		const result = await shell.exec("grep keep", "drop\nkeep\n");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("keep");
		expect(result.stdout).not.toContain("drop");
	});
});
